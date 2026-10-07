import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {createSymbol} from '../lib/gdf-symbol-editor.mjs';
import {editDrawingGraphics} from '../lib/gdf-drawing-editor.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {inspectGdfConnections,gdfTerminalPartitions} from '../lib/gdf-connections.mjs';
import {inspectGdfBusMembers} from '../lib/gdf-bus-members.mjs';
import {cleanupGdfWires,gdfCleanupBitPartitions,GDF_CLEANUP_COMPARISON_LIMIT} from '../lib/gdf-wire-cleanup.mjs';
import {sha256} from '../lib/workspace.mjs';

const w=(x1,y1,x2,y2,fields={})=>({operation:'add_wire',x1,y1,x2,y2,...fields});
const anchor=createSymbol({name:'ANCHOR',width:64,height:32,pins:[{name:'IN',x:0,y:16,labelX:8,labelY:17,attributeName:'ISTUB'}]}).buffer;
const vectorAnchor=createSymbol({name:'VECTORANCHOR',width:64,height:32,pins:[{name:'A[3..0]',x:0,y:16,labelX:8,labelY:17,attributeName:'ISTUB'}]}).buffer;
function fixture(operations,{pins=[{name:'anchor',x:0,y:0}],symbol=anchor}={}){
 return constructGdf(createBlankGdf(),[...pins.map(pin=>({operation:'add_symbol',symbolPath:'anchor.sym',symbolSha256:sha256(symbol),...pin})),...operations],()=>({path:'anchor.sym',bytes:symbol})).buffer;
}
const simple=()=>fixture([w(0,16,64,16),w(64,16,96,16)]);
function verify(bytes,result){
 const deleted=new Set(result.changes.map(change=>change.recordOffset));
 assert.deepEqual(result.buffer,Buffer.concat(tokeniseGdfGeometry(bytes).filter(token=>!deleted.has(token.offset)).map(token=>token.body)),'all retained native token bodies are byte-identical');
 assert.deepEqual(gdfTerminalPartitions(inspectGdfConnections(result.buffer)),gdfTerminalPartitions(inspectGdfConnections(bytes)));
 assert.deepEqual(gdfCleanupBitPartitions(inspectGdfBusMembers(result.buffer),parseGdfGeometry(result.buffer)),gdfCleanupBitPartitions(inspectGdfBusMembers(bytes),parseGdfGeometry(bytes)));
 assert.equal(result.connectionCheck.preserved,true);
}

test('three-branch leaf layers are peeled to the real pin conductor with source identities preserved',()=>{
 const bytes=fixture([w(0,16,64,16),w(64,16,96,16),w(96,16,96,48),w(64,48,96,48),w(96,48,128,48)]),digest=sha256(bytes),result=cleanupGdfWires(bytes);
 assert.equal(result.changes.length,4);assert.equal(result.connectionCheck.passes,3);assert.equal(result.connectionCheck.before.totalSegments,5);assert.equal(result.connectionCheck.after.totalSegments,1);assert.equal(result.connectionCheck.after.wireLength,64);assert.equal(sha256(bytes),digest);verify(bytes,result);
 assert.equal(cleanupGdfWires(result.buffer).changes.length,0,'cleanup is idempotent');
});

test('wires contacting pins at their endpoints or in their interior are retained',()=>{
 for(const bytes of [fixture([w(0,16,64,16),w(64,16,96,16)],{pins:[{name:'first',x:0,y:0},{name:'second',x:96,y:0}]}),fixture([w(0,16,96,16)],{pins:[{name:'first',x:32,y:0}]})]){
  const result=cleanupGdfWires(bytes);assert.equal(result.changes.length,0);assert.deepEqual(result.buffer,bytes);
 }
});

test('interior crossings and unsplit T contacts remain separate even when a visible dot is set',()=>{
 for(const extra of [w(32,0,32,64),w(32,16,32,64,{startDot:true})]){
  const bytes=fixture([w(0,16,64,16),extra]),result=cleanupGdfWires(bytes);
  assert.equal(result.changes.length,0);assert.equal(result.connectionCheck.before.sourceNets,2);assert.equal(result.connectionCheck.after.crossings,1);assert.equal(result.connectionCheck.protected.isolatedWithoutRealPins,1);verify(bytes,result);
 }
});

test('pin-free isolated unnamed networks are preserved rather than erased as apparently dead drawing',()=>{
 const bytes=fixture([w(0,16,64,16),w(256,16,288,16),w(288,16,288,48),w(288,48,320,48)]),result=cleanupGdfWires(bytes);
 assert.equal(result.changes.length,0);assert.equal(result.connectionCheck.protected.isolatedWithoutRealPins,3);assert.deepEqual(result.buffer,bytes);
});

test('all NODE_NAME wire records and remote aliases survive while their anonymous leaf extension is removable',()=>{
 const bytes=fixture([w(0,16,64,16,{nodeName:'REMOTE'}),w(64,16,96,16),w(256,16,288,16,{nodeName:'remote'})]),result=cleanupGdfWires(bytes);
 assert.equal(result.changes.length,1);assert.equal(result.connectionCheck.protected.annotatedConductors,2);assert.equal(result.connectionCheck.protected.isolatedWithoutRealPins,1);assert.deepEqual(inspectGdfBusMembers(result.buffer).nets.find(net=>net.terminals.length).names,['REMOTE']);verify(bytes,result);
});

