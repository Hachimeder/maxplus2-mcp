import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {DesktopController} from '../lib/desktop.mjs';
import {NativeTransport} from '../lib/windows-native.mjs';
import {desktopResult,desktopViewport,MCP_IMAGES} from '../lib/desktop-result.mjs';
import {TOOLS} from '../server.mjs';

function fixture(t,{ttl=120000}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-desktop-'));fs.writeFileSync(path.join(root,'max2win.exe'),'mock');
  const window={id:123,pid:456,app:'process:'+path.join(root,'max2win.exe'),title:'MAX+plus II Manager',bounds:{x:10,y:10,width:100,height:100}};
  const calls=[];let fail=false;let clock=1000;
  const transport={generation:1,request:async(method,args)=>{
    if(method==='windows')return {windows:[window,{id:999,app:'process:C:\\Windows\\system32\\cmd.exe',title:'terminal'}]};
    if(method==='status')return {interactiveSession:true};
    if(method==='observe')return {window:{...window,bounds:{...window.bounds}},menus:[{menu_index:0,label:'File',enabled:true,submenu:true},{menu_index:1,label:'Open',enabled:true,submenu:false,separator:false},{menu_index:2,label:'Unavailable',enabled:false,submenu:false}],accessibility:args.includeText===false?null:{tree:'0 Window\n\t1 Edit Name',focused_element:'1 Edit Name'},screenshots:args.includeScreenshot===false?[]:[{id:'shot',url:'data:image/png;base64,AQID',width:100,height:100,zIndex:0}]};
    if(method==='action'||method==='launch'){calls.push({method,args});if(fail)throw new Error('input failed');return {inputDelivered:true};}
    throw new Error('unknown mock method');
  },close:()=>{}};
  const controller=new DesktopController(root,{transport,observationTtlMs:ttl,now:()=>clock});
  t.after(()=>{controller.close();fs.rmSync(root,{recursive:true,force:true});});
  return {controller,window,calls,transport,fail:()=>{fail=true;},tick:ms=>{clock+=ms;}};
}
async function observation(f){await f.controller.request('windows');return f.controller.request('observe',{windowId:123});}

test('standard desktop calls execute directly and expose no agent-specific host requirement',async t=>{
  const f=fixture(t);const status=await f.controller.request('status');
  assert.equal(status.connected,true);assert.equal(status.agentIndependent,true);assert.equal(status.requiresHostTools,false);
  const result=await f.controller.request('windows');assert.equal(result.windows.length,1);assert.equal(result.windows[0].id,123);
  assert.equal(result.hostCall,undefined);assert.equal(result.queued,undefined);
  const o=await f.controller.request('observe',{windowId:123});assert.equal(o[MCP_IMAGES].length,1);
  const a=await f.controller.request('action',{windowId:123,observationId:o.observationId,action:'click',parameters:{element_index:1}});
  assert.equal(a.inputDelivered,true);assert.equal(a.verificationRequired,true);assert.equal(a.hostCall,undefined);assert.equal(f.calls.length,1);
  for(const tool of TOOLS.filter(t=>t.name.startsWith('desktop_')))assert.doesNotMatch(tool.description,/node_repl|sky|Codex|trusted host|hostCall/);
});

test('single-use observations and operation IDs prevent repeated input on retry',async t=>{
  const f=fixture(t);const o=await observation(f);
  const args={windowId:123,observationId:o.observationId,operationId:'retry-safe-1',action:'click',parameters:{x:20,y:20,screenshotId:'shot'}};
  const a=await f.controller.request('action',args);
  assert.notEqual(a.observationId,o.observationId);assert.equal(f.calls.length,1);
  const retry=await f.controller.request('action',args);assert.equal(retry.replayed,true);assert.equal(f.calls.length,1);
  assert.equal((await f.controller.request('result',{requestId:args.operationId})).observationId,a.observationId);
  await assert.rejects(()=>f.controller.request('action',{...args,parameters:{x:25,y:25,screenshotId:'shot'}}),/different arguments/);
  await assert.rejects(()=>f.controller.request('action',{...args,operationId:'different-id'}),/stale/);
});

