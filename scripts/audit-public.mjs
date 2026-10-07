#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ignored=new Set(['.git','bin','node_modules','.codex','.mcp-backups','.mcp-exports','research','generated','logs','screenshots','artifacts','releases','backups']);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>ignored.has(e.name)?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.relative(root,path.join(dir,e.name)).replaceAll('\\','/')]);}
const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
const staged=process.argv.includes('--staged');
if(staged&&tracked.status!==0){console.error('Staged audit requires a Git index.');process.exit(1);}
const files=tracked.status===0&&tracked.stdout?tracked.stdout.split('\0').filter(Boolean):walk(root);
const rules=[
 ['home-directory',/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/home\/[a-zA-Z0-9_.-]+\//gi],
 ['machine-name',/\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{5,}\b/g],
 ['shared-chat',/https?:\/\/chatgpt\.com\/(?:s|share)\//gi],
 ['credential',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/g],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['credential-in-url',/https?:\/\/[^\s/:"']+:[^\s/@"']+@/g],
 ['private-network',/\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g]
];
const findings=[];
function inspect(file,text,encoding){
 for(const [rule,re] of rules){re.lastIndex=0;for(const m of text.matchAll(re))findings.push({file,rule,encoding,line:text.slice(0,m.index).split('\n').length});}
 for(const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)){
  if(!/^(?:[^@]+@users\.noreply\.github\.com|[^@]+@(?:example\.com|example\.org))$/i.test(m[0]))findings.push({file,rule:'email-address',encoding,line:text.slice(0,m.index).split('\n').length});
 }
}
for(const file of files){
 if(/(?:^|\/)(?:mcp-config\.local\.json(?:\..*)?|\.env(?:\..*)?|license\.dat|maxplus2\.ini)$|\.(?:exe|dll|pdb|zip|rar|7z|png|jpg|jpeg|bmp|pdf|docx|pptx|xlsx|log|bak)$/i.test(file)||file.split('/').some(p=>ignored.has(p)))findings.push({file,rule:'excluded-file'});
 const snapshot=staged?spawnSync('git',['show',':'+file],{cwd:root,windowsHide:true,maxBuffer:8*1024*1024}):null;
 if(snapshot&&snapshot.status!==0){findings.push({file,rule:'index-read-failed'});continue;}
 const data=snapshot?snapshot.stdout:fs.readFileSync(path.join(root,file));inspect(file,data.toString('utf8'),'utf8');inspect(file,data.toString('utf16le'),'utf16le');
 // Check encoded fixture strings too; do not print any matched content.
 if(file.endsWith('.json')){
  const visit=value=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);else if(typeof value==='string'&&value.length>48&&/^[A-Za-z0-9+/]+={0,2}$/.test(value)){const b=Buffer.from(value,'base64');inspect(file,b.toString('utf8'),'base64/utf8');inspect(file,b.toString('utf16le'),'base64/utf16le');}};
  try{visit(JSON.parse(data.toString('utf8')));}catch{findings.push({file,rule:'invalid-json'});}
 }
}
console.log(JSON.stringify({mode:staged?'git-index':'working-tree',filesChecked:files.length,findings:findings.length,details:findings},null,2));
process.exitCode=findings.length?1:0;
