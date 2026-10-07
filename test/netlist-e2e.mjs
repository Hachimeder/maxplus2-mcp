/** Original MAX+plus II only; all compilation is confined to fresh os.tmpdir copies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportNetlist, parseNetlist } from '../lib/netlist.mjs';
import { scanTextRecords } from '../lib/gdf.mjs';

const installation = process.env.MAXPLUS2_ROOT || 'C:\\maxplus2';
const available = fs.existsSync(path.join(installation, 'maxplus2.exe'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normal = value => value.trim().replace(/^\\/, '').toUpperCase();
const quoteRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const endpointKey = (instance, port, member = null) => `${normal(instance || '')}.${normal(port)}${member === null ? '' : `[${member}]`}`;

function temporarySources(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-netlist-e2e-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readExport(result, extension, basename) {
  const file = result.exportPaths.find(item => item.extension === extension && path.basename(item.path, extension) === basename);
  assert.ok(file, `original-vendor ${extension} file was produced`);
  assert.equal(sha(fs.readFileSync(file.path)), file.sha256);
  return fs.readFileSync(file.path, 'latin1');
}

function moduleDeclarations(text) {
  const result = new Map();
  for (const match of text.matchAll(/\bmodule\s+(\w+)\s*\(([\s\S]*?)\)\s*;([\s\S]*?)\bendmodule/g)) {
    result.set(match[1], { ports: match[2].split(',').map(value => value.trim()), body: match[3] });
  }
  return result;
}

// Independent grammar for the vendor's Verilog writer. Positional order comes
// from the separately emitted simulation-library declarations, never from EDIF.
function crossCheckVendorVerilog(result, name) {
  const edif = result.netlistJson[0];
  const vo = readExport(result, '.vo', name);
  const modules = moduleDeclarations(vo + '\n' + readExport(result, '.vo', 'alt_max2'));
  const top = modules.get(name);
  assert.ok(top);
  const declared = [...top.body.matchAll(/\b(input|output|inout)\s+(?:\[([^\]]+)\]\s+)?([^;]+);/g)]
    .flatMap(match => match[3].split(',').map(port => ({ name: normal(port), direction: match[1].toUpperCase(), range: match[2] || null })));
  for (const port of edif.ports.filter(port => !['VCC', 'GND'].includes(normal(port.id)))) {
    const verilogName = port.arrayRange?.base || port.name;
    assert.ok(declared.some(item => item.name === normal(verilogName) && item.direction === port.direction && (port.width === 1 || item.range === `${port.arrayRange.first}:${port.arrayRange.last}`)), `port ${port.name} independently declared in Verilog`);
  }
  const netName = net => net.endpoints.find(endpoint => endpoint.instance === null && endpoint.portBitName)?.portBitName || net.name;
  const endpointNet = new Map(edif.nets.flatMap(net => net.endpoints.map(endpoint => [endpointKey(endpoint.instance, endpoint.port, endpoint.member), normal(netName(net))])));
  for (const instance of edif.instances) {
    const expression = new RegExp(`(?:^|\\n)\\s*(\\w+)\\s+${quoteRegex(instance.id)}\\s*\\(([^;]+)\\)\\s*;`);
    const match = expression.exec(top.body);
    assert.ok(match, `instance ${instance.id} independently emitted in Verilog`);
    assert.ok(match[1].toUpperCase().startsWith(instance.cell.toUpperCase()), `cell type for ${instance.id} agrees`);
    const declaration = modules.get(match[1]);
    assert.ok(declaration, `positional signature for ${match[1]} is in the vendor simulation library`);
    const connections = match[2].includes('.') && /\.\w+\s*\(/.test(match[2])
      ? [...match[2].matchAll(/\.(\w+)\s*\(([^)]*)\)/g)].map(item => [item[1], item[2]])
      : match[2].split(',').map((net, index) => [declaration.ports[index], net]);
    for (const [port, net] of connections) {
      assert.equal(endpointNet.get(endpointKey(instance.id, port)), normal(net), `${instance.id}.${port} agrees between independently parsed EDIF and Verilog`);
    }
    const numberOfEndpoints = edif.nets.reduce((count, net) => count + net.endpoints.filter(item => normal(item.instance || '') === normal(instance.id)).length, 0);
    assert.equal(connections.length, numberOfEndpoints, `all endpoints checked for ${instance.id}`);
  }
  return { ports: declared.length, instances: edif.instances.length, endpoints: edif.counts.endpoints };
}

// Boolean steady-state evaluator used only to check combinational fixture
// behavior. It deliberately ignores timing; production parsing makes no claim
// that this is a replacement for the vendor Simulator.
function evaluateCombinational(edif, inputs) {
  const values = new Map();
  const endpointNet = new Map();
  for (const net of edif.nets) {
    for (const endpoint of net.endpoints) {
      endpointNet.set(endpointKey(endpoint.instance, endpoint.port, endpoint.member), net.id);
      if (endpoint.instance === null) {
        if (normal(endpoint.port) === 'VCC') values.set(net.id, 1);
        else if (normal(endpoint.port) === 'GND') values.set(net.id, 0);
        else if (Object.hasOwn(inputs, endpoint.portBitName || endpoint.port)) values.set(net.id, inputs[endpoint.portBitName || endpoint.port]);
      }
    }
  }
  const viewFor = instance => edif.libraries.find(library => normal(library.id) === normal(instance.library))
    .cells.find(cell => normal(cell.id) === normal(instance.cell)).views.find(view => normal(view.id) === normal(instance.view));
  for (let step = 0; step <= edif.instances.length; step++) {
    let changed = false;
    for (const instance of edif.instances) {
      const view = viewFor(instance);
      const inputPorts = view.ports.filter(port => port.direction === 'INPUT');
      const args = inputPorts.map(port => values.get(endpointNet.get(endpointKey(instance.id, port.id))));
      if (args.some(value => value === undefined)) continue;
      const kind = normal(instance.cell);
      let value;
      if (/^AND\d+$/.test(kind)) value = args.every(Boolean) ? 1 : 0;
      else if (/^OR\d+$/.test(kind)) value = args.some(Boolean) ? 1 : 0;
      else if (/^XOR\d+$/.test(kind)) value = args.reduce((acc, input) => acc ^ input, 0);
      else if (['DELAY', 'BUF', 'AND1', 'OR1'].includes(kind)) value = args[0];
      else if (['NOT', 'INV'].includes(kind)) value = args[0] ^ 1;
      else if (kind === 'TRIBUF') {
        const byName = Object.fromEntries(inputPorts.map((port, index) => [normal(port.id), args[index]]));
        assert.equal(byName.OE, 1, 'fixture output remains enabled');
        value = byName.IN1;
      } else assert.fail(`test evaluator does not support ${kind}`);
      for (const port of view.ports.filter(port => port.direction === 'OUTPUT')) {
        const outputNet = endpointNet.get(endpointKey(instance.id, port.id));
        if (values.get(outputNet) !== value) { values.set(outputNet, value); changed = true; }
      }
    }
    if (!changed) break;
    if (step === edif.instances.length) assert.fail('combinational test graph did not settle');
  }
  return Object.fromEntries(edif.nets.flatMap(net => net.endpoints.filter(endpoint => endpoint.instance === null && endpoint.direction === 'OUTPUT').map(endpoint => [endpoint.portBitName || endpoint.port, values.get(net.id)])));
}

test('vendor AND5 and NAND5: all 64 truth cases plus every Verilog instance endpoint agree', { skip: !available, timeout: 120_000 }, async t => {
  const input = temporarySources(t);
  const evidence = [];
  for (const name of ['and5', 'nand5']) {
    const dir = path.join(input, name);
    fs.mkdirSync(dir);
    const vendor = path.join(installation, 'max2lib', 'edif', `${name}.gdf`);
    const originalBytes = fs.readFileSync(vendor);
    const source = path.join(dir, `${name}.gdf`);
    fs.writeFileSync(source, originalBytes);
    fs.mkdirSync(path.join(dir, 'local-hierarchy'));
    fs.writeFileSync(path.join(dir, 'local-hierarchy', 'memory.mif'), 'DEPTH = 4; WIDTH = 1; ADDRESS_RADIX = HEX; DATA_RADIX = BIN; CONTENT BEGIN [0..3] : 0; END;');
    const result = await exportNetlist({ source, root: installation });
    t.after(() => fs.rmSync(result.scratch, { recursive: true, force: true }));
    assert.equal(result.verdict, 'verified-export', JSON.stringify(result.compile));
    assert.equal(result.sourceIntegrity.unchanged, true);
    assert.equal(result.source.sha256, sha(originalBytes));
    assert.equal(sha(fs.readFileSync(vendor)), sha(originalBytes));
    assert.deepEqual(fs.readFileSync(source), originalBytes);
    assert.ok(result.sourceManifest.some(item => item.relativePath === path.join('local-hierarchy', 'memory.mif')));
    const graph = result.netlistJson[0];
    const checked = crossCheckVendorVerilog(result, name);
    const actual = [];
    for (let mask = 0; mask < 32; mask++) {
      const inputs = Object.fromEntries([1, 2, 3, 4, 5].map((pin, bit) => [`IN${pin}`, (mask >> bit) & 1]));
      const expected = name === 'and5' ? (mask === 31 ? 1 : 0) : (mask === 31 ? 0 : 1);
      const output = evaluateCombinational(graph, inputs).OUT;
      assert.equal(output, expected, `${name}(${JSON.stringify(inputs)})`);
      actual.push(output);
    }
    // A syntactically valid EDIF with a fabricated reference must not receive a
    // connectivity claim, even though all human-readable labels remain present.
    const edo = readExport(result, '.edo', name);
    const corrupt = edo.replace(/\(instanceRef\s+[^)]+\)/, '(instanceRef MISSING_INSTANCE)');
    assert.notEqual(corrupt, edo);
    assert.equal(parseNetlist(corrupt).understood.connectivity, false);
    evidence.push({ source: result.source, counts: graph.counts, checked, truthTable: actual.join(''), exports: result.exportPaths.map(item => ({ extension: item.extension, sha256: item.sha256 })) });
  }
  assert.notEqual(evidence[0].truthTable, evidence[1].truthTable, 'different known circuits remain behaviorally different');
  t.diagnostic(JSON.stringify(evidence));
});

test('invalid GDF symbol cannot produce a verified export or reuse stale outputs', { skip: !available, timeout: 60_000 }, async t => {
  const input = temporarySources(t);
  const source = path.join(input, 'broken.gdf');
  const bytes = Buffer.from(fs.readFileSync(path.join(installation, 'max2lib', 'edif', 'and5.gdf')));
  const symbol = scanTextRecords(bytes).find(record => /^AND\d+$/i.test(record.text));
  assert.ok(symbol, 'fixture contains an independently recognized primitive name');
  bytes.write('X'.repeat(symbol.length), symbol.payloadOffset, symbol.length, 'latin1');
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(path.join(input, 'broken.edo'), '(stale artifact must not be copied)');
  const result = await exportNetlist({ source, root: installation });
  t.after(() => fs.rmSync(result.scratch, { recursive: true, force: true }));
  assert.equal(result.verdict, 'not-verified');
  assert.notEqual(result.compile.reportStatus, 'successful');
  assert.equal(result.compile.successBanner, false);
  assert.match(result.compile.stdoutTail + result.compile.stderrTail, /error|failed|cannot|can't|not found/i);
  assert.equal(result.netlistJson.length, 0);
  assert.equal(result.sourceIntegrity.unchanged, true);
  assert.deepEqual(fs.readFileSync(source), bytes);
});

test('original compiler cancellation closes the owned child before returning', { skip: !available, timeout: 30_000 }, async t => {
  const input = temporarySources(t);
  const source = path.join(input, 'and5.gdf');
  fs.copyFileSync(path.join(installation, 'max2lib', 'edif', 'and5.gdf'), source);
  const controller = new AbortController();
  let child;
  let closed = false;
  const result = await exportNetlist({ source, root: installation, signal: controller.signal, onSpawn: process => {
    child = process;
    child.once('close', () => { closed = true; });
    controller.abort();
  } });
  t.after(() => fs.rmSync(result.scratch, { recursive: true, force: true }));
  assert.ok(child);
  assert.equal(closed, true);
  assert.equal(result.compile.aborted, true);
  assert.equal(result.verdict, 'not-verified');
  assert.equal(result.sourceIntegrity.unchanged, true);
});

test('vendor bus export preserves descending, ascending, and nonzero logical indices for all 256 input cases', { skip: !available, timeout: 60_000 }, async t => {
  const input = temporarySources(t);
  const source = path.join(input, 'buscheck.vhd');
  const text = 'library ieee; use ieee.std_logic_1164.all; entity buscheck is port (a: in std_logic_vector(7 downto 4); b: in std_logic_vector(1 to 4); y: out std_logic_vector(15 downto 12)); end buscheck; architecture logic of buscheck is begin y <= a and b; end logic;';
  fs.writeFileSync(source, text);
  const result = await exportNetlist({ source, root: installation });
  t.after(() => fs.rmSync(result.scratch, { recursive: true, force: true }));
  assert.equal(result.verdict, 'verified-export', JSON.stringify(result.compile));
  const graph = result.netlistJson[0];
  crossCheckVendorVerilog(result, 'buscheck');
  assert.deepEqual(graph.ports.filter(port => port.width > 1).map(port => [port.id, port.arrayRange.first, port.arrayRange.last]), [['a', 7, 4], ['b', 1, 4], ['y', 15, 12]]);
  for (const net of graph.nets) for (const endpoint of net.endpoints) if (endpoint.instance === null && endpoint.member !== null) {
    const expected = endpoint.port === 'a' ? 7 - endpoint.member : endpoint.port === 'b' ? 1 + endpoint.member : 15 - endpoint.member;
    assert.equal(endpoint.logicalIndex, expected);
    assert.equal(endpoint.portBitName, `${endpoint.port}[${expected}]`);
  }
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
    const inputs = Object.fromEntries([0, 1, 2, 3].flatMap(member => [[`a[${7 - member}]`, (a >> (3 - member)) & 1], [`b[${1 + member}]`, (b >> (3 - member)) & 1]]));
    const outputs = evaluateCombinational(graph, inputs);
    const actual = [15, 14, 13, 12].reduce((value, index) => (value << 1) | outputs[`y[${index}]`], 0);
    assert.equal(actual, a & b, `a=${a}, b=${b}`);
  }
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  assert.equal(result.sourceIntegrity.unchanged, true);
  t.diagnostic(JSON.stringify({ source: result.source, counts: graph.counts, cases: 256, arrayRanges: graph.ports.filter(port => port.arrayRange).map(port => ({ port: port.name, range: port.arrayRange })) }));
});
