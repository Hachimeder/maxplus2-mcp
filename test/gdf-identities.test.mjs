import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {replaceGdfLabel,MCP_INSTANCE_NAME_PREFIX} from '../lib/gdf-properties.mjs';
import {nativeGdfNetId} from '../lib/gdf-identities.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {sha256} from '../lib/workspace.mjs';
import {gdfConstructionTools} from '../lib/gdf-construction-tools.mjs';
import {gdfTools} from '../lib/gdf-tools.mjs';
import {validateArguments} from '../lib/validation.mjs';

const root=detectInstall()?.root;assert.ok(root,'Original symbol library required');
const resolve=p=>({path:p,bytes:fs.readFileSync(p)}),build=(b,ops)=>constructGdf(b,ops,resolve);
function add(symbol,name,x=272,y=288,nodeName){const symbolPath=path.join(root,'max2lib/prim',symbol+'.sym');return {operation:'add_symbol',symbolPath,symbolSha256:sha256(fs.readFileSync(symbolPath)),name,x,y,...(nodeName?{nodeName}:{})};}
function rewriteIds(bytes,ids,{aliases=false}={}){
  const p=parseGdfGeometry(bytes),replace=new Map(p.placements.filter(p=>Object.hasOwn(ids,p.instanceName)).map(p=>[p.attributes.find(a=>a.kindCode===41).offset,ids[p.instanceName]]));
  return Buffer.concat(tokeniseGdfGeometry(bytes).filter(t=>aliases||!(t.opcode==='q'&&t.attrType===0&&t.text?.startsWith(MCP_INSTANCE_NAME_PREFIX))).map(t=>replace.has(t.offset)?replaceGdfLabel(t,replace.get(t.offset)):t.body));
}
const note={operation:'add_annotation',x:0,y:0,text:'identity regression note'};
const two=()=>build(createBlankGdf(),[add('not','first'),add('not','second',400)]).buffer;
const unchangedTokens=(before,after,except=new Set())=>assert.deepEqual(tokeniseGdfGeometry(after).filter(t=>!except.has(t.opcode)&&!(t.opcode==='q'&&t.nativeType===7&&t.attrType===0&&t.text===note.text)).map(t=>t.body),tokeniseGdfGeometry(before).filter(t=>!except.has(t.opcode)).map(t=>t.body));

test('native NET_ID retains source text and exposes the original signed-32-bit identity',()=>{
  const bytes=two();
  for(const [raw,value] of [['-1',-1],['2147483648',-2147483648],['4294967295',-1],['4294967297',1],['02',2],['+2',2]]){
    const native=rewriteIds(bytes,{first:raw,second:'9'}),p=parseGdfGeometry(native).placements[0];
    assert.equal(p.netIdText,raw);assert.equal(p.netId,value);assert.equal(p.instanceName,raw);assert.equal(p.instanceNameSource,'native-NET_ID');
    const result=build(native,[note]);unchangedTokens(native,result.buffer);
    assert.deepEqual(build(native,[{operation:'normalize_net_ids'}]).buffer,native,raw);
  }
  assert.equal(nativeGdfNetId('legacyAlias'),null);assert.equal(nativeGdfNetId(null),null);
});

test('vendor 74179 repeated I/O identities allow unrelated edits without renumbering any native records',()=>{
  const file=path.join(root,'max2lib/mf/74179.gdf'),bytes=fs.readFileSync(file),hash=sha256(bytes),p=parseGdfGeometry(bytes);
  assert.equal(p.placements.filter(p=>p.symbolName==='INPUT'&&p.netId===8).length,2);
  assert.equal(p.placements.filter(p=>p.symbolName==='OUTPUT'&&p.netId===9).length,2);
  const result=build(bytes,[note]);unchangedTokens(bytes,result.buffer);
  assert.deepEqual(parseGdfGeometry(result.buffer).placements.map(p=>[p.symbolName,p.netIdText,p.instanceNameSource]),p.placements.map(p=>[p.symbolName,p.netIdText,p.instanceNameSource]));
  assert.deepEqual(build(bytes,[{operation:'normalize_net_ids'}]).buffer,bytes);
  assert.equal(sha256(fs.readFileSync(file)),hash);
});

test('I/O identities are independent of logical IDs; logical IDs and hidden friendly aliases each stay global',()=>{
  const base=build(createBlankGdf(),[add('input','inputA',32,296,'A'),add('not','first'),add('and2','second',400,280),add('output','outputY',536,296,'Y')]).buffer;
  const native=rewriteIds(base,{inputA:'2',first:'2',second:'3',outputY:'2'});unchangedTokens(native,build(native,[note]).buffer);
  const withAliases=rewriteIds(base,{inputA:'2',first:'2',second:'3',outputY:'2'},{aliases:true});assert.doesNotThrow(()=>build(withAliases,[note]));
  assert.throws(()=>build(rewriteIds(base,{first:'2',second:'2'}),[note]),/duplicate native NET_ID/);
  const normalized=parseGdfGeometry(build(rewriteIds(base,{first:'2',second:'2'}),[{operation:'normalize_net_ids'}]).buffer);assert.notEqual(normalized.placements.find(p=>p.symbolName==='NOT').netId,normalized.placements.find(p=>p.symbolName==='AND2').netId);
  assert.throws(()=>build(createBlankGdf(),[add('input','shared',32,296,'A'),add('not','SHARED')]),/Duplicate instance name/);
});