test('only observed enabled leaf menus can be invoked and pagination keeps their global indices',async t=>{
 const f=fixture(t);await f.controller.request('windows');let o=await f.controller.request('observe',{windowId:123,includeText:false,includeScreenshot:false,menuOffset:1,menuLimit:1});
 assert.equal(o.menus.total,3);assert.equal(o.menus.items[0].menu_index,1);assert.equal(o.menus.nextOffset,2);
 for(const menu_index of [0,2,100,-1])await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'invoke_menu',parameters:{menu_index}}),/enabled leaf/);
 const args={windowId:123,observationId:o.observationId,action:'invoke_menu',parameters:{menu_index:1},operationId:'menu-retry'};
 const r=await f.controller.request('action',args);assert.equal(r.inputDelivered,true);assert.equal(f.calls.length,1);assert.equal((await f.controller.request('action',args)).replayed,true);assert.equal(f.calls.length,1);
 await assert.rejects(()=>f.controller.request('action',{...args,operationId:'different'}),/stale/);
});

test('invalid windows, elements, coordinates, images, extra parameters and system chords do not input',async t=>{
  const f=fixture(t);const o=await observation(f);
  for(const args of [
    {windowId:999,action:'click',parameters:{element_index:1}},
    {windowId:123,action:'click',parameters:{element_index:999}},
    {windowId:123,action:'click',parameters:{x:1,y:1,screenshotId:'old'}},
    {windowId:123,action:'click',parameters:{x:-1,y:1,screenshotId:'shot'}},
    {windowId:123,action:'drag',parameters:{from_x:1,from_y:1,to_x:100,to_y:20,screenshotId:'shot'}},
    {windowId:123,action:'press_key',parameters:{key:'Win+r'}},
    {windowId:123,action:'press_key',parameters:{key:'Return',window:f.window}},
  ])await assert.rejects(()=>f.controller.request('action',{observationId:o.observationId,...args}));
  assert.equal(f.calls.length,0);
});

test('failed input consumes observation and records an error without blind replay',async t=>{
  const f=fixture(t);const o=await observation(f);f.fail();
  const args={windowId:123,observationId:o.observationId,operationId:'failed-input',action:'press_key',parameters:{key:'Escape'}};
  let first;
  await assert.rejects(()=>f.controller.request('action',args),e=>{first=e.recovery;assert.match(e.message,/outcome unknown/);assert.equal(first.inputOutcome,'unknown');assert.equal(first.automaticRetry,false);assert.equal(first.targetWindowId,123);assert.ok(first.steps.some(s=>s.tool==='desktop_windows'));assert.equal(first.knownTargetWindows.length,1);return true;});
  await assert.rejects(()=>f.controller.request('action',args),e=>{assert.match(e.message,/outcome unknown/);assert.deepEqual(e.recovery,first);return true;});
  await assert.rejects(()=>f.controller.request('result',{requestId:'failed-input'}),e=>{assert.deepEqual(e.recovery,first);return true;});
  await assert.rejects(()=>f.controller.request('action',{...args,operationId:'new-attempt'}),/stale/);
  assert.equal(f.calls.length,1);
});

test('hover, modified mouse input and drag timing cover canvas interactions with bounded parameters',async t=>{
  const f=fixture(t);let o=await observation(f);
  for(const [action,parameters] of [
    ['move',{x:10,y:20,screenshotId:'shot'}],
    ['drag',{from_x:10,from_y:20,to_x:50,to_y:60,screenshotId:'shot',modifiers:['Ctrl','Shift'],mouse_button:'right',durationMs:500}],
    ['scroll',{x:10,y:20,screenshotId:'shot',scrollX:0,scrollY:120,modifiers:['Ctrl']}],
  ])o=await f.controller.request('action',{windowId:123,observationId:o.observationId,action,parameters});
  assert.equal(f.calls.length,3);assert.deepEqual(f.calls[1].args.parameters.modifiers,['Ctrl','Shift']);
  for(const parameters of [
    {from_x:1,from_y:1,to_x:20,to_y:20,screenshotId:'shot',durationMs:6000},
    {from_x:1,from_y:1,to_x:20,to_y:20,screenshotId:'shot',modifiers:['Win']},
    {from_x:1,from_y:1,to_x:20,to_y:20,screenshotId:'shot',modifiers:['Ctrl','Ctrl']},
  ])await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'drag',parameters}));
  await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'scroll',parameters:{x:1,y:1,screenshotId:'shot',scrollX:0,scrollY:1.5}}));
  assert.equal(f.calls.length,3);
});

