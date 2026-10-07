/** Invalidate this project's top and numbered hierarchy extraction caches.
 * Every removed cache is retained byte-for-byte in the project backup store. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {scopedPath,fileDigest,sha256} from './workspace.mjs';
const SOURCES=['.gdf','.tdf','.vhd','.vhdl','.v','.edf','.edif'];
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function compileCachePlan(acfPath,{enabled=true,includeAll=false}={}){
  const root=fs.realpathSync(path.dirname(acfPath)),name=path.basename(acfPath,path.extname(acfPath));
  const sources=SOURCES.map(ext=>scopedPath(root,name+ext)).filter(p=>fs.existsSync(p)&&fs.statSync(p).isFile()),cache=scopedPath(root,name+'.cnf');
  const pattern=new RegExp('^'+escape(name)+'(?:\\(\\d+\\))?\\.cnf$','i');
  const caches=enabled&&sources.length?fs.readdirSync(root).filter(n=>pattern.test(n)).sort().map(n=>scopedPath(root,n)):[];
  if(caches.length>2000)throw new Error('Project has more than 2000 extraction caches; narrow its source scope');
  for(const p of caches)if(!fs.lstatSync(p).isFile()||fs.lstatSync(p).isSymbolicLink())throw new Error('Compiler cache must be an ordinary project-local file');
  return {enabled,cache,sources,caches:includeAll?caches:caches.slice(0,20),totalCaches:caches.length,cachesTruncated:!includeAll&&caches.length>20,available:caches.length>0,note:!enabled?'Original incremental cache reuse explicitly requested.':!sources.length?'No supported top source present; CNF is preserved because it may be the only design input.':'Top and numbered project-local hierarchy CNF caches are backed up and moved before compilation. Other projects and external library caches are preserved.'};
}
export function invalidateCompileCache(acfPath,options){
  const plan=compileCachePlan(acfPath,{...options,includeAll:true});if(!plan.available)return {...plan,invalidated:false};
  const root=fs.realpathSync(path.dirname(acfPath)),dir=scopedPath(root,'.mcp-backups'),batch=randomUUID();
  const records=plan.caches.map(p=>({...fileDigest(p),backup:scopedPath(root,path.join(dir,`compile-${batch}-${path.basename(p)}`))}));
  fs.mkdirSync(dir,{recursive:true});const moved=[];
  try{for(const r of records){fs.renameSync(r.path,r.backup);moved.push(r);}}
  catch(error){const failures=[];for(const r of [...moved].reverse())try{fs.renameSync(r.backup,r.path);}catch(e){failures.push({path:r.path,backup:r.backup,error:e.message});}if(failures.length)error.message+='; rollback needs manual recovery: '+JSON.stringify(failures);throw error;}
  const manifest=scopedPath(root,path.join(dir,`compile-${batch}-manifest.txt`)),bytes=Buffer.from(JSON.stringify({version:1,project:acfPath,backups:records},null,2));
  try{fs.writeFileSync(manifest,bytes,{flag:'wx'});}catch(error){for(const r of [...moved].reverse())fs.renameSync(r.backup,r.path);throw error;}
  const primary=records.find(r=>r.path.toLowerCase()===plan.cache.toLowerCase())??records[0];
  return {...plan,caches:plan.caches.slice(0,20),totalCaches:plan.caches.length,cachesTruncated:plan.caches.length>20,invalidated:true,backup:primary.backup,sha256:primary.sha256,bytes:primary.bytes,backups:records.slice(0,20),totalBackups:records.length,backupsTruncated:records.length>20,manifest,manifestSha256:sha256(bytes)};
}
