import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNetlist, configureNetlistAcf, exportNetlist } from '../lib/netlist.mjs';
import { parseAcf } from '../lib/acf.mjs';

const fixture = `(edif demonstration (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
  (library L (edifLevel 0)
    (cell AND2 (cellType GENERIC) (view logic (viewType NETLIST)
      (interface (port I1 (direction INPUT)) (port I2 (direction INPUT)) (port Y (direction OUTPUT)))))
    (cell TOP (cellType GENERIC) (view logic (viewType NETLIST)
      (interface (port A (direction INPUT)) (port B (direction INPUT)) (port OUT (direction OUTPUT) (designator "42")))
      (contents
        (instance gate1 (viewRef logic (cellRef AND2)))
        (net (rename first "a (first)") (joined (portRef A) (portRef I1 (instanceRef gate1))))
        (net second (joined (portRef B) (portRef I2 (instanceRef gate1))))
        (net result (joined (portRef OUT) (portRef Y (instanceRef gate1))))))))
  (design root (cellRef TOP (libraryRef L))))`;

test('EDIF 200 resolves instances, ports, renamed nets, and endpoint directions', () => {
  const result = parseNetlist(fixture);
  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.counts, { ports: 3, instances: 1, nets: 3, endpoints: 6 });
  assert.equal(result.design.cell, 'TOP');
  assert.equal(result.ports.find(port => port.id === 'OUT').pin, '42');
  assert.equal(result.instances[0].cell, 'AND2');
  assert.equal(result.nets[0].name, 'a (first)');
  assert.equal(result.nets[0].endpoints[0].role, 'driver');
  assert.equal(result.nets[0].endpoints[1].role, 'load');
  assert.equal(result.nets[2].endpoints[1].role, 'driver');
  assert.equal(result.understood.originalDrawingGeometry, false);
});

test('EDIF references are case insensitive without losing displayed identifiers', () => {
  const result = parseNetlist(fixture.replace('(cellRef AND2)', '(cellRef and2)').replace('(instanceRef gate1)', '(instanceRef GATE1)'));
  assert.equal(result.validation.ok, true);
  assert.equal(result.instances[0].cell, 'and2');
});

test('array members preserve EDIF indices and validate bus width', () => {
  const text = `(edif bus (edifVersion 2 0 0) (library L (cell TOP (view v (viewType NETLIST)
    (interface (port (array (rename D "D[3..0]") 4) (direction INPUT)))
    (contents (net n (joined (portRef (member D 0)))))))) (design root (cellRef TOP (libraryRef L))))`;
  const parsed = parseNetlist(text);
  assert.equal(parsed.validation.ok, true);
  assert.equal(parsed.ports[0].width, 4);
  assert.equal(parsed.ports[0].name, 'D[3..0]');
  assert.equal(parsed.nets[0].endpoints[0].member, 0);
  assert.equal(parsed.nets[0].endpoints[0].logicalIndex, 3);
  assert.equal(parsed.nets[0].endpoints[0].portBitName, 'D[3]');
  const bad = parseNetlist(text.replace('(member D 0)', '(member D 4)'));
  assert.equal(bad.validation.ok, false);
  assert.equal(bad.understood.connectivity, false);
  assert.ok(bad.validation.problems.some(problem => /mismatch/.test(problem.message)));
});

test('scalar members, mismatched net arrays, repeated declarations, and unknown interface forms are explicit problems', () => {
  for (const text of [
    fixture.replace('(portRef A)', '(portRef (member A 0))'),
    fixture.replace('(net second', '(net (array second 4)'),
    fixture.replace('(direction OUTPUT)', '(direction OUTPUT) (direction INPUT)'),
    fixture.replace('(port A (direction INPUT))', '(portBundle A (port X (direction INPUT)))'),
    fixture.replace('(joined (portRef B)', '(joined (portRef B)) (joined (portRef B)'),
    fixture.replace('(instanceRef gate1)', '(instanceRef gate1) (instanceRef gate1)'),
  ]) {
    assert.equal(parseNetlist(text).validation.ok, false);
  }
  assert.throws(() => parseNetlist(fixture.replace('(design root', '(design duplicate (cellRef TOP (libraryRef L))) (design root')), /exactly one design/);
});

test('missing instances, cells, and ports invalidate connectivity claims', () => {
  for (const mutation of [
    fixture.replace('(instanceRef gate1)', '(instanceRef missing)'),
    fixture.replace('(cellRef AND2)', '(cellRef absent)'),
    fixture.replace('(portRef I1 ', '(portRef absent '),
  ]) {
    const parsed = parseNetlist(mutation);
    assert.equal(parsed.validation.ok, false);
    assert.equal(parsed.understood.connectivity, false);
    assert.ok(parsed.validation.problems.some(problem => problem.type === 'reference'));
  }
});

test('a duplicated endpoint or unsupported joined form is not silently accepted', () => {
  const repeated = parseNetlist(fixture.replace('(portRef B)', '(portRef A)'));
  assert.equal(repeated.validation.ok, false);
  assert.ok(repeated.validation.problems.some(problem => /also connected/.test(problem.message)));
  const unsupported = parseNetlist(fixture.replace('(portRef B)', '(portList (portRef B))'));
  assert.equal(unsupported.validation.ok, false);
  assert.ok(unsupported.validation.problems.some(problem => problem.type === 'unsupported'));
});

