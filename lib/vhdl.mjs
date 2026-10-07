/**
 * VHDL-side schematic substrate.
 *
 * WHY THIS EXISTS INSTEAD OF A .gdf EDITOR
 *
 * MAX+PLUS II schematics are stored in a proprietary binary format: a "GDF"
 * magic followed by records of legacy little-endian floats and 16-bit
 * coordinates. Every `.gdf` in a real project shares only a 21-byte prefix, and
 * the reader/writer (`gio_read_clp_gdf` / `gio_write_clp_gdf`) live inside
 * `gedmain.dll` with no published spec. A byte-level editor would mutate a
 * structure whose invariants are unknown, where one wrong byte silently corrupts
 * a file the toolchain then misreads — an unacceptable failure mode for
 * coursework.
 *
 * But a schematic is only the WIRING layer. In practice the logic already lives
 * in synthesizable text: real projects here have `andarray.vhd`, `fa0.vhd`,
 * `fa1.vhd`, `convert.vhd`, `pc.vhd`, `rom.vhd`, while the `.gdf` files merely
 * instance and connect them.
 *
 * So this module reproduces a schematic's wiring as synthesizable VHDL with the
 * SAME entity interface, using the original modules unmodified. The result is
 * compiled and functionally checked by test/regen-verify.mjs.
 */

// ---------------------------------------------------------------------------
// Entity parsing
// ---------------------------------------------------------------------------

/** Parse a VHDL entity declaration into its generic port list. */
export function parseVhdlEntity(text) {
  const clean = text.replace(/--[^\n]*/g, '').replace(/\r/g, '');
  const entityMatch = clean.match(/\bENTITY\s+([A-Za-z_]\w*)\s+IS\b([\s\S]*?)\bEND\b/i);
  if (!entityMatch) throw new Error('no ENTITY declaration found');
  const name = entityMatch[1];
  const body = entityMatch[2];

  const portMatch = body.match(/\bPORT\s*\(([\s\S]*?)\)\s*;/i);
  if (!portMatch) throw new Error(`entity ${name} has no PORT clause`);

  const ports = [];
  for (const group of portMatch[1].split(';')) {
    const g = group.trim();
    if (!g) continue;
    const m = g.match(/^([^:]+):\s*(IN|OUT|INOUT)\s+(.+)$/i);
    if (!m) continue;
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const dir = m[2].toUpperCase();
    const typeText = m[3].trim();
    const busMatch = typeText.match(/STD_LOGIC_VECTOR\s*\(\s*(\d+)\s+(DOWNTO|TO)\s+(\d+)\s*\)/i);
    const vector = Boolean(busMatch);
    const msb = busMatch ? Number(busMatch[1]) : 0;
    const lsb = busMatch ? Number(busMatch[3]) : 0;
    for (const n of names) {
      ports.push({
        name: n, dir, vector, msb, lsb,
        width: vector ? Math.abs(msb - lsb) + 1 : 1,
        typeText, raw: g,
      });
    }
  }

  const archMatch = clean.match(/\bARCHITECTURE\s+(\w+)\s+OF\s+\w+\s+IS/i);
  return { name, ports, architecture: archMatch ? archMatch[1] : null, hasArchitecture: Boolean(archMatch) };
}

/** Render a port clause back to VHDL, preserving vector ranges. */
export function renderPorts(ports, indent = '  ') {
  return ports.map((p) => {
    const type = p.vector
      ? `STD_LOGIC_VECTOR(${p.msb} ${p.msb >= p.lsb ? 'DOWNTO' : 'TO'} ${p.lsb})`
      : 'STD_LOGIC';
    return `${indent}${p.name} : ${p.dir} ${type}`;
  }).join(';\n');
}

/** Build a signal variable token for setacf: |SIG -> "|SIG :\tKIND". */
export function buildPinVariable(signal, kind) {
  return `${normalizeSignalName(signal)} :\t${kind.toUpperCase()}`;
}

/** Ensure a hierarchy-qualified signal name carries exactly one leading pipe. */
export function normalizeSignalName(signal) {
  const s = String(signal).trim();
  return s.startsWith('|') ? s : `|${s}`;
}

// ---------------------------------------------------------------------------
// Multiplier synthesis: row-wise accumulation
// ---------------------------------------------------------------------------