test('non-NODE_NAME line attributes and empty i spans keep their owner wire and byte context',()=>{
 const bytes=fixture([w(0,16,64,16),w(64,16,96,16,{nodeName:'DOC'})]),tokens=tokeniseGdfGeometry(bytes),q=tokens.find(token=>token.opcode==='q'&&token.nativeType===11);
 const doc=Buffer.from(bytes);doc[q.offset+1]=0;
 for(const source of [doc,Buffer.concat(tokens.filter(token=>token.offset!==q.offset).map(token=>token.body))]){
  const result=cleanupGdfWires(source);assert.equal(result.changes.length,0);assert.equal(result.connectionCheck.protected.annotatedConductors,1);assert.deepEqual(result.buffer,source);
 }
 const named=fixture([w(0,16,64,16,{nodeName:'REMOTE'}),w(64,16,96,16)]),followingDoc=constructGdf(named,[{operation:'add_annotation',x:32,y:64,text:'DOC reader context'}],()=>{}).buffer;
 assert.deepEqual(cleanupGdfWires(followingDoc).buffer,followingDoc,'retain the native line that resets text context before a free DOC');
});

test('duplicate-coordinate and collinearly overlapping segments are kept with any anonymous endpoint leaf removed',()=>{
 const bytes=fixture([w(0,16,64,16),w(0,16,64,16),w(64,16,96,16)]),result=cleanupGdfWires(bytes);
 assert.equal(result.changes.length,1);assert.equal(result.connectionCheck.protected.collinearOverlapsOrZeroLength,2);assert.equal(result.connectionCheck.after.totalSegments,2);verify(bytes,result);
 const overlap=fixture([w(0,16,64,16),w(32,16,96,16)]);assert.deepEqual(cleanupGdfWires(overlap).buffer,overlap);
});

test('unknown upper flag bits and graphical lines/circles/arcs/text are never cleaned up',()=>{
 const bytes=simple(),tail=parseGdfGeometry(bytes).sheet.wires.find(wire=>wire.start.x===64),unknown=Buffer.from(bytes);unknown.writeUInt16LE(0x100,tail.offset+9);
 assert.equal(cleanupGdfWires(unknown).changes.length,0);
 let decorated=editDrawingGraphics(bytes,[{operation:'add_line',x1:64,y1:16,x2:64,y2:48},{operation:'add_circle',x:256,y:256,radius:16},{operation:'add_arc',cx:256,cy:128,startX:272,startY:128,endX:256,endY:144,radius:16,startAngleDegrees:0,sweepAngleDegrees:90}]).buffer;
 decorated=constructGdf(decorated,[{operation:'add_annotation',x:64,y:16,text:'keep the original DOC'}],()=>{}).buffer;
 const result=cleanupGdfWires(decorated);assert.equal(result.changes.length,1);verify(decorated,result);assert.equal(parseGdfGeometry(result.buffer).sheet.drawingLines.length,1);assert.ok(parseGdfGeometry(result.buffer).sheet.attributes.some(a=>a.text==='keep the original DOC'));
});

test('explicit buses use per-bit terminal and alias partitions rather than only the bundle partition',()=>{
 const bytes=fixture([w(0,16,64,16,{bus:true}),w(64,16,96,16,{bus:true})],{symbol:vectorAnchor}),result=cleanupGdfWires(bytes);
 assert.equal(result.changes.length,1);assert.equal(result.changes[0].bus,true);assert.equal(result.connectionCheck.bitTerminalPartitions,4);assert.equal(result.connectionCheck.before.busLength,96);assert.equal(result.connectionCheck.after.busLength,64);verify(bytes,result);
});

test('unresolved bus/parameter widths, old files, invalid options and budget exhaustion refuse atomically',()=>{
 const bytes=simple(),digest=sha256(bytes),unresolved=fixture([w(0,16,64,16,{bus:true})]),older=Buffer.from(bytes);older.writeUInt16LE(5,6);
 for(const [source,options,re] of [[unresolved,{},/complete explicit bit topology/],[older,{},/version 6/],[bytes,{maxComparisons:1},/budget/],[bytes,{maxComparisons:GDF_CLEANUP_COMPARISON_LIMIT+1},/integer/],[bytes,{maxPasses:0},/integer/]])assert.throws(()=>cleanupGdfWires(source,options),re);
 const chain=fixture([w(0,16,64,16),w(64,16,96,16),w(96,16,96,48)]);assert.throws(()=>cleanupGdfWires(chain,{maxPasses:1}),/pass budget/);assert.equal(sha256(bytes),digest);
 const symbol=createSymbol({name:'UNKNOWNWIDTH',width:64,height:32,pins:[{name:'A[WIDTH-1..0]',x:0,y:16,labelX:8,labelY:17,attributeName:'ISTUB'}]}).buffer;
 const parameterized=fixture([w(0,16,64,16),w(64,16,96,16)],{symbol});assert.throws(()=>cleanupGdfWires(parameterized),/source connectivity|explicit bit topology/);
});

test('root-only empty GDF is a byte-identical no-op with bounded reports',()=>{
 const bytes=createBlankGdf(),result=cleanupGdfWires(bytes);assert.deepEqual(result.buffer,bytes);assert.equal(result.changes.length,0);assert.equal(result.connectionCheck.pins,0);assert.equal(result.connectionCheck.passes,0);assert.equal(result.connectionCheck.comparisons,0);assert.ok(JSON.stringify(result.connectionCheck).length<1500);
});
