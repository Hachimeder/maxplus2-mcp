/**
 * Runtime helpers: locate the MAX+PLUS II installation, build and execute
 * commands, and never block forever on a 2002-era Win32 GUI app.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

const COMMON_ROOTS = [
  'C:\\maxplus2',
  'D:\\maxplus2',
  'E:\\maxplus2',
  'C:\\max2work',
  'C:\\max2_83',
  'C:\\maxplus3',
  'D:\\maxplus3',
];

/**
 * Detect a MAX+PLUS II installation.
 *
 * Order of resolution:
 *   1. explicit root argument
 *   2. MAXPLUS2_ROOT environment variable
 *   3. common install locations
 *   4. the HELP_FILE_DIR hint inside an already-found maxplus2.ini
 */
export function detectInstall(explicitRoot) {
  const candidates = [];
  if (explicitRoot) candidates.push(explicitRoot);
  if (process.env.MAXPLUS2_ROOT) candidates.push(process.env.MAXPLUS2_ROOT);
  candidates.push(...COMMON_ROOTS);

  for (const root of candidates) {
    try {
      if (!fs.existsSync(root)) continue;
      const exe = path.join(root, 'maxplus2.exe');
      const setacf = path.join(root, 'setacf.exe');
      if (!fs.existsSync(exe)) continue;

      const info = {
        root,
        executable: exe,
        setacf: fs.existsSync(setacf) ? setacf : null,
        version: readIniValue(root, 'SYSTEM', 'FULL_VERSION') ? null : null,
        ini: null,
        // Extra command-line tools shipped in the same directory.
        tools: {},
      };

      const iniPath = path.join(root, 'maxplus2.ini');
      if (fs.existsSync(iniPath)) {
        info.ini = iniPath;
      }

      for (const name of [
        'max2win.exe', 'setacf.exe', 'megawiz.exe', 'genmem.exe',
        'wlarithm.exe', 'wlsum.exe', 'wlcount.exe', 'wlmux.exe',
        'wlram.exe', 'wlclshif.exe', 'wdivide.exe', 'maxstart.exe',
      ]) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) info.tools[name] = p;
      }

      // Derive data-file families from the device description files present.
      try {
        const ddf = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.ddf'));
        info.families = ddf.map((f) => f.replace(/\.ddf$/i, '').toUpperCase()).sort();
      } catch {
        info.families = [];
      }

      return info;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function readIniValue(root, section, key) {
  try {
    const text = fs.readFileSync(path.join(root, 'maxplus2.ini'), 'latin1');
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const s = line.match(/^\s*\[(.+?)\]\s*$/);
      if (s) { cur = s[1]; continue; }
      if (cur !== section) continue;
      const kv = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
      if (kv && kv[1].toUpperCase() === key.toUpperCase()) return kv[2];
    }
  } catch { /* ignore */ }
  return null;
}

export function readIni(root) {
  const p = path.join(root, 'maxplus2.ini');
  const out = {};
  try {
    const text = fs.readFileSync(p, 'latin1');
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const s = line.match(/^\s*\[(.+?)\]\s*$/);
      if (s) { cur = s[1]; out[cur] = out[cur] ?? {}; continue; }
      if (!cur) continue;
      const kv = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
      if (kv) out[cur][kv[1].trim()] = kv[2];
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Execute a process without a shell, capture stdout/stderr, and enforce a
 * timeout so a blocked modal dialog cannot hang the MCP server forever.
 *
 * `onSpawn` receives the child process so a caller can keep a handle for
 * cancellation. That matters because an MCP client timeout is wall-clock and
 * progress notifications do NOT extend it: a long build must be run as an
 * interruptible job rather than a request the client will abandon while the
 * process keeps running. `onExit` is called once when the process settles, so a
 * registry can release the handle without polling.
 */
export function runProcess(exe, args, {
  cwd,
  env,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  onSpawn,
  onExit,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) { resolve({ok:false,code:null,signal:null,stdout:'',stderr:'cancelled before spawn',aborted:true,timedOut:false,durationMs:0}); return; }
    let child;
    const settle = (result) => {
      try { onExit?.(result); } catch { /* a registry must never break the run */ }
      resolve(result);
    };
    try {
      child = spawn(exe, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...(env ?? {}) },
      });
    } catch (err) {
      settle({
        ok: false, code: null, signal: null, stdout: '', stderr: String(err),
        timedOut: false, durationMs: Date.now() - started, spawnError: String(err),
      });
      return;
    }

    try { onSpawn?.(child); } catch { /* ignore */ }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let aborted = false;
    const abort = () => { aborted = true; try { child.kill(); } catch { /* close/error handles settlement */ } };
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();

    const cap = 2 * 1024 * 1024;
    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('latin1');
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('latin1');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);

    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      settle({
        ok: !timedOut && !aborted && code === 0,
        code,
        signal: exitSignal,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      settle({
        ok: false, code: null, signal: null, stdout, stderr: stderr + String(err),
        timedOut: false, durationMs: Date.now() - started, spawnError: String(err),
      });
    });
    child.on('close', finish);
  });
}

