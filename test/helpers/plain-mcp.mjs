/** Standalone ordinary stdio client for integration tests; no SDK dependency. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export class PlainMcpClient{
  constructor(workspace){this.id=0;this.pending=new Map();this.buffer='';this.stderr='';this.exports=[];
    this.child=spawn(process.execPath,[fileURLToPath(new URL('../../server.mjs',import.meta.url))],{env:{...process.env,MAXPLUS2_WORKSPACE:workspace},windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',d=>this.stderr=(this.stderr+d).slice(-3000));this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',d=>{this.buffer+=d;let end;while((end=this.buffer.indexOf('\n'))>=0){const r=JSON.parse(this.buffer.slice(0,end));this.buffer=this.buffer.slice(end+1);const p=this.pending.get(r.id);if(p){this.pending.delete(r.id);r.error?p.reject(new Error(r.error.message)):p.resolve(r.result);}}});
    this.child.on('error',e=>{for(const p of this.pending.values())p.reject(e);this.pending.clear();});
  }
  request(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out: ${this.stderr}`));},30000);this.pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  async initialize(){const r=await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'ordinary-properties-client',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return r;}
  async call(name,args={}){const r=await this.request('tools/call',{name,arguments:args});assert.notEqual(r.isError,true,r.content[0].text);assert.equal(r.content[0].text,JSON.stringify(r.structuredContent));return r.structuredContent;}
  async job(name,args){const started=await this.call(name,{...args,async:true,timeoutMs:120000});assert.ok(started.jobId);const deadline=Date.now()+130000;let s;do{await new Promise(r=>setTimeout(r,200));s=await this.call('job_status',{jobId:started.jobId});}while(s.status==='running'&&Date.now()<deadline);assert.equal(s.status,'done',JSON.stringify(s));if(name==='netlist_export'&&s.result?.scratch)this.exports.push(s.result.scratch);return s.result;}
  async close(){this.child.stdin.end();if(this.child.exitCode===null&&this.child.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.child.kill();reject(new Error('MCP shutdown timed out'));},5000);this.child.once('close',()=>{clearTimeout(timer);resolve();});});for(const dir of this.exports){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^maxplus2-netlist-/);fs.rmSync(dir,{recursive:true,force:true});}}
}
