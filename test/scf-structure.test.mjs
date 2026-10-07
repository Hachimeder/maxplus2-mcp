import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScfRecords,readScfWaveforms,editScfWaveforms} from '../lib/scf.mjs';
import {inspectScfStructure,editScfStructure,createScfStructure} from '../lib/scf-structure.mjs';
const original=fs.readFileSync(new URL('./fixtures/evaluation/zero.scf',import.meta.url));
const edit=ops=>editScfStructure(original,ops).buffer;
const events=buffer=>readScfWaveforms(buffer,{limit:10000}).signals.map(s=>({name:s.name,events:s.events.map(({time,value})=>({time,value}))}));

test('inspect vendor fixture with explicit record spans and complete display names',()=>{
  const result=inspectScfStructure(original);assert.equal(result.complete,true);assert.deepEqual(result.problems,[]);
  assert.deepEqual(result.displayOrder.map(d=>d.name),['A','B','Q']);assert.equal(result.timeRange.editorEndTicks,6000);
  for(const s of result.scalars)assert.equal(original.subarray(s.nameSpan.offset,s.nameSpan.offset+s.nameSpan.length-1).toString('latin1'),s.name);
});
test('rename growing and shrinking names recalculates all subsequent offsets',()=>{
  const renamed=edit([{type:'rename',signal:'A',name:'A_LONG_NAME'},{type:'rename',signal:'A_LONG_NAME',name:'AA'}]);
  assert.deepEqual(inspectScfStructure(renamed).displayOrder.map(d=>d.name),['AA','B','Q']);
  assert.deepEqual(events(renamed).map(s=>s.events),events(original).map(s=>s.events));
  assert.deepEqual(renamed.subarray(parseScfRecords(renamed).tailOffset),original.subarray(parseScfRecords(original).tailOffset));
});
test('reorder changes references while preserving waveform record bytes',()=>{
  const reordered=edit([{type:'reorder',signals:['Q','B','A']}]),before=parseScfRecords(original),after=parseScfRecords(reordered);
  assert.deepEqual(inspectScfStructure(reordered).displayOrder.map(d=>d.name),['Q','B','A']);
  assert.deepEqual(reordered.subarray(after.firstRecordOffset,after.tailOffset),original.subarray(before.firstRecordOffset,before.tailOffset));
});
test('group member order controls bits; all four evidenced radices are supported',()=>{
  const source=editScfWaveforms(original,[{signal:'A',events:[{time:0,value:0}]},{signal:'B',events:[{time:0,value:1}]}]).buffer;
  for(const [code,radix] of ['BIN','OCT','DEC','HEX'].entries()) {
    const grouped=editScfStructure(source,[{type:'group',name:'PAIR',members:['B','A'],radix}]).buffer;
    const structure=inspectScfStructure(grouped);assert.equal(structure.groups[0].displayCode,code);assert.equal(structure.groups[0].radix,radix);
    assert.deepEqual(structure.groups[0].members,['B','A']);assert.equal(readScfWaveforms(grouped,{signal:'PAIR'}).signals[0].bitsAtStart,'10');
    assert.deepEqual(structure.displayOrder.map(d=>d.name),['PAIR','Q']);assert.deepEqual(structure.scalars.map(s=>s.groupedCode),[1,1,0]);
  }
});
test('rename group and radix edit use new name length, then ungroup restores scalar visibility',()=>{
  const grouped=edit([{type:'group',name:'PAIR',members:['B','A'],radix:'HEX'}]);
  const modified=editScfStructure(grouped,[{type:'rename',signal:'PAIR',name:'LONGER_PAIR'},{type:'radix',signal:'LONGER_PAIR',radix:'DEC'},{type:'ungroup',signal:'LONGER_PAIR'}]).buffer;
  const structure=inspectScfStructure(modified);assert.deepEqual(structure.groups,[]);assert.deepEqual(structure.displayOrder.map(d=>d.name),['B','A','Q']);
  assert.deepEqual(structure.scalars.map(s=>s.groupedCode),[0,0,0]);
});
test('duration crops events at exact boundary and extends with the last active value',()=>{
  const source=editScfWaveforms(original,[{signal:'A',events:[{time:0,value:0},{time:100,value:1},{time:200,value:'X'},{time:300,value:'Z'}]}]).buffer;
  const cropped=editScfStructure(source,[{type:'duration',durationNs:200}]).buffer;
  const wave=readScfWaveforms(cropped,{signal:'A'});assert.equal(wave.header.durationNs,200);assert.deepEqual(wave.signals[0].events.map(e=>e.value),[0,1]);
  assert.equal(wave.signals[0].segments.at(-1).endTime,200);assert.equal(inspectScfStructure(cropped).timeRange.editorEndTicks,2000);
  const extended=editScfStructure(source,[{type:'duration',durationNs:900.1}]).buffer;
  const last=readScfWaveforms(extended,{signal:'A'}).signals[0].segments.at(-1);assert.equal(last.value,'Z');assert.equal(last.endTime,900.1);
});
test('duration and add input order are sequential and validated using current horizon',()=>{
  const buffer=edit([{type:'duration',durationNs:900},{type:'add_input',name:'C',events:[{time:0,value:1},{time:700,value:0}]}]);
  assert.deepEqual(readScfWaveforms(buffer,{signal:'C'}).signals[0].events.map(({time,value})=>({time,value})),[{time:0,value:1},{time:700,value:0}]);
  assert.throws(()=>edit([{type:'add_input',name:'C',events:[{time:0,value:1},{time:700,value:0}]},{type:'duration',durationNs:900}]),/precede/);
});
test('delete first input rebases scalar ID references and group members together',()=>{
  const grouped=edit([{type:'add_input',name:'C'},{type:'group',name:'BC',members:['B','C']}]);
  const deleted=editScfStructure(grouped,[{type:'delete_input',signal:'A'}]).buffer,structure=inspectScfStructure(deleted);
  assert.deepEqual(structure.scalars.map(s=>[s.index,s.name]),[[1,'B'],[2,'Q'],[3,'C']]);assert.deepEqual(structure.groups[0].memberIndices,[1,3]);
  assert.deepEqual(structure.displayOrder.map(d=>d.name),['BC','Q']);assert.equal(readScfWaveforms(deleted).waveformEncoding,true);
});
test('create standalone canonical input file with fractional events and X/Z',()=>{
  const created=createScfStructure({durationNs:73.8,inputs:[{name:'CLK',events:[{time:0,value:0},{time:12.3,value:1},{time:24.6,value:'X'},{time:36.9,value:'Z'}]},{name:'EN'}]});
  assert.equal(inspectScfStructure(created.buffer).complete,true);assert.equal(readScfWaveforms(created.buffer).waveformEncoding,true);
  assert.deepEqual(events(created.buffer)[0].events,[{time:0,value:0},{time:12.3,value:1},{time:24.6,value:'X'},{time:36.9,value:'Z'}]);
});
test('transaction failure after a valid operation never mutates the original',()=>{
  const before=Buffer.from(original);assert.throws(()=>editScfStructure(original,[{type:'rename',signal:'A',name:'NEW_A'},{type:'delete_input',signal:'Q'}]),/scalar input/);
  assert.deepEqual(original,before);
});
test('refuse unverified names, malformed operations, mixed-role groups and invalid time',()=>{
  for(const ops of [[{type:'rename',signal:'A',name:'b'}],[{type:'rename',signal:'A',name:'空间'}],[{type:'rename',signal:'A',name:'A B'}],
    [{type:'reorder',signals:['A','A','Q']}],[{type:'group',name:'AQ',members:['A','Q']}],[{type:'duration',durationNs:12.34}],
    [{type:'duration',durationNs:0}],[{type:'duration',durationNs:1,extra:true}],[{type:'whatever'}]])assert.throws(()=>edit(ops));
  const grouped=edit([{type:'group',name:'AB',members:['A','B']}]);assert.throws(()=>editScfStructure(grouped,[{type:'delete_input',signal:'A'}]),/ungroup/);
  assert.throws(()=>editScfStructure(grouped,[{type:'radix',signal:'AB',radix:'SIGNED'}]),/BIN, OCT, DEC or HEX/);
});
test('preserve framed unknown trailer bytes for name edits but refuse ID/membership edits',()=>{
  const unknown=Buffer.from('990103000000aabbcc','hex'),buffer=Buffer.concat([original,unknown]);
  assert.equal(inspectScfStructure(buffer).complete,true);
  const renamed=editScfStructure(buffer,[{type:'rename',signal:'A',name:'AA'}]).buffer;assert.deepEqual(renamed.subarray(-unknown.length),unknown);
  assert.throws(()=>editScfStructure(buffer,[{type:'add_input',name:'C'}]),/evidenced tags/);
  assert.throws(()=>editScfStructure(buffer,[{type:'group',name:'AB',members:['A','B']}]),/evidenced tags/);
});
test('preserve unframed opaque suffix for rename and report its bounds',()=>{
  const unknown=Buffer.from('aaeeff','hex'),buffer=Buffer.concat([original,unknown]);const inspected=inspectScfStructure(buffer);
  assert.deepEqual(inspected.opaqueTail,{offset:original.length,length:3});
  const renamed=editScfStructure(buffer,[{type:'rename',signal:'A',name:'AA'}]).buffer;assert.deepEqual(renamed.subarray(-3),unknown);
  assert.throws(()=>editScfStructure(buffer,[{type:'delete_input',signal:'A'}]),/entirely framed/);
});
test('malformed display reference, row count and preamble are diagnosed and cannot be edited',()=>{
  const inspected=inspectScfStructure(original),order=inspected.metadataRecords.find(r=>r.tag===0x102),settings=inspected.metadataRecords.find(r=>r.tag===0x101);
  for(const [offset,value] of [[order.payloadStart+8,999],[settings.payloadStart,99],[44,77]]) {
    const bad=Buffer.from(original);bad.writeUInt16LE(value,offset);assert.equal(inspectScfStructure(bad).complete,false);assert.throws(()=>editScfStructure(bad,[{type:'rename',signal:'A',name:'AA'}]),/unsupported or malformed/);
  }
});
test('52-byte vendor preamble without editor end field stays intact when changing duration',()=>{
  const prefix=Buffer.from(original.subarray(0,52));prefix.writeUInt16LE(0,38);prefix.writeUInt32LE(2,46);prefix.writeUInt16LE(0,50);
  const shorterPrefix=Buffer.concat([prefix,original.subarray(66)]);assert.equal(inspectScfStructure(shorterPrefix).complete,true);
  const changed=editScfStructure(shorterPrefix,[{type:'duration',durationNs:250}]).buffer;
  assert.equal(inspectScfStructure(changed).timeRange.editorEndTicks,null);assert.equal(readScfWaveforms(changed).header.durationNs,250);
  assert.deepEqual(changed.subarray(38,52),shorterPrefix.subarray(38,52));
});
