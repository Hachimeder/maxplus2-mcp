#!/usr/bin/env node
/**
 * maxplus2-mcp
 *
 * An MCP (Model Context Protocol) server for Altera MAX+PLUS II.
 *
 * Why this exists: MAX+PLUS II ships a usable command-line interface
 * (maxplus2.exe + setacf.exe) but has no MCP server anywhere in the
 * ecosystem. This wraps the verified CLI surface so an agent can drive a
 * MAX+PLUS II project without clicking through a 2002-era GUI.
 *
 * Design constraints, learned from the shipped binaries:
 *   - The GUI is 32-bit Win32 and may block on modal dialogs, so every child
 *     process has a hard timeout and interactive mode is never entered
 *     implicitly.
 *   - No structured output exists. Compile results are free-form .rpt text
 *     with no documented exit codes, so "success" is derived from artifacts
 *     plus report classification, and always reported as evidence, not truth.
 *   - setacf edits .acf in place with no dry-run mode, so every mutating tool
 *     is preview-first and backs the file up before touching it.
 *
 * Transport: MCP over stdio, newline-delimited JSON-RPC 2.0.
 * Zero runtime dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseAcf, findSections, readAssignments,
  buildSetacfArgs, buildPinVariable, normalizeSignalName, cmdQuoteVariable,
  validateAcf, repairChipHeaders, hasChipSection, readChipName,
} from './lib/acf.mjs';
import {
  detectInstall, readIni, buildMaxplus2Args, buildProbeArgs, runProcess,
  findProjects, backupFile, fileInfo, collectArtifacts,
  simulateAndCollect, CAPABILITY,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './lib/runtime.mjs';
import { parseReport, parsePinFile, parseSummary } from './lib/report.mjs';
import { parseTbl, tblTrace, checkTrace, stimulusCoverage } from './lib/tbl.mjs';
import { readGdf, compareGdf, scanTextRecords } from './lib/gdf.mjs';
import { authoringTools } from './lib/authoring-tools.mjs';
import { parsingTools } from './lib/parsing-tools.mjs';
import { gdfTools } from './lib/gdf-tools.mjs';
import { gdfConstructionTools } from './lib/gdf-construction-tools.mjs';
import { extendedFileTools } from './lib/extended-file-tools.mjs';
import { advancedFileTools } from './lib/advanced-file-tools.mjs';
import { practiceFileTools } from './lib/practice-file-tools.mjs';
import { validateArguments } from './lib/validation.mjs';
import { MCP_IMAGES } from './lib/desktop-result.mjs';
import { closeDesktopControllers } from './lib/desktop.mjs';
import { fileDigest,writablePath,isBackupPath } from './lib/workspace.mjs';
import {compileCachePlan,invalidateCompileCache} from './lib/compile-cache.mjs';

const SERVER_NAME = 'maxplus2-mcp';
const SERVER_VERSION = '0.10.1';

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/**
 * Server-level instructions: cross-tool ordering, the workflow, and the limits a
 * caller must know before it trusts a result. Per MCP guidance these improve
 * agent behaviour but never replace runtime validation.
 */
const SERVER_INSTRUCTIONS = [
  'Operates MAX+PLUS II (10.x) through file tools, original CLI and an MCP-owned Windows GUI backend.',
  '',
  'Workflow: installation_status -> probe_executable -> list_projects -> project_inspect',
  '-> acf_validate -> setacf_plan -> setacf_apply -> maxplus2_plan -> maxplus2_run',
  '-> simulate_and_verify -> parse_report.',
  '',
  'Rules the tools enforce rather than assume:',
  '- File mutations default to preview; apply authorized changes with confirm:true and fresh hashes.',
  '  Existing files are backed up; new files never overwrite. setacf has no dry-run: call *_plan first.',
  '- MAX+PLUS II has no exit-code contract: a SUCCESSFUL simulation can exit 1. Judge a',
  '  compile by artifact changes plus the report success banner, never by the exit code.',
  '- MAX+PLUS II discovers design sources by filename, not from the .acf, so a directory',
  '  holding two projects cross-contaminates. Keep one project per directory.',
  '- Installing END_TIME=0.0ns in SIMULATOR_CONFIGURATION is what lets a generated .vec',
  '  span the run; the 1.0us default rejects any shorter stimulus.',
  '',
  'Long work: a compile or simulation can outrun a client timeout, and a client timeout',
  'is wall-clock — it does NOT stop the child process. Pass async:true to maxplus2_run,',
  'simulate_and_verify, setacf_apply or netlist_export to get a jobId, then poll job_status',
  'and stop it with job_cancel. Prefer this over a long blocking call, because an',
  'abandoned blocking call keeps running with nobody holding the result.',
  '',
  'Authoring: project_create/project_clone -> project_files/project_read_file/project_search',
  '-> project_edit_file/memory_write/stimulus_write -> validate/compile/simulate/verify.',
  'Prefer files: project_parse_file/scf_inspect reads structured design/waveform evidence',
  'without a GUI; netlist_export obtains original-vendor synthesized GDF connectivity in',
  'a scratch copy. scf_edit changes existing scalar input events; scf_create makes new native SCF',
  'without VEC; scf_structure/scf_structure_edit inspect/change names, ordering, groups, radix,',
  'duration and input additions/deletions. Times are ns on a 0.1ns grid. Unknown references are guarded.',
  'Resimulate after changes: previous output/internal traces are stale. Names must match compiled nodes.',
  'GDF: gdf_geometry reads original sheet coordinates, definitions, placements and world pins.',
  'gdf_edit previews/applies existing v6 geometry with a fresh hash and backup. Moving a symbol',
  'does not move wires; verify connectivity by compiling/exporting the edited design.',
  'New schematics: project_create -> gdf_create -> gdf_symbol_library -> gdf_construct.',
  'Construction copies hashed original SYM prototypes, assigns numeric native NET_IDs and stores',
  'friendly instance aliases in hidden DOC records. It supports orthogonal wires, I/O names,',
  'electrical wire/bus member labels and complete modern instance parameter maps. Read geometry',
  'again after writing, then compile and simulate to verify actual behavior. gdf_declarations and',
  'gdf_declarations_edit support evidenced native CONSTANT/PARAM pairs; other legacy forms are guarded.',
  'normalize_net_ids repairs invalid/duplicate IDs using native signed32 identity and I/O/WIRE scopes.',
  'gdf_graphics_edit and gdf_text_edit add/change/delete root graphics and free DOC text.',
  'Native SYM pins already have visible labels. Never add identical DOC text at their anchors.',
  'gdf_pin_labels inspects/cleans exact pin/DOC duplicates in SYM and embedded GDF; optional',
  'right-label alignment separates same-row fixed-font pin names without moving connections.',
  'sym_inspect/sym_create/sym_edit operate standalone original-format symbols; custom names default MACRO_NAME.',
  'gdf_symbol_refresh updates only selected instances from a hashed same-name/same-type SYM.',
  'Practice workflows: gdf_wire_cleanup previews anonymous tail removal with scalar/bit guards.',
  'Use project_clone profile:sources plus explicit includePaths for a clean compile seed.',
  'Use waveform_signals then waveform_results to find gated output events and the ns view window.',
  'Held output data is not a new event while valid is low; hidden TBL columns stay absent.',
  'display_palette_inspect reads stored native roles; original Preview verifies visible colors.',
  'Inspection root offset/limit and childOffset/childLimit are independent; follow nextOffset.',
  'gdf_connections returns unsynthesized scalar nets and explicit bus bitTopology; original',
  'endpoint/overlap/pin/WIRE rules are verified. Parameterized macro widths may remain partial.',
  'gdf_move_connected moves/rotates placements with scalar routing and source partition checks.',
  'gdf_text_format_inspect/edit support explicit latin1/windows-936 and Windows face,size;',
  'stored font metrics must be supplied. Validate glyphs in the original editor.',
  'scf_stimulus_edit generates clocks/repeats/counters and transforms existing input ranges.',
  'scf_compiled_ports, scf_ports_import and scf_from_compiled_create use a fresh scoped .edo',
  'hash to select actual top-level input/output observations; simulate to calculate outputs.',
  'Pin/interface/contact changes require explicit flags and original compiler verification; wires do not reroute.',
  'Automatic routing and complete source-only connectivity inference are not implemented.',
  'maxplus2_run compile:true defaults to rebuild:true: back up and remove the matching top and numbered hierarchy',
  'CNF cache when a supported source exists, preventing stale logic after rapid edits.',
  'File previews are automatic unless confirm:true is passed. Existing file edits require',
  'the SHA-256 from a fresh read and preserve recoverable backups. Authorization already',
  'given by the user is sufficient; confirm:true is a technical argument, not a new prompt.',
  'GUI-only operations: desktop_status -> desktop_windows -> desktop_observe ->',
  'desktop_action (one action) -> inspect returned state -> repeat. All native GUI tools',
  'return results directly through standard MCP; no agent-specific host calls. Each action consumes',
  'its observationId and immediately refreshes screenshots/focus. Reobserve after errors.',
  'The independent Win32/UI Automation backend is owned by this MCP server; see',
  'maxplus2://guide. Windows with an unlocked interactive desktop and the installed toolchain',
  'is required. Cached operationId results prevent repeated input after client retries.',
  'Prefer decoded file tools for graphical schematic/waveform/symbol changes; use editors for remaining properties.',
  'desktop_observe includes paginated native menus; invoke_menu accepts a fresh enabled leaf menu_index.',
  'Programmer operations additionally require the physical cable/device and valid license.',
].join('\n');

// ---------------------------------------------------------------------------
// Result budget
// ---------------------------------------------------------------------------

/**
 * Client-side caps on a single tool result are real and silent: Claude Code warns
 * past ~10k tokens and truncates at 25k, Codex CLI caps at 10k, Gemini CLI trims
 * at 40k characters. A server that ignores this produces results the model never
 * sees in full, with no indication anything was lost.
 *
 * So every result is measured and, if oversized, replaced by a bounded summary
 * that says explicitly what was dropped and how to get it. Truncation is marked,
 * never silent — that is the difference between a partial answer and a wrong one.
 */
