import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createBlankGdf,constructGdf,readSymbolPrototype} from '../lib/gdf-authoring.mjs';
import {formatParameters,parameterSummary,parameterTemplate,MAX_GDF_TEXT_BYTES,replaceGdfLabel,MCP_INSTANCE_NAME_PREFIX} from '../lib/gdf-properties.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {sha256} from '../lib/workspace.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {validateArguments} from '../lib/validation.mjs';
import {TOOLS} from '../server.mjs';
const root=detectInstall()?.root;assert.ok(root);
const file=path.join(root,'max2lib/mega_lpm/lpm_constant.sym'),bytes=fs.readFileSync(file);
const add=(name='value',parameters)=>({operation:'add_symbol',symbolPath:file,symbolSha256:sha256(bytes),name,x:128,y:800,...(parameters?{parameters}:{})});
const build=(b,ops)=>constructGdf(b,ops,p=>({path:p,bytes:fs.readFileSync(p)}));
const wire={operation:'add_wire',x1:0,y1:0,x2:64,y2:0,nodeName:'DATA[3..0]',bus:true};
const tool=name=>TOOLS.find(t=>t.name===name);
test('native NET_ID is numeric and unique; friendly names survive as hidden DOC aliases',()=>{
  const b=build(createBlankGdf(),[add('first'),add('second')]).buffer,p=parseGdfGeometry(b);assert.deepEqual(p.placements.map(p=>p.netId),[1,2]);assert.deepEqual(p.placements.map(p=>p.instanceName),['first','second']);assert.ok(p.placements.every(p=>p.instanceNameSource==='hidden-DOC-alias'));
  assert.ok(p.placements.every(p=>p.attributes.find(a=>a.kindCode===0&&a.text.startsWith(MCP_INSTANCE_NAME_PREFIX)).display.visible===false));
});
test('normalization repairs version-0.6 aliases without changing wires or graphical definitions',()=>{
  const b=build(createBlankGdf(),[add('first'),add('second'),wire]).buffer;let i=0;const old=Buffer.concat(tokeniseGdfGeometry(b).filter(t=>!(t.opcode==='q'&&t.attrType===0&&t.text?.startsWith(MCP_INSTANCE_NAME_PREFIX))).map(t=>t.opcode==='q'&&t.attrType===41?replaceGdfLabel(t,['first','second'][i++]):t.body)),p=parseGdfGeometry(old);
  assert.ok(p.placements.every(p=>p.netId===null));assert.throws(()=>build(old,[{operation:'add_annotation',x:0,y:0,text:'note'}]),/normalize_net_ids/);
  const repaired=build(old,[{operation:'normalize_net_ids'}]).buffer,after=parseGdfGeometry(repaired);assert.deepEqual(after.placements.map(p=>p.netId),[1,2]);assert.deepEqual(after.placements.map(p=>p.instanceName),['first','second']);assert.deepEqual(after.sheet.buses[0].start,p.sheet.buses[0].start);
  assert.deepEqual(build(repaired,[{operation:'normalize_net_ids'}]).buffer,repaired);
});
test('normalization resolves duplicate numeric IDs and preserves the first valid identity',()=>{
  const b=build(createBlankGdf(),[add('first'),add('second')]).buffer;const duplicate=Buffer.concat(tokeniseGdfGeometry(b).filter(t=>!(t.opcode==='q'&&t.attrType===0&&t.text?.startsWith(MCP_INSTANCE_NAME_PREFIX))).map(t=>t.opcode==='q'&&t.attrType===41?replaceGdfLabel(t,'1'):t.body));
  const p=parseGdfGeometry(build(duplicate,[{operation:'normalize_net_ids'}]).buffer);assert.deepEqual(p.placements.map(p=>p.netId),[1,2]);assert.deepEqual(p.placements.map(p=>p.instanceName),['1','2']);
});