/**
 * Build the maxplus2.exe argument vector.
 *
 * Argument order follows the shipped help text:
 *   maxplus2 <option(s)> [<I/O option(s)>] <project name>
 *
 * Each Timing Analyzer mode is immediately followed by its own -tao output, so
 * that multiple analyses in one invocation cannot write to the same file. This
 * mirrors Altera's own documented example:
 *
 *   maxplus2 -c -ta_reg -tao "reg.txt" -ta_delay -tao "delay.txt" filter
 */
export function buildMaxplus2Args(opts) {
  const {
    projectName,
    compile = false,
    simulate = false,
    convert = false,
    taDelay = false,
    taSetup = false,
    taReg = false,
    ignoreErrors = false,
    timingAnalyzerOutput,
    simScf,
    simVec,
    simCmd,
    simTbl,
    simHst,
    outHex, outJam, outJ11, outJbc, outJb1, outPof, outRbf, outSbf, outSvf, outTtf,
  } = opts;

  const args = [];

  if (compile) args.push('-c');
  if (convert) args.push('-convert');

  // Timing Analyzer: mode flag paired with its output file.
  if (taDelay) {
    args.push('-ta_delay');
    if (timingAnalyzerOutput) args.push('-tao', String(timingAnalyzerOutput));
  }
  if (taSetup) {
    args.push('-ta_setup');
    if (timingAnalyzerOutput) args.push('-tao', String(timingAnalyzerOutput));
  }
  if (taReg) {
    args.push('-ta_reg');
    if (timingAnalyzerOutput) args.push('-tao', String(timingAnalyzerOutput));
  }

  if (simulate) args.push('-s');
  if (ignoreErrors) args.push('-i');

  const io = [
    [simScf, '-scf'],
    [simVec, '-vec'],
    [simCmd, '-cmd'],
    [simTbl, '-tbl'],
    [simHst, '-hst'],
    [outHex, '-hex'],
    [outJam, '-jam'],
    [outJ11, '-j11'],
    [outJbc, '-jbc'],
    [outJb1, '-jb1'],
    [outPof, '-pof'],
    [outRbf, '-rbf'],
    [outSbf, '-sbf'],
    [outSvf, '-svf'],
    [outTtf, '-ttf'],
  ];
  for (const [file, flag] of io) {
    if (file) args.push(flag, String(file));
  }

  if (!projectName) throw new Error('projectName is required');
  args.push(projectName);
  return args;
}

/**
 * Build a version/help probe. These run without a project and are the only
 * safe way to confirm the executable actually runs on this host: MAX+PLUS II
 * is a 32-bit Win32 application and may fail to start at all on modern
 * Windows, and -v / -h never touch a design file.
 */
export function buildProbeArgs({ help = false, version = false } = {}) {
  if (help) return ['-h'];
  if (version) return ['-v'];
  throw new Error('probe requires help:true or version:true');
}