const MAX_RESULT_CHARS = 48_000; // ~12k tokens, inside every client cap above

function boundResult(toolName, data) {
  let json;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: result for ${toolName} was not serialisable: ${err?.message ?? err}` }],
      isError: true,
    };
  }
  if (json.length <= MAX_RESULT_CHARS) {
    return {
      content: [{ type: 'text', text: json }, ...(data?.[MCP_IMAGES] ?? [])],
      structuredContent: data,
      isError: false,
    };
  }

  // Too large: keep the shape, drop the bulk, and say what happened.
  const summary = {
    truncated: true,
    tool: toolName,
    returnedChars: json.length,
    limitChars: MAX_RESULT_CHARS,
    note: `Result exceeded the ${MAX_RESULT_CHARS}-character budget (about 12k tokens, inside every known client cap) and was reduced. Narrow the request — add a section filter, lower maxDiagnostics, or pass a smaller project — rather than assuming the omitted part was empty.`,
    keptKeys: Object.keys(data ?? {}),
    preview: {},
  };
  // Keep small keys whole; report the size of large ones instead of inlining them.
  for (const [k, v] of Object.entries(data ?? {})) {
    const vJson = JSON.stringify(v);
    if (vJson === undefined) continue;
    if (vJson.length <= 4_000) summary.preview[k] = v;
    else summary.preview[k] = { omitted: true, chars: vJson.length, type: Array.isArray(v) ? 'array' : typeof v };
  }
  const text = JSON.stringify(summary);
  return {
    content: [{ type: 'text', text: text.length <= MAX_RESULT_CHARS ? text : JSON.stringify({ ...summary, preview: {} }) }, ...(data?.[MCP_IMAGES] ?? [])],
    structuredContent: summary,
    isError: false,
  };
}

const DEFAULT_WORKSPACE = process.env.MAXPLUS2_WORKSPACE
  ?? process.cwd();

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve a project given as an absolute .acf path, or a name under the workspace. */
function resolveAcf(input, workspace) {
  if (!input) throw new Error('project is required');
  const candidates = [];

  if (path.isAbsolute(input)) {
    candidates.push(input);
  } else {
    const ws = workspace ?? DEFAULT_WORKSPACE;
    candidates.push(path.join(ws, input));
    candidates.push(path.join(ws, `${input}.acf`));
  }
  if (!path.extname(input) && path.isAbsolute(input)) candidates.push(`${input}.acf`);

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  }
  // Last resort: recursive search under the workspace for a matching basename.
  const ws = workspace ?? DEFAULT_WORKSPACE;
  if (fs.existsSync(ws)) {
    const want = path.basename(input).toLowerCase();
    const wantWithExt = want.endsWith('.acf') ? want : `${want}.acf`;
    const hits = findProjects(ws).filter(
      (p) => path.basename(p).toLowerCase() === wantWithExt,
    );
    if (hits.length === 1) return path.resolve(hits[0]);
    if (hits.length > 1) {
      throw new Error(
        `project "${input}" is ambiguous; ${hits.length} matches under ${ws}:\n`
        + hits.map((h) => `  ${h}`).join('\n'),
      );
    }
  }
  throw new Error(`project not found: ${input}`);
}

/** Project name = .acf basename without extension. */
function projectNameOf(acfPath) {
  return path.basename(acfPath, path.extname(acfPath));
}

function readText(p) {
  return fs.readFileSync(p, 'latin1');
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolInstallationStatus(args) {
  const root = args?.root ?? null;
  const info = detectInstall(root);
  if (!info) {
    return {
      found: false,
      searched: {
        explicit: root,
        envMaxplus2Root: process.env.MAXPLUS2_ROOT ?? null,
        platform: process.platform,
      },
      hint: 'Set MAXPLUS2_ROOT or pass { root: "E:\\\\maxplus3" }. On non-Windows hosts MAX+PLUS II cannot run.',
    };
  }

  const ini = readIni(info.root);
  const exeInfo = fileInfo(info.executable);
  const setacfInfo = info.setacf ? fileInfo(info.setacf) : { exists: false };

  return {
    found: true,
    root: info.root,
    executable: info.executable,
    executableInfo: exeInfo,
    setacf: info.setacf,
    setacfInfo,
    ini: info.ini,
    iniSystem: ini.SYSTEM ?? null,
    licensing: ini.Licensing ?? null,
    families: info.families,
    additionalTools: Object.keys(info.tools),
    workspace: DEFAULT_WORKSPACE,
    defaultToolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    // What this specific binary actually accepts, measured rather than assumed.
    cliCapability: CAPABILITY,
  };
}

function toolListProjects(args) {
  const root = args?.root ?? DEFAULT_WORKSPACE;
  if (!fs.existsSync(root)) throw new Error(`root does not exist: ${root}`);
  const projects = findProjects(root, {
    maxDepth: args?.maxDepth ?? 6,
    limit: args?.limit ?? 500,
  });
  return {
    root,
    count: projects.length,
    projects: projects.map((p) => ({
      name: projectNameOf(p),
      acf: p,
      artifacts: Object.keys(collectArtifacts(p)).sort(),
    })),
  };
}

function toolProjectInspect(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const text = readText(acfPath);
  const parsed = parseAcf(text);
  const { chipSections } = readAssignments(parsed);

  const name = projectNameOf(acfPath);
  const artifacts = collectArtifacts(acfPath);

  const sections = {};
  const autoDevices = [];
  for (const s of parsed.sections) {
    sections[s.name] = (sections[s.name] ?? 0) + 1;
    if (s.name.toUpperCase() === 'DEFAULT_DEVICES') {
      for (const e of s.entries) {
        if (e.key.toUpperCase() === 'AUTO_DEVICE') autoDevices.push(e.value);
      }
    }
  }

  const report = artifacts['.rpt'] ? parseReport(readText(artifacts['.rpt'])) : null;

  return {
    project: name,
    acf: acfPath,
    directory: path.dirname(acfPath),
    sectionCount: parsed.sections.length,
    sections,
    chips: chipSections.map((c) => ({
      chip: c.chip,
      device: c.device,
      pinCount: c.pins.length,
    })),
    device: chipSections.find((c) => c.device)?.device ?? null,
    autoDevices,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([ext, p]) => [ext, { path: p, ...fileInfo(p) }]),
    ),
    report: report
      ? { clean: report.clean, counts: report.counts, device: report.device, statuses: report.statuses }
      : null,
  };
}

function toolAcfSections(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const parsed = parseAcf(readText(acfPath));
  const filter = args?.section ? String(args.section).toUpperCase() : null;
  const sections = parsed.sections
    .filter((s) => !filter || s.name.toUpperCase() === filter)
    .map((s) => ({
      name: s.name,
      value: s.value,
      headerLine: s.headerLine,
      endLine: s.endLine,
      unterminated: Boolean(s.unterminated),
      entryCount: s.entries.length,
      entries: args?.includeEntries === false
        ? undefined
        : s.entries.map((e) => ({ key: e.key, value: e.value, line: e.line })),
    }));
  return { acf: acfPath, totalSections: parsed.sections.length, returned: sections.length, sections };
}

function toolAcfPins(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const parsed = parseAcf(readText(acfPath));
  const { chipSections } = readAssignments(parsed);
  const pinArtifact = collectArtifacts(acfPath)['.pin'];

  const assigned = chipSections.flatMap((c) =>
    c.pins.map((p) => ({ chip: c.chip, ...p })),
  );

  // Cross-check against the compiler-generated .pin report when present.
  let verification = null;
  if (pinArtifact && fs.existsSync(pinArtifact)) {
    const actual = parsePinFile(readText(pinArtifact));
    const actualByPin = new Map(actual.pins.map((p) => [p.name.toUpperCase(), p.pin]));
    const mismatches = [];
    for (const a of assigned) {
      const key = a.signal.replace(/^[|\\"]+|["\\]+$/g, '').toUpperCase();
      const real = actualByPin.get(key);
      if (real !== undefined && real !== Number(a.pin)) {
        mismatches.push({ signal: a.signal, acfPin: Number(a.pin), actualPin: real });
      }
    }
    verification = {
      pinReport: pinArtifact,
      device: actual.device,
      pinsInReport: actual.pins.length,
      mismatches,
      consistent: mismatches.length === 0,
    };
  }

  return {
    acf: acfPath,
    chips: chipSections.map((c) => ({ chip: c.chip, device: c.device })),
    assignedPins: assigned.length,
    pins: assigned,
    verification,
  };
}

function toolSetacfPlan(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const built = buildSetacfArgsFor(args, acfPath);
  const { argv, bootstrap } = built;
  const info = detectInstall(args?.root);
  const isPin = ['INPUT_PIN', 'OUTPUT_PIN', 'BIDIR_PIN'].includes(String(args?.kind ?? '').toUpperCase());
  return {
    acf: acfPath,
    acfInfo: fileInfo(acfPath),
    setacfExe: info?.setacf ?? null,
    available: Boolean(info?.setacf),
    argv,
    section: built.effectiveSection,
    sectionValue: built.effectiveSectionValue,
    bootstrap,
    // The exact vector handed to spawn (no shell involved).
    execCommandLine: info?.setacf ? `${info.setacf} ${argv.map(quoteForDisplay).join(' ')}` : null,
    // A cmd.exe-safe rendering for manual reproduction. Only meaningful for
    // signal variables, which contain characters cmd.exe would otherwise eat.
    cmdCommandLine: info?.setacf ? commandLineForCmd(info.setacf, argv) : null,
    destructive: true,
    grammarNote: isPin
      ? 'setacf writes the variable VERBATIM into the .acf. The raw form "|SIG :\tKIND" is correct because this server spawns without a shell. Backslash-quoting is cmd.exe escaping only; do not pass it to a shell-free spawn.'
      : null,
    note: 'setacf edits the .acf in place and has no dry-run mode. Use setacf_apply to execute; it backs the file up and reports a diff.',
  };
}

function buildSetacfArgsFor(args, acfPath) {
  const kind = (args?.kind ?? '').toUpperCase();
  const isPin = ['INPUT_PIN', 'OUTPUT_PIN', 'BIDIR_PIN'].includes(kind);
  const isDevice = Boolean(args?.device);

  const opts = {
    acfFile: acfPath,
    create: Boolean(args?.create),
    section: args?.section ?? null,
    sectionValue: args?.sectionValue ?? null,
    modifyTo: args?.modifyTo,
    deleteVariable: args?.deleteVariable ?? null,
    prependPath: args?.prependPath ?? null,
  };

  if (isPin) {
    if (!args?.signal) throw new Error('signal is required when kind is a *_PIN');
    opts.variable = buildPinVariable(args.signal, kind);
    opts.value = String(args.pin);
  } else if (isDevice) {
    opts.variable = 'DEVICE';
    opts.value = String(args.device);
  } else if (args?.variable) {
    opts.variable = args.variable;
    opts.value = args?.value !== undefined ? String(args.value) : undefined;
  } else {
    throw new Error('nothing to do: supply {kind,signal,pin}, {device}, {modifyTo}, {deleteVariable}, or {variable,value}');
  }

  // Default to the project's CHIP section when setting a device/pin.
  if ((isPin || isDevice) && !opts.section) {
    opts.section = 'CHIP';
  }

  // Bootstrap guard. setacf cannot set a section VALUE on a section that does
  // not exist yet: with only `-sCHIP` it creates a bare "CHIP " header, which
  // MAX+PLUS II rejects at compile time with
  //   "Missing identifier after section keyword \"CHIP\"".
  // So when we are writing into CHIP, the section must already carry a name.
  // If it does, reuse the existing name; if it does not, supply the project
  // name, which is the convention every real MAX+PLUS II project follows.
  let bootstrap = null;
  if ((isPin || isDevice) && opts.section.toUpperCase() === 'CHIP') {
    let text;
    try { text = fs.readFileSync(acfPath, 'latin1'); } catch { text = ''; }
    const existing = readChipName(text);
    const hasSection = hasChipSection(text);

    if (!hasSection && !opts.sectionValue) {
      opts.sectionValue = projectNameOf(acfPath);
      bootstrap = {
        applied: true,
        reason: 'no well-formed CHIP section found, so the project name was used as the section value',
        chipName: opts.sectionValue,
      };
    } else if (existing) {
      bootstrap = { applied: false, existingChip: existing };
    }
  }

  const argv = buildSetacfArgs(opts);
  return { argv, bootstrap, effectiveSection: opts.section, effectiveSectionValue: opts.sectionValue ?? null };
}

function quoteForDisplay(a) {
  return /[\s"]/.test(a) ? `"${a}"` : a;
}

/**
 * Render a command line that a human can paste into cmd.exe.
 *
 * This is NOT what the server passes to spawn — the server always spawns
 * without a shell. setacf copies its variable argument verbatim into the .acf,
 * so a shell-safe rendering has to quote/escape differently from the raw argv.
 * Keeping the two separate is the whole reason setacf pin assignments are easy
 * to get wrong.
 */
function commandLineForCmd(exe, argv) {
  const quoted = argv.map((a) => {
    if (/[|"&<>^]/.test(a)) {
      // cmd.exe: escape the metacharacters, then wrap in quotes.
      return `"${a.replace(/([|"&<>^])/g, '\\$1')}"`;
    }
    return /[\s]/.test(a) ? `"${a}"` : a;
  });
  return `"${exe}" ${quoted.join(' ')}`;
}

