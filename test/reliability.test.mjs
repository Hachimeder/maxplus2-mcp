import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';

import { parseTbl, tblTrace, decodeValue, checkTrace, stimulusCoverage } from '../lib/tbl.mjs';
import { parseReport } from '../lib/report.mjs';
import { collectArtifacts, runProcess, simulateAndCollect } from '../lib/runtime.mjs';
import { TOOLS } from '../server.mjs';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const testClosers = new WeakMap();

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-reliability-'));
  if (!testClosers.has(t)) testClosers.set(t, []);
  t.after(async () => {
    // Windows locks a live tool child's cwd: terminate clients before removing it.
    for (const close of testClosers.get(t)) await close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return root;
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(10);
  }
}

function table({ radix = 'HEX', input = '0A 1', output = '0A 1', groups = true } = {}) {
  return [
    groups ? 'GROUP CREATE A[7..0] = A7 A6 A5 A4 A3 A2 A1 A0 ;' : '',
    groups ? 'GROUP CREATE Q[7..0] = Q7 Q6 Q5 Q4 Q3 Q2 Q1 Q0 ;' : '',
    'INPUTS A[7..0] CLK ;',
    'OUTPUTS Q[7..0] ;',
    'BURIED READY ;',
    'UNIT ns ;',
    `RADIX ${radix} ;`,
    'PATTERN',
    `0.0> ${input} = ${output}`,
  ].filter(Boolean).join('\n');
}

function traceRow(time, output, radix = 'HEX') {
  return { time, inputs: {}, outputs: { Q: output }, buried: {}, radix };
}

// This is Node under a legacy executable name, not an Altera installation.
// It executes an extensionless JavaScript fixture only when given its project
// basename. No test passes compile, simulate, or timing flags to this fixture.
function mockInstall(root) {
  const dir = path.join(root, 'mock install');
  fs.mkdirSync(dir);
  const executable = path.join(dir, 'maxplus2.exe');
  try { fs.linkSync(process.execPath, executable); }
  catch { fs.copyFileSync(process.execPath, executable); }
  assert.ok(fs.existsSync(executable));
  return dir;
}

function mockProject(root, name, delayMs = 400) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const project = path.join(dir, 'worker.acf');
  const events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(project, 'CHIP worker\nBEGIN\nEND;\n');
  fs.writeFileSync(path.join(dir, 'worker'), [
    'const fs = require("node:fs");',
    `const eventFile = ${JSON.stringify(events)};`,
    'const record = event => fs.appendFileSync(eventFile, JSON.stringify({event, pid: process.pid, time: Date.now()}) + "\\n");',
    'record("start");',
    `setTimeout(() => record("end"), ${delayMs});`,
  ].join('\n'));
  return { dir, project, events };
}

function readEvents(project) {
  return fs.existsSync(project.events)
    ? fs.readFileSync(project.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function serverClient(t, workspace) {
  const child = spawn(process.execPath, [serverPath], {
    // A running Windows process locks its cwd. Keep cwd outside the temporary
    // workspace so directory cleanup cannot fail before the close hook runs.
    cwd: path.dirname(serverPath),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MAXPLUS2_WORKSPACE: workspace },
  });
  let buffered = '';
  let stderr = '';
  let nextId = 1;
  const messages = [];
  const waiters = new Set();
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const raw = value => child.stdin.write(`${value}\n`);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        for (const waiter of waiters) waiter.reject(error);
        continue;
      }
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.match(message)) continue;
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  const response = (id, timeoutMs = 5_000) => {
    const found = messages.find(message => message.id === id);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`server response ${String(id)} timed out: ${stderr}`));
      }, timeoutMs);
      const waiter = {
        match: message => message.id === id,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); waiters.delete(waiter); reject(error); },
      };
      waiters.add(waiter);
    });
  };
  const begin = (method, params) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return id;
  };
  const request = (method, params) => response(begin(method, params));
  const call = (name, args) => request('tools/call', { name, arguments: args });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'server failed to close', 2_000)
      .catch(() => { child.kill(); });
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'server failed to terminate');
    for (const waiter of [...waiters]) waiter.reject(new Error('server closed'));
  };
  if (testClosers.has(t)) testClosers.get(t).push(close);
  else t.after(close);
  return {
    child, messages, send, raw, begin, response, request, call, close,
    initialize: async () => {
      const result = await request('initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'reliability-tests', version: '1' },
      });
      assert.equal(result.error, undefined);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result.result;
    },
  };
}