/** List .acf projects under a root directory. */
export function findProjects(root, { maxDepth = 6, limit = 500 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(full, depth + 1);
      } else if (/\.acf$/i.test(e.name)) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

/** Timestamped backup of a file. Returns the backup path. */
export function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.${stamp}.bak`;
  fs.copyFileSync(file, dest);
  return dest;
}

export function fileInfo(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, size: null, mtime: null };
  }
}

/** Artifacts the compiler emits next to a project. */
export const ARTIFACT_EXTENSIONS = [
  '.rpt', '.pin', '.summary', '.fit', '.ndb', '.cnf', '.pof', '.sof', '.hex',
  '.ttf', '.jed', '.svf', '.jam', '.jbc', '.rbf', '.sbf', '.tbl', '.tao',
  '.hst', '.snf', '.sym', '.mmf', '.edo', '.vho', '.vo', '.tdo', '.sdo',
];

export function collectArtifacts(projectAcfPath) {
  const dir = path.dirname(projectAcfPath);
  const base = path.basename(projectAcfPath, path.extname(projectAcfPath)).toLowerCase();
  const out = {};
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    if (!ARTIFACT_EXTENSIONS.includes(ext)) continue;
    const stem = lower.slice(0, lower.length - ext.length);
    if (stem !== base) continue;
    out[ext] = path.join(dir, name);
  }
  return out;
}

export function homeDir() {
  return os.homedir();
}

/**
 * Which maxplus2 CLI options the INSTALLED binary actually accepts.
 *
 * Established empirically by test/capabilities.mjs, which runs each option and
 * treats "printed the usage banner / exited non-zero" as rejection.
 *
 * This exists because the shipped `-h` text is generic full-version help: it
 * advertises I/O options that a Baseline build (`maxplus2base`,
 * FULL_VERSION=OFF) then refuses. Generating command lines from the help text
 * therefore produces silently failing invocations.
 *
 * Verified on MAX+PLUS II 10.2 Baseline:
 *   accepted: -c, -i, -ta_delay, -ta_reg, -ta_setup, -convert, -s, -scf, -tbl, -hst
 *   rejected: -tao, -vec, -cmd, -hex, -pof, -rbf, -sbf, -svf, -jam, -j11, -jbc, -jb1
 *
 * Notably `-pof` is REJECTED, yet compiling still writes <project>.pof for free,
 * and `-tbl` works but the process then exits 1 even though the simulation
 * succeeded. Both facts are encoded in the runner rather than assumed.
 */
export const CAPABILITY = {
  verified: true,
  build: 'Baseline (maxplus2base)',
  accepted: ['-c', '-i', '-ta_delay', '-ta_reg', '-ta_setup', '-convert', '-s', '-scf', '-tbl', '-hst'],
  rejected: ['-tao', '-vec', '-cmd', '-hex', '-pof', '-rbf', '-sbf', '-svf', '-jam', '-j11', '-jbc', '-jb1'],
  notes: [
    'Compiling always writes <project>.pof/.rpt/.pin/.snf even without -pof, because -pof is not accepted.',
    'A successful simulation may exit 1; judge it by the .tbl artifact and the "simulation was successful" banner, never by the exit code.',
    'The -h text lists options this build does not accept.',
  ],
};

/**
 * Run a headless simulation and return the parsed result table.
 *
 * Simulation requires an .scf (or .vec) stimulus whose signal names exist in
 * the compiled netlist. A mismatched stimulus produces hundreds of
 * "SNF input node ... does not exist in the current SCF" warnings and, once the
 * mismatch is severe enough, no .tbl at all — so the runner reports both the
 * banner text and whether the table actually materialised.
 */
export async function simulateAndCollect({ executable, projectName, cwd, scf, tbl, timeoutMs, onSpawn, signal }) {
  const tblName = tbl ?? `${projectName}.tbl`;
  const tblPath = path.isAbsolute(tblName) ? tblName : path.join(cwd, tblName);
  if (signal?.aborted) throw new Error('simulation cancelled before preparing the result table');
  // Refuse to spawn if the previous table cannot be removed: it must never
  // become evidence of success for a new run.
  try { if (fs.existsSync(tblPath)) fs.unlinkSync(tblPath); }
  catch (error) { throw new Error(`Cannot remove previous result table ${tblPath}; simulation was not started: ${error.message}`, { cause: error }); }

  const args = ['-s'];
  if (scf) args.push('-scf', String(scf));
  args.push('-tbl', tblName, projectName);

  const result = await runProcess(executable, args, { cwd, timeoutMs, onSpawn, signal });
  const combined = `${result.stdout}${result.stderr}`;

  const banner = combined.match(/Project simulation was successful/i) ? 'successful'
    : /Project simulation failed/i.test(combined) ? 'failed'
      : 'unknown';
  const endedAt = combined.match(/Simulation ended at\s*([\d.]+\s*\w+)/i)?.[1] ?? null;
  const stabilizedAt = combined.match(/Circuit stabilized at\s*([\d.]+\s*\w+)/i)?.[1] ?? null;
  const coverage = combined.match(/Simulation coverage:\s*(\d+)%/i)?.[1];
  const counts = {
    errors: Number(combined.match(/^\s*(\d+)\s+errors?\s*$/im)?.[1] ?? 0),
    warnings: Number(combined.match(/^\s*(\d+)\s+warnings?\s*$/im)?.[1] ?? 0),
  };
  const missingNodes = [...combined.matchAll(/SNF input node '([^']+)' does not exist/gi)]
    .map((m) => m[1]);
  const tblCreated = fs.existsSync(tblPath) && fs.statSync(tblPath).isFile();
  const tblSize = tblCreated ? fs.statSync(tblPath).size : null;
  const verified = banner === 'successful' && counts.errors === 0
    && !result.aborted && !result.timedOut && tblCreated && tblSize > 0;

  return {
    args,
    exitCode: result.code,
    timedOut: result.timedOut,
    aborted: result.aborted,
    durationMs: result.durationMs,
    banner,
    endedAt,
    stabilizedAt,
    coveragePercent: coverage === undefined ? null : Number(coverage),
    counts,
    undrivenNodes: [...new Set(missingNodes)],
    tblPath,
    tblCreated,
    tblSize,
    // The exit code is deliberately not used as the verdict.
    verdict: verified ? 'verified'
      : (banner === 'successful' && !tblCreated ? 'ran-without-table' : 'not-verified'),
    evidence: 'Verification requires a completed, uncancelled run, a success banner, zero reported errors and a newly created nonempty result table; exit code alone is insufficient.',
  };
}