async function toolSetacfApply(args) {
  if (args?.confirm !== true) {
    throw new Error('refusing to modify the .acf: pass { "confirm": true } after reviewing setacf_plan');
  }
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const info = detectInstall(args?.root);
  if (!info?.setacf) throw new Error('setacf.exe not found; run installation_status');

  const before = readText(acfPath);
  const built = buildSetacfArgsFor(args, acfPath);
  const { argv, bootstrap } = built;

  // Back up before any mutation. setacf has no dry-run and no undo.
  const backup = args?.backup === false ? null : backupFile(acfPath);

  const result = await runProcess(info.setacf, argv, {
    cwd: path.dirname(acfPath),
    timeoutMs: args?.timeoutMs ?? 120_000,
    ...jobTracker(args),
  });

  const after = readText(acfPath);
  const changed = before !== after;
  const validation = validateAcf(after, { expectedProjectName: projectNameOf(acfPath) });

  return {
    acf: acfPath,
    backup,
    argv,
    bootstrap,
    section: built.effectiveSection,
    sectionValue: built.effectiveSectionValue,
    execCommandLine: `${info.setacf} ${argv.map(quoteForDisplay).join(' ')}`,
    cmdCommandLine: commandLineForCmd(info.setacf, argv),
    ok: result.ok,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
    changed,
    diff: changed ? diffLines(before, after) : null,
    validation: {
      ok: validation.ok,
      problems: validation.problems,
      note: validation.ok
        ? 'ACF passes static validation. Compile to confirm.'
        : 'ACF has compile-blocking problems. Repair before compiling.',
    },
    warning: result.ok && !changed
      ? 'setacf exited 0 but the .acf did not change. Verify the section name/value filter matches an existing section (this is the -f/-s grammar difference that changed across MAX+PLUS II versions).'
      : (validation.ok ? null : 'setacf wrote an ACF that fails static validation; see validation.problems.'),
  };
}

/** Compact line diff, bounded. */
function diffLines(before, after, max = 40) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Map();
  a.forEach((l, i) => setA.set(l, i));
  const setB = new Map();
  b.forEach((l, i) => setB.set(l, i));

  const removed = [];
  const added = [];
  for (const [l, i] of setA) if (!setB.has(l)) removed.push({ line: i + 1, text: l });
  for (const [l, i] of setB) if (!setA.has(l)) added.push({ line: i + 1, text: l });

  return {
    removedCount: removed.length,
    addedCount: added.length,
    removed: removed.slice(0, max),
    added: added.slice(0, max),
    truncated: removed.length > max || added.length > max,
  };
}

function toolMaxplus2Plan(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const info = detectInstall(args?.root);
  const argv = buildMaxplus2Args({
    projectName: projectNameOf(acfPath),
    compile: Boolean(args?.compile),
    simulate: Boolean(args?.simulate),
    convert: Boolean(args?.convert),
    taDelay: Boolean(args?.taDelay),
    taSetup: Boolean(args?.taSetup),
    taReg: Boolean(args?.taReg),
    ignoreErrors: Boolean(args?.ignoreErrors),
    timingAnalyzerOutput: args?.timingAnalyzerOutput,
    simScf: args?.simScf,
    simVec: args?.simVec,
    simCmd: args?.simCmd,
    simTbl: args?.simTbl,
    simHst: args?.simHst,
    outHex: args?.outHex, outJam: args?.outJam, outJ11: args?.outJ11,
    outJbc: args?.outJbc, outJb1: args?.outJb1, outPof: args?.outPof,
    outRbf: args?.outRbf, outSbf: args?.outSbf, outSvf: args?.outSvf,
    outTtf: args?.outTtf,
  });
  const artifactExtensions = {
    outHex: '-hex', outJam: '-jam', outJ11: '-j11', outJbc: '-jbc', outJb1: '-jb1',
    outPof: '-pof', outRbf: '-rbf', outSbf: '-sbf', outSvf: '-svf', outTtf: '-ttf',
    simVec: '-vec', simCmd: '-cmd',
  };
  const unsupportedRequested = Object.entries(artifactExtensions)
    .filter(([key]) => args?.[key])
    .map(([, flag]) => flag)
    .filter((flag) => !CAPABILITY.accepted.includes(flag));

  return {
    project: projectNameOf(acfPath),
    acf: acfPath,
    cwd: args?.cwd ?? path.dirname(acfPath),
    executable: info?.executable ?? null,
    available: Boolean(info?.executable),
    argv,
    commandLine: info?.executable
      ? `"${info.executable}" ${argv.map(quoteForDisplay).join(' ')}`
      : null,
    capabilityWarning: unsupportedRequested.length
      ? `This build rejects ${unsupportedRequested.join(', ')} (measured, not assumed). Compiling still writes <project>.pof/.rpt/.pin for free, so drop those flags.`
      : null,
    compilerCache:args?.compile?compileCachePlan(acfPath,{enabled:args.rebuild!==false}):null,
    note: 'MAX+PLUS II writes no documented exit code. Treat run_maxplus2.artifacts + report.parse_rpt as the evidence of success, not the exit code alone.',
  };
}

