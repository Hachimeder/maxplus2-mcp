import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {detectInstall} from '../lib/runtime.mjs';
import {SOURCE_DIRECTORY,resolveLocalStartup,probeLocalCompiler} from '../scripts/local-startup.mjs';
import {makeLocalMcpConfig,saveLocalMcpConfig} from '../scripts/configure-local.mjs';
import {desktopRecovery} from '../lib/desktop-recovery.mjs';

const original=detectInstall(),root=original?.root;
const configuredRoot=process.env.MAXPLUS2_ROOT;
delete process.env.MAXPLUS2_ROOT;
const automaticInstall=detectInstall();
if(configuredRoot!==undefined)process.env.MAXPLUS2_ROOT=configuredRoot;
const pwsh=process.env.MAXPLUS2_TEST_PWSH??path.join(process.env.LOCALAPPDATA??'', 'Microsoft','WindowsApps','pwsh.exe');
const available=process.platform==='win32'&&Boolean(root);
const pwshProbe=available?spawnSync(pwsh,['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8',windowsHide:true,timeout:12000}):null;
const base=fs.mkdtempSync(path.join(os.tmpdir(),'mp2 startup relocation '));
const source=path.join(base,'relocated mcp source'),work=path.join(base,'work selected 中文'),other=path.join(base,'other cwd');
for(const p of [source,work,other])fs.mkdirSync(p);
for(const name of ['server.mjs','start-local.ps1','package.json','lib','native','scripts'])fs.cpSync(path.join(SOURCE_DIRECTORY,name),path.join(source,name),{recursive:true});
const configFile=path.join(source,'mcp-config.local.json');
const cleanEnv=()=>{const result={...process.env};delete result.MAXPLUS2_ROOT;delete result.MAXPLUS2_WORKSPACE;delete result.MAXPLUS2_NODE;return result;};
const sha=b=>createHash('sha256').update(b).digest('hex');
function config(c){fs.writeFileSync(configFile,JSON.stringify(c));}
function runConfig(args=[]){return spawnSync(process.execPath,[path.join(source,'scripts','configure-local.mjs'),...args],{cwd:other,env:cleanEnv(),encoding:'utf8',windowsHide:true,timeout:15000});}
function client(args=[],env=cleanEnv(),selectedSource=source){
  const child=spawn(pwsh,['-NoProfile','-File',path.join(selectedSource,'start-local.ps1'),...args],{cwd:other,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='',seq=0,bad='';const pending=new Map();
  const rejectAll=error=>{for(const p of pending.values())p.reject(error);pending.clear();};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',d=>stderr=(stderr+d).slice(-10000));
  child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{bad=line;rejectAll(new Error('Non-protocol stdout: '+line));continue;}const p=pending.get(r.id);if(p){pending.delete(r.id);r.error?p.reject(new Error(r.error.message)):p.resolve(r.result);}}});
  child.once('error',rejectAll);child.once('close',code=>rejectAll(new Error(`Startup ended ${code}: ${stderr}`)));
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Request timed out ${method}: ${stderr}`));},12000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {child,request,get stderr(){return stderr;},get bad(){return bad;},async status(){const r=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'relocated-startup-test',version:'1'}});assert.equal(r.serverInfo.name,'maxplus2-mcp');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');const status=await request('tools/call',{name:'installation_status',arguments:{}});assert.notEqual(status.isError,true);return status.structuredContent;},async close(){if(child.exitCode===null){child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Startup did not exit on stdin EOF'));},5000);child.once('close',()=>{clearTimeout(timer);resolve();});});}assert.equal(bad,'');}};
}

test('PowerShell runtime is actually callable and uses version 7 rather than testing its alias as a regular file',{skip:!available},()=>{
  assert.equal(pwshProbe.status,0,pwshProbe.stderr||pwshProbe.error?.message);assert.match(pwshProbe.stdout.trim(),/^7\./);console.log(`Verified PowerShell ${pwshProbe.stdout.trim()} at ${pwsh}`);
});
test('source directory comes from fileURLToPath and generator records the actual Node executable',()=>{
  assert.equal(SOURCE_DIRECTORY,fs.realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
  if(!root)return;
  const settings=resolveLocalStartup({sourceDirectory:source,installRoot:root,workspace:work},cleanEnv());
  const c=makeLocalMcpConfig(settings);assert.equal(c.mcpServers.maxplus2.command,process.execPath);assert.equal(c.mcpServers.maxplus2.args[0],path.join(source,'server.mjs'));assert.equal(c.maxplus2Local.workspaceRelative,path.relative(source,work));
});
test('configured installation can be read but copied absolute workspace and server are ignored',{skip:!available},async()=>{
  config({mcpServers:{maxplus2:{command:'missing-node.exe',args:[path.join(other,'server.mjs')],env:{MAXPLUS2_ROOT:root,MAXPLUS2_WORKSPACE:other}}}});
  const c=client();try{const s=await c.status();assert.equal(s.root,fs.realpathSync(root));assert.equal(s.workspace,fs.realpathSync(base));assert.match(c.stderr,/Ignoring absolute workspace/);assert.match(c.stderr,/Ignoring a copied server path/);}finally{await c.close();}
});
test('explicit parameters beat environments and local config in the real PowerShell MCP entry',{skip:!available},async()=>{
  config({mcpServers:{maxplus2:{env:{MAXPLUS2_ROOT:path.join(base,'missing install'),MAXPLUS2_WORKSPACE:other}}}});
  const c=client(['-InstallRoot',root,'-Workspace',work,'-NodePath',process.execPath],{...cleanEnv(),MAXPLUS2_ROOT:path.join(base,'invalid environment install'),MAXPLUS2_WORKSPACE:other});
  try{const s=await c.status();assert.equal(s.root,fs.realpathSync(root));assert.equal(s.workspace,fs.realpathSync(work));const comment='-- 中文输入输出字节验证\n';fs.writeFileSync(path.join(work,'unicode.vhd'),comment);const r=await c.request('tools/call',{name:'project_read_file',arguments:{path:'unicode.vhd',encoding:'utf8'}});assert.notEqual(r.isError,true);assert.ok(JSON.stringify(r.structuredContent).includes(comment.trim()));}finally{await c.close();}
});
test('environment roots take priority and a deleted local config falls back to discovery',{skip:!available},async()=>{
  fs.unlinkSync(configFile);
  for(const env of [{...cleanEnv(),MAXPLUS2_ROOT:root,MAXPLUS2_WORKSPACE:work},cleanEnv()]){const c=client([],env);try{
    if(!env.MAXPLUS2_ROOT&&!automaticInstall){await assert.rejects(()=>c.status(),/installation not found/);continue;}
    const s=await c.status();assert.equal(s.root,fs.realpathSync(env.MAXPLUS2_ROOT??automaticInstall.root));assert.equal(s.workspace,fs.realpathSync(env.MAXPLUS2_WORKSPACE??base));
  }finally{await c.close();}}
});
test('stale configured installation falls back, but invalid explicit/environment roots never silently select another installation',{skip:!available},async()=>{
  config({mcpServers:{maxplus2:{env:{MAXPLUS2_ROOT:path.join(base,'stale install')}}}});
  const c=client();try{
    if(automaticInstall){assert.equal((await c.status()).root,fs.realpathSync(automaticInstall.root));assert.match(c.stderr,/trying common installation/);}
    else await assert.rejects(()=>c.status(),/installation not found/);
  }finally{await c.close();}
  for(const [args,env] of [[['-InstallRoot',path.join(base,'missing explicit')],cleanEnv()],[[],{...cleanEnv(),MAXPLUS2_ROOT:path.join(base,'missing environment')}]]){
    const result=spawnSync(pwsh,['-NoProfile','-File',path.join(source,'start-local.ps1'),...args],{cwd:other,env,encoding:'utf8',windowsHide:true,timeout:12000});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/does not exist/);
  }
});
test('malformed local configuration fails only on stderr and does not launch another MCP',{skip:!available},()=>{
  fs.writeFileSync(configFile,'{"broken":');
  try{const r=spawnSync(pwsh,['-NoProfile','-File',path.join(source,'start-local.ps1')],{cwd:other,env:cleanEnv(),encoding:'utf8',windowsHide:true,timeout:12000});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/Invalid local MCP config/);}finally{fs.unlinkSync(configFile);}
});
test('compiler probe uses the selected actual vendor executable without touching a project',{skip:!available},async()=>{
  const settings=resolveLocalStartup({sourceDirectory:source,installRoot:root,workspace:work},cleanEnv());const p=await probeLocalCompiler(settings);assert.equal(p.executable,path.join(fs.realpathSync(root),'maxplus2.exe'));assert.equal(p.code,0);assert.match(p.versionText,/Version \d/);
});
test('malformed local config field types are rejected with useful messages',{skip:!available},()=>{
  for(const [value,message] of [[{mcpServers:{maxplus2:{env:[]}}},/env must be an object/],[{mcpServers:{maxplus2:{args:'wrong'}}},/args must be an array/],[{maxplus2Local:[]},/maxplus2Local must be an object/]]){
    config(value);assert.throws(()=>resolveLocalStartup({sourceDirectory:source,installRoot:root},cleanEnv()),message);
  }
  fs.unlinkSync(configFile);
});
test('configuration CLI preview, apply, refusal, fresh hash replacement and backup work from unrelated cwd',{skip:!available},()=>{
  const args=['--root',root,'--workspace',work],preview=runConfig(args);assert.equal(preview.status,0,preview.stderr);const plan=JSON.parse(preview.stdout);assert.equal(plan.preview,true);assert.equal(plan.path,configFile);assert.equal(fs.existsSync(configFile),false);assert.equal(plan.config.mcpServers.maxplus2.command,process.execPath);
  const write=runConfig([...args,'--apply']);assert.equal(write.status,0,write.stderr);const saved=JSON.parse(write.stdout),before=fs.readFileSync(configFile);assert.equal(saved.sha256,sha(before));
  const refused=runConfig([...args,'--apply']);assert.equal(refused.status,1);assert.equal(refused.stdout,'');assert.match(refused.stderr,/already exists/);assert.equal(sha(fs.readFileSync(configFile)),sha(before));
  const stale=runConfig([...args,'--apply','--overwrite','--expected-sha256','0'.repeat(64)]);assert.equal(stale.status,1);assert.match(stale.stderr,/hash changed/);
  const changed=runConfig(['--root',root,'--workspace',other,'--apply','--overwrite','--expected-sha256',sha(before)]);assert.equal(changed.status,0,changed.stderr);const replacement=JSON.parse(changed.stdout);assert.equal(sha(fs.readFileSync(replacement.backup)),sha(before));assert.equal(replacement.previousSha256,sha(before));assert.notEqual(replacement.sha256,sha(before));
});
test('generated relative workspace survives another move and JSON args point to the selected source',{skip:!available},async()=>{
  const next=path.join(base,'second relocation','relocated mcp source');fs.mkdirSync(path.dirname(next));fs.cpSync(source,next,{recursive:true});fs.mkdirSync(path.join(path.dirname(next),'other cwd'));
  const s=resolveLocalStartup({sourceDirectory:next,installRoot:root},cleanEnv());assert.equal(s.workspace,path.join(path.dirname(next),'other cwd'));assert.equal(s.server,path.join(next,'server.mjs'));assert.equal(s.workspaceSource,'local-config-relative');
  const out=path.join(base,'generated selected source.json');const r=runConfig(['--source',next,'--root',root,'--output',out,'--apply']);assert.equal(r.status,0,r.stderr);const cfg=JSON.parse(fs.readFileSync(out));assert.equal(cfg.mcpServers.maxplus2.args[0],path.join(next,'server.mjs'));assert.equal(cfg.mcpServers.maxplus2.command,process.execPath);
  const c=client([],cleanEnv(),next);try{const actual=await c.status();assert.equal(actual.workspace,path.join(path.dirname(next),'other cwd'));assert.equal(actual.root,fs.realpathSync(root));}finally{await c.close();}
});
test('config saving refuses stale or missing expected targets and never overwrites by default',()=>{
  const f=path.join(work,'config write bounds.json'),initial=Buffer.from('{}\n'),next=Buffer.from('{"a":1}\n');saveLocalMcpConfig(f,initial);assert.throws(()=>saveLocalMcpConfig(f,next),/already exists/);assert.throws(()=>saveLocalMcpConfig(f,next,{overwrite:true,expectedSha256:'f'.repeat(64)}),/hash changed/);assert.equal(fs.readFileSync(f).equals(initial),true);assert.throws(()=>saveLocalMcpConfig(path.join(work,'missing.json'),next,{expectedSha256:sha(initial)}),/missing/);
});
test('focus and modal recovery preserve errors, require fresh observations and never repeat input',()=>{
  const message='Target lost foreground focus or an unobserved owned window appeared; input stopped.';
  const r=desktopRecovery(new Error(message),{root:'C:\\custom installed root',windowId:42,action:'type_text',window:{id:42,pid:9,minimized:true},windows:[{id:42,pid:9,title:'target'},{id:56,pid:10,title:'other'}]});assert.equal(r.originalMessage,message);assert.equal(r.automaticRetry,false);assert.equal(r.inputOutcome,'unknown');assert.equal(r.steps[0].tool,'desktop_windows');assert.equal(r.knownTargetWindows.length,1);assert.ok(r.steps.some(s=>s.arguments?.action==='activate_window'));assert.ok(r.steps.every(s=>!['type_text','press_key','click'].includes(s.arguments?.action)));assert.ok(r.steps.every(s=>s.arguments.root==='C:\\custom installed root'));
  const modal=desktopRecovery('Window is disabled by a modal dialog',{windowId:42,action:'click'});assert.equal(modal.code,'DESKTOP_MODAL_CHANGED');assert.match(modal.steps[0].reason,/enabled owned dialog/);
});