test('parameter maps are bounded source expressions with unique case-insensitive identifiers',()=>{
  assert.deepEqual(formatParameters({width:4,TYPE:'"SIGNED"',offset:-1}).entries,[{name:'OFFSET',value:'-1'},{name:'TYPE',value:'"SIGNED"'},{name:'WIDTH',value:'4'}]);
  for(const p of [{},{WIDTH:1,width:2},{'bad-name':2},{WIDTH:true},{WIDTH:Infinity},{WIDTH:'4\nX=1'},{WIDTH:''},{WIDTH:'中文'},{WIDTH:'X'.repeat(257)},Array.from({length:2})])assert.throws(()=>formatParameters(p));
  assert.throws(()=>formatParameters(Object.fromEntries(Array.from({length:20},(_,i)=>['P'+i,'X'.repeat(200)]))),/2047/);
});
test('installed constant symbol exposes original parameter declarations independently of assignments',()=>{
  const s=readSymbolPrototype(bytes),p=parameterTemplate(s.parsed.sheet.attributes);assert.deepEqual(p.entries.map(p=>p.name).sort(),['LPM_CVALUE','LPM_WIDTH']);assert.ok(p.entries.every(p=>p.value===''));
});
test('different instances share the same definition while retaining separate modern parameters',()=>{
  const b=build(createBlankGdf(),[add('first',{LPM_WIDTH:4,LPM_CVALUE:5}),{...add('second',{LPM_WIDTH:8,LPM_CVALUE:42}),x:400}]).buffer,p=parseGdfGeometry(b);
  assert.equal(p.definitions.length,1);assert.equal(p.placements.length,2);assert.deepEqual(p.placements[0].parameters.entries,[{name:'LPM_CVALUE',value:'5'},{name:'LPM_WIDTH',value:'4'}]);assert.equal(p.placements[1].parameters.entries[0].value,'42');assert.equal(p.placements[0].attributes.find(a=>a.nativeType===10).parameterOffset,0);
});
test('complete parameter replacement preserves record flags, metrics and original offset tail',()=>{
  const b=build(createBlankGdf(),[add('value',{LPM_WIDTH:4,LPM_CVALUE:5})]).buffer,p=parseGdfGeometry(b),t=tokeniseGdfGeometry(b).find(t=>t.nativeType===10);
  const marked=Buffer.from(b);marked.writeUInt16LE(0x8361,t.offset+7);marked.writeInt16LE(-7,t.end-2);
  const changed=build(marked,[{operation:'set_parameters',recordOffset:p.placements[0].offset,parameters:{LPM_WIDTH:4,LPM_CVALUE:10}}]).buffer,a=parseGdfGeometry(changed).placements[0].attributes.find(a=>a.nativeType===10);
  assert.equal(a.rawFlags,0x8361);assert.equal(a.parameterOffset,-7);assert.deepEqual(a.metrics,p.placements[0].attributes.find(a=>a.nativeType===10).metrics);assert.equal(a.text,'LPM_CVALUE=10\nLPM_WIDTH=4');
  const minimal=build(changed,[{operation:'set_parameters',recordOffset:parseGdfGeometry(changed).placements[0].offset,parameters:{LPM_WIDTH:1}}]).buffer;assert.deepEqual(parseGdfGeometry(minimal).placements[0].parameters.entries,[{name:'LPM_WIDTH',value:'1'}]);
});
test('clearing parameters removes the u block and preserves all default instance attributes',()=>{
  const b=build(createBlankGdf(),[add('value',{LPM_WIDTH:4,LPM_CVALUE:5})]).buffer,p=parseGdfGeometry(b);
  const r=build(b,[{operation:'clear_parameters',recordOffset:p.placements[0].offset}]).buffer,after=parseGdfGeometry(r);
  assert.equal(after.placements[0].parameters.entries.length,0);assert.equal(after.placements[0].instanceName,'value');assert.ok(!tokeniseGdfGeometry(r).some(t=>t.opcode==='u'));
});
test('ambiguous and legacy parameter records are refused rather than overwritten',()=>{
  assert.equal(parameterSummary([{nativeType:10,kindCode:53,text:'WIDTH'}]).writable,false);assert.equal(parameterSummary([{nativeType:10,kindCode:55,text:'W=4\nw=5'}]).writable,false);
  const b=build(createBlankGdf(),[add('value',{LPM_WIDTH:4,LPM_CVALUE:5})]).buffer,p=parseGdfGeometry(b),t=tokeniseGdfGeometry(b).find(t=>t.nativeType===10),q=Buffer.concat([t.body.subarray(0,-2),Buffer.from([0x76,1,0,56,0]),t.body.subarray(-2)]),alt=Buffer.concat([b.subarray(0,t.offset),q,b.subarray(t.end)]);
  assert.throws(()=>build(alt,[{operation:'set_parameters',recordOffset:p.placements[0].offset,parameters:{LPM_WIDTH:1}}]),/legacy/);
});
test('named wire has native NODE_NAME ownership while following free text remains root graphics',()=>{
  const b=build(createBlankGdf(),[wire,{operation:'add_annotation',x:0,y:32,text:'root text'}]).buffer,p=parseGdfGeometry(b);
  assert.equal(p.sheet.buses[0].annotations[0].kindCode,6);assert.equal(p.sheet.buses[0].annotations[0].text,'DATA[3..0]');assert.equal(p.sheet.attributes[0].nativeType,7);assert.equal(p.sheet.attributes[0].text,'root text');assert.equal(p.sheet.primitives.length,1);
});
test('wire name replacement changes only its label and keeps flags, endpoints and free annotations',()=>{
  const b=build(createBlankGdf(),[{...wire,startDot:true},{operation:'add_annotation',x:0,y:32,text:'keep'}]).buffer,p=parseGdfGeometry(b),offset=p.sheet.buses[0].offset;
  const next=build(b,[{operation:'set_wire_name',recordOffset:offset,nodeName:'NEW_DATA[7..4]'}]).buffer,after=parseGdfGeometry(next);
  assert.equal(after.sheet.buses[0].rawFlags,33);assert.deepEqual(after.sheet.buses[0].start,p.sheet.buses[0].start);assert.equal(after.sheet.buses[0].annotations[0].text,'NEW_DATA[7..4]');assert.equal(after.sheet.attributes[0].text,'keep');
  const clear=build(next,[{operation:'clear_wire_name',recordOffset:offset}]).buffer,a=parseGdfGeometry(clear);assert.equal(a.sheet.buses[0].annotations?.length??0,0);assert.equal(a.sheet.attributes[0].text,'keep');assert.ok(!tokeniseGdfGeometry(clear).some(t=>t.opcode==='i'));
});
test('an existing unnamed wire can be named, with bit syntax accepted and malformed labels rejected',()=>{
  const {nodeName,...unnamed}=wire,b=build(createBlankGdf(),[unnamed]).buffer;
  const p=parseGdfGeometry(build(b,[{operation:'set_wire_name',recordOffset:20,nodeName:'DATA[0]'}]).buffer);assert.equal(p.sheet.buses[0].annotations[0].text,'DATA[0]');
  for(const nodeName of ['a b','DATA[-1]','DATA[3:0]','DATA[0]x','中文'])assert.throws(()=>build(b,[{operation:'set_wire_name',recordOffset:20,nodeName}]));
  assert.throws(()=>build(b,[{operation:'clear_wire_name',recordOffset:20}]),/no node name/);
});
test('MCP parameter edits retain previews, stale hash guards, backups and transactional rejection',async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-props-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));const a={workspace,path:'demo.gdf'},original=build(createBlankGdf(),[add('value',{LPM_WIDTH:1,LPM_CVALUE:0})]).buffer;fs.writeFileSync(path.join(workspace,a.path),original);
  const p=parseGdfGeometry(original),args={...a,expectedSha256:sha256(original),operations:[{operation:'set_parameters',recordOffset:p.placements[0].offset,parameters:{LPM_WIDTH:1,LPM_CVALUE:1}}]};
  assert.equal((await tool('gdf_construct').handler(args)).preview,true);assert.deepEqual(fs.readFileSync(path.join(workspace,a.path)),original);
  await assert.rejects(()=>tool('gdf_construct').handler({...args,expectedSha256:'0'.repeat(64),confirm:true}),/changed/);
  const changed=await tool('gdf_construct').handler({...args,confirm:true});assert.deepEqual(fs.readFileSync(changed.backup),original);
  await tool('project_restore_file').handler({...a,backup:changed.backup,backupSha256:sha256(original),expectedSha256:changed.nextSha256,confirm:true});assert.deepEqual(fs.readFileSync(path.join(workspace,a.path)),original);
});
test('schemas require parameter/wire operation fields and enforce parameter object size/types',()=>{
  const base={path:'demo.gdf',expectedSha256:'a'.repeat(64)},schema=tool('gdf_construct').inputSchema;
  for(const op of [{operation:'set_parameters',recordOffset:20},{operation:'set_parameters',recordOffset:20,parameters:{}},{operation:'set_parameters',recordOffset:20,parameters:{WIDTH:true}},{operation:'set_wire_name',recordOffset:20}])assert.throws(()=>validateArguments({...base,operations:[op]},schema));
  assert.doesNotThrow(()=>validateArguments({...base,operations:[{operation:'set_parameters',recordOffset:20,parameters:{WIDTH:4}},{operation:'set_wire_name',recordOffset:20,nodeName:'N[0]'}]},schema));
});
test('native-compatible text limit applies to property blocks and new/edited annotations',()=>{
  assert.equal(MAX_GDF_TEXT_BYTES,2047);assert.throws(()=>build(createBlankGdf(),[{operation:'add_annotation',x:0,y:0,text:'a'.repeat(2048)}]),/Latin-1/);
  assert.throws(()=>validateArguments({path:'demo.gdf',expectedSha256:'a'.repeat(64),edits:[{operation:'set_text',recordOffset:20,text:'a'.repeat(2048)}]},tool('gdf_edit').inputSchema));
});
