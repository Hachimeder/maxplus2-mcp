/**
 * MAX+PLUS II report / message parsers.
 *
 * Verified against real MAX+PLUS II 10.2 output. Reports are free-form text
 * with no documented machine interface, so this is a deliberately conservative
 * line classifier: it never invents structure, it only labels lines that carry
 * an explicit severity prefix.
 */

// Severity prefixes observed in real reports:
//   "Info: Chip 'sram' in device 'EP1K10TC100-1' has ..."
//   "INFO: Signal 'CLK' chosen for auto global Clock"
//   "Error: ..." / "Warning: ..." / "Critical Warning: ..."
const RE_SEVERITY = /^[\s>]*((?:Critical\s+)?(?:Error|Warning|Info))[\s]*[:：][\s]*(.*)$/i;

// MAX+PLUS II has no exit-code contract, but the report carries explicit
// banners. These are the real success/failure markers, verified against
// MAX+PLUS II 10.2 report output:
//   "***** Project compilation was successful"
//   "***** Logic for device 'top' compiled without errors."
//   (failures print an "_errors" variant)
const RE_BANNER = /^\s*\*{3,}\s*(.*?)\s*$/;
const RE_WITHOUT_ERRORS = /compiled without errors/i;
const RE_WITH_ERRORS = /compiled with (?:\d+\s+)?errors?/i;

const RE_DEVICE_LINE = /^\s*Device\s*:\s*([A-Za-z0-9-]+)\s*$/;
const RE_CHIP_DEVICE = /CHIP\s+"?([^"\s]+)"?\s+ASSIGNED\s+TO\s+AN?\s+([A-Za-z0-9-]+)/i;
const RE_DEVICE_ASSIGN = /DEVICE\s*=\s*([A-Za-z0-9-]+)\s*;/i;
const RE_HEADER_FIELD = /^\s*(Compiled|Version)\s*:\s*(.+?)\s*$/i;

/**
 * Classify a single report line.
 * Returns null when the line carries no recognisable severity.
 */
export function classifyLine(line) {
  const m = line.match(RE_SEVERITY);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, ' ');
  const severity =
    raw === 'critical error' ? 'error'
    : raw === 'critical warning' ? 'warning'
    : raw;
  return { severity, message: m[2].trim() };
}

/**
 * Parse .rpt / .msg / .log style text.
 *
 * `clean` is derived from the success banners where available, because those
 * are what the tool itself asserts; severity-prefixed lines are counted
 * separately and never used to overwrite a positive banner.
 */
export function parseReport(text, { maxDiagnostics = 200 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const diagnostics = [];
  const banners = [];
  const counts = { error: 0, warning: 0, info: 0 };
  let totalDiagnostics = 0;
  let device = null;
  let chip = null;
  let compiled = null;
  let version = null;
  let successBanner = false;
  let failureBanner = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cls = classifyLine(line);
    if (cls) {
      totalDiagnostics++;
      counts[cls.severity] = (counts[cls.severity] ?? 0) + 1;
      if (diagnostics.length < maxDiagnostics) {
        diagnostics.push({ ...cls, line: i + 1, text: line.trim() });
      }
      continue;
    }

    const banner = line.match(RE_BANNER);
    if (banner) {
      const body = banner[1];
      banners.push({ line: i + 1, text: body });
      if (RE_WITHOUT_ERRORS.test(body) || /(?:compilation|simulation) was successful/i.test(body)) successBanner = true;
      if (RE_WITH_ERRORS.test(body) || /(?:compilation|simulation) was unsuccessful/i.test(body)) failureBanner = true;
      continue;
    }

    const dl = line.match(RE_DEVICE_LINE);
    if (dl && !device) {
      device = dl[1];
      continue;
    }

    const cd = line.match(RE_CHIP_DEVICE);
    if (cd) {
      if (!chip) chip = cd[1];
      if (!device) device = cd[2];
      continue;
    }

    if (!device) {
      const da = line.match(RE_DEVICE_ASSIGN);
      if (da) device = da[1];
    }

    const hf = line.match(RE_HEADER_FIELD);
    if (hf) {
      const key = hf[1].toLowerCase();
      if (key === 'compiled') compiled = hf[2];
      if (key === 'version') version = hf[2];
    }
  }

  const clean = !failureBanner && counts.error === 0;

  return {
    device,
    chip,
    version,
    compiled,
    counts,
    clean,
    status: !clean ? 'failed' : successBanner ? 'successful' : 'unknown',
    successBanner,
    failureBanner,
    banners: banners.slice(0, 20),
    diagnostics,
    truncated: totalDiagnostics > diagnostics.length,
    totalDiagnostics,
    lineCount: lines.length,
  };
}

/**
 * Parse a .pin file: "CHIP "x" ASSIGNED TO AN EP1K10TC100-1" plus
 * "NAME : pinno" lines.
 */
export function parsePinFile(text) {
  const pins = [];
  let chip = null;
  let device = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const cd = raw.match(RE_CHIP_DEVICE);
    if (cd) {
      chip = cd[1];
      device = cd[2];
      continue;
    }
    const p = raw.match(/^\s*([A-Za-z0-9_\[\]|.\\]+)\s*:\s*(\d+)\s*$/);
    if (p) pins.push({ name: p[1], pin: Number(p[2]) });
  }
  return { chip, device, pins };
}

/**
 * Parse a .summary file (key : value pairs).
 */
export function parseSummary(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
