#!/usr/bin/env node
/** Real Windows backend plus an ordinary MCP client, without an agent SDK.
 * Native input is exercised only in the helper's own disposable WinForms test
 * window. Any user's already-open MAX+plus II window is observed read-only.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildDesktopHelper} from '../lib/windows-native.mjs';

if(process.platform!=='win32'){
  console.log('Native Windows integration skipped: this host is not Windows.');
  process.exit(0);
}
let passed=0,failed=0;
async function check(label,fn){try{const detail=await fn();passed++;console.log(`  PASS ${label}${detail?` -> ${detail}`:''}`);}catch(err){failed++;console.log(`  FAIL ${label}: ${err.message}`);}}
function run(exe,args,timeoutMs=30000){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('native self-test timed out'));},timeoutMs);
    child.stdout.setEncoding('utf8');child.stdout.on('data',d=>stdout+=d);child.stderr.setEncoding('utf8');child.stderr.on('data',d=>stderr+=d);
    child.on('error',err=>{clearTimeout(timer);reject(err);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
}
let helper;
await check('bundled Windows source builds with installed .NET Framework',async()=>{helper=await buildDesktopHelper();assert.match(helper,/MaxplusDesktop\.exe$/);return helper;});
if(helper)await check('real native input and UIA work in an isolated disposable fixture',async()=>{
  const result=await run(helper,['--self-test']);assert.equal(result.code,0,result.stderr||result.stdout);
  const proof=JSON.parse(result.stdout.trim());assert.equal(proof.failed,0,JSON.stringify(proof));assert.ok(proof.passed>=6,JSON.stringify(proof));return `${proof.passed} native checks`;
});

const serverPath=fileURLToPath(new URL('../server.mjs',import.meta.url));
const server=spawn(process.execPath,[serverPath],{cwd:path.dirname(serverPath),windowsHide:true,stdio:['pipe','pipe','pipe']});
let sequence=0,buffer='',diagnostics='';const pending=new Map();
server.stderr.setEncoding('utf8');server.stderr.on('data',d=>diagnostics=(diagnostics+d).slice(-3000));
server.stdout.setEncoding('utf8');server.stdout.on('data',d=>{
  buffer+=d;let end;
  while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    let msg;try{msg=JSON.parse(line);}catch(err){for(const p of pending.values())p.reject(err);pending.clear();continue;}
    const p=pending.get(msg.id);if(!p)continue;pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);
  }
});
server.on('error',err=>{for(const p of pending.values())p.reject(err);pending.clear();});
function request(method,params){const id=++sequence;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP request timed out: ${method}; ${diagnostics}`));},30000);
  pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
  server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});}
async function call(name,args={}){const r=await request('tools/call',{name,arguments:args});assert.notEqual(r.isError,true,r.content?.[0]?.text);return r;}
let windows=[],connected=false;
try{
  await check('a plain stdio client initializes with the standard desktop tool schemas',async()=>{
    const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'plain-native-e2e',version:'1'}});assert.equal(init.serverInfo.version,'0.10.1');
    server.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await request('tools/list',{});assert.equal(list.tools.filter(t=>t.name.startsWith('desktop_')).length,6);
    assert.ok(list.tools.find(t=>t.name==='desktop_action').inputSchema.properties.action.enum.includes('move'));return `${list.tools.length} tools`;
  });
  await check('standard MCP status reaches the owned native worker directly',async()=>{
    const r=await call('desktop_status');const s=r.structuredContent;assert.equal(s.backend,'standalone-win32-uia');assert.equal(s.agentIndependent,true);assert.equal(s.requiresHostTools,false);
    assert.equal(s.connected,true,s.reason||JSON.stringify(s));connected=true;return `interactive desktop available`;
  });
  if(connected){
    await check('window enumeration is restricted to the installed MAX+plus II programs',async()=>{
      const r=await call('desktop_windows');windows=r.structuredContent.windows;assert.ok(Array.isArray(windows));
      for(const w of windows){assert.ok(Number.isSafeInteger(w.id));assert.ok(Number.isSafeInteger(w.pid));assert.match(w.app,/^process:.*\\(?:max2win|maxplus2|megawiz|genmem|wlarithm|wlsum|wlcount|wlmux|wlram|wlclshif|wdivide)\.exe$/i);assert.ok(w.bounds.width>0&&w.bounds.height>0);}
      return `${windows.length} real windows`;
    });
    const visible=windows.find(w=>!w.minimized);
    if(visible)await check('a real MAX+plus II observation returns a PNG image through ordinary MCP',async()=>{
      const r=await call('desktop_observe',{windowId:visible.id});const state=r.structuredContent;
      assert.equal(state.window.id,visible.id);assert.ok(state.observationId);assert.ok(state.accessibility?.tree);assert.ok(state.accessibility.focused_element!==undefined);assert.ok(state.menus&&Number.isInteger(state.menus.total));
      const img=r.content.find(c=>c.type==='image');assert.ok(img,JSON.stringify(state));assert.equal(img.mimeType,'image/png');
      const bytes=Buffer.from(img.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.length>100);assert.ok(!JSON.stringify(state).includes('base64'));return `${bytes.readUInt32BE(16)} × ${bytes.readUInt32BE(20)} PNG; no input sent`;
    });else console.log('  Read-only original-window screenshot not exercised: no non-minimized MAX+plus II window. Native screenshot/input fixture still ran.');
  }
}finally{
  server.stdin.end();
  if(server.exitCode===null&&server.signalCode===null)await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{server.kill();reject(new Error('MCP failed to shut down its worker'));},5000);server.once('close',()=>{clearTimeout(timer);resolve();});
  });
}
console.log(`OK passed=${passed} failed=${failed}`);process.exitCode=failed?1:0;
