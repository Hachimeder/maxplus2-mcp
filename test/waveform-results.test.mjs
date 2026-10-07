import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {analyseWaveformResults,inspectWaveformSignals} from '../lib/waveform-results.mjs';

const table = (rows,{unit='ns',radix='HEX',inputs='A',outputs='VALID DATA[7..0] KIND',groups=''}={}) => `${groups}\nINPUTS ${inputs} ;\nOUTPUTS ${outputs} ;\nUNIT ${unit} ;\nRADIX ${radix} ;\nPATTERN\n${rows}\n;\n`;
const analyse = (text,options={}) => analyseWaveformResults(text,{validSignal:'VALID',dataSignals:['DATA[7..0]'],kindSignal:'KIND',...options});
const standard = table('0> 0 = 0 00 0\n500100> 0 = 1 03 0\n500200> 1 = 1 03 0\n500300> 1 = 0 03 0\n600100> 0 = 1 03 1\n600200> 0 = 0 03 1\n700000> 0 = 0 03 1');

test('delayed valid pulses produce exactly two results despite identical held data',()=>{
  const r=analyse(standard);
  assert.equal(r.totalEvents,2); assert.equal(r.sampledEvents,2); assert.equal(r.status,'complete');
  assert.deepEqual(r.events.items.map(e=>[e.timeNs,e.values['DATA[7..0]'].value,e.kind.value]),[[500100,3,0],[600100,3,1]]);
  assert.deepEqual([r.recommendedWindow.startTimeNs,r.recommendedWindow.endTimeNs],[499100,601100]);
  assert.equal(r.events.items[0].values['DATA[7..0]'].rawToken,'03');
});

test('settle sampling uses the latest row at or before the point, never a future row',()=>{
  const t=table('0> 0 = 0 00 0\n10> 0 = 1 01 0\n12> 0 = 1 02 0\n16> 0 = 1 03 1\n20> 0 = 0 04 1\n30> 0 = 0 04 1');
  const r=analyse(t,{settleNs:5});
  assert.equal(r.events.items[0].sampleTimeNs,15); assert.equal(r.events.items[0].sampleRowTimeNs,12);
  assert.equal(r.events.items[0].values['DATA[7..0]'].value,2); assert.equal(r.events.items[0].kind.value,0);
});

test('settle cannot cross the valid window, including an exact decimal boundary',()=>{
  const t=table('0> 0 = 0 00 0\n0.1> 0 = 1 01 0\n0.3> 0 = 0 02 0\n1> 0 = 0 02 0');
  const r=analyse(t,{settleNs:0.2});
  assert.equal(r.events.items[0].sampleTimeNs,0.3); assert.equal(r.events.items[0].status,'outside_valid_window');
  assert.equal(r.events.items[0].values['DATA[7..0]'].value,null); assert.equal(r.sampledEvents,0);
  assert.equal(analyse(t,{settleNs:10}).events.items[0].status,'outside_table');
  assert.equal(analyse(t,{settleNs:0.15,endTimeNs:0.2}).events.items[0].status,'outside_requested_window');
});

test('initial high is marked; unknown-to-high is uncertain rather than a invented rising edge',()=>{
  const t=table('0> 0 = 1 01 0\n1> 0 = X 02 0\n2> 0 = 1 03 0\n3> 0 = 0 03 0\n4> 0 = 1 04 0\n5> 0 = 0 04 0');
  const r=analyse(t);
  assert.deepEqual(r.events.items.map(e=>[e.timeNs,e.initial]),[[0,true],[4,false]]);
  assert.equal(r.unknownValidRows,1); assert.equal(r.uncertainValidEntryCount,1); assert.equal(r.uncertainValidEntries[0].timeNs,2);
  const narrow=analyse(t,{startTimeNs:3}); assert.equal(narrow.status,'complete'); assert.equal(narrow.totalEvents,1);
});

test('samples means native high rows and explicitly differs from valid rising events',()=>{
  const r=analyse(standard,{edge:'samples'});
  assert.equal(r.totalEvents,3); assert.deepEqual(r.events.items.map(e=>e.timeNs),[500100,500200,600100]);
  assert.match(r.limitations.join(' '),/native rows/);
});