async function toolMaxplus2Run(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const info = detectInstall(args?.root);
  if (!info?.executable) throw new Error('maxplus2.exe not found; run installation_status');

  const dir = path.dirname(acfPath);
  const name = projectNameOf(acfPath);
  const beforeArtifacts = collectArtifacts(acfPath);
  const beforeInfo = Object.fromEntries(Object.entries(beforeArtifacts).map(([ext,p]) => [ext, { ...fileInfo(p), ...fileDigest(p) }]));
  if (args?.cwd && fs.realpathSync(args.cwd) !== fs.realpathSync(dir)) throw new Error('cwd must be the project directory; clone the project to run elsewhere');

  const argv = buildMaxplus2Args({
    projectName: name,
    compile: Boolean(args?.compile),
    simulate: Boolean(args?.simulate),
    convert: Boolean(args?.convert),
    taDelay: Boolean(args?.taDelay),
    taSetup: Boolean(args?.taSetup),
    taReg: Boolean(args?.taReg),
    ignoreErrors: Boolean(args?.ignoreErrors),
    timingAnalyzerOutput: args?.timingAnalyzerOutput,
    simScf: args?.simScf,
    simVec: args?.simVec,
    simCmd: args?.simCmd,
    simTbl: args?.simTbl,
    simHst: args?.simHst,
    outHex: args?.outHex, outJam: args?.outJam, outJ11: args?.outJ11,
    outJbc: args?.outJbc, outJb1: args?.outJb1, outPof: args?.outPof,
    outRbf: args?.outRbf, outSbf: args?.outSbf, outSvf: args?.outSvf,
    outTtf: args?.outTtf,
  });

  const compilerCache=args?.compile?invalidateCompileCache(acfPath,{enabled:args.rebuild!==false}):null;
  const result = await runProcess(info.executable, argv, {
    cwd: args?.cwd ?? dir,
    timeoutMs: args?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    ...jobTracker(args),
  });

  const afterArtifacts = collectArtifacts(acfPath);
  const created = [];
  const updated = [];
  for (const [ext, p] of Object.entries(afterArtifacts)) {
    const prev = beforeArtifacts[ext];
    if (!prev) created.push({ ext, path: p, ...fileInfo(p) });
    else {
      const a = beforeInfo[ext];
      const b = { ...fileInfo(p), ...fileDigest(p) };
      if (a.mtime !== b.mtime || a.sha256 !== b.sha256) updated.push({ ext, path: p, ...b });
    }
  }

  const rpt = afterArtifacts['.rpt'] ? parseReport(readText(afterArtifacts['.rpt'])) : null;
  const freshExtensions = new Set([...created,...updated].map(a => a.ext));

  const artifactFlags = {
    outHex: '-hex', outJam: '-jam', outJ11: '-j11', outJbc: '-jbc', outJb1: '-jb1',
    outPof: '-pof', outRbf: '-rbf', outSbf: '-sbf', outSvf: '-svf', outTtf: '-ttf',
    simVec: '-vec', simCmd: '-cmd',
  };
  const unsupportedRequested = Object.entries(artifactFlags)
    .filter(([key]) => args?.[key])
    .map(([, flag]) => flag)
    .filter((flag) => !CAPABILITY.accepted.includes(flag));

  return {
    project: name,
    cwd: args?.cwd ?? dir,
    argv,
    exitCode: result.code,
    ok: result.ok,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutTail: tail(result.stdout, 3000),
    stderrTail: tail(result.stderr, 3000),
    artifactsCreated: created,
    artifactsUpdated: updated,
    compilerCache,
    unboundedRequested: unsupportedRequested,
    capabilityWarning: unsupportedRequested.length
      ? `This build rejects ${unsupportedRequested.join(', ')}; the invocation likely printed its usage banner instead of compiling. Re-run without those flags — compiling already writes <project>.pof/.rpt/.pin/.snf.`
      : null,
    // The exit code is not a contract here. A successful run can exit non-zero,
    // and a usage-banner failure exits non-zero too, so neither direction is
    // reliable. Report what the process actually printed.
    printedUsageBanner: /Command-Line Mode Usage/.test(result.stdout),
    report: rpt
      ? {
        fresh: freshExtensions.has('.rpt'),
        clean: rpt.clean,
        counts: rpt.counts,
        device: rpt.device,
        status: rpt.status,
        successBanner: rpt.successBanner,
        diagnostics: rpt.diagnostics.slice(0, 60),
      }
      : null,
    evidence: {
      note: 'Exit code is NOT a documented contract for MAX+PLUS II. Read artifactsCreated/artifactsUpdated and report.counts as the real signal.',
      producedProgrammingFiles: ['pof', 'sof', 'hex', 'ttf', 'jed', 'svf', 'jam', 'jbc', 'rbf', 'sbf']
        .filter((e) => freshExtensions.has(`.${e}`)),
      currentRunStatus: result.timedOut || result.spawnError || /Command-Line Mode Usage/.test(result.stdout)
        ? 'failed' : freshExtensions.has('.rpt') && rpt?.status === 'successful' ? 'successful' : freshExtensions.has('.rpt') && rpt?.status === 'failed' ? 'failed' : 'unknown',
    },
  };
}

function tail(s, n) {
  if (!s) return '';
  return s.length <= n ? s : `…(${s.length - n} bytes truncated)…\n${s.slice(-n)}`;
}

/**
 * Run `maxplus2 -v` (or `-h`). This is the only invocation that is both
 * read-only and project-independent, so it is how we answer the question
 * "does this 2002-era binary actually still start on this host?".
 */
async function toolProbeExecutable(args) {
  const info = detectInstall(args?.root);
  if (!info?.executable) throw new Error('maxplus2.exe not found; run installation_status');

  const argv = buildProbeArgs({ version: args?.mode !== 'help', help: args?.mode === 'help' });
  const result = await runProcess(info.executable, argv, {
    cwd: args?.cwd ?? info.root,
    timeoutMs: args?.timeoutMs ?? 60_000,
    ...jobTracker(args),
  });

  const output = `${result.stdout}${result.stderr}`.trim();

  return {
    executable: info.executable,
    argv,
    launched: result.spawnError === undefined,
    spawnError: result.spawnError ?? null,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail: tail(output, 2000),
    outputBytes: output.length,
    verdict: result.timedOut
      ? 'TIMED OUT: the process started but never returned. Most likely a modal dialog is blocking it. Do not use headless compile loops on this host until this is resolved.'
      : (result.spawnError
        ? `FAILED TO LAUNCH: ${result.spawnError}`
        : (output.length > 0
          ? 'RUNS: produced output. Headless execution is plausible.'
          : 'RAN BUT SILENT: exited with no output. Verify manually before trusting batch runs.')),
  };
}

function toolAcfValidate(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const name = projectNameOf(acfPath);
  const text = readText(acfPath);
  const result = validateAcf(text, { expectedProjectName: name });
  const chip = readChipName(text);
  return {
    acf: acfPath,
    project: name,
    ok: result.ok,
    problems: result.problems,
    chipSection: chip,
    hasWellFormedChipSection: hasChipSection(text),
    note: result.ok
      ? 'No static problems found. This does not prove the design compiles; run maxplus2_run for that.'
      : `Found ${result.problems.length} problem(s). Two of them are created by setacf itself and can be repaired with acf_repair_chip_headers.`,
  };
}

function toolAcfRepairChipHeaders(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const name = projectNameOf(acfPath);
  const text = readText(acfPath);
  const chipName = args?.chipName ?? name;

  const { text: repaired, repairs } = repairChipHeaders(text, chipName);

  const result = {
    acf: acfPath,
    chipName,
    repairsFound: repairs.length,
    repairs,
    changed: repairs.length > 0,
    applied: false,
  };

  if (repairs.length === 0) {
    result.note = 'Nothing to repair: no malformed CHIP header found.';
    return result;
  }
  if (args?.confirm !== true) {
    result.note = 'Preview only. Pass { "confirm": true } to write the repaired ACF. A backup is taken automatically.';
    return result;
  }

  result.backup = args?.backup === false ? null : backupFile(acfPath);
  fs.writeFileSync(acfPath, repaired, 'latin1');
  result.applied = true;

  const after = readText(acfPath);
  const validation = validateAcf(after, { expectedProjectName: name });
  result.validation = { ok: validation.ok, problems: validation.problems };
  result.note = validation.ok
    ? 'Repaired. The ACF now passes static validation; compile to confirm.'
    : 'Repaired the CHIP header, but other problems remain.';
  return result;
}

/**
 * Run a headless simulation and verify the result against expected values.
 *
 * This closes the loop that was previously assumed impossible: the Simulator
 * writes a plain-text result table (.tbl), so outputs can be checked
 * programmatically instead of by a human reading a waveform.
 */
async function toolSimulateAndVerify(args) {
  const acfPath = resolveAcf(args?.project, args?.workspace);
  const info = detectInstall(args?.root);
  if (!info?.executable) throw new Error('maxplus2.exe not found; run installation_status');

  const dir = path.dirname(acfPath);
  const name = projectNameOf(acfPath);

  // Default the stimulus to the project's own .scf, which is what the GUI
  // Simulator would use.
  let scf = args?.scf ?? null;
  if (!scf) {
    const candidate = path.join(dir, `${name}.scf`);
    if (fs.existsSync(candidate)) scf = `${name}.scf`;
  }

  const sim = await simulateAndCollect({
    executable: info.executable,
    projectName: name,
    cwd: dir,
    scf,
    tbl: args?.tbl,
    timeoutMs: args?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    onSpawn: jobTracker(args).onSpawn,
    signal: jobTracker(args).signal,
  });

  const out = { project: name, cwd: dir, stimulus: scf, ...sim };

  if (!sim.tblCreated) {
    out.diagnosis = sim.undrivenNodes.length
      ? `The stimulus does not drive ${sim.undrivenNodes.length} netlist input(s), so the simulator had nothing to tabulate. Regenerate the .scf for this design, or compile first so the netlist matches the stimulus.`
      : 'No result table was produced. Compile the project first (maxplus2_run with compile:true so the .snf exists), then simulate.';
    return out;
  }

  const parsed = parseTbl(readText(sim.tblPath));
  const trace = tblTrace(parsed);
  out.table = {
    unit: parsed.unit,
    radix: parsed.radix,
    inputs: parsed.inputs,
    outputs: parsed.outputs,
    buried: parsed.buried,
    rowCount: parsed.rowCount,
  };
  out.coverage = stimulusCoverage(parsed);
  out.tracePreview = trace.slice(0, args?.previewRows ?? 12);
  out.traceTail = trace.slice(-Math.min(4, trace.length));

  if (args?.expect) {
    out.verification = checkTrace(trace, args.expect, { tolerance: args?.tolerance ?? 0.05 });
    if (sim.verdict !== 'verified' || parsed.problems.length || !trace.length) {
      out.verification.ok = false;
      out.verification.evidenceError = 'The run or result table is not valid evidence; inspect verdict, tableProblems and the simulation diagnostics.';
    }
    out.tableProblems = parsed.problems;
  } else {
    out.verification = {
      ok: null,
      note: 'No expectations supplied. Pass expect: { "<time>": { "<SIGNAL>": value } } to turn this run into an automated check.',
    };
  }
  return out;
}

