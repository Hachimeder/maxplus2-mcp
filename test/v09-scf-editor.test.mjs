import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createScfStructure, inspectScfStructure} from '../lib/scf-structure.mjs';
import {readScfWaveforms, parseScfRecords} from '../lib/scf.mjs';
import {inspectScfEditorMetadata, editScfStimuli, compiledScfPortCatalog, createScfFromCompiledPorts, importScfCompiledPorts} from '../lib/scf-editor-metadata.mjs';
const source = () => createScfStructure({durationNs: 100, inputs: [{name: 'A'}, {name: 'B'}, {name: 'C'}]}).buffer;
const events = (b, n) => readScfWaveforms(b, {signal: n, limit: 10000}).signals[0].events.map(({time, value}) => ({time, value}));
const valueAt = (b, n, t) => readScfWaveforms(b, {signal: n, startTime: t}).signals[0].valueAtStart;
const edit = operations => editScfStimuli(source(), operations).buffer;
const edif = (ports = '(port A (direction INPUT)) (port Q (direction OUTPUT))') => `(edif demo (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (library work (cell demo (cellType GENERIC) (view logic (viewType NETLIST) (interface ${ports}) (contents))))
 (design demo (cellRef demo (libraryRef work))))`;

test('metadata reports only evidenced fields and explicitly opaque cursor/zoom/style fields', () => {
  const b = source(), r = inspectScfEditorMetadata(b);
  assert.equal(r.complete, true); assert.equal(r.timeRange.editorEndTicks, 1000);
  assert.ok(r.unknownEditorFields.includes('cursor positions')); assert.ok(r.unknownEditorFields.includes('zoom'));
  assert.deepEqual(r.displayOrder.map(d => d.name), ['A', 'B', 'C']);
  assert.ok(r.metadataRecords.every(r => r.payloadHex.length <= 128));
});
test('clock uses exact fractional ticks, duty cycle and low-start phase while retaining outside range', () => {
  const b = edit([{type: 'clock', signal: 'A', periodNs: 12.3, highNs: 3.1, startsHigh: false, startTime: 10, endTime: 40}]);
  assert.equal(valueAt(b, 'A', 9.9), 0); assert.equal(valueAt(b, 'A', 19.2), 1);
  assert.equal(valueAt(b, 'A', 22.3), 0); assert.equal(valueAt(b, 'A', 40), 0);
  assert.deepEqual(events(b, 'A').slice(0, 5), [{time: 0, value: 0}, {time: 19.2, value: 1}, {time: 22.3, value: 0}, {time: 31.5, value: 1}, {time: 34.6, value: 0}]);
});
test('repeat preserves X/Z and clips final segment without inventing an event at the horizon', () => {
  const b = edit([{type: 'repeat', signal: 'A', pattern: [{durationNs: 12.5, value: 0}, {durationNs: 12.5, value: 1}, {durationNs: 12.5, value: 'X'}, {durationNs: 12.5, value: 'Z'}]}]);
  assert.deepEqual(events(b, 'A').map(e => e.value), [0, 1, 'X', 'Z', 0, 1, 'X', 'Z']);
  assert.equal(valueAt(b, 'A', 99.9), 'Z');
});
test('MSB-first counter wraps, permits negative steps and retains outside windows', () => {
  const b = edit([{type: 'counter', signals: ['A', 'B', 'C'], intervalNs: 10, startValue: '0x1', step: -1, startTime: 5, endTime: 35}]);
  const bits = t => ['A', 'B', 'C'].map(n => valueAt(b, n, t)).join('');
  assert.deepEqual([bits(0), bits(5), bits(15), bits(25), bits(35)], ['000', '001', '000', '111', '000']);
});
test('counter supports integers wider than JS number precision', () => {
  const names = Array.from({length: 64}, (_, i) => `D${63 - i}`), b = createScfStructure({durationNs: 1, inputs: names.map(name => ({name}))}).buffer;
  const r = editScfStimuli(b, [{type: 'counter', signals: names, intervalNs: 0.5, startValue: '0xffffffffffffffff'}]).buffer;
  assert.equal(names.map(n => valueAt(r, n, 0)).join(''), '1'.repeat(64));
  assert.equal(names.map(n => valueAt(r, n, 0.5)).join(''), '0'.repeat(64));
});
test('invert preserves X/Z and shift has explicit clipping and leading fill', () => {
  const b = edit([{type: 'repeat', signal: 'A', pattern: [{durationNs: 25, value: 0}, {durationNs: 25, value: 1}, {durationNs: 25, value: 'X'}, {durationNs: 25, value: 'Z'}]},
    {type: 'invert', signal: 'A'}, {type: 'shift', signal: 'A', deltaNs: 12.5, fillValue: 'Z'}]);
  assert.deepEqual(events(b, 'A'), [{time: 0, value: 'Z'}, {time: 12.5, value: 1}, {time: 37.5, value: 0}, {time: 62.5, value: 'X'}, {time: 87.5, value: 'Z'}]);
  const r = editScfStimuli(b, [{type: 'shift', signal: 'A', deltaNs: -50}]).buffer;
  assert.deepEqual(events(r, 'A'), [{time: 0, value: 0}, {time: 12.5, value: 'X'}, {time: 37.5, value: 'Z'}]);
});
test('fill and overlapping copy use half-open ranges and snapshot the current source', () => {
  const b = edit([{type: 'clock', signal: 'A', periodNs: 20}, {type: 'copy_range', from: 'A', to: 'A', sourceStart: 0, sourceEnd: 30, targetStart: 5},
    {type: 'copy_range', from: 'A', to: 'B', sourceStart: 5, sourceEnd: 35, targetStart: 40}, {type: 'fill_range', signal: 'B', value: 'X', startTime: 45, endTime: 55}]);
  assert.equal(valueAt(b, 'A', 5), 1); assert.equal(valueAt(b, 'A', 15), 0); assert.equal(valueAt(b, 'A', 25), 1);
  assert.equal(valueAt(b, 'B', 40), 1); assert.equal(valueAt(b, 'B', 45), 'X'); assert.equal(valueAt(b, 'B', 55), 0); assert.equal(valueAt(b, 'B', 70), 0);
});
test('input edits preserve complete opaque trailer and every output scalar byte', () => {
  const original = fs.readFileSync(new URL('./fixtures/evaluation/zero.scf', import.meta.url)), parsed = parseScfRecords(original);
  const opaque = Buffer.concat([original, Buffer.from('abcd001122', 'hex')]), result = editScfStimuli(opaque, [{type: 'clock', signal: 'A', periodNs: 50}]).buffer;
  const p = parseScfRecords(result), oldQ = parsed.records.find(r => r.name === 'Q'), newQ = p.records.find(r => r.name === 'Q');
  assert.deepEqual(result.subarray(p.tailOffset), opaque.subarray(parsed.tailOffset));
  assert.deepEqual(result.subarray(newQ.start, newQ.start + newQ.size), original.subarray(oldQ.start, oldQ.start + oldQ.size));
});
test('complete events beyond the default paging limit are retained during range edits', () => {
  const large = createScfStructure({durationNs: 1200, inputs: [{name: 'A', events: Array.from({length: 12000}, (_, i) => ({time: i / 10, value: i % 2}))}]}).buffer;
  const b = editScfStimuli(large, [{type: 'fill_range', signal: 'A', value: 'X', startTime: 1, endTime: 2}]).buffer;
  assert.equal(valueAt(b, 'A', 1100.1), 1); assert.equal(readScfWaveforms(b).signals[0].totalEvents, 11991);
});
test('atomic transactions reject unsupported fields, malformed times, wrong roles and event explosions', () => {
  const b = source(), prior = Buffer.from(b);
  for (const ops of [[{type: 'clock', signal: 'A', periodNs: 0.1}], [{type: 'clock', signal: 'A', periodNs: 10, extra: true}],
    [{type: 'clock', signal: 'A', periodNs: 10, highNs: 10}], [{type: 'clock', signal: 'A', periodNs: 10, startTime: 20, endTime: 10}],
    [{type: 'repeat', signal: 'A', pattern: [{durationNs: 0.01, value: 0}]}], [{type: 'counter', signals: ['A', 'A'], intervalNs: 1}],
    [{type: 'counter', signals: ['A'], intervalNs: 1, startValue: Number.MAX_SAFE_INTEGER + 1}],
    [{type: 'copy_range', from: 'A', to: 'B', sourceStart: 0, sourceEnd: 100, targetStart: 0.1}],
    [{type: 'fill_range', signal: 'A', value: 1}, {type: 'shift', signal: 'missing', deltaNs: 1}]]) assert.throws(() => editScfStimuli(b, ops));
  assert.deepEqual(b, prior);
  const huge = createScfStructure({durationNs: 100000, inputs: [{name: 'A'}]}).buffer;
  assert.throws(() => editScfStimuli(huge, [{type: 'clock', signal: 'A', periodNs: 0.2}]), /budget/);
  const native = fs.readFileSync(new URL('./fixtures/evaluation/zero.scf', import.meta.url));
  assert.throws(() => editScfStimuli(native, [{type: 'invert', signal: 'Q'}]), /editable scalar input/);
});
test('compiled catalog has explicit range order, excludes native constants and refuses invented internal names', () => {
  const text = edif('(port VCC (direction INPUT)) (port GND (direction INPUT)) (port (array (rename A "A[2:0]") 3) (direction INPUT)) (port Q (direction OUTPUT))');
  const r = compiledScfPortCatalog(text);
  assert.deepEqual(r.nodes.map(n => n.name), ['A2', 'A1', 'A0', 'Q']); assert.deepEqual(r.excludedConstants, ['VCC', 'GND']); assert.equal(r.complete, true);
  const ambiguous = compiledScfPortCatalog(edif('(port (array A 3) (direction INPUT)) (port Q (direction OUTPUT)) (port IO (direction INOUT))'));
  assert.equal(ambiguous.complete, false); assert.equal(ambiguous.unsupported.length, 2);
  assert.throws(() => createScfFromCompiledPorts(edif('(port (array A 3) (direction INPUT))'), {durationNs: 100}), /unsupported ports/);
  assert.throws(() => createScfFromCompiledPorts(text, {durationNs: 100, signals: ['LC7']}), /not found/);
  assert.throws(() => compiledScfPortCatalog(edif('(port (array (rename A "A[1:0]") 2) (direction INPUT)) (port A1 (direction INPUT))')), /collide/);
});
test('compiled creation and append create X output observations and retain existing input stimuli', () => {
  const text = edif(), created = createScfFromCompiledPorts(text, {durationNs: 100}).buffer;
  assert.deepEqual(inspectScfStructure(created).scalars.map(s => [s.name, s.role]), [['A', 'input'], ['Q', 'output']]);
  assert.equal(valueAt(created, 'Q', 0), 'X');
  const input = createScfStructure({durationNs: 100, inputs: [{name: 'A', events: [{time: 0, value: 1}]}]}).buffer;
  const appended = importScfCompiledPorts(input, text).buffer;
  assert.equal(valueAt(appended, 'A', 0), 1); assert.equal(valueAt(appended, 'Q', 0), 'X');
  assert.deepEqual(importScfCompiledPorts(appended, text).buffer, appended);
  assert.throws(() => importScfCompiledPorts(source(), edif('(port A (direction OUTPUT))')), /role disagrees/);
  const outputOnly = createScfFromCompiledPorts(text, {durationNs: 100, signals: ['Q']}).buffer;
  assert.equal(inspectScfStructure(outputOnly).scalars[0].role, 'output');
});
