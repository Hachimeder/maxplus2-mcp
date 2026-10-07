/**
 * MAX+PLUS II Simulator table (.tbl) parser.
 *
 * The claim that simulation output is not machine-readable is WRONG. Running
 * the Simulator headless writes a plain-text, 100%-printable table:
 *
 *   GROUP CREATE OUTDATA[7..0] = OUTDATA7 OUTDATA6 ... OUTDATA0 ;
 *   INPUTS LOAD CS CLR CLK ;
 *   OUTPUTS OUTDATA[7..0] ;
 *   BURIED PC AR ;
 *   UNIT ns ;
 *   RADIX HEX ;
 *   PATTERN
 *   %       L         .
 *   %       O   C C   .
 *   %       A C L L   0  P  A
 *   %       D S R K   ]  C  R
 *
 *      0.0> 1 0 0 0 = 80 00 00
 *     20.0> 1 0 0 1 = 80 00 00
 *
 * Each row is: <time> > <input bit values> = <group/buried values in RADIX>.
 * The values after `=` are the SIMULATED OUTPUT, so an expected-result check is
 * possible without a human looking at a waveform.
 *
 * Three subtleties this parser handles:
 *   1. A row can be emitted at a non-grid time, and the final row is the
 *      settled state at the end of the simulation. Both are real data.
 *   2. The header comment block is a fixed-width column ruler that names each
 *      input bit. It wraps for wide buses (`OUTDATA[7..0]` spans several lines),
 *      so the ruler is used as a hint, not as the source of truth.
 *   3. `>=` and `=` both appear, and rows can carry an error/undefined marker.
 */

/**
 * Parse a .tbl file into structured signal metadata plus time-stamped rows.
 */