/**
 * Emit an N x N unsigned multiplier as structural VHDL.
 *
 * STRUCTURE: row-wise accumulation, chosen after a carry-save column reduction
 * was abandoned. Two independent models of that reduction disagreed with integer
 * multiplication, so there was no trustworthy reference to build against.
 * Row-wise accumulation is just integer addition of shifted operands, so
 * lib/arraymath.mjs can model it exactly and a test asserts the two agree.
 *
 * Wiring:
 *   - ANDARRAY produces every partial product AiBj (all the AND logic)
 *   - accumulator bit i of row k is Ai AND Bk, i.e. the partial product AiBk
 *   - the accumulator is extended by a row of full adders per row, chaining the
 *     carry upward exactly like an integer add
 *   - the final accumulator bits become the product
 *
 * `spec.andTerms` is a lookup from a partial-product name to the ANDARRAY output
 * that carries it, so nothing here has to guess the naming scheme.
 */
export function emitArrayMultiplierVhdl(spec) {
  const {
    entity, width, productWidth,
    portsDecl, andComponent, adderComponent, convertComponent = null,
    architectureName = 'STRUCTURAL', notes = [],
  } = spec;

  const accWidth = width + width;
  const termName = (i, k) => `A${i}B${k}`;
  const L = [];
  const w = (s = '') => L.push(s);

  // ---- accumulator signal names ------------------------------------------
  // acc[r] holds the accumulator state after adding row r (acc[0] is row 0).
  const accBits = [];
  for (let r = 0; r < width; r++) {
    accBits.push(Array.from({ length: accWidth }, (_, i) => `acc${r}_${i}`));
  }
  // Full-adder outputs: one adder per bit position per accumulation row.
  const sumName = (r, i) => `sum${r}_${i}`;
  const carryName = (r, i) => `carry${r}_${i}`;
  // Carry input to bit i of accumulation row r. Bit 0's carry-in is the constant
  // `cin<r>`, kept separate from the FA's carry OUTPUT `carry<r>_0` — sharing one
  // name makes the signal have two drivers.
  const carryInName = (r, i) => (i === 0 ? `cin${r}` : carryName(r, i - 1));

  w('LIBRARY IEEE;');
  w('USE IEEE.STD_LOGIC_1164.ALL;');
  for (const note of notes) w(`-- ${note}`);
  w('');
  w(`ENTITY ${entity} IS`);
  w('PORT(');
  w(portsDecl);
  w(');');
  w(`END ${entity};`);
  w('');
  w(`ARCHITECTURE ${architectureName} OF ${entity} IS`);
  w(`  COMPONENT ${andComponent.name}`);
  w('  PORT(');
  w(andComponent.portDecl);
  w('  );');
  w('  END COMPONENT;');
  w(`  COMPONENT ${adderComponent.name}`);
  w(`  PORT(${adderComponent.portDecl});`);
  w('  END COMPONENT;');
  if (convertComponent) {
    w(`  COMPONENT ${convertComponent.name}`);
    w('  PORT(');
    w(convertComponent.portDecl);
    w('  );');
    w('  END COMPONENT;');
  }
  w('');

  // ---- declarations -------------------------------------------------------
  // The partial products are outputs of ANDARRAY, so they need local signals
  // before this level can reference them.
  for (const name of andComponent.outputs ?? []) w(`  SIGNAL ${name} : STD_LOGIC;`);
  for (const row of accBits) {
    for (const s of row) w(`  SIGNAL ${s} : STD_LOGIC;`);
  }
  // A constant zero for adder positions that have no addend. VHDL has no logic
  // literals, and this toolchain rejects a literal on a port map
  // ("expected converted actual in actual designator"), so it needs a signal.
  w('  SIGNAL GND : STD_LOGIC;');
  for (let r = 1; r < width; r++) {
    w(`  -- accumulation row ${r}`);
    w(`  SIGNAL cin${r} : STD_LOGIC;`);
    for (let i = 0; i < accWidth; i++) w(`  SIGNAL ${sumName(r, i)} : STD_LOGIC;`);
    for (let i = 0; i < accWidth; i++) w(`  SIGNAL ${carryName(r, i)} : STD_LOGIC;`);
  }
  if (convertComponent) w(`  SIGNAL PROD : STD_LOGIC_VECTOR(${productWidth - 1} DOWNTO 0);`);
  w('');

  w('BEGIN');
  w('  -- Partial products: all of the AND logic.');
  w(`  U_AND : ${andComponent.name} PORT MAP(`);
  w('    A => A, B => B,');
  const named = andComponent.outputs ?? [];
  named.forEach((p, i) => w(`    ${p} => ${p}${i === named.length - 1 ? '' : ','}`));
  w('  );');
  w('');

  // ---- row 0 --------------------------------------------------------------
  w('  GND <= \'0\';');
  w('');
  w('  -- Row 0: A masked by B bit 0, shifted by 0. No addition yet.');
  for (let i = 0; i < accWidth; i++) {
    if (i < width) w(`  ${accBits[0][i]} <= ${termName(i, 0)};`);
    else w(`  ${accBits[0][i]} <= '0';`);
  }
  w('');

  // ---- rows 1..width-1 ----------------------------------------------------
  for (let r = 1; r < width; r++) {
    w(`  -- Row ${r}: add (A masked by B bit ${r}) shifted by ${r}.`);
    w(`  cin${r} <= '0';`);
    // One adder per bit, spanning the whole accumulator. Every position must have
    // a driven carry-out, because the next position reads it: omitting the adders
    // below the shift left carry<r>_<r-1> undriven while bit r still read it
    // ("missing source" on that FA input), and truncating the top of the chain
    // dropped the final carry entirely (3 x 3 read back as 1, not 9).
    //
    // Positions below the shift add nothing, but they must still pass the carry
    // along, so they use GND as the addend rather than being short-circuited.
    for (let i = 0; i < accWidth; i++) {
      const x = accBits[r - 1][i];
      const hasAddend = i >= r && i - r < width;
      const y = hasAddend ? termName(i - r, r) : 'GND';
      w(`  U_FA${r}_${i} : ${adderComponent.name} PORT MAP(X => ${x}, Y => ${y}, Z => ${carryInName(r, i)}, S => ${sumName(r, i)}, C => ${carryName(r, i)});`);
      w(`  ${accBits[r][i]} <= ${sumName(r, i)};`);
    }
    w('');
  }

  // ---- product ------------------------------------------------------------
  const finalRow = accBits[width - 1];
  w('  -- The final accumulator is the product.');
  if (convertComponent) {
    w(`  U_CONV : ${convertComponent.name} PORT MAP(`);
    for (let i = 0; i < productWidth; i++) w(`    I${i} => ${finalRow[i]},`);
    w('    P => PROD');
    w('  );');
    w('  P <= PROD;');
  } else {
    for (let i = 0; i < productWidth; i++) w(`  P(${i}) <= ${finalRow[i]};`);
  }
  w(`END ${architectureName};`);
  w('');
  return { text: L.join('\n'), accumulationRows: width - 1, accumulatorWidth: accWidth };
}