test('event pagination returns reliable full totals and nextOffset',()=>{
  const first=analyse(standard,{limit:1}),second=analyse(standard,{offset:first.events.nextOffset,limit:1});
  assert.equal(first.events.total,2); assert.equal(first.events.nextOffset,1); assert.equal(first.events.returned,1);
  assert.equal(second.events.total,2); assert.equal(second.events.nextOffset,null); assert.equal(second.events.items[0].index,1);
  const beyond=analyse(standard,{offset:20,limit:1}); assert.equal(beyond.events.returned,0); assert.equal(beyond.events.total,2); assert.equal(beyond.events.nextOffset,null);
});

test('source units convert exactly to ns and ns arguments remain ns',()=>{
  for (const [unit,expected] of [['fs',0.00000125],['ps',0.00125],['ns',1.25],['us',1250],['µs',1250],['μs',1250],['ms',1250000],['s',1250000000]]) {
    const r=analyse(table('0> 0 = 0 00 0\n1.25> 0 = 1 0A 0\n2> 0 = 0 0A 0',{unit}),{paddingNs:0});
    assert.equal(r.events.items[0].timeNs,expected); assert.equal(r.events.items[0].sourceTime,1.25); assert.equal(r.unit,'ns'); assert.equal(r.sourceUnit,unit);
  }
});

test('grouped and expanded inputs decode independently using their actual token layout',()=>{
  const grouped=table('0> 00 0 = 00\n1> 0A 1 = 03\n2> 0A 0 = 03',{inputs:'INBUS[7..0] VALID',outputs:'DATA[7..0]',groups:'GROUP CREATE INBUS[7..0] = I7 I6 I5 I4 I3 I2 I1 I0 ;'});
  const a=analyseWaveformResults(grouped,{validSignal:'VALID',dataSignals:['INBUS[7..0]','DATA[7..0]']});
  assert.equal(a.events.items[0].values['INBUS[7..0]'].value,10); assert.deepEqual(a.events.items[0].values['INBUS[7..0]'].rawTokens,['0A']);
  const expanded=table('0> 0 0 0 0 = 00\n1> 1 0 1 1 = 03\n2> 1 0 1 0 = 03',{inputs:'INBUS[2..0] VALID',outputs:'DATA[7..0]'});
  const b=analyseWaveformResults(expanded,{validSignal:'valid',dataSignals:['inbus[2..0]']});
  assert.equal(b.events.items[0].values['INBUS[2..0]'].value,5); assert.equal(b.events.items[0].values['INBUS[2..0]'].radix,'BIN');
  assert.deepEqual(b.events.items[0].values['INBUS[2..0]'].rawTokens,['1','0','1']);
});

test('missing hidden SCF columns are reported without inventing data or valid edges',()=>{
  const r=analyse(standard,{dataSignals:['CLK','DATA[7..0]']});
  assert.equal(r.status,'missing_signals'); assert.deepEqual(r.missingSignals,['CLK']);
  assert.equal(r.events.items[0].values.CLK.state,'missing'); assert.equal(r.events.items[0].values.CLK.value,null); assert.equal(r.events.items[0].values.CLK.name,'CLK');
  const missing=analyse(standard,{validSignal:'hidden_clk'}); assert.equal(missing.totalEvents,0); assert.deepEqual(missing.missingSignals,['hidden_clk']);
});

test('X, Z and mixed unknown values remain null with exact native tokens',()=>{
  const r=analyse(table('0> 0 = 0 00 0\n1> 0 = 1 XX X\n2> 0 = 0 XX X\n3> 0 = 1 ZZ Z\n4> 0 = 0 ZZ Z\n5> 0 = 1 0X 0\n6> 0 = 0 0X 0'));
  assert.deepEqual(r.events.items.map(e=>e.values['DATA[7..0]'].state),['X','Z','mixed_unknown']);
  assert.deepEqual(r.events.items.map(e=>e.values['DATA[7..0]'].rawToken),['XX','ZZ','0X']);
  assert.equal(r.unknownDataEvents,3); assert.equal(r.status,'unknown_values');
});

