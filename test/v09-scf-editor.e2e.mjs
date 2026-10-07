/** Independent MAX+plus II 10.2 acceptance: fresh SCF stimulus only, no VEC. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {TOOLS} from '../server.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {exportNetlist} from '../lib/netlist.mjs';
import {parseTbl, tblTrace} from '../lib/tbl.mjs';
import {readScfWaveforms, parseScfRecords} from '../lib/scf.mjs';
import {createScfStructure, inspectScfStructure} from '../lib/scf-structure.mjs';
import {editScfStimuli, compiledScfPortCatalog, createScfFromCompiledPorts, importScfCompiledPorts} from '../lib/scf-editor-metadata.mjs';
const install = detectInstall();
if (!install) { console.log('SKIP: MAX+plus II unavailable'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v09-scf-editor-'));
const call = (name, args) => TOOLS.find(t => t.name === name).handler(args);
const sha = b => createHash('sha256').update(b).digest('hex');
const manifest = {vendor: 'MAX+plus II 10.2', root: install.root, scenarios: []};
let passed = 0;
try {
  async function project(name, range) {
    const source = `LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY ${name} IS PORT (A : IN STD_LOGIC_VECTOR(${range}); EN : IN STD_LOGIC; Q : OUT STD_LOGIC_VECTOR(${range})); END ${name};\nARCHITECTURE rtl OF ${name} IS BEGIN Q <= A WHEN EN = '1' ELSE "000"; END rtl;\n`;
    const created = await call('project_create', {workspace: dir, name, device: 'EP1K10TC100-1', source, confirm: true});
    const compiled = await call('maxplus2_run', {project: created.project, compile: true, root: install.root, timeoutMs: 120000});
    assert.equal(compiled.report?.clean, true, JSON.stringify(compiled)); passed++;
    const exported = await exportNetlist({source: created.project, root: install.root, timeoutMs: 120000});
    assert.equal(exported.verdict, 'verified-export'); assert.equal(exported.compile.counts.error, 0); assert.equal(exported.compile.counts.warning, 0);
    const output = exported.exportPaths.find(p => p.extension === '.edo' && path.basename(p.path, '.edo') === name);
    assert.ok(output); const edif = fs.readFileSync(output.path, 'latin1');
    const catalog = compiledScfPortCatalog(edif); assert.equal(catalog.complete, true); passed++;
    return {...created, edif, catalog, inputNames: catalog.nodes.filter(n => n.role === 'input').map(n => n.name), outputNames: catalog.nodes.filter(n => n.role === 'output').map(n => n.name)};
  }
  const descending = await project('descending', '2 DOWNTO 0');
  assert.deepEqual(descending.inputNames, ['A2', 'A1', 'A0', 'EN']);
  assert.deepEqual(descending.outputNames, ['Q2', 'Q1', 'Q0']); passed++;
  async function simulate(proj, label, buffer) {
    const work = path.join(dir, label); fs.mkdirSync(work);
    for (const name of fs.readdirSync(proj.directory)) if (/\.(acf|vhd|snf|cnf)$/i.test(name)) fs.copyFileSync(path.join(proj.directory, name), path.join(work, name));
    const scf = path.join(work, `${proj.name ?? path.basename(proj.project, '.acf')}.scf`), name = path.basename(proj.project, '.acf');
    fs.writeFileSync(scf, buffer); assert.equal(fs.existsSync(path.join(work, `${name}.vec`)), false);
    const result = await call('simulate_and_verify', {project: path.join(work, `${name}.acf`), root: install.root, timeoutMs: 120000});
    assert.equal(result.verdict, 'verified', JSON.stringify(result)); assert.deepEqual(result.counts, {errors: 0, warnings: 0}, JSON.stringify(result));
    const text = fs.readFileSync(result.tblPath, 'latin1'), parsed = parseTbl(text), trace = tblTrace(parsed), rewritten = fs.readFileSync(scf);
    assert.equal(inspectScfStructure(rewritten).complete, true);
    for (const n of proj.outputNames) assert.ok(parsed.outputs.includes(n), `native output ${n} was explicitly selected`);
    const inputRecords = parseScfRecords(buffer).records.filter(r => proj.inputNames.includes(r.name));
    for (const r of inputRecords) {
      const after = parseScfRecords(rewritten).records.find(s => s.name === r.name);
      assert.ok(after); assert.deepEqual(rewritten.subarray(after.waveformStart, after.waveformStart + 17), buffer.subarray(r.waveformStart, r.waveformStart + 17));
    }
    manifest.scenarios.push({label, directory: work, sourceScfSha256: sha(buffer), vendorScfSha256: sha(rewritten), tblSha256: sha(Buffer.from(text, 'latin1')), counts: result.counts, outputs: parsed.outputs});
    return {trace, parsed, text, rewritten};
  }
  {
    let buffer = createScfFromCompiledPorts(descending.edif, {durationNs: 400}).buffer;
    buffer = editScfStimuli(buffer, [{type: 'counter', signals: ['A2', 'A1', 'A0'], intervalNs: 40.1, startValue: 5}, {type: 'clock', signal: 'EN', periodNs: 200, highNs: 80.3}]).buffer;
    const result = await simulate(descending, 'compiled-clock-counter', buffer);
    for (const row of result.trace.filter(r => r.time < 400)) {
      const ticks = Math.round(row.time * 10), count = (5 + Math.floor(ticks / 401)) % 8;
      assert.equal(['A2', 'A1', 'A0'].map(n => row.rawInputs[n][0]).join(''), count.toString(2).padStart(3, '0'));
      assert.equal(row.rawInputs.EN[0], ticks % 2000 < 803 ? '1' : '0');
    }
    for (const time of [25, 65, 110, 160, 225, 265, 310, 365]) {
      const settled = result.trace.filter(r => r.time <= time).at(-1), count = (5 + Math.floor(time / 40.1)) % 8, expected = time % 200 < 80.3 ? count : 0;
      assert.equal(['Q2', 'Q1', 'Q0'].map(n => settled.rawValues[n]).join(''), expected.toString(2).padStart(3, '0'), `settled Q at ${time} ns`);
    }
    passed++; console.log('PASS compiled top-level nodes: no-VEC SCF clock/counter accepted; every vendor input row and eight independent settled outputs match the arithmetic oracle');
  }
  {
    const existing = createScfStructure({durationNs: 400, inputs: descending.inputNames.map(name => ({name, events: [{time: 0, value: name === 'EN' || name === 'A2' ? 1 : 0}]}))}).buffer;
    const originalHash = sha(existing), imported = importScfCompiledPorts(existing, descending.edif).buffer;
    assert.equal(sha(existing), originalHash); assert.equal(readScfWaveforms(imported, {signal: 'Q2'}).signals[0].valueAtStart, 'X');
    const result = await simulate(descending, 'append-observable-outputs', imported);
    const settled = result.trace.filter(r => r.time <= 100).at(-1);
    assert.deepEqual(['Q2', 'Q1', 'Q0'].map(n => settled.rawValues[n]), ['1', '0', '0']);
    passed++; console.log('PASS missing compiled outputs appended: native TBL computes Q=100 from preserved initial stimuli; X placeholders replaced by native results');
  }
  {
    let buffer = createScfFromCompiledPorts(descending.edif, {durationNs: 400}).buffer;
    buffer = editScfStimuli(buffer, [{type: 'repeat', signal: 'A0', pattern: [{durationNs: 80, value: 0}, {durationNs: 80, value: 1}, {durationNs: 80, value: 'X'}, {durationNs: 80, value: 'Z'}]},
      {type: 'copy_range', from: 'A0', to: 'A1', sourceStart: 0, sourceEnd: 240, targetStart: 40}, {type: 'invert', signal: 'A1'},
      {type: 'shift', signal: 'A1', deltaNs: 12.5, fillValue: 'Z'}, {type: 'fill_range', signal: 'EN', value: 1}]).buffer;
    const result = await simulate(descending, 'repeat-copy-invert-shift', buffer);
    const a0Expected = [[0, '0'], [80, '1'], [160, 'X'], [240, 'Z'], [320, '0']];
    const a1Expected = [[0, 'Z'], [12.5, '1'], [132.5, '0'], [212.5, 'X'], [292.5, '1']];
    for (const [time, value] of a0Expected) assert.equal(result.trace.find(r => r.time === time).rawInputs.A0[0], value);
    for (const [time, value] of a1Expected) assert.equal(result.trace.find(r => r.time === time).rawInputs.A1[0], value);
    passed++; console.log('PASS repeat/copy/invert/shift: all independently predicted 0/1/X/Z transition times read exactly by native Simulator');
  }
  const ascending = await project('ascending', '0 TO 2');
  assert.deepEqual(ascending.inputNames, ['A0', 'A1', 'A2', 'EN']); assert.deepEqual(ascending.outputNames, ['Q0', 'Q1', 'Q2']); passed++;
  {
    let buffer = createScfFromCompiledPorts(ascending.edif, {durationNs: 400}).buffer;
    buffer = editScfStimuli(buffer, [{type: 'counter', signals: ['A0', 'A1', 'A2'], intervalNs: 100, startValue: 5, step: -1}, {type: 'fill_range', signal: 'EN', value: 1}]).buffer;
    const result = await simulate(ascending, 'ascending-vector-indices', buffer);
    for (const [i, time] of [50, 150, 250, 350].entries()) {
      const settled = result.trace.filter(r => r.time <= time).at(-1), expected = (5 - i).toString(2).padStart(3, '0');
      assert.equal(['A0', 'A1', 'A2'].map(n => settled.rawInputs[n][0]).join(''), expected);
      assert.equal(['Q0', 'Q1', 'Q2'].map(n => settled.rawValues[n]).join(''), expected);
    }
    passed++; console.log('PASS ascending vector: explicit 0-to-2 EDIF range produces A0/A1/A2 native nodes; descending arithmetic and settled outputs match independently');
  }
  fs.writeFileSync(path.join(dir, 'oracle-results.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`OK passed=${passed} failed=0\nFixtures retained at ${dir}`);
} catch (error) { console.error(`FAIL passed=${passed} failed=1\n${error.stack}\nArtifacts: ${dir}`); process.exitCode = 1; }