/** Parse an existing .tbl result table without re-running the simulator. */
function toolParseTbl(args) {
  const p = args?.path
    ? (path.isAbsolute(args.path) ? args.path : path.resolve(args?.workspace ?? DEFAULT_WORKSPACE, args.path))
    : (() => {
      const acfPath = resolveAcf(args?.project, args?.workspace);
      const name = projectNameOf(acfPath);
      const candidate = path.join(path.dirname(acfPath), `${name}.tbl`);
      if (!fs.existsSync(candidate)) {
        throw new Error(`no .tbl next to ${acfPath}; run simulate_and_verify first, or pass { path }`);
      }
      return candidate;
    })();

  if (!fs.existsSync(p)) throw new Error(`table not found: ${p}`);
  const parsed = parseTbl(readText(p));
  const trace = tblTrace(parsed);
  const out = {
    path: p,
    unit: parsed.unit,
    radix: parsed.radix,
    version: parsed.version,
    generatedFrom: parsed.generatedFrom,
    groups: parsed.groups,
    inputs: parsed.inputs,
    outputs: parsed.outputs,
    buried: parsed.buried,
    rowCount: parsed.rowCount,
    coverage: stimulusCoverage(parsed),
    trace: args?.full ? trace : trace.slice(0, args?.limit ?? 40),
    truncated: !args?.full && trace.length > (args?.limit ?? 40),
  };
  if (args?.expect) out.verification = checkTrace(trace, args.expect, { tolerance: args?.tolerance ?? 0.05 });
  return out;
}

function toolParseRpt(args) {  const p = args?.path
    ? (path.isAbsolute(args.path) ? args.path : path.resolve(args?.workspace ?? DEFAULT_WORKSPACE, args.path))
    : (() => {
      const acfPath = resolveAcf(args?.project, args?.workspace);
      const rpt = collectArtifacts(acfPath)['.rpt'];
      if (!rpt) throw new Error(`no .rpt next to ${acfPath}; compile the project first or pass { path }`);
      return rpt;
    })();

  if (!fs.existsSync(p)) throw new Error(`report not found: ${p}`);
  const text = readText(p);

  if (/\.pin$/i.test(p)) {
    const pin = parsePinFile(text);
    return { path: p, kind: 'pin', ...pin };
  }
  if (/\.summary$/i.test(p)) {
    return { path: p, kind: 'summary', values: parseSummary(text) };
  }
  const report = parseReport(text, { maxDiagnostics: args?.maxDiagnostics ?? 200 });
  return { path: p, kind: 'report', ...report };
}

/**
 * Read a Graphic Design File and report the symbols and labels it is drawn from.
 *
 * Capability boundary, enforced rather than documented only: this READS a
 * schematic. Strict geometry is exposed separately; synthesized connectivity
 * cannot be returned and the file cannot be rewritten. The `understood` block in
 * the result says so, and there is no write path to misuse.
 */