test('case-insensitive selection retains canonical names and declaration collisions fail',()=>{
  assert.equal(analyse(standard,{validSignal:'valid',dataSignals:['data[7..0]'],kindSignal:'kind'}).validSignal,'VALID');
  assert.throws(()=>analyse(table('0> 0 = 0 00 0 0',{outputs:'VALID DATA[7..0] KIND valid'})),/collision/);
  assert.throws(()=>analyse(standard,{dataSignals:['DATA[7..0]','data[7..0]']}),/duplicate or case-colliding/);
  assert.throws(()=>analyse(standard,{validSignal:'DATA[7..0]'}),/scalar/);
});

test('malformed native headers, rows, values and missing terminators never become success',()=>{
  for (const broken of [standard.replace('UNIT ns ;','UNIT ticks ;'),standard.replace('RADIX HEX ;','RADIX nope ;'),standard.replace('500100>','..1>'),standard.replace('500100>','0>'),standard.replace('1 03 0','1 GG 0'),standard.replace('1 03 0','1 03'),standard.replace('1 03 0','1 03 0 1'),standard.replace('1 03 0','2 03 0'),standard.replace('A ;','A ;\nUNIT ns ;'),standard.slice(0,-2),standard+'1> 0 = 0 00 0\n']) assert.throws(()=>analyse(broken),/Malformed|Unsupported|strictly increasing|token|exceeds|Duplicate|terminated|Unexpected/);
  assert.throws(()=>analyse(standard,{edge:'falling'}),/edge/);
  assert.throws(()=>analyse(standard,{startTimeNs:20,endTimeNs:10}),/startTimeNs/);
});

test('unsafe-width numeric values retain exact decimal strings and do not silently round',()=>{
  const t=table('0> 0 = 0 0000000000000000 0\n1> 0 = 1 FFFFFFFFFFFFFFFF 0\n2> 0 = 0 FFFFFFFFFFFFFFFF 0',{outputs:'VALID WIDE[63..0] KIND'});
  const r=analyse(t,{dataSignals:['WIDE[63..0]']});
  const v=r.events.items[0].values['WIDE[63..0]'];
  assert.equal(v.value,null); assert.equal(v.valueDecimal,'18446744073709551615'); assert.equal(v.state,'unsafe_integer');
});

test('fixed and requested parsing budgets fail before returning incomplete event totals',()=>{
  assert.throws(()=>analyse(standard,{maxRows:2}),/row budget/);
  assert.throws(()=>analyse(standard,{maxComparisons:2}),/comparison budget/);
  assert.throws(()=>analyse(standard,{maxEvents:1}),/event budget/);
  assert.throws(()=>analyse(' '.repeat(32*1024*1024+1)),/32 MiB/);
  const groups=Array.from({length:2001},(_,i)=>`GROUP CREATE G${i} = P${i} ;`).join('\n');
  assert.throws(()=>analyse(table('0> 0 = 0 00 0',{groups})),/GROUP declaration budget/);
  const many=Array.from({length:25},(_,i)=>`GROUP CREATE G${i} = ${Array.from({length:4096},(_,j)=>`P${j}`).join(' ')} ;`).join('\n');
  assert.throws(()=>analyse(table('0> 0 = 0 00 0',{groups:many})),/GROUP member budget/);
  assert.throws(()=>analyse(table('0> 0 = 0 00 0',{groups:'GROUP CREATE G = A ;\nGROUP CREATE g = B ;'})),/case-colliding TBL GROUP/);
});

test('no valid events returns a null recommendation and strict signal discovery is read-only',()=>{
  const t=table('0> 0 = 0 00 0\n1> 0 = 0 03 0');
  const r=analyse(t); assert.equal(r.totalEvents,0); assert.equal(r.status,'no_valid_events'); assert.equal(r.recommendedWindow,null);
  const c=inspectWaveformSignals(t); assert.equal(c.rowCount,2); assert.deepEqual(c.signals.map(s=>s.name),['A','VALID','DATA[7..0]','KIND']);
  assert.throws(()=>inspectWaveformSignals(t.replace('0 03 0','0 GG 0')),/Invalid/);
});