test('grouped HEX inputs do not consume the scalar after an input bus', () => {
  const parsed = parseTbl(table());
  assert.equal(parsed.rows[0].inputLayout, 'grouped');
  assert.deepEqual(tblTrace(parsed)[0].inputs, { 'A[7..0]': 10, CLK: 1 });
  assert.deepEqual(parsed.rows[0].inputs[0].bits, ['0', '0', '0', '0', '1', '0', '1', '0']);
  assert.deepEqual(stimulusCoverage(parsed).undrivenInputs, []);
  assert.deepEqual(parsed.problems, []);
});

test('expanded binary input tokens decode independently of HEX result columns', () => {
  const parsed = parseTbl(table({ input: '0 0 0 0 1 0 1 0 1' }));
  assert.equal(parsed.rows[0].inputLayout, 'expanded');
  const row = tblTrace(parsed)[0];
  assert.deepEqual(row.inputs, { 'A[7..0]': 10, CLK: 1 });
  assert.deepEqual(row.outputs, { 'Q[7..0]': 10 });
  assert.deepEqual(row.buried, { READY: 1 });
});

test('input width comes from bus syntax when GROUP CREATE is absent', () => {
  const parsed = parseTbl(table({ groups: false, input: '0 0 0 0 1 0 1 0 1' }));
  assert.equal(parsed.rows[0].inputs[0].width, 8);
  assert.deepEqual(tblTrace(parsed)[0].inputs, { 'A[7..0]': 10, CLK: 1 });
});

test('declared radices decode both grouped inputs and observable results', async t => {
  for (const [radix, token, value] of [['HEX', '10', 16], ['BIN', '10', 2], ['OCT', '10', 8], ['DEC', '10', 10]]) {
    await t.test(radix, () => {
      const row = tblTrace(parseTbl(table({ radix, input: `${token} 1`, output: `${token} 1` })))[0];
      assert.equal(row.inputs['A[7..0]'], value);
      assert.equal(row.outputs['Q[7..0]'], value);
      assert.equal(row.buried.READY, 1);
    });
  }
});

test('malformed input token counts are reported rather than silently shifted', () => {
  const parsed = parseTbl(table({ input: '0 1 1' }));
  assert.equal(parsed.rows[0].inputLayout, 'invalid');
  assert.match(parsed.problems[0].message, /input token count/i);
  assert.equal(tblTrace(parsed)[0].inputs['A[7..0]'], null);
});

test('numeric decoding rejects unknown suffixes, invalid digits, and unsafe integers', () => {
  for (const token of ['10X', '1Z', 'F-', '1g', '-1', 'X', 'U', '', null, undefined, '20000000000001']) {
    assert.equal(decodeValue(token), null, `HEX token ${String(token)} must not produce a known number`);
  }
  assert.equal(decodeValue('2', 'BIN'), null);
  assert.equal(decodeValue('8', 'OCT'), null);
  assert.equal(decodeValue('A', 'DEC'), null);
  assert.equal(decodeValue('10', 'unsupported'), null);
  assert.equal(decodeValue('AF'), 175);
  assert.equal(decodeValue(['1', '0'], 'BIN'), 2);
});

test('unknown bus values stay unknown in traces and retain their raw token', () => {
  const parsed = parseTbl(table({ input: '1X 1', output: '1X 1' }));
  const row = tblTrace(parsed)[0];
  assert.equal(row.inputs['A[7..0]'], null);
  assert.equal(row.outputs['Q[7..0]'], null);
  assert.deepEqual(row.rawInputs['A[7..0]'], ['1X']);
  assert.equal(row.rawValues['Q[7..0]'], '1X');
  assert.equal(checkTrace(row ? [row] : [], [{ time: 0, outputs: { 'Q[7..0]': 16 } }]).ok, false);
});

