/** New workflows through an ordinary stdio client and the original compiler. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';
import {sha256} from '../lib/workspace.mjs';
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-practice-client-')),client=new PlainMcpClient(workspace);
let passed=0,project;
const call=(name,args)=>client.call(name,args);
async function check(label,run){await run();passed++;console.log('PASS '+label);}
try{
 await client.initialize();
 await check('ordinary client discovers current workflow schemas and original stored palette',async()=>{
  const tools=(await client.request('tools/list')).tools;assert.equal(tools.length,68);
  for(const name of ['gdf_wire_cleanup','waveform_signals','waveform_results','display_palette_inspect'])assert.ok(tools.some(t=>t.name===name));
  assert.equal(tools.find(t=>t.name==='gdf_wire_cleanup').annotations.destructiveHint,true);
  assert.deepEqual(tools.find(t=>t.name==='project_clone').inputSchema.properties.profile.enum,['all','sources']);
  const p=await call('display_palette_inspect');assert.equal(p.savedSettingsOnly,true);assert.equal(p.liveWindowVerified,false);assert.ok(p.entries.some(e=>e.name==='Text'));assert.equal(p.COMPANY_NAME,undefined);
  const stopped=await client.request('tools/call',{name:'desktop_action',arguments:{windowId:1,observationId:'never-observed',action:'press_key',parameters:{key:'Escape'}}});
  assert.equal(stopped.isError,true);assert.equal(stopped.content[0].text,JSON.stringify(stopped.structuredContent));assert.equal(stopped.structuredContent.recovery.code,'DESKTOP_OBSERVATION_STALE');assert.equal(stopped.structuredContent.recovery.automaticRetry,false);assert.ok(stopped.structuredContent.recovery.steps.some(s=>s.tool==='desktop_windows'));
 });
 await check('anonymous wire pruning preview/apply/backup retains source and clean original compilation',async()=>{
  project=await call('project_create',{name:'demo',device:'EP1K10TC100-1',confirm:true});
  const b=await call('gdf_create',{project:project.project,path:'demo.gdf',confirm:true}),operations=[];
  for(const [s,name,x,y,nodeName]of [['input','inputA',32,296,'A'],['input','inputB',32,280,'B'],['xor','gate',272,280],['output','outputY',408,288,'Y']]){
   const symbol=await call('gdf_symbol_library',{path:`prim/${s}.sym`});operations.push({operation:'add_symbol',symbolPath:symbol.path,symbolSha256:symbol.sha256,name,x,y,...(nodeName?{nodeName}:{})});
  }
  for(const [x1,y1,x2,y2]of [[200,304,400,304],[400,304,400,368],[200,288,272,288],[336,296,408,296]])operations.push({operation:'add_wire',x1,y1,x2,y2});
  await call('gdf_construct',{project:project.project,path:'demo.gdf',expectedSha256:b.sha256,operations,confirm:true});
  const baseline=fs.readFileSync(path.join(project.directory,'demo.gdf'));assert.equal((await client.job('maxplus2_run',{project:project.project,compile:true})).report.clean,true);
  const args={project:project.project,path:'demo.gdf',expectedSha256:sha256(baseline)},preview=await call('gdf_wire_cleanup',args);
  assert.equal(preview.preview,true);assert.ok(preview.totalChanges>0);assert.equal(preview.connectionCheck.preserved,true);assert.deepEqual(fs.readFileSync(path.join(project.directory,'demo.gdf')),baseline);
  const edited=await call('gdf_wire_cleanup',{...args,confirm:true});assert.equal(edited.result.sha256,preview.nextSha256);assert.equal(sha256(fs.readFileSync(edited.backup)),args.expectedSha256);
  assert.equal((await client.job('maxplus2_run',{project:project.project,compile:true})).report.clean,true);
  const failed=await client.request('tools/call',{name:'gdf_wire_cleanup',arguments:{...args,confirm:true}});assert.equal(failed.isError,true);assert.match(failed.content[0].text,/changed/);assert.equal(sha256(fs.readFileSync(path.join(project.directory,'demo.gdf'))),edited.result.sha256);
 });
 await check('fresh native simulation yields gated numeric events and an honest suggested view window',async()=>{
  await call('stimulus_write',{project:project.project,path:'demo.vec',inputs:['A','B'],outputs:['Y'],rows:[{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}],interval:100,confirm:true});
  const sim=await client.job('simulate_and_verify',{project:project.project});assert.equal(sim.verdict,'verified');assert.deepEqual(sim.counts,{errors:0,warnings:0});
  const s=await call('waveform_signals',{project:project.project,path:'demo.tbl',limit:100});assert.deepEqual(s.signals.items.map(s=>s.name),['A','B','Y']);
  const opts={project:project.project,path:'demo.tbl',validSignal:'B',dataSignals:['Y'],settleNs:50,paddingNs:10,limit:1};
  const first=await call('waveform_results',opts);assert.equal(first.status,'unknown_values');assert.equal(first.unknownValidRows,1);assert.equal(first.unknownDataEvents,0);assert.equal(first.totalEvents,2);assert.equal(first.events.items[0].values.Y.value,1);assert.equal(first.events.nextOffset,1);
  const second=await call('waveform_results',{...opts,offset:first.events.nextOffset});assert.equal(second.events.items[0].values.Y.value,0);assert.equal(second.events.nextOffset,null);assert.equal(second.events.total,2);assert.equal(second.unit,'ns');assert.ok(second.recommendedWindow.startTimeNs<=100);assert.ok(second.recommendedWindow.endTimeNs>=350);
  const absent=await call('waveform_results',{...opts,dataSignals:['hidden_CLK']});assert.equal(absent.status,'missing_signals');assert.deepEqual(absent.missingSignals,['hidden_CLK']);assert.equal(absent.events.items[0].values.hidden_CLK.value,null);
 });
 await check('source-only clone excludes prior results, keeps explicit stimulus and independently compiles',async()=>{
  const preview=await call('project_clone',{project:project.project,directory:'seed',profile:'sources',includePaths:['demo.vec']});assert.equal(preview.preview,true);assert.ok(preview.skippedFiles>0);
  const copy=await call('project_clone',{project:project.project,directory:'seed',profile:'sources',includePaths:['demo.vec'],confirm:true});assert.equal(fs.existsSync(path.join(copy.directory,'demo.tbl')),false);assert.equal(fs.existsSync(path.join(copy.directory,'demo.scf')),false);assert.ok(fs.existsSync(path.join(copy.directory,'demo.vec')));
  assert.equal((await client.job('maxplus2_run',{project:copy.project,compile:true})).report.clean,true);assert.equal((await client.job('simulate_and_verify',{project:copy.project})).verdict,'verified');
 });
 console.log(`OK passed=${passed} failed=0\nScratch retained: ${workspace}`);
}finally{await client.close();}
