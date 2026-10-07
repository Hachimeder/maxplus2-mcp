import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cloneProject,sha256} from '../lib/workspace.mjs';
import {inspectStoredPalette} from '../lib/display-palette.mjs';
import {practiceFileTools} from '../lib/practice-file-tools.mjs';

test('source clone selects dependencies and explicit stimuli without copying 129MiB history',()=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-source-clone-'));
 try{
  const dir=path.join(workspace,'original');fs.mkdirSync(path.join(dir,'hierarchy'),{recursive:true});
  for(const [name,text]of [['top.acf','CHIP top\nEND;'],['top.vhd','entity top is end;'],['hierarchy/macro.sym','symbol'],['micro.asm','assembly'],['stim.scf','stimulus'],['data.bin','memory'],['top.edo','export'],['.mcp-clone-manifest.json','old manifest']])fs.writeFileSync(path.join(dir,name),text);
  const large=path.join(dir,'history.tbl'),fd=fs.openSync(large,'w');fs.ftruncateSync(fd,129*1024*1024);fs.closeSync(fd);
  const args={directory:'copy',profile:'sources',includePaths:['stim.scf','data.bin']};
  assert.throws(()=>cloneProject(path.join(dir,'top.acf'),workspace,{directory:'all'}),/128.*MiB/);
  const preview=cloneProject(path.join(dir,'top.acf'),workspace,args);assert.equal(preview.preview,true);assert.equal(preview.fileCount,6);assert.equal(preview.skippedFiles,3);assert.equal(fs.existsSync(path.join(workspace,'copy')),false);
  const result=cloneProject(path.join(dir,'top.acf'),workspace,{...args,confirm:true});assert.equal(result.fileCount,6);assert.equal(result.profile,'sources');
  const manifest=JSON.parse(fs.readFileSync(result.manifestPath,'utf8'));assert.equal(manifest.length,6);
  for(const row of manifest){assert.equal(sha256(fs.readFileSync(row.source)),row.sha256);assert.equal(sha256(fs.readFileSync(row.destination)),row.sha256);}
  assert.equal(fs.existsSync(path.join(workspace,'copy','history.tbl')),false);assert.equal(fs.existsSync(path.join(workspace,'copy','top.edo')),false);assert.equal(fs.statSync(large).size,129*1024*1024);
  assert.throws(()=>cloneProject(path.join(dir,'top.acf'),workspace,{...args,directory:'bad',includePaths:['../outside.scf']}),/escapes/);
  assert.throws(()=>cloneProject(path.join(dir,'top.acf'),workspace,{...args,directory:'bad',includePaths:['.mcp-clone-manifest.json']}),/reserved/);
  assert.throws(()=>cloneProject(path.join(dir,'top.acf'),workspace,{...args,directory:'bad',includePaths:['missing.scf']}),/missing/);
  assert.equal(fs.existsSync(path.join(workspace,'bad')),false);
 }finally{assert.equal(path.dirname(workspace),fs.realpathSync(os.tmpdir()));fs.rmSync(workspace,{recursive:true,force:true});}
});
test('stored palette exposes application roles without asserting GDF bits or live display',()=>{
 const p=inspectStoredPalette('[SYSTEM]\nsecret=do-not-return\n[Colors]\nText=18\nSymbol Pinstub Names=2\nNodes & Connection Dots=0\n');
 assert.equal(p.savedSettingsOnly,true);assert.equal(p.liveWindowVerified,false);assert.equal(p.entries[0].verifiedMeaning,'Windows system text color');assert.equal(p.entries[1].verifiedMeaning,'blue');assert.equal(p.roles.freeDocText,'Text');assert.equal(JSON.stringify(p).includes('do-not-return'),false);
 assert.throws(()=>inspectStoredPalette('[Colors]\nText=2\ntext=4'),/Duplicate/);assert.throws(()=>inspectStoredPalette('[Colors]\nText=999'),/Unrecognized/);assert.throws(()=>inspectStoredPalette('[SYSTEM]\nText=2'),/No stored/);
});
test('selected waveform evidence remains readable when the TBL contains1500 unrelated columns',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-wave-budget-'));
 try{
  const names=Array.from({length:1500},(_,i)=>`Q${i}`),rows=[0,1,0].map((v,i)=>`${i}.0> = ${v} ${names.map(()=>i===1?1:0).join(' ')}`);
  fs.writeFileSync(path.join(root,'many.tbl'),`OUTPUTS VALID ${names.join(' ')} ;\nUNIT ns;\nRADIX HEX;\nPATTERN\n${rows.join('\n')}\n;\n`);
  const tools=practiceFileTools({defaultWorkspace:root,resolveAcf:p=>p}),result=tools.find(t=>t.name==='waveform_results').handler({path:'many.tbl',validSignal:'VALID',dataSignals:['Q1499']});
  assert.equal(result.totalDeclaredSignals,1501);assert.equal(result.signals.length,2);assert.equal(result.events.total,1);assert.equal(result.events.items[0].values.Q1499.value,1);assert.ok(JSON.stringify(result).length<=36000);assert.equal(result.signalCatalogTool,'waveform_signals');
 }finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
