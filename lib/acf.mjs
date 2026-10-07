/**
 * MAX+PLUS II Assignment & Configuration File (.acf) parser / serializer.
 *
 * Real format (verified against MAX+PLUS II 10.2 output):
 *
 *   -- comment
 *   DEFAULT_DEVICES
 *   BEGIN
 *       AUTO_DEVICE = EP1K10TC100-1;
 *   END;
 *
 *   CHIP top
 *   BEGIN
 *       |OUTDATA7 :	OUTPUT_PIN = 39;
 *       DEVICE = EP1K30TC144-1;
 *       |CLK :	INPUT_PIN = 126;
 *   END;
 *
 * Two section shapes exist:
 *   - <NAME>            followed by BEGIN   (single-section form)
 *   - <NAME> <value>    followed by BEGIN   (e.g. CHIP top, DEFINE_... NORMAL.MAX5000)
 */

const RE_SECTION_START = /^\s*([A-Z][A-Z0-9_]*)(?:[ \t]+([^\s;]+))?\s*$/;
const RE_BEGIN = /^\s*BEGIN\s*;?\s*$/;
const RE_END = /^\s*END\s*;\s*$/;

/**
 * Parse .acf text into { sections: [{ name, value, lines: [{key, val}], startLine, endLine }] }
 * Preserves original line layout so callers can report precise locations.
 */
export function parseAcf(text) {
  const rawLines = text.split(/\r?\n/);
  const sections = [];
  let cur = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const lineNo = i + 1;

    if (cur === null) {
      const m = line.match(RE_SECTION_START);
      if (m && !line.trim().startsWith('--')) {
        // Peek: the next non-blank line must be BEGIN for this to be a section header.
        let j = i + 1;
        while (j < rawLines.length && rawLines[j].trim() === '') j++;
        if (j < rawLines.length && RE_BEGIN.test(rawLines[j])) {
          cur = {
            name: m[1],
            value: m[2] ?? null,
            headerLine: lineNo,
            entries: [],
          };
          i = j; // consume BEGIN
          continue;
        }
      }
      continue;
    }

    if (RE_END.test(line)) {
      cur.endLine = lineNo;
      sections.push(cur);
      cur = null;
      continue;
    }

    const entry = line.match(/^\s*([^=;]+?)\s*=\s*(.*?)\s*;\s*$/);
    if (entry) {
      cur.entries.push({
        key: entry[1].trim(),
        value: entry[2].trim(),
        line: lineNo,
      });
    }
  }

  // Unterminated trailing section: keep it so callers can detect damage.
  if (cur !== null) {
    cur.endLine = rawLines.length;
    cur.unterminated = true;
    sections.push(cur);
  }

  return { sections, lineCount: rawLines.length };
}

/** Find sections by name (case-insensitive). */
export function findSections(parsed, name) {
  const want = name.toUpperCase();
  return parsed.sections.filter((s) => s.name.toUpperCase() === want);
}

/**
 * Extract the device assignment and all pin/location constraints.
 * Returns { chipSections: [{ chip, device, pins: [{signal, kind, pin, line}] }] }
 */
export function readAssignments(parsed) {
  const chipSections = [];
  for (const s of findSections(parsed, 'CHIP')) {
    const pins = [];
    let device = null;
    for (const e of s.entries) {
      if (e.key.toUpperCase() === 'DEVICE') {
        device = e.value;
        continue;
      }
      // Signal keys appear as: |NAME : KIND   (colon is part of the key)
      const km = e.key.match(/^(.*?)\s*:\s*([A-Z_]+)$/);
      if (km && /_PIN$/.test(km[2].toUpperCase())) {
        pins.push({
          signal: km[1].trim(),
          kind: km[2].toUpperCase(),
          pin: e.value,
          line: e.line,
        });
      }
    }
    chipSections.push({ chip: s.value, device, pins, startLine: s.headerLine });
  }
  return { chipSections };
}