test('verification uses the nearest row rather than the first row in tolerance', () => {
  const result = checkTrace([traceRow(0.96, 0), traceRow(1.0, 1)], [{ time: 1, outputs: { Q: 1 } }]);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].matchedRowTime, 1);
  assert.equal(checkTrace([traceRow(0.96, 0)], [{ time: 1, outputs: { Q: 1 } }]).ok, false);
  assert.equal(checkTrace([traceRow(0, 1)], [{ time: 1, outputs: { Q: 1 } }]).ok, false);
});

test('empty, nonnumeric, and invalid expectations cannot prove a simulation correct', () => {
  const rows = [traceRow(0, null)];
  for (const expectation of [{}, [], [{ time: 0, outputs: {} }], [{ time: NaN, outputs: { Q: 1 } }]]) {
    assert.throws(() => checkTrace(rows, expectation), /expectation|finite time|output/i);
  }
  for (const expected of ['not-a-number', '1X', null, NaN, -1, 1.5]) {
    assert.throws(() => checkTrace(rows, [{ time: 0, outputs: { Q: expected } }]), /invalid numeric expectation/i);
  }
  assert.throws(() => checkTrace(rows, { 0: { Q: 1 } }, { tolerance: -1 }), /tolerance/i);
  assert.throws(() => checkTrace(rows, { 0: { Q: 1 } }, { tolerance: Infinity }), /tolerance/i);
});

test('report counts include diagnostics omitted from the retained preview', () => {
  const report = parseReport('Info: retained\nWarning: omitted\nError: omitted failure\nCritical Error: another failure', { maxDiagnostics: 1 });
  assert.deepEqual(report.counts, { error: 2, warning: 1, info: 1 });
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.totalDiagnostics, 4);
  assert.equal(report.truncated, true);
  assert.equal(report.clean, false);
  assert.equal(report.status, 'failed');
  assert.equal(parseReport('Error: still counted', { maxDiagnostics: 0 }).counts.error, 1);
  assert.equal(parseReport('Info: retained', { maxDiagnostics: 1 }).truncated, false);
});

test('a report needs success evidence and cannot hide errors behind a success banner', () => {
  assert.equal(parseReport('').status, 'unknown');
  assert.equal(parseReport('***** Project compilation was successful').status, 'successful');
  assert.equal(parseReport('***** Project compilation was successful\nError: downstream failure').status, 'failed');
});

test('artifact matching does not pick neighboring project basenames', t => {
  const root = temporaryDirectory(t);
  const project = path.join(root, 'top.acf');
  for (const file of ['top.acf', 'TOP.RPT', 'top.pin', 'top2.rpt', 'top_backup.pin', 'topology.pof', 'top.tbl.bak', 'other.sof']) {
    fs.writeFileSync(path.join(root, file), file);
  }
  const result = collectArtifacts(project);
  assert.deepEqual(Object.keys(result).sort(), ['.pin', '.rpt']);
  assert.equal(path.basename(result['.rpt']), 'TOP.RPT');
  assert.equal(path.basename(result['.pin']), 'top.pin');
});

test('runProcess skips spawning when its AbortSignal was already aborted', async t => {
  const root = temporaryDirectory(t);
  const marker = path.join(root, 'unexpected execution.txt');
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], {
    signal: controller.signal, onSpawn: () => { spawned = true; },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(marker), false);
});