function toolGdfInspect(args) {
  const resolve = (input, kind) => {
    if (!input) throw new Error(`${kind} is required`);
    const candidates = path.isAbsolute(input)
      ? [input]
      : [path.resolve(args?.workspace ?? DEFAULT_WORKSPACE, input)];
    if (!path.extname(input)) for (const c of [...candidates]) candidates.push(`${c}.gdf`);
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    }
    throw new Error(`${kind} not found: ${input}`);
  };

  const p = resolve(args?.path, 'path');
  const result = readGdf(fs.readFileSync(p));
  const out = { path: p, ...result };

  if (args?.compareWith) {
    const q = resolve(args.compareWith, 'compareWith');
    out.comparison = { against: q, ...compareGdf(fs.readFileSync(p), fs.readFileSync(q)) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Job registry — for work that outlives a client's patience
// ---------------------------------------------------------------------------

/**
 * The problem this solves, stated precisely: an MCP client timeout is WALL-CLOCK
 * and progress notifications do NOT extend it. A full compile can hold the
 * connection for minutes, and when the client gives up it abandons the request —
 * but the child process keeps running, so the caller loses both the result and
 * control of the machine.
 *
 * The fix is a job handle: start the work, return an id immediately, and let the
 * caller poll. That also makes cancellation possible, which a blocking call cannot
 * offer at all.
 *
 * The handle is threaded through the arguments as a NON-ENUMERABLE property, so it
 * never appears in a schema, a log, or a JSON round trip, and cannot collide with a
 * caller-supplied field.
 */
const JOBS = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
let jobCounter = 0;

function newJobId() {
  jobCounter += 1;
  return `job-${jobCounter}-${Date.now().toString(36)}`;
}

/** Read the handle the dispatcher attached, if any. Called by tools, not clients. */
function jobTracker(args) {
  const job = args?.__job;
  if (!job) return {};
  return {
    onSpawn: (child) => job.track(child),
    signal: job.controller.signal,
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    const ended = job.finishedAt ?? job.startedAt;
    if (now - ended > JOB_TTL_MS && job.status !== 'running') JOBS.delete(id);
  }
}

function startJob(toolName, toolArgs, handler) {
  const id = newJobId();
  const job = {
    id,
    tool: toolName,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    children: new Set(),
    controller: new AbortController(),
    track(child) {
      this.children.add(child);
      if (this.controller.signal.aborted) child.kill();
      child.once('close', () => this.children.delete(child));
    },
    cancel() {
      let killed = 0;
      const live = [...this.children].filter(c=>c.exitCode === null && c.signalCode === null && !c.killed);
      this.controller.abort();
      for (const c of live) {
        // runProcess's AbortSignal listener may already have sent the signal.
        // Count that successful termination request instead of killing twice.
        try { if (c.killed || c.kill()) killed += 1; } catch { /* already gone */ }
      }
      return killed;
    },
  };
  JOBS.set(id, job);

  // The handle is attached to a shallow clone so the caller's object is untouched.
  const patched = Object.create(null);
  for (const [k, v] of Object.entries(toolArgs ?? {})) patched[k] = v;
  Object.defineProperty(patched, '__job', { value: job, enumerable: false });

  job.completion = Promise.resolve()
    .then(() => { if (job.controller.signal.aborted) throw new Error('cancelled before dispatch'); return handler(patched); })
    .then((result) => {
      if (job.status === 'cancelled') return;
      job.status = 'done';
      job.result = result;
    })
    .catch((err) => {
      if (job.status === 'cancelled') return;
      job.status = 'failed';
      job.error = err?.message ?? String(err);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      pruneJobs();
    });

  return job;
}

function toolJobStatus(args) {
  const id = args?.jobId;
  if (!id) throw new Error('jobId is required');
  const job = JOBS.get(id);
  if (!job) {
    throw new Error(`unknown job: ${id}. Jobs are held for ${JOB_TTL_MS / 60000} minutes after they settle, and are lost if the server restarts.`);
  }
  const out = {
    jobId: job.id,
    tool: job.tool,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    runningProcesses: job.children.size,
  };
  if (job.status === 'done') {
    out.finishedAt = new Date(job.finishedAt).toISOString();
    out.result = job.result;
  } else if (job.status === 'failed') {
    out.finishedAt = new Date(job.finishedAt).toISOString();
    out.error = job.error;
  } else {
    out.hint = 'Poll again, or call job_cancel to stop it. The client timeout does not stop this work.';
  }
  return out;
}

async function toolJobCancel(args) {
  const id = args?.jobId;
  if (!id) throw new Error('jobId is required');
  const job = JOBS.get(id);
  if (!job) throw new Error(`unknown job: ${id}`);
  if (job.status !== 'running') {
    return { jobId: id, status: job.status, cancelled: false, note: 'the job had already settled' };
  }
  const killed = job.cancel();
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  await job.completion;
  return {
    jobId: id,
    status: 'cancelled',
    cancelled: true,
    processesKilled: killed,
    note: killed === 0
      ? 'No child process was running at that moment; the job is marked cancelled and no further work will be reported.'
      : `Terminated ${killed} child process(es).`,
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'installation_status',
    title: "Installation status",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "local-installation",
    description:
      'Locate the MAX+PLUS II installation (maxplus2.exe / setacf.exe), report version info from maxplus2.ini, available device families, and additional bundled tools. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Installation root, e.g. C:\\maxplus2. Defaults to MAXPLUS2_ROOT or common paths.' },
      },
      additionalProperties: false,
    },
    handler: toolInstallationStatus,
  },
  {
    name: 'list_projects',
    title: "List projects",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-directory",
    description: 'Recursively find .acf projects under a root directory and list the artifacts already compiled for each. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to scan. Defaults to MAXPLUS2_WORKSPACE or the server cwd.' },
        maxDepth: { type: 'integer', description: 'Recursion depth limit (default 6).' },
        limit: { type: 'integer', description: 'Maximum projects to return (default 500).' },
      },
      additionalProperties: false,
    },
    handler: toolListProjects,
  },
  {
    name: 'project_inspect',
    title: "Inspect project",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description: 'Summarize one project: .acf sections, CHIP blocks, device, pin count, compiled artifacts with timestamps, and the cleanliness of the last .rpt. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (e.g. "top") or absolute path to a .acf.' },
        workspace: { type: 'string', description: 'Directory to resolve relative project names against.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolProjectInspect,
  },
  {
    name: 'acf_read_sections',
    title: "Read ACF sections",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description: 'Read the .acf as structured sections/entries with line numbers. Use to discover which section holds a setting before writing. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or absolute .acf path.' },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        section: { type: 'string', description: 'Only return this section (case-insensitive), e.g. CHIP.' },
        includeEntries: { type: 'boolean', description: 'Set false to return section headers only (default true).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolAcfSections,
  },
  {
    name: 'acf_read_pins',
    title: "Read pin assignments",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description: 'Extract device and pin assignments from the .acf CHIP block, and cross-check them against the compiler-generated .pin report when present. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolAcfPins,
  },
  {
    name: 'setacf_plan',
    title: "Plan a setacf change",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description: 'Build the exact setacf.exe argument vector for a change WITHOUT executing it. Always call this first: setacf edits the .acf in place and has no dry-run mode.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        root: { type: 'string', description: 'MAX+PLUS II install root.' },
        kind: { type: 'string', enum: ['INPUT_PIN', 'OUTPUT_PIN', 'BIDIR_PIN'], description: 'Pin assignment kind.' },
        signal: { type: 'string', description: 'Signal name, e.g. "|CLK" or "CLK".' },
        pin: { type: ['string', 'integer'], description: 'Pin number.' },
        device: { type: 'string', description: 'Set the DEVICE assignment, e.g. EP1K30TC144-1.' },
        section: { type: 'string', description: 'Section name (defaults to CHIP for device/pin edits).' },
        sectionValue: { type: 'string', description: 'Section value, e.g. the chip name.' },
        modifyTo: { type: 'string', description: 'Modify an existing section value (-m).' },
        deleteVariable: { type: 'string', description: 'Delete a variable (-d).' },
        prependPath: { type: 'string', description: 'Prepend a hierarchy path (-p).' },
        variable: { type: 'string', description: 'Raw variable for advanced use.' },
        value: { type: 'string', description: 'Raw value for advanced use.' },
        create: { type: 'boolean', description: 'Create the .acf if missing (-c).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolSetacfPlan,
  },
  {
    name: 'setacf_apply',
    title: "Apply a setacf change",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    sideEffects: "write",
    reversibility: "reversible-by-backup",
    actsOn: "acf-file",
    description: 'Execute a setacf change. Backs the .acf up first and returns a line diff. Requires confirm:true. Prefer calling setacf_plan first.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        root: { type: 'string', description: "MAX+PLUS II installation root, for example C:\\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths." },
        confirm: { type: 'boolean', description: 'Must be true to actually write.' },
        backup: { type: 'boolean', description: 'Back up the .acf first (default true).' },
        timeoutMs: { type: 'integer', description: "Hard timeout in milliseconds. A client timeout is wall-clock and progress does not extend it, so keep this below the client budget." },
        kind: { type: 'string', enum: ['INPUT_PIN', 'OUTPUT_PIN', 'BIDIR_PIN'] , description: "Assignment kind. INPUT_PIN, OUTPUT_PIN or BIDIR_PIN sets a pin; omit it when setting a device or a raw variable." },
        signal: { type: 'string', description: "Signal name to constrain, for example \"|CLK\" or \"CLK\". A leading pipe is added automatically if absent." },
        pin: { type: ['string', 'integer'], description: "Pin number to assign." },
        device: { type: 'string', description: "Device to assign, for example EP1K30TC144-1. Written as the DEVICE variable in the CHIP section." },
        section: { type: 'string', description: "ACF section name. Device and pin edits default to CHIP; other settings live in sections such as SIMULATOR_CONFIGURATION." },
        sectionValue: { type: 'string', description: "Section value, for example the chip name in \"CHIP top\". Required when the section does not exist yet, because setacf cannot name a section it is creating." },
        modifyTo: { type: 'string', description: "New value for an existing section (-m). Requires section and sectionValue." },
        deleteVariable: { type: 'string', description: "Name of the variable to delete from its section (-d)." },
        prependPath: { type: 'string', description: "Hierarchy path prefix to prepend to the variable (-p), for a signal inside a sub-design." },
        variable: { type: 'string', description: "Raw setacf variable for advanced use, for example \"DEVICE\" or a full \"\\\"|SIG\\\":PIN\" form." },
        value: { type: 'string', description: "Value paired with variable for advanced use." },
        create: { type: 'boolean', description: "Create the .acf if it does not exist (-c). Use only when bootstrapping a new project." },
        async: { type: 'boolean', description: "Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status." },
      },
      required: ['project', 'confirm'],
      additionalProperties: false,
    },
    handler: toolSetacfApply,
  },
  {
    name: 'maxplus2_plan',
    title: "Plan a maxplus2 run",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description: 'Build the exact maxplus2.exe command line for compile / timing analysis / simulation / object conversion, WITHOUT running it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        root: { type: 'string', description: "MAX+PLUS II installation root, for example C:\\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths." },
        compile: { type: 'boolean', description: 'Run the Compiler (-c).' },
        rebuild: { type: 'boolean', description: 'Back up/move matching top and numbered hierarchy CNF before compile to force source extraction (default true); false requests native incremental reuse.' },
        simulate: { type: 'boolean', description: 'Run the Simulator (-s).' },
        convert: { type: 'boolean', description: 'Convert object files (-convert).' },
        taDelay: { type: 'boolean', description: 'Timing Analyzer, Delay Matrix (-ta_delay).' },
        taSetup: { type: 'boolean', description: 'Timing Analyzer, Setup/Hold (-ta_setup).' },
        taReg: { type: 'boolean', description: 'Timing Analyzer, Registered Performance (-ta_reg).' },
        ignoreErrors: { type: 'boolean', description: 'Continue past errors (-i).' },
        timingAnalyzerOutput: { type: 'string', description: '-tao file.' },
        simScf: { type: 'string' , description: "Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run." }, simVec: { type: 'string' , description: "Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run." },
        simCmd: { type: 'string' , description: "Simulator command file (-cmd). REJECTED by this build." }, simTbl: { type: 'string' , description: "Where to write the simulator result table. Plain text, and what verification reads back." }, simHst: { type: 'string' , description: "Simulator command file (-cmd). REJECTED by this build." },
        outHex: { type: 'string' , description: "HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex." }, outJam: { type: 'string' , description: "JAM STAPL output (-jam). REJECTED by this build." }, outJ11: { type: 'string' , description: "HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex." },
        outJbc: { type: 'string' , description: "JBC 2.0 output (-jbc). REJECTED by this build." }, outJb1: { type: 'string' , description: "JBC 1.0 output (-jb1). REJECTED by this build." }, outPof: { type: 'string' , description: "POF output (-pof). REJECTED by this build, but compiling writes <project>.pof anyway." },
        outRbf: { type: 'string' , description: "RBF output (-rbf). REJECTED by this build." }, outSbf: { type: 'string' , description: "SBF output (-sbf). REJECTED by this build." }, outSvf: { type: 'string' , description: "SVF output (-svf). REJECTED by this build, so this installation cannot derive a JTAG programming file." },
        outTtf: { type: 'string', description: "TTF output file (-ttf). REJECTED by this build; compiling writes <project>.ttf." },
        cwd: { type: 'string', description: "Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run." },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolMaxplus2Plan,
  },
  {
    name: 'maxplus2_run',
    title: "Run maxplus2",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    sideEffects: "write",
    reversibility: "regenerable",
    actsOn: "build-artifacts",
    description: 'Execute maxplus2.exe (compile / simulate / timing / convert) with a hard timeout, then report which artifacts changed and the parsed report summary. Beware: this starts a 2002-era Win32 process that can block on modal dialogs.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        root: { type: 'string', description: "MAX+PLUS II installation root, for example C:\\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths." },
        compile: { type: 'boolean', description: "Run the Compiler (-c). This also writes the .pof, .rpt and .pin artifacts." },
        rebuild: { type: 'boolean', description: 'Back up/move matching top and numbered hierarchy CNF before compile to force source extraction (default true); false requests native incremental reuse.' },
        simulate: { type: 'boolean', description: "Run the Simulator (-s). Requires stimulus: pass simScf, or leave a .scf or a matching .vec next to the project." },
        convert: { type: 'boolean', description: "Convert object files (-convert)." },
        taDelay: { type: 'boolean', description: "Run the Timing Analyzer in Delay Matrix mode (-ta_delay)." },
        taSetup: { type: 'boolean', description: "Run the Timing Analyzer in Setup/Hold Matrix mode (-ta_setup)." },
        taReg: { type: 'boolean', description: "Run the Timing Analyzer in Registered Performance mode (-ta_reg)." },
        ignoreErrors: { type: 'boolean', description: "Continue past errors (-i). Use when you want every diagnostic from one run rather than stopping at the first failure." },
        timingAnalyzerOutput: { type: 'string', description: "File for Timing Analyzer output. Each analysis mode is emitted with its own -tao, so multiple modes cannot overwrite one file." },
        simScf: { type: 'string' , description: "Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run." }, simVec: { type: 'string' , description: "Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run." },
        simCmd: { type: 'string' , description: "Simulator command file (-cmd). REJECTED by this build." }, simTbl: { type: 'string' , description: "Where to write the simulator result table. Plain text, and what verification reads back." }, simHst: { type: 'string' , description: "Simulator command file (-cmd). REJECTED by this build." },
        outHex: { type: 'string' , description: "HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex." }, outJam: { type: 'string' , description: "JAM STAPL output (-jam). REJECTED by this build." }, outJ11: { type: 'string' , description: "HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex." },
        outJbc: { type: 'string' , description: "JBC 2.0 output (-jbc). REJECTED by this build." }, outJb1: { type: 'string' , description: "JBC 1.0 output (-jb1). REJECTED by this build." }, outPof: { type: 'string' , description: "POF output (-pof). REJECTED by this build, but compiling writes <project>.pof anyway." },
        outRbf: { type: 'string' , description: "RBF output (-rbf). REJECTED by this build." }, outSbf: { type: 'string' , description: "SBF output (-sbf). REJECTED by this build." }, outSvf: { type: 'string' , description: "SVF output (-svf). REJECTED by this build, so this installation cannot derive a JTAG programming file." },
        outTtf: { type: 'string', description: "TTF output file (-ttf). REJECTED by this build; compiling writes <project>.ttf." },
        cwd: { type: 'string', description: "Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run." },
        timeoutMs: { type: 'integer', description: 'Hard timeout, default 900000 (15 min).' },
        async: { type: 'boolean', description: "Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status." },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolMaxplus2Run,
  },
  {
    name: 'acf_validate',
    title: "Validate ACF",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "project-files",
    description:
      'Statically validate an .acf for defects that block compilation, notably the bare "CHIP " header that setacf itself creates when no CHIP section exists yet (MAX+PLUS II then fails with "Missing identifier after section keyword"). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolAcfValidate,
  },
  {
    name: 'acf_repair_chip_headers',
    title: "Repair CHIP headers",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    sideEffects: "destructive",
    reversibility: "reversible-by-backup",
    actsOn: "acf-file",
    description:
      'Rewrite malformed CHIP headers (bare "CHIP " or shell-escaped names) into canonical "CHIP <name>" form. setacf is append-only and cannot fix these itself. Preview-first; requires confirm:true to write and backs the file up.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        chipName: { type: 'string', description: 'Name to use for the CHIP section. Defaults to the project name.' },
        confirm: { type: 'boolean', description: 'Must be true to write. Without it this is a preview.' },
        backup: { type: 'boolean', description: 'Back up the .acf first (default true).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolAcfRepairChipHeaders,
  },
  {
    name: 'probe_executable',
    title: "Probe the executable",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "local-process",
    description:
      'Run `maxplus2 -v` (or -h) to verify the 2002-era binary actually starts and returns on this host. Read-only and project-independent. Run this before trusting any headless compile loop: MAX+PLUS II can block forever on a modal dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'MAX+PLUS II install root.' },
        mode: { type: 'string', enum: ['version', 'help'], description: 'Which probe to run (default version).' },
        cwd: { type: 'string', description: "Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run." },
        timeoutMs: { type: 'integer', description: 'Hard timeout, default 60000.' },
      },
      additionalProperties: false,
    },
    handler: toolProbeExecutable,
  },
  {
    name: 'simulate_and_verify',
    title: "Simulate and verify",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "write",
    reversibility: "regenerable",
    actsOn: "build-artifacts",
    description:
      'Run the Simulator headless and return the parsed result table, then optionally check expected output values. This is how simulation verification is automated: MAX+PLUS II writes a plain-text .tbl containing the simulated outputs, so a design can be checked without a human reading a waveform. Note a successful simulation may exit 1 — the verdict comes from the success banner plus the table artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Project name (for example \"top\") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it." },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        root: { type: 'string', description: "MAX+PLUS II installation root, for example C:\\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths." },
        scf: { type: 'string', description: 'Stimulus file. Defaults to <project>.scf if present.' },
        tbl: { type: 'string', description: 'Where to write the result table. Defaults to <project>.tbl.' },
        previewRows: { type: 'integer', description: 'How many leading trace rows to return (default 12).' },
        tolerance: { type: 'number', description: 'Time tolerance in table units when matching expectations (default 0.05).' },
        timeoutMs: { type: 'integer', description: "Hard timeout in milliseconds. A client timeout is wall-clock and progress does not extend it, so keep this below the client budget." },
        expect: {
          type: 'object',
          description: 'Expected values, as { "<time>": { "SIGNAL": value } }. Values may be numbers or hex strings like "80". Outputs and buried nodes are both checkable.',
          additionalProperties: true,
        },
        async: { type: 'boolean', description: "Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status." },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolSimulateAndVerify,
  },
  {
    name: 'parse_tbl',
    title: "Parse result table",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "build-artifacts",
    description:
      'Parse an existing MAX+PLUS II Simulator result table (.tbl) into a time-indexed trace of inputs, outputs and buried nodes, with optional expected-value checking. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name; uses its <project>.tbl. Optional if path is given.' },
        path: { type: 'string', description: 'Explicit .tbl path.' },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        limit: { type: 'integer', description: 'Max trace rows to return (default 40).' },
        full: { type: 'boolean', description: 'Return every row.' },
        tolerance: { type: 'number', description: "Time tolerance, in the table's own unit, when matching an expectation to a simulation row. Default 0.05." },
        expect: { type: 'object', additionalProperties: true , description: "Expected values as { \"<time>\": { \"<SIGNAL>\": value } }. Values may be numbers or hex strings. A mismatch is reported, not thrown." },
      },
      additionalProperties: false,
    },
    handler: toolParseTbl,
  },
  {
    name: 'parse_report',
    title: "Parse a report",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "build-artifacts",
    description: 'Parse a MAX+PLUS II .rpt / .summary / .pin file into structured severity counts, statuses, device, and diagnostics. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name; uses its .rpt. Optional if path is given.' },
        path: { type: 'string', description: 'Explicit report path (absolute, or relative to workspace).' },
        workspace: { type: 'string', description: "Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        maxDiagnostics: { type: 'integer', description: 'Cap on returned diagnostics (default 200).' },
      },
      additionalProperties: false,
    },
    handler: toolParseRpt,
  },
  {
    name: 'gdf_inspect',
    title: "Inspect a schematic",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "gdf-file",
    description:
      'Read a strictly validated GDF/SYM schematic summary: labels, fonts, title fields and geometry counts. gdf_geometry provides paginated original coordinates, definitions, instances and world pin positions; gdf_edit supports existing v6 geometry. Electrical connectivity requires netlist_export. Optionally compare labels with another drawing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Schematic to read: absolute, or relative to workspace. A missing .gdf extension is added automatically.' },
        workspace: { type: 'string', description: "Directory that a relative path is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory." },
        compareWith: { type: 'string', description: 'Optional second schematic to compare against, reporting labels present in one but not the other.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: toolGdfInspect,
  },
  {
    name: 'job_status',
    title: "Check a background job",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "none",
    reversibility: "not-applicable",
    actsOn: "background-job",
    description:
      'Poll a background job started with async:true. Returns running/done/failed/cancelled, how long it has been going, how many child processes are live, and the full result once it settles. This exists because a client timeout is wall-clock and does NOT stop the work: polling is the only way to keep a long compile without losing it. Results are held for 30 minutes after they settle.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId returned when the job was started with async:true.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    handler: toolJobStatus,
  },
  {
    name: 'job_cancel',
    title: "Cancel a background job",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    sideEffects: "destructive",
    reversibility: "not-applicable",
    actsOn: "background-job",
    description:
      'Terminate a running background job by killing its child process. Use this rather than abandoning a job: an abandoned job keeps running and keeps holding the project directory. Build artifacts already written are left in place — this stops work, it does not undo it.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId to terminate.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    handler: toolJobCancel,
  },
];