/**
 * Build the argv tail for setacf.exe.
 *
 * Documented usage (extracted from setacf.exe v27.1):
 *   setacf [-h] [-c] [-f<file>] [-a] [-s<sect_name>[:<sect_value>]]
 *          [-p<new_hpath>] [-m<new_value>] [-d <variable>] [variable [value]]
 *
 * Variable syntax for assignments: [<name>:]<keyword>  with <name> wrapped in
 * escaped double quotes, e.g.  \"\|OUT\":INPUT_PIN
 *
 * NOTE: -f and -s/-m are concatenated flags (no space). This is exactly how
 * the shipped binary's own help documents them.
 */
export function buildSetacfArgs(opts) {
  const {
    acfFile,
    create = false,
    global: isGlobal = false,
    section,
    sectionValue,
    modifyTo,
    deleteVariable,
    prependPath,
    variable,
    value,
  } = opts;

  const args = [];
  if (create) args.push('-c');
  if (acfFile) args.push(`-f${acfFile}`);
  if (isGlobal) args.push('-a');

  if (section) {
    args.push(sectionValue ? `-s${section}:${sectionValue}` : `-s${section}`);
  }
  if (modifyTo !== undefined && modifyTo !== null) args.push(`-m${modifyTo}`);
  if (prependPath) args.push(`-p${prependPath}`);
  if (deleteVariable) args.push('-d', deleteVariable);

  if (variable !== undefined && variable !== null && variable !== '') {
    args.push(variable);
    if (value !== undefined && value !== null && value !== '') args.push(value);
  }
  return args;
}

/**
 * Build the setacf variable token for a signal assignment.
 *
 * GRAMMAR, settled empirically against setacf.exe v27.1 (MAX+PLUS II 10.2):
 * setacf copies the variable bytes VERBATIM into the .acf. It performs no
 * un-escaping whatsoever. Verified by passing each candidate form and reading
 * the resulting file:
 *
 *   arg  |CLK :\tINPUT_PIN          ->  .acf  |CLK :\tINPUT_PIN = 43;
 *   arg  \"\|CLK\":INPUT_PIN        ->  .acf  \"\|CLK\":INPUT_PIN = 43;     (garbage)
 *   arg  \|CLK:INPUT_PIN           ->  .acf  \|CLK:INPUT_PIN = 43;          (garbage)
 *
 * Therefore the backslashes described in Altera's help are CMD.EXE escaping
 * for the interactive command line (where `|` would otherwise be a pipe and
 * `"` would otherwise be consumed), NOT part of the variable itself.
 *
 * This server spawns setacf WITHOUT a shell, so the raw form is both correct
 * and safest: no shell can mangle it. Use `cmdQuoteVariable()` instead when
 * generating a line meant to be pasted into, or run from, cmd.exe.
 *
 * The canonical .acf rendering is `|SIGNAL :\tKIND` (see any compiled project).
 */
export function buildPinVariable(signal, kind) {
  const name = normalizeSignalName(signal);
  return `${name} :\t${kind.toUpperCase()}`;
}

/** Ensure a hierarchy-qualified signal name carries exactly one leading pipe. */
export function normalizeSignalName(signal) {
  const s = String(signal).trim();
  if (s.startsWith('|')) return s;
  return `|${s}`;
}

/**
 * Alternative rendering for humans and for cmd.exe command lines only.
 * Do NOT pass the result to a shell-free spawn — setacf stores it verbatim.
 */
