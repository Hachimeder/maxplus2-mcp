/** Evidence-bounded SCF editor operations. Native private metadata is preserved. */
import {parseScfRecords, readScfWaveforms, editScfWaveforms} from './scf.mjs';
import {inspectScfStructure, editScfStructure, createScfStructure} from './scf-structure.mjs';
import {parseNetlist} from './netlist.mjs';

const MAX_EVENTS = 200000;
const MAX_BYTES = 4 * 1024 * 1024;
const INPUT_PREFIX = Buffer.from('0100010003000100000100000100000000', 'hex');
const OUTPUT_PREFIX = Buffer.from('0200040003000100000100000100000000', 'hex');
const strict = (o, fields, label) => {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !fields.includes(k)))
    throw new Error(`${label} contains unsupported fields`);
};
function tick(ns, label, {positive = false, signed = false} = {}) {
  const n = Math.round(ns * 10);
  if (typeof ns !== 'number' || !Number.isFinite(ns) || !Number.isSafeInteger(n) || Math.abs(ns * 10 - n) > 1e-7
      || Math.abs(n) > 0xffffffff || (!signed && n < 0) || (positive && n < 1))
    throw new Error(`${label} must use exact 0.1 ns ticks within the uint32 range`);
  return n;
}
function level(value) {
  const v = typeof value === 'string' ? value.toUpperCase() : value;
  if (![0, 1, 'X', 'Z'].includes(v)) throw new Error('logic value must be 0, 1, X or Z');
  return v;
}
function coalesce(events) {
  const out = [];
  for (const event of events) {
    if (out.at(-1)?.ticks === event.ticks) out.pop();
    if (!out.length || out.at(-1).value !== event.value) out.push(event);
  }
  if (out.length > MAX_EVENTS) throw new Error('generated waveform exceeds the 200000 event budget');
  return out;
}
const active = (events, t) => {
  let low = 0, high = events.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (events[mid].ticks <= t) low = mid; else high = mid - 1; }
  return events[low].value;
};
function range(op, duration) {
  const start = tick(op.startTime ?? 0, 'startTime'), end = tick(op.endTime ?? duration / 10, 'endTime', {positive: true});
  if (start >= end || end > duration) throw new Error('operation range must satisfy 0 <= startTime < endTime <= SCF duration');
  return {start, end};
}
function replaceRange(old, start, end, replacement, duration) {
  const result = old.filter(e => e.ticks < start);
  result.push(...replacement);
  if (end < duration) result.push({ticks: end, value: active(old, end)});
  result.push(...old.filter(e => e.ticks > end));
  return coalesce(result);
}
function signedInteger(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer or an integer string`);
    return BigInt(value);
  }
  if (typeof value !== 'string' || value.length > 150 || !/^(?:-?\d+|0x[\da-f]+)$/i.test(value))
    throw new Error(`${label} must be a safe integer or decimal/hexadecimal integer string`);
  return BigInt(value);
}
function signalModel(input) {
  const buffer = Buffer.from(input);
  if (buffer.length > MAX_BYTES) throw new Error('SCF editor supports files up to 4 MiB');
  const wave = readScfWaveforms(buffer, {limit: 10000});
  if (wave.header.version !== 4 || !wave.recordFraming || !wave.waveformEncoding)
    throw new Error('SCF stimuli require a fully decoded version 4 waveform');
  const parsed = parseScfRecords(buffer), signals = new Map();
  // The native run chain is already fully validated above. Read the complete chain,
  // not the paginated response (which only contains the first 10000 events).
  for (const s of wave.signals.filter(s => s.role === 'input')) {
    const record = parsed.records.find(r => r.index === s.index), events = [];
    let atTicks = 0;
    const count = buffer.readUInt32LE(record.waveformStart + 17);
    for (let i = 0; i < count; i++) {
      const at = record.waveformStart + 21 + i * 8, value = [0, 1, 'X', 'Z'][buffer.readUInt16LE(at + 6)];
      if (!events.length || events.at(-1).value !== value) events.push({ticks: atTicks, value});
      atTicks += buffer.readUInt32LE(at);
    }
    signals.set(s.name, events);
  }
  return {buffer, parsed, duration: wave.header.durationTicks, signals};
}

/** Known semantic fields and uninterpreted native bytes have separate representations. */
export function inspectScfEditorMetadata(input) {
  const buffer = Buffer.from(input), structure = inspectScfStructure(buffer);
  return {complete: structure.complete, problems: structure.problems, timeRange: structure.timeRange,
    displayOrder: structure.displayOrder, groups: structure.groups,
    metadataRecords: structure.metadataRecords.map(r => ({...r,
      payloadHex: buffer.subarray(r.payloadStart, Math.min(r.payloadStart + 64, r.payloadStart + r.payloadLength)).toString('hex'),
      payloadPreviewTruncated: r.payloadLength > 64})), opaqueTail: structure.opaqueTail,
    supportedStimulusOperations: ['clock', 'repeat', 'counter', 'shift', 'invert', 'fill_range', 'copy_range'],
    supportedCompiledImport: ['top-level scalar input ports', 'top-level scalar output ports', 'range-labeled vector input/output ports'],
    unknownEditorFields: ['cursor positions', 'time markers', 'grid interval', 'zoom', 'per-row drawing style', 'private node references'],
    note: 'Editor-end time is evidenced as a horizon, not a cursor. Uninterpreted metadata is preserved; unknown field meaning is not inferred from byte round trips.'};
}

/** Ordered atomic stimulus transaction. Ranges are half-open and preserve events outside their range. */
export function editScfStimuli(input, operations) {
  const m = signalModel(input);
  if (!Array.isArray(operations) || !operations.length || operations.length > 200) throw new Error('stimulus operations must contain 1..200 entries');
  const changes = [], touched = new Set();
  const get = name => { if (typeof name !== 'string' || !m.signals.has(name)) throw new Error(`editable scalar input not found: ${name}`); return m.signals.get(name); };
  const set = (name, events) => { m.signals.set(name, coalesce(events)); touched.add(name); };
  for (const op of operations) {
    if (!op || typeof op.type !== 'string') throw new Error('every stimulus operation requires a type');
    if (op.type === 'clock' || op.type === 'repeat') {
      strict(op, op.type === 'clock' ? ['type', 'signal', 'periodNs', 'highNs', 'startsHigh', 'startTime', 'endTime']
        : ['type', 'signal', 'pattern', 'startTime', 'endTime'], op.type);
      const old = get(op.signal), {start, end} = range(op, m.duration);
      let pattern;
      if (op.type === 'clock') {
        const period = tick(op.periodNs, 'periodNs', {positive: true}), high = tick(op.highNs ?? op.periodNs / 2, 'highNs', {positive: true});
        if (high >= period) throw new Error('clock highNs must be shorter than periodNs');
        if (op.startsHigh !== undefined && typeof op.startsHigh !== 'boolean') throw new Error('startsHigh must be boolean');
        pattern = op.startsHigh === false ? [{ticks: period - high, value: 0}, {ticks: high, value: 1}]
          : [{ticks: high, value: 1}, {ticks: period - high, value: 0}];
      } else {
        if (!Array.isArray(op.pattern) || !op.pattern.length || op.pattern.length > 10000) throw new Error('repeat pattern requires 1..10000 segments');
        pattern = op.pattern.map(p => { strict(p, ['durationNs', 'value'], 'repeat segment'); return {ticks: tick(p.durationNs, 'durationNs', {positive: true}), value: level(p.value)}; });
      }
      const cycleTicks = pattern.reduce((n, p) => n + p.ticks, 0);
      if (cycleTicks > 0xffffffff) throw new Error('repeat cycle exceeds the uint32 tick range');
      if (pattern.every(p => p.value === pattern[0].value)) {
        set(op.signal, replaceRange(old, start, end, [{ticks: start, value: pattern[0].value}], m.duration));
      } else {
        const count = Math.ceil((end - start) / cycleTicks) * pattern.length;
        if (count > MAX_EVENTS) throw new Error('generated waveform exceeds the 200000 event budget');
        const generated = []; let at = start, i = 0;
        while (at < end) { const p = pattern[i++ % pattern.length]; generated.push({ticks: at, value: p.value}); at += p.ticks; }
        set(op.signal, replaceRange(old, start, end, generated, m.duration));
      }
      changes.push({type: op.type, signal: op.signal, startTime: start / 10, endTime: end / 10, cycleNs: cycleTicks / 10});
    } else if (op.type === 'counter') {
      strict(op, ['type', 'signals', 'intervalNs', 'startValue', 'step', 'startTime', 'endTime'], 'counter');
      if (!Array.isArray(op.signals) || !op.signals.length || op.signals.length > 128 || new Set(op.signals).size !== op.signals.length)
        throw new Error('counter signals require 1..128 unique scalar input names in MSB-to-LSB order');
      const originals = op.signals.map(get), {start, end} = range(op, m.duration), interval = tick(op.intervalNs, 'intervalNs', {positive: true});
      const count = Math.ceil((end - start) / interval);
      if (count * op.signals.length > MAX_EVENTS) throw new Error('counter exceeds the 200000 generated event budget');
      const modulus = 1n << BigInt(op.signals.length), wrap = n => (n % modulus + modulus) % modulus;
      let value = wrap(signedInteger(op.startValue ?? 0, 'startValue'));
      const step = signedInteger(op.step ?? 1, 'step'), generated = op.signals.map(() => []);
      for (let t = start; t < end; t += interval) {
        for (let k = 0; k < generated.length; k++) generated[k].push({ticks: t, value: Number(value >> BigInt(generated.length - 1 - k) & 1n)});
        value = wrap(value + step);
      }
      op.signals.forEach((name, k) => set(name, replaceRange(originals[k], start, end, generated[k], m.duration)));
      changes.push({type: op.type, signals: [...op.signals], intervalNs: interval / 10, startTime: start / 10, endTime: end / 10,
        startValue: String(op.startValue ?? 0), step: String(op.step ?? 1), bitOrder: 'MSB to LSB', overflow: 'wrap modulo 2^width'});
    } else if (op.type === 'invert') {
      strict(op, ['type', 'signal', 'startTime', 'endTime'], 'invert');
      const old = get(op.signal), {start, end} = range(op, m.duration), inv = v => v === 0 ? 1 : v === 1 ? 0 : v;
      const generated = [{ticks: start, value: inv(active(old, start))}, ...old.filter(e => e.ticks > start && e.ticks < end).map(e => ({ticks: e.ticks, value: inv(e.value)}))];
      set(op.signal, replaceRange(old, start, end, generated, m.duration));
      changes.push({type: op.type, signal: op.signal, startTime: start / 10, endTime: end / 10, unknownPolicy: 'preserve X and Z'});
    } else if (op.type === 'shift') {
      strict(op, ['type', 'signal', 'deltaNs', 'fillValue'], 'shift');
      const old = get(op.signal), delta = tick(op.deltaNs, 'deltaNs', {signed: true});
      const fill = level(op.fillValue ?? 0), first = delta > 0 ? fill : active(old, Math.min(-delta, m.duration - 1));
      const generated = [{ticks: 0, value: first}, ...old.map(e => ({ticks: e.ticks + delta, value: e.value})).filter(e => e.ticks >= 0 && e.ticks < m.duration)];
      set(op.signal, generated); changes.push({type: op.type, signal: op.signal, deltaNs: delta / 10, fillValue: fill, durationPolicy: 'fixed horizon; clip translated events; hold final level'});
    } else if (op.type === 'fill_range') {
      strict(op, ['type', 'signal', 'value', 'startTime', 'endTime'], 'fill_range');
      const old = get(op.signal), {start, end} = range(op, m.duration), value = level(op.value);
      set(op.signal, replaceRange(old, start, end, [{ticks: start, value}], m.duration));
      changes.push({type: op.type, signal: op.signal, value, startTime: start / 10, endTime: end / 10});
    } else if (op.type === 'copy_range') {
      strict(op, ['type', 'from', 'to', 'sourceStart', 'sourceEnd', 'targetStart'], 'copy_range');
      const source = get(op.from).map(e => ({...e})), old = get(op.to), start = tick(op.sourceStart, 'sourceStart'), end = tick(op.sourceEnd, 'sourceEnd', {positive: true}), target = tick(op.targetStart, 'targetStart');
      if (start >= end || end > m.duration || target + end - start > m.duration) throw new Error('copied source and destination ranges must fit the SCF horizon');
      const generated = [{ticks: target, value: active(source, start)}, ...source.filter(e => e.ticks > start && e.ticks < end).map(e => ({ticks: e.ticks - start + target, value: e.value}))];
      set(op.to, replaceRange(old, target, target + end - start, generated, m.duration));
      changes.push({type: op.type, from: op.from, to: op.to, sourceStart: start / 10, sourceEnd: end / 10, targetStart: target / 10, overlapPolicy: 'snapshot source before editing'});
    } else throw new Error(`unsupported SCF stimulus operation: ${op.type}`);
  }
  const eventCount = [...touched].reduce((n, name) => n + m.signals.get(name).length, 0);
  if (eventCount > MAX_EVENTS) throw new Error('transaction exceeds the 200000 generated event budget');
  // Underlying writer caps 100000 events per scalar and preserves every unedited scalar and opaque trailer byte.
  const edits = [...touched].map(signal => ({signal, events: m.signals.get(signal).map(e => ({time: e.ticks / 10, value: e.value}))}));
  const result = editScfWaveforms(m.buffer, edits);
  if (result.buffer.length > MAX_BYTES) throw new Error('generated SCF exceeds 4 MiB');
  return {...result, changes, eventCount, note: 'Stimuli changed atomically; old output/internal traces require a fresh vendor simulation. All operation ranges are half-open; all opaque bytes are preserved.'};
}

/** Original-vendor EDIF gives verified top-level names and directions; it does not list all SNF nodes. */
export function compiledScfPortCatalog(edifText) {
  const netlist = parseNetlist(edifText);
  if (!netlist.validation.ok) throw new Error('compiled port import requires a validated EDIF netlist');
  const nodes = [], unsupported = [], excludedConstants = [];
  for (const port of netlist.ports) {
    if (port.direction === 'INPUT' && ['VCC', 'GND'].includes(port.name.toUpperCase())) { excludedConstants.push(port.name); continue; }
    if (!['INPUT', 'OUTPUT'].includes(port.direction)) { unsupported.push({name: port.name, reason: 'INOUT stimulus/observation roles require a separate native-node oracle'}); continue; }
    const role = port.direction.toLowerCase();
    if (!port.dimensions.length) nodes.push({name: port.name, role, portId: port.id, logicalIndex: null});
    else if (port.arrayRange && port.arrayRange.first >= 0 && port.arrayRange.last >= 0 && port.width <= 2000) {
      for (let i = 0; i < port.width; i++) {
        const index = port.arrayRange.first + port.arrayRange.step * i;
        nodes.push({name: `${port.arrayRange.base}${index}`, role, portId: port.id, logicalIndex: index,
          sourceLabel: `${port.arrayRange.base}[${index}]`, naming: 'MAX+plus II 10.2 Simulator flattens nonnegative vector indices'});
      }
    } else unsupported.push({name: port.name, reason: 'array requires an explicit bounded nonnegative range label; ambiguous indices are not invented'});
  }
  if (nodes.length > 2000) throw new Error('compiled port catalog exceeds 2000 scalar nodes');
  const names = new Set();
  for (const node of nodes) {
    if (!node.name || node.name.length > 255 || /[\s\x00-\x1f\x7f]/.test(node.name) || [...node.name].some(c => c.charCodeAt(0) > 255))
      throw new Error(`compiled SCF node name cannot be represented: ${node.name}`);
    if (names.has(node.name.toUpperCase())) throw new Error(`compiled SCF node names collide after native vector flattening: ${node.name}`);
    names.add(node.name.toUpperCase());
  }
  return {design: netlist.design, provenance: netlist.provenance, nodes, unsupported, excludedConstants,
    complete: unsupported.length === 0, nodeScope: 'compiled top-level input/output ports',
    note: 'Synthesized internal EDIF nets are not asserted to be selectable SNF nodes. Built-in VCC/GND are excluded. Vector members follow the explicit source range order.'};
}
function selectNodes(catalog, options) {
  if (options.signals !== undefined) {
    if (!Array.isArray(options.signals) || !options.signals.length || new Set(options.signals).size !== options.signals.length || options.signals.some(n => typeof n !== 'string'))
      throw new Error('signals must be a nonempty unique list of compiled scalar node names');
    return options.signals.map(name => { const node = catalog.nodes.find(n => n.name === name); if (!node) throw new Error(`compiled input/output node not found: ${name}`); return node; });
  }
  if (!catalog.complete) throw new Error('compiled design has unsupported ports; select evidenced scalar signals explicitly');
  if (!catalog.nodes.length) throw new Error('compiled design has no importable input/output nodes');
  return catalog.nodes;
}
function applyOutputRoles(buffer, selected) {
  const output = Buffer.from(buffer), records = parseScfRecords(output).records;
  for (const node of selected.filter(n => n.role === 'output')) {
    const record = records.find(r => r.name === node.name);
    if (!record || !output.subarray(record.waveformStart, record.waveformStart + 17).equals(INPUT_PREFIX))
      throw new Error(`new scalar template differs from the evidenced input layout: ${node.name}`);
    OUTPUT_PREFIX.copy(output, record.waveformStart);
  }
  if (!inspectScfStructure(output).complete || !readScfWaveforms(output).waveformEncoding) throw new Error('compiled port import failed SCF structural validation');
  return output;
}

/** Create both input stimuli and observable outputs from a validated compiled top-level interface. */
export function createScfFromCompiledPorts(edifText, options) {
  strict(options, ['durationNs', 'signals'], 'compiled SCF creation');
  const catalog = compiledScfPortCatalog(edifText), selected = selectNodes(catalog, options);
  const created = createScfStructure({durationNs: options.durationNs, inputs: selected.map(n => ({name: n.name, events: [{time: 0, value: n.role === 'output' ? 'X' : 0}]}))});
  const buffer = applyOutputRoles(created.buffer, selected);
  return {...created, buffer, changes: [{type: 'create_compiled_ports', nodes: selected, durationNs: created.durationNs}],
    note: 'Created compiled top-level inputs with initial 0 and outputs with placeholder X. A fresh vendor simulation must calculate outputs; no internal-node or INOUT identity is guessed.'};
}

/** Append missing compiled top-level ports without renaming or resetting existing waveforms. */
export function importScfCompiledPorts(input, edifText, options = {}) {
  strict(options, ['signals'], 'compiled SCF port import');
  const catalog = compiledScfPortCatalog(edifText), selected = selectNodes(catalog, options), before = inspectScfStructure(input);
  if (!before.complete) throw new Error('compiled port import requires a supported complete SCF structure');
  const existing = new Map(before.scalars.map(s => [s.name.toUpperCase(), s]));
  const added = [], retained = [];
  for (const node of selected) {
    const old = existing.get(node.name.toUpperCase());
    if (old) {
      if (old.role !== node.role) throw new Error(`existing SCF role disagrees with compiled node ${node.name}`);
      retained.push({name: old.name, compiledName: node.name, role: node.role});
    } else added.push(node);
  }
  if (!added.length) return {buffer: Buffer.from(input), changes: [{type: 'import_compiled_ports', added: [], retained}], durationNs: before.header.durationNs, unit: 'ns', note: 'All selected compiled ports already exist; current events and metadata were retained.'};
  const appended = editScfStructure(input, added.map(n => ({type: 'add_input', name: n.name, events: [{time: 0, value: n.role === 'output' ? 'X' : 0}]})));
  const buffer = applyOutputRoles(appended.buffer, added);
  return {...appended, buffer, changes: [{type: 'import_compiled_ports', added, retained}],
    note: 'Missing compiled top-level ports appended; existing waveforms and native metadata retained. New inputs start at 0; new output observations are X until the vendor Simulator runs.'};
}