export function parseTbl(text) {
  const lines = String(text).split(/\r?\n/);

  const groups = {};
  const inputs = [];
  const outputs = [];
  const buried = [];
  let unit = null;
  let radix = null;
  let generatedFrom = null;
  let version = null;
  let date = null;

  const rows = [];
  const problems = [];
  let inPattern = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (/^%/.test(line)) continue; // ruler / comment

    // Header fields
    let m = raw.match(/^\s*MAX\+plus II\s+(\S+)\s+Date:\s*(.+?)\s*$/i);
    if (m) { version = m[1]; date = m[2]; continue; }

    m = raw.match(/^\s*File Generated From:\s*(.+?)\s*$/i);
    if (m) { generatedFrom = m[1]; continue; }

    m = raw.match(/^\s*GROUP\s+CREATE\s+(\S+)\s*=\s*(.+?)\s*;\s*$/i);
    if (m) {
      groups[m[1]] = m[2].trim().split(/\s+/);
      continue;
    }

    m = raw.match(/^\s*INPUTS?\s+(.+?)\s*;\s*$/i);
    if (m) { inputs.push(...m[1].trim().split(/\s+/)); continue; }

    m = raw.match(/^\s*OUTPUTS?\s+(.+?)\s*;\s*$/i);
    if (m) { outputs.push(...m[1].trim().split(/\s+/)); continue; }

    m = raw.match(/^\s*BURIED\s+(.+?)\s*;\s*$/i);
    if (m) { buried.push(...m[1].trim().split(/\s+/)); continue; }

    m = raw.match(/^\s*UNIT\s+(\S+)\s*;\s*$/i);
    if (m) { unit = m[1]; continue; }

    m = raw.match(/^\s*RADIX\s+(\S+)\s*;\s*$/i);
    if (m) { radix = m[1]; continue; }

    if (/^PATTERN\s*$/i.test(line)) { inPattern = true; continue; }

    if (!inPattern) continue;

    // Data row: "<time>> <inputs...> = <values...>"  OR, when the stimulus
    // declares no outputs, just "<time>> <inputs...>".
    m = raw.match(/^\s*([\d.]+)\s*>\s*(.*?)\s*=\s*(.*?)\s*$/) || raw.match(/^\s*([\d.]+)\s*>\s*(.*?)\s*$/);
    if (m) {
      const time = Number(m[1]);
      // Note: a single bit is written right-aligned with a trailing space, so a
      // wide bus like OUTDATA[7..0] appears as "8 0 0 0 0 0 0 0 0  0 0 0 ...".
      // Splitting on whitespace is correct; do NOT assume one token per value.
      const inputBits = m[2].trim().split(/\s+/).filter(Boolean);
      // With no '=' present there are no output values; the row still carries a
      // real time and input state, which is what a stimulus-only table records.
      const values = m[3] === undefined ? [] : m[3].trim().split(/\s+/).filter(Boolean);
      if (!Number.isFinite(time)) continue;

      // Input bits: one whitespace-separated token PER BIT, so a bus declared
      // in INPUTS expands to one token per member of its GROUP.
      const expandedInputs = [];
      const widthOf = name => groups[name]?.length ?? (()=>{ const m = /\[(\d+)\.\.(\d+)\]/.exec(name); return m ? Math.abs(Number(m[1])-Number(m[2]))+1 : 1; })();
      const expandedWidth = inputs.reduce((n,name)=>n+widthOf(name),0);
      const layout = inputBits.length === inputs.length ? 'grouped' : inputBits.length === expandedWidth ? 'expanded' : 'invalid';
      if (layout === 'invalid') problems.push({line:i+1,message:`input token count ${inputBits.length} matches neither ${inputs.length} signals nor ${expandedWidth} bits`});
      let bitIdx = 0;
      for (const name of inputs) {
        const width = widthOf(name);
        const tokens = layout === 'grouped' ? inputBits.slice(bitIdx,bitIdx+1) : inputBits.slice(bitIdx,bitIdx+width);
        const token = tokens.join('');
        const value = layout === 'invalid' ? null : decodeValue(token, layout === 'expanded' ? 'BIN' : radix ?? 'HEX');
        if (value !== null && width < 53 && value >= 2 ** width) problems.push({line:i+1,message:`input ${name} exceeds ${width} bits`});
        expandedInputs.push({
          name,
          width,
          bits: layout === 'grouped' ? value === null ? Array.from({length:width},()=>/z/i.test(token)?'Z':'X') : value.toString(2).padStart(width,'0').split('') : tokens,
          rawTokens: tokens,
          value,
        });
        bitIdx += layout === 'grouped' ? 1 : width;
      }

      // Values on the right of `=`: one whitespace-separated token PER SIGNAL,
      // already encoded in RADIX. A 2-token "80 00 00" means three signals
      // (OUTDATA=0x80, PC=0x00, AR=0x00) — NOT six tokens of bit data.
      const named = {};
      let vIdx = 0;
      const assign = (name) => {
        const tok = values[vIdx];
        vIdx += 1;
        named[name] = tok === undefined ? null : tok;
      };
      for (const name of outputs) assign(name);
      for (const name of buried) assign(name);

      rows.push({
        line: i + 1,
        time,
        raw,
        inputBits,
        inputs: expandedInputs,
        values,
        named,
        inputLayout: layout,
      });
      continue;
    }

    // Non-numeric markers, e.g. rows flagged with an error indicator.
    if (/[>]/.test(raw)) {
      rows.push({ line: i + 1, time: null, raw, unparsed: true });
    }
  }

  return {
    version,
    date,
    generatedFrom,
    unit,
    radix,
    groups,
    inputs,
    outputs,
    buried,
    rows,
    rowCount: rows.length,
    problems,
  };
}

/**
 * Decode a value token group into an integer.
 *
 * IMPORTANT: MAX+PLUS II writes one character per value with whitespace
 * between them, and pads single-bit values with a trailing space, so a raw
 * token slice looks like ["8","0","0","0","0","0","0","0"] preceded by an
 * empty token for the pad. Callers must filter empties and join before
 * decoding — joining directly would concatenate the pad and shift the value.
 *
 * Unknown levels (X, Z, U, -) decode to null rather than silently becoming 0.
 */
