import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compileCachePlan,invalidateCompileCache} from '../lib/compile-cache.mjs';
import {writablePath,changeProjectFile,createProject,editGdfFile,createGdfFile,restoreProjectFile,sha256} from '../lib/workspace.mjs';
import {createBlankGdf} from '../lib/gdf-authoring.mjs';
import {TOOLS} from '../server.mjs';
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-cache-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('project hierarchy caches are all backed up while other project and input-only files remain',t=>{
 const root=temp(t),acf=path.join(root,'top.acf');fs.writeFileSync(acf,'CHIP top\nBEGIN\nEND;');fs.writeFileSync(path.join(root,'top.tdf'),'source');
 const expected=['top.cnf','top(1).cnf','top(23).cnf'];for(const f of [...expected,'other.cnf','other(1).cnf','topology.cnf'])fs.writeFileSync(path.join(root,f),f);
 const plan=compileCachePlan(acf);assert.deepEqual(plan.caches.map(p=>path.basename(p)).sort(),expected.sort());assert.equal(fs.existsSync(path.join(root,'.mcp-backups')),false);
 const result=invalidateCompileCache(acf);assert.equal(result.totalBackups,3);for(const b of result.backups){assert.equal(fs.existsSync(b.path),false);assert.equal(sha256(fs.readFileSync(b.backup)),b.sha256);assert.equal(fs.readFileSync(b.backup,'utf8'),path.basename(b.path));}
 assert.equal(JSON.parse(fs.readFileSync(result.manifest)).backups.length,3);for(const f of ['other.cnf','other(1).cnf','topology.cnf'])assert.equal(fs.readFileSync(path.join(root,f),'utf8'),f);
});
test('numbered cache is invalidated even when top cache is already absent',t=>{
 const root=temp(t),acf=path.join(root,'top.acf');fs.writeFileSync(acf,'');fs.writeFileSync(path.join(root,'top.vhd'),'source');fs.writeFileSync(path.join(root,'top(1).cnf'),'child');const r=invalidateCompileCache(acf);assert.equal(r.invalidated,true);assert.equal(r.totalBackups,1);
});
test('CNF-only and explicit incremental hierarchy preserve all caches',t=>{
 const root=temp(t),acf=path.join(root,'top.acf');fs.writeFileSync(acf,'');for(const f of ['top.cnf','top(1).cnf'])fs.writeFileSync(path.join(root,f),'input');assert.equal(invalidateCompileCache(acf).invalidated,false);fs.writeFileSync(path.join(root,'top.tdf'),'source');assert.equal(invalidateCompileCache(acf,{enabled:false}).invalidated,false);for(const f of ['top.cnf','top(1).cnf'])assert.equal(fs.readFileSync(path.join(root,f),'utf8'),'input');
});
test('all authoring paths reject backup aliases and nested backup scopes before mutation',t=>{
 const root=temp(t);fs.mkdirSync(path.join(root,'.mcp-backups'));const data=createBlankGdf(),saved=path.join(root,'.mcp-backups','saved.gdf');fs.writeFileSync(saved,data);
 for(const rel of ['.mcp-backups/saved.gdf',...(process.platform==='win32'?['.MCP-BACKUPS/saved.gdf','.McP-BaCkUpS/saved.gdf']:[])])assert.throws(()=>editGdfFile(root,{path:rel,expectedSha256:sha256(data),edits:[{recordOffset:20,operation:'translate',dx:8,dy:0}],confirm:true}),/backup store/);
 assert.throws(()=>createGdfFile(root,{path:'.mcp-backups/new.gdf',confirm:true}),/backup store/);
 assert.throws(()=>createProject(root,{name:'demo',directory:'.mcp-backups/demo',confirm:true}),/backup store/);
 assert.throws(()=>changeProjectFile(path.join(root,'.mcp-backups'),{path:'new.txt',content:'no',confirm:true}),/backup store/);
 fs.symlinkSync(path.join(root,'.mcp-backups'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');assert.throws(()=>writablePath(root,'alias/saved.gdf'),/backup store/);assert.throws(()=>writablePath(root,'alias/new/nested.gdf'),/backup store/);
 assert.deepEqual(fs.readFileSync(saved),data);assert.equal(fs.existsSync(path.join(root,'.mcp-backups','new.gdf')),false);
});
test('large compiler backup can be restored with its original digest',t=>{
 const root=temp(t),acf=path.join(root,'top.acf'),cache=path.join(root,'top.cnf'),bytes=Buffer.alloc(4*1024*1024+1,7);fs.writeFileSync(acf,'');fs.writeFileSync(path.join(root,'top.tdf'),'source');fs.writeFileSync(cache,bytes);const r=invalidateCompileCache(acf);assert.equal(fs.existsSync(cache),false);
 const restored=restoreProjectFile(root,{path:'top.cnf',backup:r.backup,backupSha256:r.sha256,confirm:true});assert.equal(restored.restoredSha256,sha256(bytes));assert.deepEqual(fs.readFileSync(cache),bytes);
});

test('compiler, simulator and assignment writers cannot mutate a project inside the backup store',async t=>{
 const root=temp(t),store=path.join(root,'.mcp-backups');fs.mkdirSync(store);const project=path.join(store,'safe.acf');fs.writeFileSync(project,'CHIP safe\nBEGIN\nEND;\n');const before=fs.readFileSync(project);
 for(const name of ['maxplus2_run','simulate_and_verify','setacf_apply'])await assert.rejects(()=>TOOLS.find(tool=>tool.name===name).handler({workspace:root,project,compile:true}),/reserved/);
 assert.deepEqual(fs.readFileSync(project),before);assert.deepEqual(fs.readdirSync(store),['safe.acf']);
});
