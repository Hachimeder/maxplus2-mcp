import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseGdfGeometry, tokeniseGdfGeometry, rebuildGdfGeometry, gdfPlacementTransform, gdfTransformPoint, gdfStretchPlacement } from '../lib/gdf-geometry.mjs';
const install=process.env.MAXPLUS2_ROOT;

// Captured from our own original MAX+plus II Graphic Editor drawings, not copied
// from the vendor library. The oracle actions and source files are in research.
const HEADER = '4744460000000600006503020244';
const BLANK = Buffer.from(HEADER + '666a7007d00474', 'hex');
const DIAGONAL = Buffer.from(HEADER + '666a7007d0046dc800500468011004400774', 'hex');
const shorts = (...values) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const str = (text, narrow = false) => { const b = Buffer.from(text, 'latin1'); return Buffer.concat([Buffer.from([narrow ? 0x73 : 0x76]), narrow ? Buffer.from([b.length]) : shorts(b.length), b, Buffer.from([0])]); };
const q = (attrType, fontCode, text, { metrics, font, alternative, parameterOffset } = {}) => Buffer.concat([Buffer.from([0x71, attrType, fontCode]), shorts(4, 8), Buffer.from([0x6b, 0x80]), ...(fontCode >= 4 ? [str(font ?? 'Arial,8')] : []), ...(metrics ? [shorts(...metrics)] : []), str(text), ...(alternative !== undefined ? [str(alternative)] : []), ...(parameterOffset !== undefined ? [shorts(parameterOffset)] : [])]);
const wrap = body => Buffer.concat([BLANK.subarray(0, 20), body, Buffer.from([0x74])]);

test('original blank and diagonal oracles decode sheet units and exact coordinates', () => {
  const blank = parseGdfGeometry(BLANK); assert.equal(blank.header.version, 6); assert.equal(blank.header.size, 8); assert.equal(blank.header.streamPrefixSize, 14);
  assert.deepEqual(blank.sheet.extent, { width: 1904, height: 1232 }); assert.equal(blank.sheet.primitives.length, 0);
  const line = parseGdfGeometry(DIAGONAL).sheet.drawingLines[0]; assert.deepEqual(line.start, { x: 200, y: 1104 }); assert.deepEqual(line.end, { x: 360, y: 1040 }); assert.equal(line.opcode, 'm'); assert.equal(line.knownFlags, 0);
});

test('real wire width flag distinguishes a bus without treating its opcode as a bus type', () => {
  const wire = Buffer.concat([Buffer.from([0x6b]), shorts(200, 944, 440, 944), Buffer.from([0x40, 0x07])]);
  const bus = Buffer.concat([Buffer.from([0x6b]), shorts(200, 904, 440, 904), Buffer.from([0xa0, 0x92])]);
  const p = parseGdfGeometry(wrap(Buffer.concat([wire, bus]))); assert.equal(p.sheet.wires.length, 1); assert.equal(p.sheet.buses.length, 1); assert.equal(p.sheet.buses[0].opcode, 'k'); assert.equal(p.sheet.buses[0].knownFlags, 32);
});

test('strict reader rejects every truncated oracle prefix, unknown opcode and extra trailer', () => {
  for (let i = 0; i < DIAGONAL.length; i++) assert.throws(() => parseGdfGeometry(DIAGONAL.subarray(0, i)));
  assert.throws(() => parseGdfGeometry(wrap(Buffer.from([0x78]))), /Unknown GDF opcode/);
  assert.throws(() => parseGdfGeometry(Buffer.concat([BLANK, Buffer.from([0])])), /trailer/);
});

test('required metadata, extent and modern version guards reject unsupported streams', () => {
  const wrongVersion = Buffer.from(BLANK); wrongVersion.writeUInt16LE(1, 6); assert.throws(() => parseGdfGeometry(wrongVersion), /version/);
  const missingE = Buffer.concat([BLANK.subarray(0, 9), BLANK.subarray(14)]); assert.throws(() => parseGdfGeometry(missingE), /source metadata/);
  assert.throws(() => parseGdfGeometry(Buffer.from(HEADER + '6674', 'hex')), /extent j/);
  const wrongSource = Buffer.from(BLANK); wrongSource[10] = 4; assert.throws(() => parseGdfGeometry(wrongSource), /marker 3/);
});