test('runProcess aborts a live child, waits for close, and releases its signal listener', async t => {
  const root = temporaryDirectory(t);
  const lateMarker = path.join(root, 'unexpected completion.txt');
  const controller = new AbortController();
  let child;
  let closes = 0;
  let exits = 0;
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); });
  const script = `process.stdout.write('READY'); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(lateMarker)},'ran'),1500);`;
  const result = await runProcess(process.execPath, ['-e', script], {
    timeoutMs: 5_000,
    signal: controller.signal,
    onSpawn: spawned => {
      child = spawned;
      child.once('close', () => { closes++; });
      child.stdout.once('data', () => controller.abort());
    },
    onExit: () => { exits++; },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, false);
  assert.equal(closes, 1);
  assert.equal(exits, 1);
  assert.equal(fs.existsSync(lateMarker), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('runProcess removes its abort listener after normal completion', async () => {
  const controller = new AbortController();
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("done")'], { signal: controller.signal });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'done');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelled simulation leaves the previous table untouched and never spawns', async t => {
  const root = temporaryDirectory(t);
  const tbl = path.join(root,'worker.tbl');
  fs.writeFileSync(tbl,'previous result');
  const controller=new AbortController();controller.abort();
  let spawned=false;
  await assert.rejects(simulateAndCollect({executable:process.execPath,projectName:'worker',cwd:root,signal:controller.signal,onSpawn:()=>{spawned=true;}}),/cancelled before preparing/);
  assert.equal(spawned,false);
  assert.equal(fs.readFileSync(tbl,'utf8'),'previous result');
});

test('simulation refuses to start when a previous result cannot be removed', async t => {
  const root=temporaryDirectory(t);
  fs.mkdirSync(path.join(root,'worker.tbl'));
  let spawned=false;
  await assert.rejects(simulateAndCollect({executable:process.execPath,projectName:'worker',cwd:root,onSpawn:()=>{spawned=true;}}),/Cannot remove previous result table.*not started/);
  assert.equal(spawned,false);
});

test('project queues serialize canonical aliases while independent projects proceed', async t => {
  const root = temporaryDirectory(t);
  const install = mockInstall(root);
  const first = mockProject(root, 'first project');
  const independent = mockProject(root, 'independent project');
  const alias = path.join(root, 'project alias');
  fs.symlinkSync(first.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const run = TOOLS.find(tool => tool.name === 'maxplus2_run').handler;
  await Promise.all([
    run({ project: first.project, root: install }),
    run({ project: path.join(alias, 'worker.acf'), root: install }),
    run({ project: independent.project, root: install }),
  ]);
  const same = readEvents(first);
  const other = readEvents(independent);
  assert.deepEqual(same.map(event => event.event), ['start', 'end', 'start', 'end']);
  assert.deepEqual(other.map(event => event.event), ['start', 'end']);
  assert.ok(other[0].time < same[1].time, 'independent project must start before the first project completes');
});

test('stdio rejects calls before initialization without executing a tool', async t => {
  const client = serverClient(t, temporaryDirectory(t));
  const reply = await client.call('installation_status', {});
  assert.equal(reply.error?.code, -32002);
  await client.initialize();
  assert.deepEqual((await client.request('ping', {})).result, {});
});

test('stdio validates malformed envelopes and keeps the session usable', async t => {
  const client = serverClient(t, temporaryDirectory(t));
  await client.initialize();
  client.raw('{');
  assert.equal((await client.response(null)).error?.code, -32700);
  for (const message of [null, [], { jsonrpc: '1.0', id: 10, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    const before = client.messages.length;
    client.send(message);
    await waitFor(() => client.messages.length > before, 'invalid envelope received no error');
    assert.equal(client.messages.at(-1).error?.code, -32600);
  }
  assert.deepEqual((await client.request('ping', {})).result, {});
});

test('stdio enforces argument shape, unknown fields, booleans, and advertised async', async t => {
  const root = temporaryDirectory(t);
  const project = mockProject(root, 'schema project');
  const client = serverClient(t, root);
  await client.initialize();
  for (const args of [[], null, { unrecognized: true }, { async: true }]) {
    const reply = await client.call('installation_status', args);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result?.isError, true);
    assert.equal(reply.result?.structuredContent?.jobId, undefined);
  }
  const wrongBoolean = await client.call('maxplus2_plan', { project: project.project, compile: 'false' });
  assert.equal(wrongBoolean.result?.isError, true);
  assert.match(wrongBoolean.result.content[0].text, /boolean/i);
  const invalidTimeout = await client.call('probe_executable', { timeoutMs: -1 });
  assert.equal(invalidTimeout.result?.isError, true);
  assert.deepEqual((await client.request('ping', {})).result, {});
  assert.deepEqual(readEvents(project), []);
});

test('a tool notification produces no response and does not disturb the next request', async t => {
  const client = serverClient(t, temporaryDirectory(t));
  await client.initialize();
  const before = client.messages.length;
  client.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'installation_status', arguments: {} } });
  const reply = await client.request('ping', {});
  assert.deepEqual(reply.result, {});
  assert.equal(client.messages.length - before, 1, 'notifications must not elicit an extra response');
});

test('background job cancellation closes its mock process and retains a cancelled result', async t => {
  const root = temporaryDirectory(t);
  const install = mockInstall(root);
  const project = mockProject(root, 'cancel project', 5_000);
  const client = serverClient(t, root);
  await client.initialize();
  const started = await client.call('maxplus2_run', { project: project.project, root: install, async: true });
  const jobId = started.result?.structuredContent?.jobId;
  assert.ok(jobId, JSON.stringify(started));
  await waitFor(() => readEvents(project).length > 0, 'mock process never started');
  const cancelled = await client.call('job_cancel', { jobId });
  assert.equal(cancelled.result?.structuredContent?.status, 'cancelled');
  assert.equal(cancelled.result?.structuredContent?.processesKilled, 1);
  const status = (await client.call('job_status', { jobId })).result.structuredContent;
  assert.equal(status.status, 'cancelled');
  assert.equal(status.runningProcesses, 0);
  assert.equal(status.result, undefined);
  assert.deepEqual(readEvents(project).map(event => event.event), ['start']);
  const repeated = (await client.call('job_cancel', { jobId })).result.structuredContent;
  assert.equal(repeated.cancelled, false);
});

test('cancelling a queued job preserves serialization and prevents its later spawn', async t => {
  const root=temporaryDirectory(t), install=mockInstall(root), project=mockProject(root,'queued cancellation',600);
  const client=serverClient(t,root);await client.initialize();
  const args={project:project.project,root:install,async:true};
  const first=(await client.call('maxplus2_run',args)).result.structuredContent.jobId;
  await waitFor(()=>readEvents(project).length===1,'first job did not start');
  const queued=(await client.call('maxplus2_run',args)).result.structuredContent.jobId;
  const last=(await client.call('maxplus2_run',args)).result.structuredContent.jobId;
  const cancelled=(await client.call('job_cancel',{jobId:queued})).result.structuredContent;
  assert.equal(cancelled.status,'cancelled');
  assert.equal((await client.call('job_status',{jobId:queued})).result.structuredContent.runningProcesses,0);
  await waitFor(()=>readEvents(project).length===4,'uncancelled jobs did not finish');
  assert.deepEqual(readEvents(project).map(e=>e.event),['start','end','start','end']);
  for(const jobId of [first,last]) assert.notEqual((await client.call('job_status',{jobId})).result.structuredContent.status,'cancelled');
});

function processAlive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}

test('standard cancellation stops a synchronous tool child and keeps transport usable', async t => {
  const root=temporaryDirectory(t), install=mockInstall(root), project=mockProject(root,'request cancellation',5_000);
  const client=serverClient(t,root);await client.initialize();
  const requestId=client.begin('tools/call',{name:'maxplus2_run',arguments:{project:project.project,root:install}});
  await waitFor(()=>readEvents(project).length===1,'request child did not start');
  const pid=readEvents(project)[0].pid;
  client.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId,reason:'test'}});
  await waitFor(()=>!processAlive(pid),'cancelled child is still running');
  assert.deepEqual((await client.request('ping',{})).result,{});
  assert.deepEqual(readEvents(project).map(e=>e.event),['start']);
});

test('closing stdio waits for the active synchronous tool child to stop', async t => {
  const root=temporaryDirectory(t), install=mockInstall(root), project=mockProject(root,'shutdown cancellation',5_000);
  const client=serverClient(t,root);await client.initialize();
  client.begin('tools/call',{name:'maxplus2_run',arguments:{project:project.project,root:install}});
  await waitFor(()=>readEvents(project).length===1,'shutdown child did not start');
  const pid=readEvents(project)[0].pid;
  await client.close();
  assert.equal(processAlive(pid),false);
  assert.deepEqual(readEvents(project).map(e=>e.event),['start']);
});