// ---------------------------------------------------------------------------
// Simulation verification notes
// ---------------------------------------------------------------------------

/**
 * WHY A VHDL TESTBENCH CANNOT DRIVE ITS OWN STIMULUS HERE
 *
 * Established experimentally, not assumed:
 *   - MAX+PLUS II drives Simulator stimulus from the .scf, never from VHDL.
 *   - The internal scan register is `_index`, not a legal VHDL identifier, so a
 *     bench cannot read it (`Error: found illegal character '_'`).
 *   - `WAIT ... FOR` is rejected ("condition clause and timeout clause together
 *     in a wait statement is not supported"), and REPORT is not implemented in
 *     sequential statements.
 *
 * A generated .vec file is the working route — see test/stimulus-e2e.mjs — but
 * it carries exactly one pattern row, so breadth comes from repeated runs rather
 * than from one long sweep.
 */

// ---------------------------------------------------------------------------
// Pin planning
// ---------------------------------------------------------------------------

/** Apply pin assignments extracted from a .pin report as setacf calls. */
export function pinPlanFromReport(pinEntries, { inputs = [], outputs = [], skip = [] } = {}) {
  const skipSet = new Set([...skip, 'TCK', 'TMS', 'TDO', 'TDI', 'CONF_DONE', 'nCEO', 'nSTATUS',
    'nCONFIG', 'VCCIO', 'VCCINT', 'GND', 'RESERVED', 'MSEL0', 'MSEL1', 'VCC_CKLK', 'GND_CKLK',
    'DCLK', 'DATA0']);
  const inSet = new Set(inputs.map((s) => s.toUpperCase()));
  const outSet = new Set(outputs.map((s) => s.toUpperCase()));
  const plan = [];
  for (const e of pinEntries) {
    const name = e.name.toUpperCase();
    if (skipSet.has(name)) continue;
    if (!inSet.has(name) && !outSet.has(name)) continue;
    plan.push({
      signal: e.name,
      pin: e.pin,
      kind: inSet.has(name) ? 'INPUT_PIN' : 'OUTPUT_PIN',
    });
  }
  return plan;
}