test('transparent WIRE connector identities do not collide with logical primitives',()=>{
  const base=build(createBlankGdf(),[add('not','first'),add('wire','second',400)]).buffer,native=rewriteIds(base,{first:'2',second:'2'});
  unchangedTokens(native,build(native,[note]).buffer);assert.deepEqual(build(native,[{operation:'normalize_net_ids'}]).buffer,native);
});

test('true logical duplicates are rejected after native conversion even when hidden aliases differ',()=>{
  for(const [first,second] of [['2','02'],['-1','4294967295'],['2','4294967298'],['2147483648','-2147483648']]){
    for(const aliases of [false,true]){
      const native=rewriteIds(two(),{first,second},{aliases}),before=Buffer.from(native);
      assert.throws(()=>build(native,[note]),/duplicate native NET_ID/);assert.deepEqual(native,before);
      const normalized=build(native,[{operation:'normalize_net_ids'}]),p=parseGdfGeometry(normalized.buffer);
      assert.equal(p.placements[0].netIdText,first);assert.notEqual(p.placements[0].netId,p.placements[1].netId);
      assert.equal(p.placements[1].instanceName,aliases?'second':p.placements[1].netIdText);
      assert.equal(p.placements[1].instanceNameSource,aliases?'hidden-DOC-alias':'native-NET_ID');
      assert.deepEqual(build(normalized.buffer,[{operation:'normalize_net_ids'}]).buffer,normalized.buffer);
    }
  }
  const vendor=fs.readFileSync(path.join(root,'max2lib/edif/74155o.gdf'));assert.throws(()=>build(vendor,[note]),/duplicate native NET_ID/);
});

test('automatic IDs reserve converted original identities and keep new aliases separate from native labels',()=>{
  const native=rewriteIds(build(createBlankGdf(),[add('not','first')]).buffer,{first:'4294967297'});
  const p=parseGdfGeometry(build(native,[add('not','newGate',400)]).buffer);
  assert.deepEqual(p.placements.map(p=>p.netId),[1,2]);assert.equal(p.placements[0].netIdText,'4294967297');assert.equal(p.placements[1].instanceName,'newGate');
});

test('legacy malformed native labels get deterministic unique legal aliases and synchronized identity sources',()=>{
  const base=build(createBlankGdf(),[add('not','first'),add('not','second',400),add('not','mcp_instance_1',528)]).buffer;
  const native=rewriteIds(base,{first:'bad-label',second:'bad-label',mcp_instance_1:'mcp_instance_1'});
  assert.throws(()=>build(native,[note]),/normalize_net_ids/);
  const normalized=build(native,[{operation:'normalize_net_ids'}]),p=parseGdfGeometry(normalized.buffer);
  assert.deepEqual(p.placements.map(p=>p.netId),[1,2,3]);assert.deepEqual(p.placements.map(p=>p.instanceName),['mcp_instance_1_2','mcp_instance_2','mcp_instance_1']);
  assert.ok(p.placements.every(p=>p.instanceNameSource==='hidden-DOC-alias'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.instanceName)));
  assert.deepEqual(normalized.changes.map(c=>c.previousNetIdText),['bad-label','bad-label','mcp_instance_1']);
  assert.deepEqual(build(native,[{operation:'normalize_net_ids'}]).buffer,normalized.buffer);
  assert.deepEqual(build(normalized.buffer,[{operation:'normalize_net_ids'}]).buffer,normalized.buffer);
});

test('MCP schema/handler wrapper previews and applies both original compatibility cases with SHA and backup integrity',async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-identities-mcp-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  const tools=[...gdfTools({defaultWorkspace:workspace,resolveAcf(){throw new Error('No ACF needed');}}),...gdfConstructionTools({defaultWorkspace:workspace,resolveAcf(){throw new Error('No ACF needed');}})];
  const call=(name,args)=>{const tool=tools.find(t=>t.name===name);validateArguments(args,tool.inputSchema);return tool.handler(args);};
  const variants=[['vendor.gdf',fs.readFileSync(path.join(root,'max2lib/mf/74179.gdf'))],['negative.gdf',rewriteIds(two(),{first:'-1'})],['large.gdf',rewriteIds(two(),{first:'2147483648'})]];
  for(const [file,bytes] of variants){
    fs.writeFileSync(path.join(workspace,file),bytes);const geometry=call('gdf_geometry',{path:file,view:'placements',limit:100}),args={path:file,expectedSha256:geometry.sha256,operations:[note]};
    assert.equal((await call('gdf_construct',{...args,confirm:false})).preview,true);assert.deepEqual(fs.readFileSync(path.join(workspace,file)),bytes);
    const result=await call('gdf_construct',{...args,confirm:true});assert.equal(result.applied,true);assert.equal(result.previousSha256,sha256(bytes));assert.deepEqual(fs.readFileSync(result.backup),bytes);
    unchangedTokens(bytes,fs.readFileSync(path.join(workspace,file)));
    const current=call('gdf_geometry',{path:file,view:'placements',limit:100});assert.equal((await call('gdf_construct',{path:file,expectedSha256:current.sha256,operations:[{operation:'normalize_net_ids'}],confirm:false})).preview,true);
    assert.throws(()=>call('gdf_construct',{...args,confirm:true}),/changed/);
  }
});
