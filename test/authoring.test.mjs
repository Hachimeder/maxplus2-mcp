import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject, cloneProject, readProjectFile, changeProjectFile, restoreProjectFile, buildStimulus, buildMemory, inventory, scopedPath, sha256 } from '../lib/workspace.mjs';
import { validateArguments } from '../lib/validation.mjs';

function workspace(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-author-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('create previews without writing, applies isolated project and refuses overwrite',t=>{
  const dir=workspace(t);const args={name:'demo',device:'EP1K10TC100-1',source:'ENTITY demo IS END demo;'};
  assert.equal(createProject(dir,args).preview,true);assert.equal(fs.existsSync(path.join(dir,'demo')),false);
  const r=createProject(dir,{...args,confirm:true});assert.match(fs.readFileSync(r.project,'latin1'),/CHIP demo/);
  assert.match(fs.readFileSync(r.project,'latin1'),/END_TIME = 0.0ns/);assert.throws(()=>createProject(dir,args),/already exists/);
  assert.throws(()=>createProject(dir,{name:'../evil'}),/identifier/);
});
test('edit hash conflict leaves original bytes, exact patch creates a recoverable backup',t=>{
  const dir=workspace(t);fs.writeFileSync(path.join(dir,'a.vhd'),'a\r\nb\r\n','latin1');
  const old=fs.readFileSync(path.join(dir,'a.vhd'));const read=readProjectFile(dir,{path:'a.vhd'});
  assert.throws(()=>changeProjectFile(dir,{path:'a.vhd',content:'other',confirm:true,expectedSha256:'bad'}),/SHA-256/);
  assert.deepEqual(fs.readFileSync(path.join(dir,'a.vhd')),old);
  const args={path:'a.vhd',operation:'patch',edits:[{find:'b',replace:'c'}],expectedSha256:read.sha256};
  assert.equal(changeProjectFile(dir,args).preview,true);assert.deepEqual(fs.readFileSync(path.join(dir,'a.vhd')),old);
  const r=changeProjectFile(dir,{...args,confirm:true});assert.deepEqual(fs.readFileSync(r.backup),old);
  assert.equal(fs.readFileSync(path.join(dir,'a.vhd'),'latin1'),'a\r\nc\r\n');
  assert.throws(()=>changeProjectFile(dir,{...args,expectedSha256:r.result.sha256,edits:[{find:'a',replace:'z',occurrences:2}],confirm:true}),/found 1/);
});
test('delete, move and copy preserve bytes and exclude backups from inventory',t=>{
  const dir=workspace(t);const data=Buffer.from([71,68,70,0,255]);fs.writeFileSync(path.join(dir,'x.gdf'),data);
  const digest=sha256(data);
  const c=changeProjectFile(dir,{path:'x.gdf',operation:'copy',destination:'nested/y.gdf',expectedSha256:digest,confirm:true});assert.equal(c.result.sha256,digest);
  const m=changeProjectFile(dir,{path:'x.gdf',operation:'move',destination:'z.gdf',expectedSha256:digest,confirm:true});assert.deepEqual(fs.readFileSync(m.backup),data);
  assert.equal(fs.existsSync(path.join(dir,'x.gdf')),false);
  const d=changeProjectFile(dir,{path:'z.gdf',operation:'delete',expectedSha256:digest,confirm:true});assert.deepEqual(fs.readFileSync(d.backup),data);
  assert.equal(inventory(dir).total,1);
  assert.throws(()=>changeProjectFile(dir,{path:'z.gdf',operation:'write',content:'bad',confirm:true}),/binary/);
});
test('restore recovers deleted binary bytes and protects current edits with a hash',t=>{
  const dir=workspace(t);const data=Buffer.from([71,68,70,0,255]);fs.writeFileSync(path.join(dir,'x.gdf'),data);
  const removed=changeProjectFile(dir,{path:'x.gdf',operation:'delete',expectedSha256:sha256(data),confirm:true});
  const args={path:'x.gdf',backup:removed.backup,backupSha256:removed.previousSha256};
  assert.equal(restoreProjectFile(dir,args).preview,true);assert.equal(fs.existsSync(path.join(dir,'x.gdf')),false);
  restoreProjectFile(dir,{...args,confirm:true});assert.deepEqual(fs.readFileSync(path.join(dir,'x.gdf')),data);
  assert.throws(()=>restoreProjectFile(dir,{...args,expectedSha256:'stale',confirm:true}),/SHA-256/);
  assert.throws(()=>restoreProjectFile(dir,{...args,backup:'x.gdf',expectedSha256:sha256(data)}),/backup store/);
});

test('path confinement rejects traversal, ADS and symlink/junction escapes',t=>{
  const dir=workspace(t);const outside=workspace(t);
  assert.throws(()=>scopedPath(dir,'../out.vhd'),/escapes/);assert.throws(()=>scopedPath(dir,'a.vhd:stream'),/invalid/);
  assert.throws(()=>scopedPath(dir,'CON.txt'),/reserved/);
  fs.symlinkSync(outside,path.join(dir,'escape'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>scopedPath(dir,'escape/secret.vhd'),/junction/);
});
test('clone verifies every source including binary dependencies without changing originals',t=>{
  const dir=workspace(t);const r=createProject(dir,{name:'demo',source:'-- original',confirm:true});
  fs.writeFileSync(path.join(r.directory,'module.gdf'),Buffer.from([0,1,2,255]));
  const before=sha256(fs.readFileSync(r.project));
  const clone=cloneProject(r.project,dir,{directory:'copy',confirm:true});
  assert.equal(sha256(fs.readFileSync(r.project)),before);assert.equal(clone.fileCount,3);
  const manifest=JSON.parse(fs.readFileSync(clone.manifestPath));
  for(const item of manifest)assert.equal(sha256(fs.readFileSync(item.destination)),item.sha256);
  assert.throws(()=>cloneProject(r.project,dir,{directory:'demo/inside',confirm:true}),/inside/);
});
test('paged reading and explicit encoding preserve legacy data',t=>{
  const dir=workspace(t);fs.writeFileSync(path.join(dir,'a.txt'),'one\ntwo\nthree');
  const r=readProjectFile(dir,{path:'a.txt',startLine:2,lineCount:1});assert.equal(r.content,'two');assert.equal(r.nextLine,3);
  assert.throws(()=>changeProjectFile(dir,{path:'u.vhd',content:'-- 中文',confirm:true}),/Latin-1/);
  changeProjectFile(dir,{path:'u.vhd',content:'-- 中文',encoding:'utf8',confirm:true});assert.equal(readProjectFile(dir,{path:'u.vhd',encoding:'utf8'}).content,'-- 中文');
});
test('stimulus maps explicit bus order, drives every input and emits INTERVAL grammar',()=>{
  const args={inputs:[{name:'A',nodes:['A3','A2','A1','A0']},'CLK'],rows:[{A:3,CLK:0},{A:5,CLK:1}],interval:40};
  const text=buildStimulus(args);assert.match(text,/INTERVAL 40;/);assert.match(text,/STOP 80;/);assert.match(text,/0 0 1 1 0\n0 1 0 1 1\n;\n$/);
  assert.throws(()=>buildStimulus({...args,rows:[{A:16,CLK:0}]}),/exceeds/);
  assert.throws(()=>buildStimulus({...args,rows:[{A:1}]}),/CLK requires/);
  assert.throws(()=>buildStimulus({...args,stop:10}),/time range/);
});
test('memory writer initializes unused addresses and rejects overflow',()=>{
  const text=buildMemory({width:8,depth:4,values:[2,'0xff'],defaultValue:0});assert.match(text,/1 : FF/);assert.match(text,/\[2\.\.3\] : 0/);
  assert.throws(()=>buildMemory({width:8,depth:1,values:[256]}),/WIDTH/);
  assert.match(buildMemory({width:64,depth:1,values:['0x123456789abcdef0']}),/123456789ABCDEF0/);
});
test('runtime schema validation rejects wrong types, extra fields and nested bad edits',()=>{
  const schema={type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'integer',minimum:1,maximum:3}}};
  assert.throws(()=>validateArguments({value:'2'},schema),/integer/);assert.throws(()=>validateArguments({value:0},schema),/minimum/);
  assert.throws(()=>validateArguments({value:2,unknown:true},schema),/unknown/);assert.throws(()=>validateArguments([],schema),/object/);
});
