/** Owned Windows UI Automation/Win32 worker, communicating over private stdio. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let building;
export async function buildDesktopHelper() {
  if(process.platform!=='win32')throw new Error('Native GUI requires Windows; file/CLI tools remain available.');
  if(building)return building;
  building=(async()=>{
    const source=path.join(projectRoot,'native','MaxplusDesktop.cs');
    const digest=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    // Hash-named builds avoid overwriting an EXE held open by another MCP client.
    const output=path.join(projectRoot,'bin','native',digest.slice(0,16),'MaxplusDesktop.exe');
    if(fs.existsSync(output))return output;
    const framework=['Framework64','Framework'].map(arch=>path.join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET',arch,'v4.0.30319')).find(p=>fs.existsSync(path.join(p,'csc.exe')));
    if(!framework)throw new Error('.NET Framework C# compiler missing. Install/enable .NET Framework 4.8 or build the provided native helper on a Windows machine.');
    const refs=['System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','WindowsBase.dll','UIAutomationClient.dll','UIAutomationTypes.dll'];
    const resolved=refs.map(name=>[path.join(framework,name),path.join(framework,'WPF',name)].find(p=>fs.existsSync(p)));
    if(resolved.some(p=>!p))throw new Error('Windows .NET Framework UI Automation references missing; see docs/DESKTOP.md.');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const staged=path.join(path.dirname(output),`build-${process.pid}.exe`);
    await new Promise((resolve,reject)=>{
      const child=spawn(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:anycpu','/optimize+',`/out:${staged}`,...resolved.map(r=>`/reference:${r}`),source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let diagnostics='';const timer=setTimeout(()=>child.kill(),60000);
      for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{diagnostics=(diagnostics+d.toString()).slice(-10000);});
      child.once('error',err=>{clearTimeout(timer);reject(err);});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Native helper build failed (${code}): ${diagnostics}`));});
    });
    try{fs.renameSync(staged,output);}catch(err){if(!fs.existsSync(output))throw err;}
    finally{if(fs.existsSync(staged))fs.unlinkSync(staged);}
    return output;
  })();
  try{return await building;}finally{building=undefined;}
}

export class NativeTransport {
  constructor(installRoot,{timeoutMs=20000,executable,spawnWorker=spawn}={}) {
    this.installRoot=fs.realpathSync(installRoot);this.timeoutMs=timeoutMs;this.executable=executable;this.spawnWorker=spawnWorker;
    this.child=null;this.pending=new Map();this.nextId=0;this.generation=0;this.closed=false;this.starting=null;
  }
  async start() {
    if(this.closed)throw new Error('desktop backend closed');
    if(this.child)return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const executable=this.executable??await buildDesktopHelper();
      if(this.closed)throw new Error('desktop backend closed');
      const child=this.spawnWorker(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:projectRoot});
      this.child=child;this.generation++;let buffer='';let diagnostics='';
      child.stderr.setEncoding('utf8');child.stderr.on('data',d=>{diagnostics=(diagnostics+d).slice(-2000);});
      child.stdout.setEncoding('utf8');
      const lost=message=>{if(this.child===child)this.child=null;for(const [id,p] of this.pending){if(p.child===child){clearTimeout(p.timer);this.pending.delete(id);p.reject(new Error(message));}}};
      child.on('error',err=>lost(`Native desktop worker unavailable: ${err.message}`));
      child.on('close',code=>lost(`Native desktop worker ended (${code}); re-list and observe before retrying. ${diagnostics}`));
      child.stdin.on('error',()=>{});
      child.stdout.on('data',chunk=>{
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>24*1024*1024){child.kill();lost('Native desktop response exceeded 24 MiB');return;}
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
          let message;try{message=JSON.parse(line);}catch{child.kill();lost('Native worker emitted malformed JSON');return;}
          const p=this.pending.get(message.id);if(!p)continue;
          clearTimeout(p.timer);this.pending.delete(message.id);
          message.error?p.reject(new Error(message.error.message??String(message.error))):p.resolve(message.result);
        }
      });
    })();
    try{await this.starting;}finally{this.starting=null;}
  }
  async request(method,args={}) {
    await this.start();const child=this.child;const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);this.child=null;child.kill();reject(new Error('Native desktop timed out. Input outcome may be unknown; re-list and observe. Never repeat input blindly.'));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer,child});
      child.stdin.write(JSON.stringify({id,method,args,installRoot:this.installRoot})+'\n',err=>{if(err){clearTimeout(timer);this.pending.delete(id);reject(err);}});
    });
  }
  close() {
    this.closed=true;const child=this.child;this.child=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('desktop backend closed'));}this.pending.clear();
    if(child){child.stdin.end();child.kill();}
  }
}
