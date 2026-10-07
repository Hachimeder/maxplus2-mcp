/** Plain MCP client creates a binary schematic from scratch and verifies two
 * independently specified truth tables using the actual original simulator. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseTbl,tblTrace,checkTrace} from '../lib/tbl.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-construction-client-'));
const child=spawn(process.execPath,[path.join(here,'../server.mjs')],{env:{...process.env,MAXPLUS2_WORKSPACE:workspace},windowsHide:true,stdio:['pipe','pipe','pipe']});
let id=0,buffer='',stderr='',passed=0;const pending=new Map(),ownedExports=[];
child.stderr.on('data',d=>stderr=(stderr+d).slice(-3000));child.stdout.setEncoding('utf8');
child.stdout.on('data',d=>{buffer+=d;let end;while((end=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(row.id);if(p){pending.delete(row.id);row.error?p.reject(new Error(row.error.message)):p.resolve(row.result);}}});
child.on('error',e=>{for(const p of pending.values())p.reject(e);pending.clear();});
function request(method,params={}){const key=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`MCP timeout: ${method}; ${stderr}`));},30000);pending.set(key,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});}
async function call(name,args={}){const r=await request('tools/call',{name,arguments:args});assert.notEqual(r.isError,true,r.content[0].text);assert.equal(r.content[0].text,JSON.stringify(r.structuredContent));return r.structuredContent;}
async function job(name,args){const started=await call(name,{...args,async:true,timeoutMs:120000});assert.ok(started.jobId);const deadline=Date.now()+130000;let status;do{await new Promise(r=>setTimeout(r,200));status=await call('job_status',{jobId:started.jobId});}while(status.status==='running'&&Date.now()<deadline);assert.equal(status.status,'done',JSON.stringify(status));return status.result;}
async function check(label,fn){await fn();passed++;console.log(`PASS ${label}`);}
async function inspectSymbol(name){const r=await call('gdf_symbol_library',{path:`prim/${name}.sym`,limit:100});return r;}
const wire=(x1,y1,x2,y2)=>({operation:'add_wire',x1,y1,x2,y2});
const placed=(s,name,x,y,nodeName)=>({operation:'add_symbol',symbolPath:s.path,symbolSha256:s.sha256,name,x,y,...(nodeName?{nodeName}:{})});
function truth(trace,expected){const expectations=expected.map((Y,i)=>{const row=trace.filter(r=>r.time>=i*100&&r.time<(i+1)*100).at(-1);assert.ok(row,`no settled event for interval ${i}`);return {time:row.time,outputs:{Y}};});assert.equal(checkTrace(trace,expectations,{tolerance:0}).ok,true,JSON.stringify(trace));assert.equal(checkTrace(trace,[{time:expectations[0].time,outputs:{Y:1-expected[0]}}],{tolerance:0}).ok,false);}
let project,blank,initial,constructed,xor,input,output,and;
try{
  await check('ordinary client discovers all current tools and construction annotations',async()=>{
    const r=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'plain-construction-client',version:'1'}});assert.equal(r.serverInfo.version,'0.10.1');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await request('tools/list');assert.ok(list.tools.length>=50);assert.equal(list.tools.find(t=>t.name==='gdf_construct').annotations.destructiveHint,true);assert.equal(list.tools.find(t=>t.name==='gdf_symbol_library').annotations.readOnlyHint,true);
  });
  await check('blank project and original SYM pins are available over standard MCP',async()=>{
    project=await call('project_create',{name:'demo',device:'EP1K10TC100-1',confirm:true});blank=await call('gdf_create',{project:project.project,path:'demo.gdf',confirm:true});assert.equal(blank.bytes,21);
    input=await inspectSymbol('input');output=await inspectSymbol('output');xor=await inspectSymbol('xor');and=await inspectSymbol('and2');
    assert.deepEqual(xor.pins.map(p=>p.position),[{x:64,y:16},{x:0,y:24},{x:0,y:8}]);assert.equal(input.pins[0].position.x,168);
  });
  await check('hashed construction previews then inserts four symbols and three wires',async()=>{
    const operations=[placed(input,'inputA',32,296,'A'),placed(input,'inputB',32,280,'B'),placed(xor,'gate',272,280),placed(output,'outputY',408,288,'Y'),wire(200,304,272,304),wire(200,288,272,288),wire(336,296,408,296)];
    const args={project:project.project,path:'demo.gdf',expectedSha256:blank.sha256,operations};const preview=await call('gdf_construct',args);assert.equal(preview.preview,true);assert.equal(fs.statSync(blank.path).size,21);
    const bad=await request('tools/call',{name:'gdf_construct',arguments:{...args,operations:[{...operations[0],symbolSha256:'0'.repeat(64)}],confirm:true}});assert.equal(bad.isError,true);assert.equal(fs.statSync(blank.path).size,21);
    constructed=await call('gdf_construct',{...args,confirm:true});assert.equal(constructed.counts.after.placements,4);assert.equal(constructed.counts.after.sheetPrimitives,3);assert.equal(fs.statSync(constructed.backup).size,21);
    initial=await call('gdf_geometry',{project:project.project,path:'demo.gdf',view:'placements',limit:100,childLimit:100});assert.equal(initial.counts.definitions,3);assert.deepEqual(initial.records.items.find(p=>p.instanceName==='gate').pins.items.map(p=>p.worldPosition),[{x:336,y:296},{x:272,y:304},{x:272,y:288}]);
  });
  await check('original compiler and simulator accept entirely new XOR GDF with all four patterns',async()=>{
    const compiled=await job('maxplus2_run',{project:project.project,compile:true});assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));assert.equal(compiled.report?.fresh,true);
    await call('stimulus_write',{project:project.project,path:'demo.vec',inputs:['A','B'],outputs:['Y'],rows:[{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}],interval:100,confirm:true});
    const sim=await job('simulate_and_verify',{project:project.project});assert.equal(sim.banner,'successful',JSON.stringify(sim));assert.equal(sim.tblCreated,true);truth(tblTrace(parseTbl(fs.readFileSync(sim.tblPath,'latin1'))),[0,1,1,0]);
  });
  await check('delete XOR and insert AND2 in one transaction changes simulated logic',async()=>{
    const gate=initial.records.items.find(p=>p.instanceName==='gate');await call('gdf_construct',{project:project.project,path:'demo.gdf',expectedSha256:initial.sha256,operations:[{operation:'delete_symbol',recordOffset:gate.offset},placed(and,'gate',272,280)],confirm:true});
    const g=await call('gdf_geometry',{project:project.project,path:'demo.gdf',view:'definitions',limit:100,childLimit:1});assert.deepEqual(g.records.items.map(p=>p.name).sort(),['AND2','INPUT','OUTPUT']);
    const compiled=await job('maxplus2_run',{project:project.project,compile:true});assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));
    const sim=await job('simulate_and_verify',{project:project.project});assert.equal(sim.banner,'successful',JSON.stringify(sim));truth(tblTrace(parseTbl(fs.readFileSync(sim.tblPath,'latin1'))),[0,0,0,1]);
  });
  await check('external node rename changes original-vendor exported ports and backup restores bytes',async()=>{
    const g=await call('gdf_geometry',{project:project.project,path:'demo.gdf',view:'placements',limit:100}),before=fs.readFileSync(blank.path),pin=g.records.items.find(p=>p.instanceName==='inputA');
    const r=await call('gdf_construct',{project:project.project,path:'demo.gdf',expectedSha256:g.sha256,operations:[{operation:'set_node_name',recordOffset:pin.offset,nodeName:'C'}],confirm:true});
    const exported=await job('netlist_export',{project:project.project,path:'demo.gdf'});ownedExports.push(exported.scratch);assert.equal(exported.verdict,'verified-export',JSON.stringify(exported.compile));
    const names=exported.netlistJson[0].ports.items.map(p=>p.name);assert.ok(names.includes('C'));assert.ok(!names.includes('A'));assert.ok(names.includes('B')&&names.includes('Y'));
    await call('project_restore_file',{project:project.project,path:'demo.gdf',backup:r.backup,backupSha256:g.sha256,expectedSha256:r.nextSha256,confirm:true});assert.deepEqual(fs.readFileSync(blank.path),before);
  });
  console.log(`OK passed=${passed} failed=0\nNew GDF XOR and replacement AND2 truth tables independently verified through ordinary MCP and original MAX+PLUS II.`);
}finally{
  child.stdin.end();if(child.exitCode===null&&child.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('construction MCP failed to shut down'));},5000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  for(const dir of [workspace,...ownedExports].filter(Boolean)){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^(mp2-gdf-construction-client-|maxplus2-netlist-)/);fs.rmSync(dir,{recursive:true,force:true});}
}