export function cmdQuoteVariable(signal, kind) {
  const name = normalizeSignalName(signal);
  const escaped = name.replace(/([\\|"])/g, '\\$1');
  return `\\"${escaped}\\":${kind.toUpperCase()}`;
}

/**
 * True when the text already contains a well-formed CHIP header
 * (`CHIP <name>`), which is the precondition for setacf being able to
 * address that section by value.
 */
export function hasChipSection(text) {
  return /^[ \t]*CHIP[ \t]+[^\s;\\"]+[ \t]*$/m.test(text);
}

/** Read the first CHIP section's name, if any. */
export function readChipName(text) {
  const m = text.match(/^[ \t]*CHIP[ \t]+([^\s;\\"]+)[ \t]*$/m);
  return m ? m[1] : null;
}

/**
 * Static validation of an .acf.
 *
 * The first check exists because of a real, reproducible failure: invoking
 * `setacf -sCHIP` when no CHIP section exists yet makes setacf create a header
 * with no section value, emitting a bare `CHIP ` line. MAX+PLUS II then refuses
 * to compile:
 *
 *   Error: File ...acf: Line 568: Missing identifier after section keyword "CHIP"
 *   ACF contains syntax errors.
 *
 * An empty CHIP header is therefore a hard, compile-blocking defect, and
 * because setacf is append-only there is no way to repair it with setacf.
 */
export function validateAcf(text, { expectedProjectName = null } = {}) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // A CHIP header must be exactly "CHIP <value>" or a bare "CHIP" that is
    // immediately followed by BEGIN (which MAX+PLUS II accepts as zero-valued).
    const m = line.match(/^[ \t]*CHIP[ \t]*([^\s;]*)[ \t]*$/);
    if (!m) return;
    const value = m[1];
    if (value === '') return; // "CHIP" + BEGIN is tolerated by the compiler

    if (/[\\"]/.test(value)) {
      problems.push({
        line: i + 1,
        severity: 'error',
        code: 'escaped-chip-name',
        message: `CHIP section value contains shell escaping: ${value}`,
        hint: 'setacf stored a cmd-escaped variable verbatim. Repair the header to a bare chip name.',
      });
    }
  });

  // Bare "CHIP " followed by BEGIN with no identifier is the setacf-created
  // defect. It matches the same expression as above with an empty capture.
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*CHIP[ \t]{1,}$/.test(lines[i])) continue;
    problems.push({
      line: i + 1,
      severity: 'error',
      code: 'empty-chip-header',
      message: 'CHIP header has no identifier (trailing whitespace only)',
      raw: lines[i],
      hint: expectedProjectName
        ? `setacf created this. Repair with acf_repair_chip_headers (suggested name: "${expectedProjectName}").`
        : 'setacf created this. Repair with acf_repair_chip_headers.',
    });
  }

  // Unbalanced BEGIN/END.
  let depth = 0;
  lines.forEach((line, i) => {
    if (/^[ \t]*BEGIN[ \t]*$/.test(line)) depth++;
    else if (/^[ \t]*END[ \t]*;/.test(line)) {
      depth--;
      if (depth < 0) {
        problems.push({
          line: i + 1, severity: 'error', code: 'unbalanced-end',
          message: 'END; without a matching BEGIN',
        });
        depth = 0;
      }
    }
  });
  if (depth !== 0) {
    problems.push({
      line: null, severity: 'error', code: 'unterminated-section',
      message: `${depth} BEGIN block(s) never closed with END;`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Rewrite malformed CHIP headers into canonical form.
 * Only touches the header line; entry lines are left untouched.
 */
export function repairChipHeaders(text, chipName) {
  const lines = text.split(/\r?\n/);
  const repairs = [];
  for (let i = 0; i < lines.length; i++) {
    const bare = /^([ \t]*)CHIP[ \t]+$/.exec(lines[i]);
    if (bare) {
      repairs.push({ line: i + 1, before: lines[i], after: `${bare[1]}CHIP ${chipName}` });
      lines[i] = `${bare[1]}CHIP ${chipName}`;
      continue;
    }
    const escaped = /^([ \t]*)CHIP[ \t]+([^\s;]*)[ \t]*$/.exec(lines[i]);
    if (escaped && /[\\"]/.test(escaped[2])) {
      repairs.push({ line: i + 1, before: lines[i], after: `${escaped[1]}CHIP ${chipName}` });
      lines[i] = `${escaped[1]}CHIP ${chipName}`;
    }
  }
  return { text: lines.join('\n'), repairs };
}
