import {PACKAGE_VERSION} from './helpers/package-version.mjs';
/** Standard external MCP client: file-first workflows without any agent SDK. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-plain-file-client-'));
const oracle=JSON.parse(fs.readFileSync(path.join(here,'fixtures','scf-events-oracle.json'),'utf8'));
const original=Buffer.from(oracle.cases['all-values'].scfBase64,'base64');
fs.writeFileSync(path.join(workspace,'demo.scf'),original);
const server=spawn(process.execPath,[path.join(here,'..','server.mjs')],{
  env:{...process.env,MAXPLUS2_WORKSPACE:workspace},windowsHide:true,stdio:['pipe','pipe','pipe'],
});
let sequence=0,buffer='',stderr='',passed=0,failed=0,exportResult;
const pending=new Map();
server.stderr.setEncoding('utf8');server.stderr.on('data',d=>stderr=(stderr+d).slice(-3000));
server.stdout.setEncoding('utf8');server.stdout.on('data',d=>{
  buffer+=d;let end;
  while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    let msg;try{msg=JSON.parse(line);}catch(e){for(const p of pending.values())p.reject(e);pending.clear();continue;}
    const p=pending.get(msg.id);if(!p)continue;pending.delete(msg.id);
    msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);
  }
});
server.on('error',e=>{for(const p of pending.values())p.reject(e);pending.clear();});
function request(method,params){const id=++sequence;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out; ${stderr}`));},30000);
  pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
  server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});}
async function call(name,args={}){
  const r=await request('tools/call',{name,arguments:args});assert.notEqual(r.isError,true,r.content?.[0]?.text);
  assert.equal(r.content[0].text,JSON.stringify(r.structuredContent));return r.structuredContent;
}
async function check(label,fn){try{await fn();passed++;console.log(`  PASS ${label}`);}catch(e){failed++;console.log(`  FAIL ${label}: ${e.stack}`);}}
let initial,changed;
const edits=[{signal:'A',events:[{time:0,value:1},{time:125.5,value:0},{time:250,value:'X'},{time:350,value:'Z'}]}];
try{
  await check('ordinary client discovers file tools and both standard guide resources',async()=>{
    const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'plain-file-e2e',version:'1'}});
    assert.equal(init.serverInfo.version,PACKAGE_VERSION);server.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await request('tools/list',{});assert.ok(list.tools.length>=50);
    for(const name of ['project_parse_file','scf_edit','netlist_export'])assert.ok(list.tools.some(t=>t.name===name));
    const resources=await request('resources/list',{});assert.equal(resources.resources.length,2);
    const guide=await request('resources/read',{uri:'maxplus2://file-guide'});assert.match(guide.contents[0].text,/scf_edit/);
  });
  await check('SCF logic and exact query boundaries cross the actual MCP transport',async()=>{
    initial=await call('project_parse_file',{path:'demo.scf',signal:'A',startTime:200,limit:1});
    assert.equal(initial.format,'scf');assert.equal(initial.data.unit,'ns');assert.equal(initial.data.signals[0].valueAtStart,'X');
    assert.equal(initial.data.signals[0].events[0].time,200);assert.equal(initial.data.signals[0].events[0].value,'X');
    assert.deepEqual(fs.readFileSync(path.join(workspace,'demo.scf')),original);
  });
  await check('SCF preview and stale-hash error preserve the original',async()=>{
    const preview=await call('scf_edit',{path:'demo.scf',expectedSha256:initial.sha256,edits});assert.equal(preview.preview,true);
    const bad=await request('tools/call',{name:'scf_edit',arguments:{path:'demo.scf',expectedSha256:'0'.repeat(64),edits,confirm:true}});
    assert.equal(bad.isError,true);assert.match(bad.content[0].text,/changed|SHA/);assert.deepEqual(fs.readFileSync(path.join(workspace,'demo.scf')),original);
  });
  await check('SCF apply returns backup evidence and changed events over MCP',async()=>{
    changed=await call('scf_edit',{path:'demo.scf',expectedSha256:initial.sha256,edits,confirm:true});assert.equal(changed.applied,true);
    assert.deepEqual(fs.readFileSync(changed.backup),original);assert.match(changed.note,/stale/);
    const result=await call('project_parse_file',{path:'demo.scf',signal:'A'});
    assert.deepEqual(result.data.signals[0].events.map(({time,value})=>({time,value})),edits[0].events);
    assert.equal(result.sha256,changed.nextSha256);
  });
  await check('backup restore through MCP recovers identical binary bytes',async()=>{
    const restored=await call('project_restore_file',{path:'demo.scf',backup:changed.backup,backupSha256:initial.sha256,expectedSha256:changed.nextSha256,confirm:true});
    assert.equal(restored.applied,true);assert.deepEqual(fs.readFileSync(path.join(workspace,'demo.scf')),original);
  });
  if(!process.argv.includes('--file-only')) {
  await check('new source exports through the real background MCP job path',async()=>{
    const source='LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY circuit IS PORT (A,B : IN STD_LOGIC; Q : OUT STD_LOGIC); END circuit;\nARCHITECTURE rtl OF circuit IS BEGIN Q <= A XOR B; END rtl;\n';
    const project=await call('project_create',{name:'circuit',source,device:'EP1K10TC100-1',confirm:true});
    const started=await call('netlist_export',{path:path.relative(workspace,project.project),async:true,timeoutMs:60000});assert.ok(started.jobId);
    const deadline=Date.now()+90000;let status;
    do{await new Promise(r=>setTimeout(r,250));status=await call('job_status',{jobId:started.jobId});}while(status.status==='running'&&Date.now()<deadline);
    assert.equal(status.status,'done',JSON.stringify(status));exportResult=status.result;
    assert.equal(exportResult.verdict,'verified-export',JSON.stringify(exportResult.compile));assert.equal(exportResult.sourceIntegrity.unchanged,true);
    assert.equal(exportResult.compile.successBanner,true);assert.equal(exportResult.netlistJson[0].understood.connectivity,true);
    assert.equal(fs.readFileSync(path.join(project.directory,'circuit.vhd'),'utf8'),source);
  });
  await check('original-vendor EDIF and HDL exports can be read through paginated MCP tools',async()=>{
    const edo=exportResult.exportPaths.find(f=>f.extension==='.edo');assert.ok(edo);
    const parsed=await call('project_parse_file',{workspace:exportResult.projectDir,path:path.basename(edo.path),limit:1,endpointLimit:1});
    assert.equal(parsed.sha256,edo.sha256);assert.equal(parsed.data.validation.ok,true);assert.ok(parsed.data.counts.nets>0);
    assert.equal(parsed.data.nets.returned,1);assert.ok(parsed.data.nets.items[0].totalEndpoints>=1);
    const vo=exportResult.exportPaths.find(f=>f.extension==='.vo');assert.ok(vo);
    const text=await call('project_read_file',{workspace:exportResult.projectDir,path:path.basename(vo.path),lineCount:30});
    assert.match(JSON.stringify(text),/module|Altera/i);
  });
  } else console.log('Optional native export checks omitted (--file-only).');
}finally{
  server.stdin.end();
  if(server.exitCode===null&&server.signalCode===null)await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{server.kill();reject(new Error('file MCP failed to shut down'));},5000);server.once('close',()=>{clearTimeout(timer);resolve();});
  });
  // Only paths created by this fixture and the returned owned temporary export.
  for(const dir of [workspace,exportResult?.scratch].filter(Boolean)){
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^(mp2-plain-file-client-|maxplus2-netlist-)/);
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
console.log(`OK passed=${passed} failed=${failed}`);process.exitCode=failed?1:0;