TOOLS.push(...authoringTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...parsingTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...gdfTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...gdfConstructionTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...extendedFileTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...advancedFileTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));
TOOLS.push(...practiceFileTools({ defaultWorkspace: DEFAULT_WORKSPACE, resolveAcf }));

const GUIDE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs', 'DESKTOP.md');
const FILE_GUIDE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs', 'FILE-FIRST.md');
TOOLS.push({
  name:'capability_matrix', title:'Discover available MAX+plus II capabilities',
  description:'Return precise routes and runtime requirements for authoring, compilation, simulation and native GUI-only workflows. Distinguishes implemented entry points from operations verified on this machine and physical programming requirements.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},sideEffects:'none',reversibility:'not-applicable',actsOn:'server-capabilities',
  handler:async()=>{
    const gui = await TOOLS.find(t=>t.name==='desktop_status').handler({});
    return { version:SERVER_VERSION, toolCount:TOOLS.length, cli:CAPABILITY, desktop:gui,
      workflows:[
        {task:'file-first design/waveform parsing and authoring',route:['project_create','project_clone','project_files','project_parse_file','scf_inspect','scf_edit','project_read_file','project_search','project_edit_file','memory_write'],available:true},
        {task:'original GDF/SYM graphics, text, geometry and embedded symbol refresh',route:['gdf_geometry','gdf_edit','gdf_graphics_edit','gdf_text_edit','gdf_text_format_inspect','gdf_text_format_edit','sym_inspect','sym_create','sym_edit','gdf_symbol_refresh','project_restore_file'],available:true,requires:'fresh SHA-256 and backups; explicit font metrics/encoding; refresh needs explicit interface/contact review'},
        {task:'unsynthesized scalar source nets and explicit bus member connectivity',route:['gdf_connections'],available:true,requires:'decoded geometry and explicit range names; partial results identify unknown macro widths and hierarchy internals'},
        {task:'connection-preserving scalar symbol movement/rotation',route:['gdf_connections','gdf_move_connected','maxplus2_run','simulate_and_verify'],available:true,requires:'GDF6 scalar sheet, fresh hash, collision/route budgets, unchanged source terminal partitions; compiler verifies behavior'},
        {task:'create/edit GDF v6 symbols, wires, modern parameters, electrical labels and bus members',route:['gdf_symbol_library','gdf_create','gdf_construct','gdf_geometry','maxplus2_run','simulate_and_verify'],available:true,requires:'original SYM prototypes with fresh hashes; explicit grid coordinates/labels and complete parameter maps; original compiler/simulator for behavioral evidence'},
        {task:'GDF/HDL synthesized port/instance/net connectivity',route:['netlist_export','project_parse_file'],available:Boolean(detectInstall()),requires:'original compiler; export compiles only an isolated temporary copy'},
        {task:'SCF creation, compiled-port import, generated stimuli, structure and time span',route:['scf_create','scf_from_compiled_create','scf_compiled_ports','scf_ports_import','scf_inspect','scf_edit','scf_stimulus_edit','scf_structure','scf_structure_edit','scf_editor_metadata','simulate_and_verify'],available:true,requires:'SCF4; fresh hashed exported EDIF for actual top-level nodes; original simulator computes outputs'},
        {task:'checked scalar/bus anonymous wire-tail pruning',route:['gdf_wire_cleanup','maxplus2_run','simulate_and_verify'],available:true,requires:'GDF6 and complete original source scalar/bit topology; no labelled wires or unresolved macros'},
        {task:'gated simulation output events and suggested viewing interval',route:['waveform_signals','waveform_results'],available:true,requires:'fresh original TBL with actual valid/data columns; analysis does not save editor zoom or visibility'},
        {task:'stored original display palette diagnosis',route:['display_palette_inspect','desktop_observe','desktop_action'],available:true,requires:'stored ini palette; original editor Preview for visible color evidence'},
        {task:'original CONSTANT/PARAM source declarations',route:['gdf_declarations','gdf_declarations_edit'],available:true,requires:'existing unambiguous native h declaration pairs; expressions and dependencies verified by compiler'},
        {task:'assignments/compile/simulate/timing/reports',route:['setacf_plan','setacf_apply','maxplus2_run','stimulus_write','simulate_and_verify','parse_report','parse_tbl'],available:Boolean(detectInstall())},
        {task:'graphic/symbol/waveform editors, hierarchy/floorplan, wizard, programmer UI, conversion and printing',route:['desktop_windows','desktop_observe','desktop_action'],available:gui.connected,requires:'independent Windows backend and unlocked interactive desktop; no agent-specific host tools'},
        {task:'program/verify a physical device',route:['desktop_observe','desktop_action'],available:null,requires:'license, supported cable, powered connected device; hardware must be checked in Programmer'},
      ],guide:'maxplus2://file-guide',desktopGuide:'maxplus2://guide',limits:['GUI mouse/keyboard/drag and observed native menus provide operation entry points; every application workflow has not been individually validated.','Arbitrary old u parameter forms and unverified file versions remain unsupported. Explicit bus source bits are decoded; parameter-dependent macro widths and hierarchy internals remain partial. Connected routing supports scalar placement movement, not bus routing or symbol-refresh reconnection.','Text uses explicit Latin-1 or strict Windows-936; Windows glyph width/height must be supplied. Original visual verification is for this machine ACP936 and installed Arial/宋体 fonts.','SCF cursor/grid/zoom/private node references remain uninterpreted. Compiled import supports top-level INPUT/OUTPUT nodes, not all internal SNF nodes or INOUT; unknown trailers prevent unsafe reference changes.','Symbol refresh reports interface/contact changes and requires explicit flags; source topology does not prove synthesized logic equivalence.','Server restart invalidates observation IDs and recent desktop results; call desktop_windows again.'] };
  },
});

