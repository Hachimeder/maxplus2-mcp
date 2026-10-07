import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseScfHeader,parseScfRecords,readScfWaveforms,describeScf,editScfWaveforms} from '../lib/scf.mjs';
import {parseTbl,tblTrace} from '../lib/tbl.mjs';
const oracle=JSON.parse(fs.readFileSync(new URL('./fixtures/scf-events-oracle.json',import.meta.url),'utf8'));
const fixture=name=>Buffer.from(oracle.cases[name].scfBase64,'base64');

test('SCF framing includes the final value word: independently generated constant 0 and 1 differ',()=>{
  for(const [name,value] of [['zero',0],['one',1]]){
    const buffer=fixture(name), parsed=parseScfRecords(buffer), wave=readScfWaveforms(buffer);
    assert.equal(parsed.complete,true);assert.equal(parsed.firstRecordOffset,66);
    assert.equal(parsed.records[0].kindTag,5);assert.equal(parsed.records[0].nameLength,2);
    assert.equal(buffer.readUInt16LE(parsed.records[0].waveformEnd-2),value);
    assert.equal(wave.signals.find(s=>s.name==='A').events[0].value,value);
  }
});

test('SCF time units and fractional durations match the vendor VEC and TBL',()=>{
  const wave=readScfWaveforms(fixture('fraction'));
  assert.equal(wave.header.durationTicks,738);assert.equal(wave.header.durationNs,73.8);
  assert.equal(wave.header.timebaseText,'73.8ns');
  assert.deepEqual(wave.signals.find(s=>s.name==='A').events.map(e=>e.time),[0,12.3,24.6,36.9,49.2,61.5]);
  const trace=tblTrace(parseTbl(oracle.cases.fraction.vendorTable));
  for(const row of trace.filter(r=>r.time<73.8))for(const signal of wave.signals){
    const expected=signal.role==='input'?row.rawInputs[signal.name][0]:row.rawValues[signal.name];
    assert.equal(String(signal.segments.find(s=>s.startTime<=row.time&&row.time<s.endTime)?.value),expected);
  }
});

test('SCF supports vendor-confirmed X and Z values without turning them into numbers',()=>{
  const a=readScfWaveforms(fixture('all-values'),{signal:'A'}).signals[0];
  assert.deepEqual(a.events.map(({time,value})=>({time,value})),[
    {time:0,value:0},{time:100,value:1},{time:200,value:'X'},{time:300,value:'Z'},{time:400,value:0},{time:500,value:1}]);
  assert.equal(a.decoded,true);
});

test('SCF waveform range filtering, pagination and missing names are explicit',()=>{
  const read=readScfWaveforms(fixture('all-values'),{signals:['A','missing'],startTime:150,endTime:450,offset:1,limit:1});
  const a=read.signals[0];assert.equal(a.valueAtStart,1);assert.equal(a.totalEvents,3);
  assert.deepEqual(a.events,[{time:300,ticks:3000,value:'Z'}]);assert.equal(a.truncated,true);
  assert.deepEqual(read.missingSignals,['missing']);
  for(const options of [{startTime:-1},{startTime:10,endTime:9},{offset:0.1},{limit:0},{limit:10001},{signals:'A'}])assert.throws(()=>readScfWaveforms(fixture('zero'),options));
});

test('SCF valueAtStart uses the new value at exact X/Z event boundaries',()=>{
  const buffer=fixture('all-values');
  for(const [time,value] of [[0,0],[99.9,0],[100,1],[199.9,1],[200,'X'],[200.1,'X'],[299.9,'X'],[300,'Z'],[300.1,'Z'],[400,0],[500,1],[600,null],[700,null]]){
    const read=readScfWaveforms(buffer,{signal:'A',startTime:time,endTime:time,offset:1,limit:1});
    assert.equal(read.signals[0].valueAtStart,value,`A at ${time} ns`);
  }
});

test('SCF bus valueAtStart preserves unknown null and new bits at event boundaries',()=>{
  // A synthetic display group over independent vendor-oracle scalar waveforms.
  // This is a lookup regression fixture, not evidence of vendor acceptance.
  const original=fixture('all-values'), parsed=parseScfRecords(original), group=Buffer.alloc(21);
  group.writeUInt16LE(3,0);group.writeUInt32LE(15,2);group.writeUInt16LE(1,6);
  group.writeUInt16LE(3,8);group.write('AB\0',10,'ascii');group.writeUInt16LE(2,13);
  group.writeUInt16LE(1,15);group.writeUInt16LE(2,17);group.writeUInt16LE(3,19);
  const header=Buffer.from(original.subarray(0,parsed.firstRecordOffset));header.writeUInt16LE(1,28);
  const buffer=Buffer.concat([header,group,original.subarray(parsed.firstRecordOffset)]);
  for(const [time,bits,value] of [[0,'00',0],[100,'10',2],[199.9,'10',2],[200,'X0',null],[300,'Z0',null],[400,'00',0],[600,null,null]]){
    const bus=readScfWaveforms(buffer,{signal:'AB',startTime:time,endTime:time}).signals[0];
    assert.equal(bus.decoded,true);assert.equal(bus.bitsAtStart,bits,`bits at ${time} ns`);
    assert.equal(bus.valueAtStart,value,`value at ${time} ns`);
  }
});