test('truncated, non-EDIF, EDIF 300, and alias-level input fail explicitly', () => {
  for (const text of [fixture.slice(0, -1), fixture + ')', '(notedif X)', fixture.replace('2 0 0', '3 0 0'), fixture.replace('keywordLevel 0', 'keywordLevel 1')]) {
    assert.throws(() => parseNetlist(text), /EDIF|parenthesis|root|level/i);
  }
});

test('writer configuration preserves device and pin assignments and is stable', () => {
  const original = 'CHIP top\nBEGIN\n DEVICE = EP1K30TC144-1;\n |A : INPUT_PIN = 43;\nEND;\nCOMPILER_INTERFACES_CONFIGURATION\nBEGIN\n EDIF_NETLIST_WRITER = OFF;\nEND;\n';
  const configured = configureNetlistAcf(original, 'top');
  const parsed = parseAcf(configured.text);
  assert.equal(configured.defaultDevice, null);
  const chip = parsed.sections.find(section => section.name === 'CHIP');
  assert.equal(chip.entries.find(entry => entry.key === 'DEVICE').value, 'EP1K30TC144-1');
  assert.equal(chip.entries.find(entry => /INPUT_PIN/.test(entry.key)).value, '43');
  const iface = parsed.sections.find(section => section.name === 'COMPILER_INTERFACES_CONFIGURATION');
  assert.equal(iface.entries.filter(entry => entry.key === 'EDIF_NETLIST_WRITER').length, 1);
  assert.equal(iface.entries.find(entry => entry.key === 'EDIF_NETLIST_WRITER').value, 'ON');
  assert.equal(configureNetlistAcf(configured.text, 'top').text, configured.text);
  assert.equal(configureNetlistAcf('', 'top').defaultDevice, 'EP1K10TC100-1');
  assert.throws(() => configureNetlistAcf(original, '-option'), /basename/);
});

test('an aborted export never creates scratch or starts a compiler', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(exportNetlist({ source: 'missing.gdf', signal: controller.signal, onSpawn: () => { spawned = true; } }), /cancelled before preparing/);
  assert.equal(spawned, false);
});

test('isolated export rejects an external absolute source path before spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-netlist-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'maxplus2.exe'), 'must never execute');
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir);
  const source = path.join(sourceDir, 'top.vhd');
  fs.writeFileSync(source, '-- external reference "Z:\\external\\component.vhd"');
  const before = fs.readFileSync(source);
  let spawned = false;
  let retainedScratch;
  try {
    await assert.rejects(exportNetlist({ source, root: install, onSpawn: () => { spawned = true; } }), error => {
      retainedScratch = /isolated scratch retained at (.+)\)$/.exec(error.message)?.[1];
      assert.match(error.message, /external absolute path/);
      return true;
    });
  } finally {
    if (retainedScratch) fs.rmSync(retainedScratch, { recursive: true, force: true });
  }
  assert.equal(spawned, false);
  assert.deepEqual(fs.readFileSync(source), before);
});

test('source ambiguity, ancestor paths, and path-prefix collisions are rejected before compiler spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-netlist-isolation-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(install);
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(install, 'maxplus2.exe'), 'must never execute');
  const source = path.join(sourceDir, 'top.vhd');
  fs.writeFileSync(source, '-- unambiguous source');
  const competing = path.join(sourceDir, 'top.gdf');
  fs.writeFileSync(competing, Buffer.from('GDF\0'));
  let spawned = false;
  const run = () => exportNetlist({ source, root: install, onSpawn: () => { spawned = true; } });
  await assert.rejects(run(), /ambiguous top-level design source/);
  fs.unlinkSync(competing);
  for (const text of [`-- "${sourceDir}-sibling\\external.vhd"`, `-- "${install}-sibling\\external.vhd"`, `-- "${install}\\..\\outside.vhd"`, '-- "..\\outside.vhd"']) {
    fs.writeFileSync(source, text);
    let scratch;
    try {
      await assert.rejects(run(), error => {
        scratch = /isolated scratch retained at (.+)\)$/.exec(error.message)?.[1];
        assert.match(error.message, /external absolute path|parent-relative path/);
        return true;
      });
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
    assert.equal(fs.readFileSync(source, 'utf8'), text);
  }
  assert.equal(spawned, false);
});

test('source size limit is checked before reading an oversized dependency', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-netlist-size-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(install);
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(install, 'maxplus2.exe'), 'must never execute');
  const source = path.join(sourceDir, 'top.vhd');
  fs.writeFileSync(source, '-- source');
  const tooLarge = path.join(sourceDir, 'huge.mif');
  const handle = fs.openSync(tooLarge, 'wx');
  fs.ftruncateSync(handle, 32 * 1024 * 1024 + 1);
  fs.closeSync(handle);
  let scratch;
  let readLarge = false;
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === tooLarge) readLarge = true;
    return originalRead.call(this, file, ...args);
  };
  try {
    await assert.rejects(exportNetlist({ source, root: install }), error => {
      scratch = /isolated scratch retained at (.+)\)$/.exec(error.message)?.[1];
      assert.match(error.message, /source copy exceeds/);
      return true;
    });
  } finally {
    fs.readFileSync = originalRead;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(readLarge, false);
});
