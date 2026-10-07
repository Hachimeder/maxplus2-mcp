/** Agent-independent MAX+plus II desktop service. All clients use MCP only. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeTransport} from './windows-native.mjs';
import {desktopResult,desktopViewport} from './desktop-result.mjs';
import {desktopRecovery} from './desktop-recovery.mjs';

export const PROGRAMS=['max2win.exe','maxplus2.exe','megawiz.exe','genmem.exe','wlarithm.exe','wlsum.exe','wlcount.exe','wlmux.exe','wlram.exe','wlclshif.exe','wdivide.exe'];
export const ACTIONS=['click','move','press_key','type_text','set_value','drag','scroll','perform_secondary_action','activate_window','invoke_menu'];
const controllers=new Set();
export function closeDesktopControllers(){for(const c of [...controllers])c.close();}

export function validateDesktopAction(args,observed) {
  if(!ACTIONS.includes(args.action))throw new Error('unsupported desktop action');
  const p=args.parameters??{};
  if(typeof p!=='object'||p===null||Array.isArray(p))throw new Error('parameters must be an object');
  const allowed={click:['element_index','x','y','screenshotId','mouse_button','click_count','modifiers'],move:['x','y','screenshotId','modifiers'],press_key:['key'],type_text:['text'],set_value:['element_index','value'],drag:['from_x','from_y','to_x','to_y','screenshotId','mouse_button','modifiers','durationMs'],scroll:['x','y','scrollX','scrollY','screenshotId','modifiers'],perform_secondary_action:['element_index','action'],activate_window:[],invoke_menu:['menu_index']}[args.action];
  if(Object.keys(p).some(k=>!allowed.includes(k)))throw new Error('unexpected desktop action parameter');
  if(p.modifiers!==undefined&&(!Array.isArray(p.modifiers)||p.modifiers.length>3||new Set(p.modifiers).size!==p.modifiers.length||p.modifiers.some(k=>!['Ctrl','Shift','Alt'].includes(k))))throw new Error('modifiers must be distinct Ctrl, Shift or Alt');
  if(p.mouse_button!==undefined&&!['left','right','middle','l','r','m'].includes(p.mouse_button))throw new Error('invalid mouse_button');
  const indexed=()=>{if(!Number.isSafeInteger(p.element_index)||p.element_index<0||!observed.accessibility?.tree?.split('\n').some(l=>new RegExp(`^\\s*${p.element_index}\\s`).test(l)))throw new Error('element_index was not in this observation');};
  const finite=k=>{if(!Number.isFinite(p[k]))throw new Error(`${k} must be finite`);};
  const coordinates=keys=>{
    const shot=observed.screenshots?.find(s=>s.id===p.screenshotId);
    if(!shot)throw new Error('coordinate input requires screenshotId from this observation');
    keys.forEach(finite);
    // Popup screenshots may extend beyond the selected window. Their origin
    // still uses the main window's physical coordinate system.
    const left=shot.originX??0,top=shot.originY??0;
    const width=shot.width??observed.window.bounds?.width,height=shot.height??observed.window.bounds?.height;
    for(let i=0;i<keys.length;i+=2){if(p[keys[i]]<left||p[keys[i+1]]<top||p[keys[i]]>=left+width||p[keys[i+1]]>=top+height)throw new Error('coordinates lie outside the selected observed screenshot');}
  };
  if(args.action==='click'){
    if(p.element_index!==undefined){indexed();if(p.x!==undefined||p.y!==undefined)throw new Error('choose indexed OR coordinate click');}
    else coordinates(['x','y']);
    if(p.mouse_button!==undefined&&!['left','right','middle','l','r','m'].includes(p.mouse_button))throw new Error('invalid mouse_button');
    if(p.click_count!==undefined&&![1,2].includes(p.click_count))throw new Error('click_count must be 1 or 2');
  }
  if(args.action==='move')coordinates(['x','y']);
  if(args.action==='drag'){
    coordinates(['from_x','from_y','to_x','to_y']);
    if(p.durationMs!==undefined&&(!Number.isInteger(p.durationMs)||p.durationMs<100||p.durationMs>5000))throw new Error('durationMs must be an integer from 100 to 5000');
  }
  if(args.action==='scroll'){coordinates(['x','y']);for(const k of ['scrollX','scrollY']){finite(k);if(!Number.isInteger(p[k])||Math.abs(p[k])>120000)throw new Error('scroll amounts must be integer wheel units within +/-120000');}}
  if(args.action==='press_key'){
    if(typeof p.key!=='string'||!p.key.trim()||p.key.length>100)throw new Error('key must be a single key/chord');
    if(p.key.split('+').some(k=>/^(meta|windows|win|cmd|command|super|os)$/i.test(k.trim())))throw new Error('Windows/system shortcuts are not allowed');
  }
  if(args.action==='type_text'){
    if(!observed.accessibility?.focused_element)throw new Error('focus must be observed before typing');
    if(typeof p.text!=='string'||p.text.length>20000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p.text))throw new Error('invalid literal text');
  }
  if(args.action==='set_value'){indexed();if(typeof p.value!=='string'||p.value.length>20000)throw new Error('invalid value');}
  if(args.action==='invoke_menu'){const item=observed.menus?.items?.find(m=>m.menu_index===p.menu_index);if(!Number.isSafeInteger(p.menu_index)||!item||!item.enabled||item.submenu||item.separator)throw new Error('menu_index must identify an enabled leaf command in this observation');}
  if(args.action==='perform_secondary_action'){indexed();if(typeof p.action!=='string'||!p.action)throw new Error('secondary action label required');}
  return p;
}

export class DesktopController {
  constructor(installRoot,{transport,observationTtlMs=120000,now=Date.now}={}) {
    this.root=fs.realpathSync(installRoot);this.transport=transport??new NativeTransport(this.root);
    this.allow=new Set(PROGRAMS.filter(f=>fs.existsSync(path.join(this.root,f))).map(f=>('process:'+path.join(this.root,f)).toLowerCase()));
    if(!this.allow.size)throw new Error('no installed MAX+plus II executables');
    this.session=randomUUID();this.known=new Map();this.observation=null;this.results=new Map();this.queue=Promise.resolve();this.ttl=observationTtlMs;this.now=now;this.closed=false;
    controllers.add(this);
  }
  allowed(w){return w&&Number.isSafeInteger(w.id)&&this.allow.has(w.app?.toLowerCase());}
  request(method,args={}) {
    const run=this.queue.catch(()=>{}).then(()=>this.execute(method,args));
    this.queue=run;return run;
  }
  async windows() {
    const data=await this.transport.request('windows',{});
    const windows=(data.windows??[]).filter(w=>this.allowed(w));this.known.clear();for(const w of windows)this.known.set(w.id,w);
    return {windows};
  }
  async windowFor(id) {
    const previous=this.known.get(id);if(!previous)throw new Error('unknown window; call desktop_windows and select one returned ID');
    const current=(await this.transport.request('windows',{})).windows?.find(w=>w.id===id&&w.app===previous.app&&(previous.pid===undefined||w.pid===previous.pid));
    if(!this.allowed(current)){this.observation=null;throw new Error('window closed/replaced; call desktop_windows');}
    return current;
  }
  async observe(args) {
    this.observation=null;await this.windowFor(args.windowId);
    const state=desktopViewport(await this.transport.request('observe',args),args);
    if(!this.allowed(state.window))throw new Error('native capture returned a non-target window');
    const result={...state,session:this.session,observationId:randomUUID(),observedAt:new Date(this.now()).toISOString(),expiresInMs:this.ttl};
    this.known.set(state.window.id,state.window);this.observation={...result,created:this.now(),generation:this.transport.generation};return result;
  }
  async execute(method,args) {
    if(this.closed)throw new Error('desktop backend closed');
    for(const [id,r] of this.results)if(this.now()-r.created>10*60*1000)this.results.delete(id);
    if(method==='result'){
      const cached=this.results.get(args.requestId);if(!cached)throw new Error('unknown/expired desktop requestId');
      if(cached.error)throw Object.assign(new Error(cached.error),{recovery:cached.errorRecovery});return desktopResult(cached.result);
    }
    const requestId=args.operationId??randomUUID();
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))throw new Error('operationId must contain 1..100 letters/digits/underscore/hyphen');
    const signature=JSON.stringify({method,args:{...args,operationId:undefined}});
    const cached=this.results.get(requestId);
    if(cached){if(cached.signature!==signature)throw new Error('operationId already belongs to different arguments');if(cached.error)throw Object.assign(new Error(cached.error),{recovery:cached.errorRecovery});return desktopResult({...cached.result,replayed:true});}
    try{
      let data;
      if(method==='status'){
        const native=await this.transport.request('status',{});
        data={...native,connected:native.interactiveSession!==false&&native.inputDesktopAvailable!==false,backend:'standalone-win32-uia',agentIndependent:true,requiresHostTools:false,session:this.session,installRoot:this.root,actions:ACTIONS};
      }
      else if(method==='windows')data=await this.windows();
      else if(method==='launch'){
        const program=args.program??'max2win.exe';if(!PROGRAMS.includes(program)||!this.allow.has(('process:'+path.join(this.root,program)).toLowerCase()))throw new Error('program must be an installed MAX+plus II executable from the allowlist');
        this.observation=null;data={...(await this.transport.request('launch',{program})),...(await this.windows())};
      }else if(method==='observe')data=await this.observe(args);
      else if(method==='action'){
        const o=this.observation;
        if(!o||o.observationId!==args.observationId||o.window.id!==args.windowId||this.now()-o.created>this.ttl||o.generation!==this.transport.generation)throw new Error('observation is stale, consumed or expired; call desktop_observe');
        const parameters=validateDesktopAction(args,o);const current=await this.windowFor(args.windowId);
        if(o.generation!==this.transport.generation){this.observation=null;throw new Error('native worker restarted; reobserve before input');}
        if(o.window.bounds&&JSON.stringify(current.bounds)!==JSON.stringify(o.window.bounds)){this.observation=null;throw new Error('window moved/resized; reobserve before input');}
        this.observation=null;
        try{
          const input=await this.transport.request('action',{windowId:args.windowId,action:args.action,parameters});
          data={...input,action:args.action,inputDelivered:true,verificationRequired:true,...await this.observe({windowId:args.windowId})};
        }catch(err){this.observation=null;throw new Error(`input or refresh outcome unknown; re-list/observe before retrying. ${err.message}`);}
      }else throw new Error('unknown desktop method');
      const result={requestId,...data};
      // Images stay on disk only when the native helper explicitly exports them;
      // the transient replay cache is bounded to avoid retaining full screenshots.
      if(this.results.size>=12)this.results.delete(this.results.keys().next().value);
      this.results.set(requestId,{signature,created:this.now(),result});return desktopResult(result);
    }catch(err){
      if(method==='action'){
        let windows=[];
        try{windows=(await this.transport.request('windows',{})).windows?.filter(w=>this.allowed(w))??[];}catch{/* Original failure remains authoritative. */}
        err.recovery=desktopRecovery(err,{root:this.root,windowId:args.windowId,action:args.action,window:windows.find(w=>w.id===args.windowId)??this.known.get(args.windowId),windows});
      }
      if(this.results.size>=12)this.results.delete(this.results.keys().next().value);
      this.results.set(requestId,{signature,created:this.now(),error:err.message,errorRecovery:err.recovery});throw err;
    }
  }
  close(){this.closed=true;this.observation=null;this.results.clear();this.transport.close();controllers.delete(this);}
}
