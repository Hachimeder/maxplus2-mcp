import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {TOOLS} from '../server.mjs';
import {sha256} from '../lib/workspace.mjs';
import {validateArguments} from '../lib/validation.mjs';
import {netlistPage} from '../lib/file-parsing.mjs';
import {scanTextRecords} from '../lib/gdf.mjs';
const oracle=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/scf-events-oracle.json',import.meta.url)),'utf8'));
const tool=name=>TOOLS.find(t=>t.name===name);
test('GDF text evidence requires the declared terminator and rejects truncated or damaged records',()=>{
  const valid=Buffer.from('4744460000000600006503020244666a7007d004710000040008006b80760300414e440074','hex');
  assert.deepEqual(scanTextRecords(valid),[{offset:29,payloadOffset:32,length:3,text:'AND'}]);
  assert.throws(()=>scanTextRecords(valid.subarray(0,35)),/Truncated/);
  const damaged=Buffer.from(valid);damaged[35]=0x41;assert.throws(()=>scanTextRecords(damaged),/NUL/);
});
function fixture(t){const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-file-tools-'));const bytes=Buffer.from(oracle.cases['all-values'].scfBase64,'base64');fs.writeFileSync(path.join(workspace,'demo.scf'),bytes);t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));return {workspace,bytes,path:'demo.scf',expectedSha256:sha256(bytes)};}

test('unified file parser returns exact identity and real binary logic events without GUI',async t=>{
  const f=fixture(t),r=await tool('project_parse_file').handler({...f,signal:'A',startTime:150,endTime:450,limit:1});
  assert.equal(r.sha256,f.expectedSha256);assert.equal(r.format,'scf');assert.equal(r.data.unit,'ns');assert.equal(r.data.signals[0].valueAtStart,1);
  assert.equal(r.data.signals[0].truncated,true);assert.equal(r.data.signals[0].events[0].value,'X');assert.equal(fs.readFileSync(path.join(f.workspace,f.path)).equals(f.bytes),true);
});

test('SCF file mutation previews, rejects changed hashes, backs up and restores exact bytes',async t=>{
  const f=fixture(t),edits=[{signal:'A',events:[{time:0,value:1},{time:125.5,value:0},{time:250,value:'X'}]}];
  const args={...f,edits};const preview=await tool('scf_edit').handler(args);assert.equal(preview.preview,true);assert.equal(fs.readFileSync(path.join(f.workspace,f.path)).equals(f.bytes),true);
  await assert.rejects(()=>tool('scf_edit').handler({...args,expectedSha256:'old',confirm:true}),/changed|SHA/);
  const changed=await tool('scf_edit').handler({...args,confirm:true});assert.equal(changed.applied,true);assert.equal(fs.readFileSync(changed.backup).equals(f.bytes),true);
  const read=await tool('project_parse_file').handler({...f,signal:'A'});assert.deepEqual(read.data.signals[0].events.map(({time,value})=>({time,value})),edits[0].events);
  assert.match(changed.note,/stale/);
  const restored=await tool('project_restore_file').handler({workspace:f.workspace,path:f.path,backup:changed.backup,backupSha256:f.expectedSha256,expectedSha256:read.sha256,confirm:true});
  assert.equal(restored.applied,true);assert.equal(fs.readFileSync(path.join(f.workspace,f.path)).equals(f.bytes),true);
});

test('file parser scopes files and explicit formats still reject invalid binary content',async t=>{
  const f=fixture(t);await assert.rejects(()=>tool('project_parse_file').handler({workspace:f.workspace,path:'../outside.scf'}),/escapes/);
  fs.writeFileSync(path.join(f.workspace,'bad.scf'),'not an SCF');await assert.rejects(()=>tool('project_parse_file').handler({workspace:f.workspace,path:'bad.scf'}),/short|magic/);
  await assert.rejects(()=>tool('scf_edit').handler({...f,confirm:true,edits:[{signal:'Q',events:[{time:0,value:0}]}]}),/only input/);
  assert.equal(fs.readFileSync(path.join(f.workspace,f.path)).equals(f.bytes),true);
});

test('structured ACF and report inspection retain complete counts and explicit page metadata',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.workspace,'demo.acf'),'CHIP demo\nBEGIN\n DEVICE = EP1K10TC100-1;\nEND;\nSIMULATOR_CONFIGURATION\nBEGIN\n END_TIME = 0.0ns;\nEND;');
  const r=await tool('project_parse_file').handler({workspace:f.workspace,path:'demo.acf',limit:1});assert.equal(r.data.sections.total,2);assert.equal(r.data.sections.nextOffset,1);assert.equal(r.data.sections.items[0].entries[0].value,'EP1K10TC100-1');
  fs.writeFileSync(path.join(f.workspace,'demo.rpt'),'Info: retained\nWarning: second\nError: omitted');const report=await tool('project_parse_file').handler({workspace:f.workspace,path:'demo.rpt',limit:1});assert.equal(report.data.counts.error,1);assert.equal(report.data.diagnostics.length,1);assert.equal(report.data.truncated,true);
});

test('EDIF connection paging preserves net identifiers and endpoint roles without duplicated views',()=>{
  const parsed={format:'EDIF',version:'2.0.0',name:'demo',design:{cell:'TOP'},ports:[{id:'A'}],instances:[{id:'U1'}],nets:[{id:'N',name:'N',endpoints:Array.from({length:100},(_,i)=>({port:'P'+i,role:i===0?'driver':'load'}))}],libraries:[{id:'L',name:'L',cells:[{id:'TOP',name:'TOP',views:[{id:'V',type:'NETLIST',ports:[],instances:[],nets:[]}]}]}],validation:{ok:true},understood:{connectivity:true},limitations:[]};
  const p=netlistPage(parsed,{net:'N',endpointOffset:0,endpointLimit:2});assert.equal(p.nets.items[0].totalEndpoints,100);assert.equal(p.nets.items[0].nextEndpointOffset,2);assert.equal(p.nets.items[0].endpoints[0].role,'driver');assert.equal(p.libraries[0].cells[0].views,undefined);
  const next=netlistPage(parsed,{net:'N',endpointOffset:2,endpointLimit:2});assert.equal(next.nets.items[0].endpoints[0].port,'P2');assert.equal(netlistPage(parsed,{cell:'L/TOP'}).selectedCell.id,'TOP');
  assert.throws(()=>netlistPage(parsed,{cell:'missing'}),/uniquely/);
});

test('MCP schemas prevent unsupported event types and misplaced async from reaching writers',()=>{
  for(const args of [{path:'x.scf',expectedSha256:'hash',edits:[{signal:'A',events:[{time:0,value:2}]}]},{path:'x.scf',expectedSha256:'hash',edits:[{signal:'A',events:[{time:0,value:1,extra:true}]}]},{path:'x.scf',expectedSha256:'hash',edits:[],async:true}])assert.throws(()=>validateArguments(args,tool('scf_edit').inputSchema));
  assert.doesNotThrow(()=>validateArguments({path:'top.gdf',async:true},tool('netlist_export').inputSchema));
});