test('text parser consumes labels with nonzero prior high byte and exposes exact editable spans', () => {
  const bytes = wrap(q(0, 0, 'GDF_ORACLE')); const a = parseGdfGeometry(bytes).sheet.attributes[0];
  assert.equal(a.text, 'GDF_ORACLE'); assert.equal(a.rawFlags, 0x806b); assert.equal(a.kindCode, 0);
  assert.equal(bytes.subarray(a.textRecord.payloadOffset, a.textRecord.payloadOffset + a.textRecord.length).toString('latin1'), a.text);
  const damaged = Buffer.from(bytes); damaged[a.textRecord.end - 1] = 65; assert.throws(() => parseGdfGeometry(damaged), /NUL terminator/);
});

test('font byte >=4 governs metrics rather than testing a single bit', () => {
  const a = parseGdfGeometry(wrap(q(0x13, 5, 'DYNAMIC', { font: 'Arial,10', metrics: [70, 15] }))).sheet.attributes[0];
  assert.equal(a.fontCode, 5); assert.equal(a.font, 'Arial,10'); assert.deepEqual(a.metrics, { width: 70, height: 15 }); assert.equal(a.text, 'DYNAMIC');
});

test('q owns alternate strings, special unfonted metrics and parameter offset tail', () => {
  const special = parseGdfGeometry(wrap(q(0x32, 0, 'LABEL', { metrics: [42, 12], alternative: 'ALIAS' }))).sheet.attributes[0];
  assert.deepEqual(special.metrics, { width: 42, height: 12 }); assert.equal(special.alternative, 'ALIAS');
  const symbol = Buffer.concat([Buffer.from([0x67, 0x66, 0x6a]), shorts(48, 32), q(1, 0, 'PARAM'), Buffer.from([0x72]), shorts(100, 200), Buffer.from([0, 0x75]), q(0x37, 0, 'WIDTH', { metrics: [16, 10], alternative: '8', parameterOffset: -3 })]);
  const a = parseGdfGeometry(wrap(symbol)).placements[0].attributes[0]; assert.equal(a.nativeType, 10); assert.equal(a.parameterOffset, -3); assert.equal(a.alternative, '8');
  assert.throws(() => parseGdfGeometry(wrap(str('standalone'))), /Unknown GDF opcode/);
});

test('all eight original-reader transforms preserve grid rounding for negative intermediates', () => {
  const pos = { x: 100, y: 200 }, extent = { width: 64, height: 40 }, p = { x: 16, y: 8 };
  const expected = [{ x:116,y:208 },{ x:140,y:200 },{ x:148,y:232 },{ x:116,y:232 },{ x:116,y:232 },{ x:148,y:208 },{ x:140,y:232 },{ x:116,y:200 }];
  for (let code = 0; code < 8; code++) assert.deepEqual(gdfTransformPoint(p, gdfPlacementTransform(pos, extent, code)), expected[code]);
  assert.equal(gdfPlacementTransform(pos, extent, 8), null);
  assert.deepEqual(gdfPlacementTransform(pos, extent, 1), [0, 1, -1, 0, 148, 184]);
});

test('byte slices reassemble actual oracle files exactly and retain opaque flag bits', () => {
  assert.deepEqual(rebuildGdfGeometry(tokeniseGdfGeometry(DIAGONAL)), DIAGONAL);
  const token = tokeniseGdfGeometry(DIAGONAL).find(t => t.opcode === 'm'); assert.equal(token.flags, 0x0740); assert.equal(token.offset, 20); assert.equal(token.body.length, 11);
});

test('definition geometry order and misplaced pins are rejected before editable output', () => {
  const l = Buffer.concat([Buffer.from([0x6c]), shorts(8, 0, 8, 8), shorts(0)]), k = Buffer.concat([Buffer.from([0x6b]), shorts(0, 8, 8, 8), shorts(0)]);
  assert.throws(() => parseGdfGeometry(wrap(Buffer.concat([l, k]))), /original-reader order/);
  assert.throws(() => parseGdfGeometry(wrap(Buffer.concat([Buffer.from([0x70]), shorts(0, 0)]))), /preceding graphical attribute/);
});

