/** Regression for a same-size, unchanged-mtime edit in an extracted child. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';import {parseTbl,tblTrace} from '../lib/tbl.mjs';import {sha256} from '../lib/workspace.mjs';
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-hier-client-')),client=new PlainMcpClient(workspace);let passed=0;
const call=(n,a)=>client.call(n,a),job=(n,a)=>client.job(n,a),check=async(n,f)=>{await f();passed++;console.log('PASS '+n);};
let project,dir,child,stamp,original,firstCache;
async function compile(){const r=await job('maxplus2_run',{project,compile:true});assert.equal(r.report.clean,true,JSON.stringify(r.report));return r;}
async function outputs(){const r=await job('simulate_and_verify',{project});assert.equal(r.banner,'successful');return [0,100].map(time=>tblTrace(parseTbl(fs.readFileSync(r.tblPath,'latin1'))).filter(row=>row.time>=time&&row.time<time+100).at(-1).outputs.y);}
try{
 await client.initialize();
 await check('original two-level design compiles and simulates inversion cleanly',async()=>{
  const p=await call('project_create',{name:'top',device:'EPF10K20RC240-4',sourceExtension:'.tdf',source:'FUNCTION child(a) RETURNS(y);\nSUBDESIGN top ( a : INPUT; y : OUTPUT; )\nBEGIN\n y = child(a);\nEND;\n',confirm:true});project=p.project;dir=p.directory;child=path.join(dir,'child.tdf');
  original='SUBDESIGN child ( a : INPUT; y : OUTPUT; )\nBEGIN\n y = !a;\nEND;\n';await call('project_edit_file',{project,path:'child.tdf',content:original,confirm:true});fs.utimesSync(child,1700000000,1700000000);stamp=fs.statSync(child);
  await call('stimulus_write',{project,path:'top.vec',inputs:['a'],outputs:['y'],rows:[{a:0},{a:1}],interval:100,confirm:true});await compile();assert.deepEqual(await outputs(),[1,0]);
  firstCache=fs.readdirSync(dir).filter(n=>/^top\(\d+\)\.cnf$/i.test(n));assert.ok(firstCache.length>0,'No numbered hierarchy cache produced');
 });
 await check('unchanged source size/mtime still rebuilds numbered caches and changes actual logic',async()=>{
  const beforeHash=sha256(fs.readFileSync(child));await call('project_edit_file',{project,path:'child.tdf',expectedSha256:beforeHash,content:original.replace('!a',' a'),confirm:true});fs.utimesSync(child,stamp.atime,stamp.mtime);assert.equal(fs.statSync(child).size,Buffer.byteLength(original));assert.equal(fs.statSync(child).mtimeMs,stamp.mtimeMs);
  const before=new Map(firstCache.map(n=>[path.join(dir,n),sha256(fs.readFileSync(path.join(dir,n)))])),r=await compile();
  const cache=r.compilerCache;assert.ok(cache,'Expected cache rebuild evidence');assert.equal(cache.invalidated,true);assert.ok(cache.backups.some(b=>firstCache.includes(path.basename(b.path))),JSON.stringify(cache));
  for(const b of cache.backups)if(before.has(b.path))assert.equal(sha256(fs.readFileSync(b.backup)),before.get(b.path));assert.deepEqual(await outputs(),[0,1]);
 });
}finally{await client.close();assert.equal(path.dirname(workspace),os.tmpdir());fs.rmSync(workspace,{recursive:true,force:true});}
console.log(`OK passed=${passed} failed=0`);