test('a locked or unavailable input desktop is not advertised as connected',async t=>{
  const f=fixture(t);const request=f.transport.request;
  f.transport.request=(method,args)=>method==='status'?Promise.resolve({interactiveSession:true,inputDesktopAvailable:false}):request(method,args);
  assert.equal((await f.controller.request('status')).connected,false);
});

test('moved windows, expired observations and a restarted helper require reobservation',async t=>{
  for(const mutate of [f=>f.tick(121000),f=>f.window.bounds.x++,f=>f.transport.generation++]){
    const f=fixture(t);const o=await observation(f);mutate(f);
    await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'press_key',parameters:{key:'Return'}}));
    assert.equal(f.calls.length,0);
  }
});

test('typing requires observed focus and indexed inputs require observed text',async t=>{
  const f=fixture(t);await f.controller.request('windows');
  const o=await f.controller.request('observe',{windowId:123,includeText:false});
  await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'type_text',parameters:{text:'hello'}}),/focus/);
  await assert.rejects(()=>f.controller.request('action',{windowId:123,observationId:o.observationId,action:'set_value',parameters:{element_index:1,value:'hello'}}),/observation/);
  assert.equal(f.calls.length,0);
});

test('desktop screenshot remains standard image content without base64 in text metadata',()=>{
  const data=desktopResult({screenshots:[{id:'1',url:'data:image/png;base64,AQID',width:10,zIndex:0}],observationId:'o'});
  assert.equal(data[MCP_IMAGES][0].type,'image');assert.equal(data[MCP_IMAGES][0].data,'AQID');assert.equal(JSON.stringify(data).includes('base64'),false);
});

test('large native trees keep image and actionable observation metadata within the MCP budget',()=>{
  const elements=Array.from({length:1500},(_,element_index)=>({element_index,name:'label'.repeat(100),value:'value'.repeat(1000),patterns:['ValuePattern'],secondaryActions:[]}));
  const state={window:{id:123},accessibility:{tree:elements.map(e=>`${e.element_index} Edit ${e.name}`).join('\n'),elements,focused_element:{element_index:800}},screenshots:[{url:'data:image/png;base64,AQID'}]};
  const first=desktopViewport(state,{textOffset:0,textLimit:100});
  assert.ok(JSON.stringify({...first,screenshots:[]}).length<40001);assert.ok(first.accessibility.nextTextOffset>0);assert.equal(first.accessibility.totalElements,1500);
  const next=desktopViewport(state,{textOffset:800,textLimit:10});assert.equal(next.accessibility.elements[0].element_index,800);assert.match(next.accessibility.tree,/^800 /);assert.equal(next.accessibility.focused_element.element_index,800);
  assert.equal(desktopResult(first)[MCP_IMAGES].length,1);
});

test('standalone helper uses owned private stdio and cleans up on timeout',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-native-protocol-'));
  const script=path.join(root,'worker.cjs');
  fs.writeFileSync(script,`let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){let q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.method==='hang')continue;process.stdout.write(JSON.stringify({id:q.id,result:{method:q.method,root:q.installRoot,connected:true}})+'\\n');}});`);
  let child;
  const transport=new NativeTransport(root,{timeoutMs:500,executable:process.execPath,spawnWorker:(exe,args,options)=>(child=spawn(exe,[script],options))});
  t.after(()=>{transport.close();fs.rmSync(root,{recursive:true,force:true});});
  const status=await transport.request('status');assert.equal(status.connected,true);assert.equal(status.root,fs.realpathSync(root));assert.equal(transport.generation,1);
  await assert.rejects(()=>transport.request('hang'),/timed out/);
  await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('close',resolve));
  assert.equal(transport.pending.size,0);
  await transport.request('status');assert.equal(transport.generation,2);
});