test('long input labels reconstruct original symbol extensions and world pins', () => {
  const body = Buffer.concat([Buffer.from([0x67, 0x66, 0x6a]), shorts(168, 16), q(3, 0, '1'), Buffer.from([0x70]), shorts(168, 8), q(1, 0, 'INPUT'), Buffer.from([0x72]), shorts(32, 376), Buffer.from([0, 0x68]), q(5, 0, 'VERY_LONG_INPUT_NODE')]);
  const p = parseGdfGeometry(wrap(body)); assert.equal(p.placements[0].transform.understood, true); assert.deepEqual(p.placements[0].pins[0].worldPosition, {x:200,y:384}); assert.equal(p.understood.allPlacements, true); assert.equal(p.placements[0].transform.extension.source, 'decoded-text-driven-stretch'); assert.equal(p.placements[0].transform.extension.left, 96);
});

test('vendor AND5 placements map named pin stubs onto independently stored wire endpoints', { skip: !install || !fs.existsSync(path.join(install,'max2lib/edif/and5.gdf')) }, () => {
  const p = parseGdfGeometry(fs.readFileSync(path.join(install,'max2lib/edif/and5.gdf')));
  const input = p.placements.find(i => i.symbolName === 'INPUT' && i.nodeName === 'IN1'); assert.deepEqual(input.position, { x:32,y:376 }); assert.deepEqual(input.pins[0].localPosition, { x:168,y:8 }); assert.deepEqual(input.pins[0].worldPosition, { x:200,y:384 });
  const and = p.placements.find(i => i.symbolName === 'AND6'); const pin = and.pins.find(pin => pin.name === '3'); assert.deepEqual(pin.worldPosition, { x:272,y:384 }); assert.ok(p.sheet.wires.some(w => w.start.x === 200 && w.start.y === 384 && w.end.x === 272 && w.end.y === 384));
  assert.equal(p.understood.connectivity, false); assert.equal(pin.direction, 'undetermined');
});

test('installed vendor corpus validates strict grammar and every token boundary without resync', { skip: !install || !fs.existsSync(path.join(install,'max2lib')) }, () => {
  const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : ['.gdf','.sym'].includes(path.extname(e.name).toLowerCase()) ? [path.join(dir,e.name)] : []);
  const files = walk(path.join(install,'max2lib')); assert.ok(files.length > 0); console.log(`GDF/SYM corpus: ${files.length} files`);
  for (const filename of files) { const b = fs.readFileSync(filename); const parsed = parseGdfGeometry(b); assert.equal(parsed.understood.framing, true, filename); const tokens = tokeniseGdfGeometry(b); assert.deepEqual(rebuildGdfGeometry(tokens), b, filename); for (let i = 1; i < tokens.length; i++) assert.equal(tokens[i].offset, tokens[i - 1].end, filename); }
});

test('all captured original x86 transform and stretching vectors agree', () => {
  const transforms=JSON.parse(fs.readFileSync(new URL('./fixtures/transform-machine-oracle.json',import.meta.url)));
  for(const v of transforms.vectors){const p=gdfTransformPoint({x:v.point[0],y:v.point[1]},gdfPlacementTransform({x:v.location[0],y:v.location[1]},{width:v.size[0],height:v.size[1]},v.orientation,{left:v.extensions[0],right:v.extensions[1]}));assert.deepEqual([p.x,p.y],v.nativeResult);}
  const stretches=JSON.parse(fs.readFileSync(new URL('./fixtures/stretch-machine-oracle.json',import.meta.url)));
  for(const v of stretches.vectors){const p=gdfStretchPlacement({x:123,y:-321},v.width,v.startX,v.orientation);assert.deepEqual([p.position.x,p.position.y],v.location);assert.deepEqual([p.extension.left,p.extension.right],v.extensions);}
  assert.equal(transforms.vectors.length,840);assert.equal(stretches.vectors.length,416);
});
