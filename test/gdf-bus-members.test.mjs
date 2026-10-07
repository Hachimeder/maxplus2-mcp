import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {createSymbol} from '../lib/gdf-symbol-editor.mjs';
import {inspectGdfBusMembers,declaredGdfSignal} from '../lib/gdf-bus-members.mjs';
import {sha256} from '../lib/workspace.mjs';

test('declared vector order is explicit and unsafe numeric indices never alias',()=>{
 assert.deepEqual(declaredGdfSignal('A[3..0]').members.map(m=>m.name),['A[3]','A[2]','A[1]','A[0]']);
 assert.deepEqual(declaredGdfSignal('A[0..3]').members.map(m=>m.name),['A[0]','A[1]','A[2]','A[3]']);
 assert.equal(declaredGdfSignal('A[9007199254740992]'),null);
});

test('custom vector pins connect on four independent bits with both identities retained',()=>{
 const symbol=createSymbol({name:'VECTOR_PORT',width:64,height:32,pins:[{name:'A[3..0]',attributeName:'ISTUB',x:0,y:16,labelX:8,labelY:17}]}).buffer;
 const bytes=constructGdf(createBlankGdf(),[
  ...[0,128].map((x,i)=>({operation:'add_symbol',symbolPath:'port.sym',symbolSha256:sha256(symbol),name:'port'+i,x,y:0})),
  {operation:'add_wire',x1:0,y1:16,x2:128,y2:16,bus:true,nodeName:'DATA[3..0]'}
 ],()=>({path:'port.sym',bytes:symbol})).buffer;
 const model=inspectGdfBusMembers(bytes);assert.equal(model.complete,true);assert.equal(model.nets.length,4);
 for(const net of model.nets){assert.equal(net.terminals.length,2);assert.equal(new Set(net.terminals.map(t=>t.member)).size,1);}
});