// Execute all project-scoped operations in order, while independent directories
// remain concurrent. Canonical paths prevent aliases from bypassing the queue.
const PROJECT_QUEUES = new Map();
const scopedWrites = new Set(['project_create','project_clone','project_files','project_read_file','project_search','project_edit_file','project_restore_file','stimulus_write','memory_write','scf_inspect','scf_edit','project_parse_file','netlist_export','gdf_geometry','gdf_edit','gdf_create','gdf_construct','gdf_graphics_edit','gdf_text_edit','gdf_symbol_refresh','gdf_declarations','gdf_declarations_edit','sym_inspect','sym_edit','sym_create','scf_structure','scf_structure_edit','scf_create','gdf_connections','gdf_move_connected','gdf_text_format_inspect','gdf_text_format_edit','scf_editor_metadata','scf_stimulus_edit','scf_compiled_ports','scf_ports_import','scf_from_compiled_create','gdf_wire_cleanup','waveform_signals','waveform_results']);
for (const t of TOOLS) {
  t.inputSchema.additionalProperties ??= false;
  const props = t.inputSchema.properties ?? {};
  if (props.timeoutMs) Object.assign(props.timeoutMs,{minimum:1,maximum:DEFAULT_TOOL_TIMEOUT_MS});
  const original = t.handler;
  t.handler = async args => {
    const a = args ?? {};
    if(a.project && t.sideEffects!=='none'){
      const project=resolveAcf(a.project,a.workspace);
      if(isBackupPath(path.dirname(project),project))throw new Error('cannot mutate a project in the reserved backup store');
      const canonicalProject=fs.realpathSync(project);
      writablePath(path.dirname(canonicalProject),canonicalProject);
    }
    let key = null;
    if (a.project) key = fs.realpathSync(path.dirname(resolveAcf(a.project,a.workspace)));
    else if (scopedWrites.has(t.name)) key = fs.realpathSync(a.workspace ?? DEFAULT_WORKSPACE);
    if (!key) return original(a);
    if (process.platform === 'win32') key = key.toLowerCase();
    const previous = PROJECT_QUEUES.get(key) ?? Promise.resolve();
    const operation = previous.catch(()=>{}).then(()=>{
      if (a.__job?.controller.signal.aborted) throw new Error('cancelled before acquiring project lock');
      return original(a);
    });
    PROJECT_QUEUES.set(key,operation);
    const release = () => {if(PROJECT_QUEUES.get(key) === operation)PROJECT_QUEUES.delete(key);};
    operation.then(release,release);
    const signal=a.__job?.controller.signal;
    if (!signal) return operation;
    let abort;
    const cancelled=new Promise((_,reject)=>{
      abort=()=>reject(new Error('cancelled while queued'));
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    });
    // During execution, runProcess settles only after the child closes. A queued
    // cancellation can return immediately but must retain the queue chain.
    try {
      await Promise.race([previous.catch(()=>{}),cancelled]);
      if(signal.aborted)throw new Error('cancelled before acquiring project lock');
      signal.removeEventListener('abort',abort);
      return await operation;
    } finally {signal.removeEventListener('abort',abort);}
  };
}

const ACTIVE_REQUESTS = new Map();
let initialized = false;

// ---------------------------------------------------------------------------
// JSON-RPC / MCP over stdio (newline-delimited)
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handleMessage(msg) {
  if (!msg || Array.isArray(msg) || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string'
    || (Object.hasOwn(msg,'id') && !(typeof msg.id==='string' || Number.isSafeInteger(msg.id)))) {
    replyError(null,-32600,'invalid JSON-RPC 2.0 request'); return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled') ACTIVE_REQUESTS.get(params?.requestId)?.cancel();
    return;
  }
  if (!isRequest) return; // requests cannot execute as notifications
  if (!initialized && method !== 'initialize' && method !== 'ping') { replyError(id,-32002,'initialize the server first'); return; }

  switch (method) {
    case 'initialize': {
      initialized = true;
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: {}, prompts:{} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      if (isRequest) reply(id, {});
      return;

    case 'resources/list':
      reply(id,{resources:[{uri:'maxplus2://file-guide',name:'MAX+plus II file-first parsing and editing guide',mimeType:'text/markdown'},{uri:'maxplus2://guide',name:'MAX+plus II authoring and desktop guide',mimeType:'text/markdown'}]}); return;
    case 'resources/templates/list': reply(id,{resourceTemplates:[]}); return;
    case 'resources/read':
      if (!['maxplus2://guide','maxplus2://file-guide'].includes(params?.uri)) { replyError(id,-32602,'unknown resource URI'); return; }
      reply(id,{contents:[{uri:params.uri,mimeType:'text/markdown',text:fs.readFileSync(params.uri==='maxplus2://file-guide'?FILE_GUIDE_PATH:GUIDE_PATH,'utf8')}]}); return;
    case 'prompts/list':
      reply(id,{prompts:[{name:'maxplus2_workflow',description:'Compose an evidence-driven MAX+plus II task using files, CLI and native GUI.',arguments:[{name:'task',description:'User-authorized design task.',required:true}]}]}); return;
    case 'prompts/get':
      if (params?.name !== 'maxplus2_workflow' || typeof params.arguments?.task !== 'string') { replyError(id,-32602,'maxplus2_workflow requires task'); return; }
      reply(id,{description:'MAX+plus II workflow',messages:[{role:'user',content:{type:'text',text:`Task: ${params.arguments.task}\n\n${SERVER_INSTRUCTIONS}\nRead maxplus2://file-guide first; maxplus2://guide describes GUI fallback. Report verified results and outstanding runtime/hardware limits.`}}]}); return;

    case 'tools/list': {
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          // outputSchema is deliberately omitted: results here are dynamic shapes
          // (parsed reports, pin tables, traces), and a wrong outputSchema makes
          // strict clients drop the tool entirely — worse than declaring none.
          annotations: t.annotations,
          // A multi-axis classification alongside the boolean hints. sideEffects
          // alone does not capture reversibility or what the operation acts on,
          // and one risk label is not enough for a consent decision.
          _meta: {
            sideEffects: t.sideEffects,
            reversibility: t.reversibility,
            actsOn: t.actsOn,
          },
        })),
      });
      return;
    }

    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        // Unknown tool is a protocol-level fault: the caller named something that
        // does not exist. Nothing the model can do to the arguments will fix it.
        replyError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      const callArgs = params?.arguments === undefined ? {} : params.arguments;
      try { validateArguments(callArgs,tool.inputSchema); }
      catch (err) { reply(id,{content:[{type:'text',text:`Error: ${err.message}`}],isError:true}); return; }

      // Long work can be deferred. This is not a convenience: a client timeout is
      // wall-clock and does NOT stop the child process, so without a job handle a
      // caller that gives up loses the result AND control of the machine.
      if (callArgs.async === true) {
        const job = startJob(name, callArgs, tool.handler);
        reply(id, boundResult(name, {
          jobId: job.id,
          status: 'running',
          tool: name,
          pollWith: 'job_status',
          cancelWith: 'job_cancel',
          note: 'Started in the background. The result is held for 30 minutes after it settles. Poll job_status; use job_cancel to stop it.',
        }));
        return;
      }

      try {
        let settleRequest;
        const tracker = {controller:new AbortController(),children:new Set(),track(child){this.children.add(child);child.once('close',()=>this.children.delete(child));if(this.controller.signal.aborted)child.kill();},cancel(){this.controller.abort();for(const c of this.children)c.kill();}};
        tracker.completion = new Promise(resolve=>{settleRequest=resolve;});
        const trackedArgs = {...callArgs};
        Object.defineProperty(trackedArgs,'__job',{value:tracker,enumerable:false});
        ACTIVE_REQUESTS.set(id,tracker);
        try {
          const data = await tool.handler(trackedArgs);
          if (!tracker.controller.signal.aborted) reply(id, boundResult(name, data));
        } finally { ACTIVE_REQUESTS.delete(id); settleRequest(); }
      } catch (err) {
        // Tool execution error: the model CAN see this and self-correct, which is
        // why validation and operational failures come back as isError results
        // rather than JSON-RPC errors (spec 2025-11-25, SEP-1303).
        if(err.recovery){reply(id,{...boundResult(name,{error:err.message,recovery:err.recovery}),isError:true});return;}
        reply(id, {
          content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        replyError(null, -32700, 'parse error');
        continue;
      }
      Promise.resolve(handleMessage(msg)).catch((err) => {
        replyError(msg?.id ?? null, -32603, `internal error: ${err?.message ?? err}`);
      });
    }
  });
  const shutdown = async () => {
    closeDesktopControllers();
    const requests = [...ACTIVE_REQUESTS.values()];
    for (const request of requests) request.cancel();
    for (const job of JOBS.values()) if (job.status === 'running') { job.status='cancelled'; job.cancel(); }
    await Promise.allSettled([...requests.map(request=>request.completion), ...[...JOBS.values()].map(job=>job.completion)]);
    process.exit(0);
  };
  process.stdin.on('end',shutdown);
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
}

// Only start the transport when run as a server; importing the module (tests)
// must not attach stdin handlers.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();

export { TOOLS, resolveAcf, buildSetacfArgsFor, diffLines };