export function decodeValue(token, radix = 'HEX') {
  if (token === undefined || token === null) return null;
  const t = Array.isArray(token) ? token.join('') : String(token);
  const s = t.replace(/\s+/g, '').trim();
  if (s === '') return null;
  const base = {HEX:16,BIN:2,BINARY:2,OCT:8,OCTAL:8,DEC:10,DECIMAL:10,UNS:10}[String(radix).toUpperCase()];
  if (!base) return null;
  const digits = {16:/^[0-9a-f]+$/i,2:/^[01]+$/,8:/^[0-7]+$/,10:/^[0-9]+$/}[base];
  if (!digits.test(s)) return null;
  const n = Number.parseInt(s, base);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Build a compact trace: one entry per row, with inputs and outputs flattened
 * to named values. Buses are decoded to integers.
 */
export function tblTrace(parsed) {
  return parsed.rows
    .filter((r) => r.time !== null && r.values)
    .map((r) => {
      const inputs = {};
      for (const g of r.inputs) {
        inputs[g.name] = g.value;
      }
      const outputsOut = {};
      for (const name of parsed.outputs) {
        outputsOut[name] = decodeValue(r.named[name], parsed.radix ?? 'HEX');
      }
      const buriedOut = {};
      for (const name of parsed.buried) {
        buriedOut[name] = decodeValue(r.named[name], parsed.radix ?? 'HEX');
      }
      return { time: r.time, inputs, outputs: outputsOut, buried: buriedOut, line: r.line, rawInputs:Object.fromEntries(r.inputs.map(g=>[g.name,g.rawTokens])), rawValues:r.named, radix:parsed.radix ?? 'HEX' };
    });
}

/**
 * Compare a trace against expected output values.
 *
 * `expectations` is either:
 *   - an object { "<time>": { OUTDATA: 0x80, PC: 0x00 } }, or
 *   - an array of { time, outputs }
 * Times are matched to the nearest row within `tolerance`.
 *
 * Returns per-check results plus an overall pass/fail. This is the piece that
 * makes simulation verification possible without a human reading a waveform.
 */
export function checkTrace(trace, expectations, { tolerance = 0.05 } = {}) {
  const wants = Array.isArray(expectations)
    ? expectations
    : Object.entries(expectations).map(([time, outputs]) => ({ time: Number(time), outputs }));
  if (!wants.length) throw new Error('expectations must contain at least one signal assertion');
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance must be finite and nonnegative');

  const results = [];
  for (const want of wants) {
    if (!Number.isFinite(want.time) || !want.outputs || !Object.keys(want.outputs).length) throw new Error('every expectation requires a finite time and at least one output');
    const row = trace.reduce((best,r)=>Math.abs(r.time-want.time)<=tolerance && (!best || Math.abs(r.time-want.time)<Math.abs(best.time-want.time)) ? r : best,null);
    if (!row) {
      results.push({ time: want.time, ok: false, reason: 'no simulation row at this time' });
      continue;
    }
    const mismatches = [];
    for (const [signal, expected] of Object.entries(want.outputs)) {
      // Outputs and buried nodes are both observable results.
      const actual = row.outputs[signal] !== undefined
        ? row.outputs[signal]
        : row.buried[signal];
      if (actual === undefined) {
        mismatches.push({ signal, expected, actual, reason: 'signal not present in this .tbl' });
        continue;
      }
      const exp = typeof expected === 'string' ? decodeValue(expected) : expected;
      if (!Number.isSafeInteger(exp) || exp < 0) throw new Error(`invalid numeric expectation for ${signal}; unknown values cannot prove numeric correctness`);
      if (actual !== exp) mismatches.push({ signal, expected: exp, actual });
    }
    results.push({
      time: want.time,
      matchedRowTime: row.time,
      ok: mismatches.length === 0,
      mismatches: mismatches.length ? mismatches : undefined,
    });
  }

  const failed = results.filter((r) => !r.ok).length;
  return {
    ok: failed === 0,
    checked: results.length,
    failed,
    results,
  };
}

/** Describe how much of the design the stimulus actually exercised. */
export function stimulusCoverage(parsed) {
  const driven = new Set();
  const undriven = [];
  for (const row of parsed.rows) {
    if (row.time === null || !row.inputs) continue;
    for (const g of row.inputs) {
      const anyKnown = g.bits.some((b) => !/^[xzuXZU-]/.test(b));
      if (anyKnown) driven.add(g.name);
    }
  }
  for (const name of parsed.inputs) {
    if (!driven.has(name)) undriven.push(name);
  }
  return {
    declaredInputs: parsed.inputs,
    drivenInputs: [...driven],
    undrivenInputs: undriven,
  };
}