test('corrupt count, duration, flags and logic code cannot claim waveform decoding',()=>{
  const buffer=fixture('zero'), r=parseScfRecords(buffer).records[0], w=r.waveformStart;
  for(const [at,value,size] of [[w+17,2,4],[w+21,0,4],[w+25,1,2],[w+27,17,2]]){
    const changed=Buffer.from(buffer);size===4?changed.writeUInt32LE(value,at):changed.writeUInt16LE(value,at);
    const result=readScfWaveforms(changed);assert.equal(result.waveformEncoding,false);assert.ok(result.problems.length);
    assert.throws(()=>editScfWaveforms(changed,[{signal:'A',events:[{time:0,value:1}]}]),/undecoded/);
  }
});

test('corrupt framing, wrong name length, magic and version are rejected for writes',()=>{
  const buffer=fixture('zero'), r=parseScfRecords(buffer).records[0];
  for(const change of [b=>b.writeUInt32LE(0xffffffff,r.start+2),b=>b.writeUInt16LE(1,r.start+8),b=>b.writeUInt16LE(99,r.start)]){
    const bad=Buffer.from(buffer);change(bad);assert.equal(parseScfRecords(bad).complete,false);
    assert.throws(()=>editScfWaveforms(bad,[{signal:'A',events:[{time:0,value:0}]}]));
  }
  assert.throws(()=>parseScfHeader(Buffer.from('bad')));assert.throws(()=>parseScfHeader(Buffer.alloc(50)));
  const version=Buffer.from(buffer);version.writeUInt16LE(5,6);assert.throws(()=>editScfWaveforms(version,[{signal:'A',events:[{time:0,value:0}]}]),/version/);
});

test('SCF input writes preserve header, opaque preamble, trailer and unrelated records',()=>{
  const buffer=fixture('zero'), before=parseScfRecords(buffer);
  const events=[{time:0,value:1},{time:12.3,value:'X'},{time:25,value:'Z'},{time:30,value:0}];
  const output=editScfWaveforms(buffer,[{signal:'A',events}]).buffer, after=parseScfRecords(output);
  assert.deepEqual(output.subarray(0,after.firstRecordOffset),buffer.subarray(0,before.firstRecordOffset));
  assert.deepEqual(output.subarray(after.tailOffset),buffer.subarray(before.tailOffset));
  for(const name of ['B','Q']){
    const r0=before.records.find(r=>r.name===name), r1=after.records.find(r=>r.name===name);
    assert.deepEqual(output.subarray(r1.start,r1.start+r1.size),buffer.subarray(r0.start,r0.start+r0.size));
  }
  assert.deepEqual(readScfWaveforms(output,{signal:'A'}).signals[0].events.map(({time,value})=>({time,value})),events);
  assert.equal(describeScf(output).understood.trailer,false);assert.deepEqual(describeScf(output).writableScalarInputs,['A','B']);
});

test('SCF editing rejects ambiguous times, unsupported signals/values and output traces',()=>{
  const buffer=fixture('zero');
  for(const events of [[],[{time:1,value:0}],[{time:0,value:0},{time:0,value:1}],[{time:0,value:0},{time:0.01,value:1}],[{time:0,value:0},{time:600,value:1}],[{time:0,value:2}],[{time:0,value:'H'}],[{time:0,value:1,extra:true}]])assert.throws(()=>editScfWaveforms(buffer,[{signal:'A',events}]));
  for(const signal of ['Q','A[1..0]','missing'])assert.throws(()=>editScfWaveforms(buffer,[{signal,events:[{time:0,value:0}]}]));
  assert.throws(()=>editScfWaveforms(buffer,[{signal:'A',events:[{time:0,value:0}]},{signal:'A',events:[{time:0,value:1}]}]));
  const edit=editScfWaveforms(buffer,[{signal:'A',events:[{time:0,value:'x'},{time:100,value:'X'},{time:200,value:'z'}]}]);
  assert.deepEqual(edit.changes[0].events,[{time:0,value:'X'},{time:200,value:'Z'}]);
});

