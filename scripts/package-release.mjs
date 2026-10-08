#!/usr/bin/env node
/** Archive only a committed public tree; local configuration and build output are never inputs. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let output=path.join(root,'artifacts'),ref='HEAD';
for(let i=2;i<process.argv.length;i++){
 const flag=process.argv[i];if(!['--output','--ref'].includes(flag)||!process.argv[i+1])throw new Error('Usage: node scripts/package-release.mjs [--output directory] [--ref commit]');
 if(flag==='--output')output=path.resolve(process.argv[++i]);else ref=process.argv[++i];
}
function git(args,encoding='utf8'){
 const r=spawnSync('git',args,{cwd:root,encoding,windowsHide:true,maxBuffer:16*1024*1024});
 if(r.status!==0)throw new Error(`Git ${args[0]} failed: ${r.stderr??r.error?.message??''}`);
 return r.stdout;
}
const commit=git(['rev-parse','--verify','--end-of-options',ref+'^{commit}']).trim();
const pkg=JSON.parse(git(['show',commit+':package.json']));
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version))throw new Error('Invalid package version');
const files=git(['ls-tree','-r','--name-only',commit]).trim().split('\n');
const forbidden=files.filter(p=>/(?:^|\/)(?:bin|node_modules|\.codex|\.mcp-backups|research|generated|screenshots|logs|backups|releases)(?:\/|$)|(?:^|\/)(?:mcp-config\.local\.json|\.env|license\.dat|maxplus2\.ini)(?:$|\.)|\.(?:exe|dll|pdb|zip|rar|7z|log|bak)$/i.test(p));
if(forbidden.length)throw new Error('Refused excluded paths: '+forbidden.join(', '));
const runtimePaths=['server.mjs','start-local.ps1','package.json','LICENSE','NOTICE.md','SECURITY.md','README.md','README.en.md','mcp-config.example.json','lib','native/MaxplusDesktop.cs','docs','ci','scripts/local-startup.mjs','scripts/configure-local.mjs','scripts/build-desktop.ps1','scripts/audit-public.mjs'];
for(const entry of runtimePaths)if(!files.some(p=>p===entry||p.startsWith(entry+'/')))throw new Error('Runtime entry is missing: '+entry);
fs.mkdirSync(output,{recursive:true});
const assets=[];
for(const source of [false,true]){
 const name=`maxplus2-mcp-v${pkg.version}${source?'-source':''}.zip`,dest=path.join(output,name);
 if(fs.existsSync(dest))throw new Error('Archive already exists; use a new output directory: '+name);
 git(['archive','--format=zip','--prefix=maxplus2-mcp/','--output='+dest,commit,...(source?[]:['--',...runtimePaths])]);
 const bytes=fs.readFileSync(dest);
 assets.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),assets.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
console.log(JSON.stringify({version:pkg.version,commit,assets},null,2));
