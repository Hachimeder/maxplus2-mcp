#!/usr/bin/env node
/** Relocatable stdio entry. No client-specific settings or host agent SDK. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {detectInstall,buildProbeArgs,runProcess} from '../lib/runtime.mjs';

export const SOURCE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const has = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
function directory(value,base,label) {
  if(typeof value!=='string'||!value.trim())throw new Error(`${label} must be a non-empty directory path`);
  const resolved=path.resolve(base,value);
  if(!fs.existsSync(resolved)||!fs.statSync(resolved).isDirectory())throw new Error(`${label} does not exist: ${resolved}`);
  return fs.realpathSync(resolved);
}
function install(value,base,label) {
  const root=directory(value,base,label),exe=path.join(root,'maxplus2.exe');
  if(!fs.existsSync(exe)||!fs.statSync(exe).isFile())throw new Error(`${label} has no maxplus2.exe: ${root}`);
  const found=detectInstall(root);
  if(!found||fs.realpathSync(found.root)!==root)throw new Error(`${label} did not resolve to the selected installation`);
  return {...found,root,executable:exe};
}
export function resolveLocalStartup(options={},env=process.env) {
  const sourceDirectory=directory(options.sourceDirectory??SOURCE_DIRECTORY,SOURCE_DIRECTORY,'MCP source');
  const server=path.join(sourceDirectory,'server.mjs');
  if(!fs.existsSync(server)||!fs.statSync(server).isFile())throw new Error(`MCP source has no server.mjs: ${sourceDirectory}`);
  const configPath=path.resolve(sourceDirectory,options.configPath??'mcp-config.local.json');
  let config={},warnings=[];
  if(fs.existsSync(configPath)){
    if(!fs.statSync(configPath).isFile()||fs.statSync(configPath).size>128*1024)throw new Error(`Local MCP config must be a JSON file up to 128 KiB: ${configPath}`);
    try{config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));}catch(error){throw new Error(`Invalid local MCP config ${configPath}: ${error.message}`);}
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error(`Local MCP config must contain an object: ${configPath}`);
  }
  const local=config.mcpServers?.maxplus2;
  if(local!==undefined&&(!local||typeof local!=='object'||Array.isArray(local)))throw new Error('mcpServers.maxplus2 must be an object');
  if(local?.env!==undefined&&(!local.env||typeof local.env!=='object'||Array.isArray(local.env)))throw new Error('mcpServers.maxplus2.env must be an object');
  if(local?.args!==undefined&&!Array.isArray(local.args))throw new Error('mcpServers.maxplus2.args must be an array');
  if(config.maxplus2Local!==undefined&&(!config.maxplus2Local||typeof config.maxplus2Local!=='object'||Array.isArray(config.maxplus2Local)))throw new Error('maxplus2Local must be an object');
  let found,installSource;
  if(has(options,'installRoot')){found=install(options.installRoot,process.cwd(),'Explicit installation');installSource='explicit';}
  else if(env.MAXPLUS2_ROOT!==undefined&&env.MAXPLUS2_ROOT!==''){found=install(env.MAXPLUS2_ROOT,process.cwd(),'MAXPLUS2_ROOT');installSource='environment';}
  else if(local?.env?.MAXPLUS2_ROOT){
    try{found=install(local.env.MAXPLUS2_ROOT,sourceDirectory,'Configured installation');installSource='local-config';}
    catch(error){warnings.push(`${error.message}; trying common installation locations`);}
  }
  if(!found){const detected=detectInstall();if(!detected)throw new Error('MAX+plus II installation not found; provide --root / -InstallRoot or MAXPLUS2_ROOT');found=install(detected.root,process.cwd(),'Discovered installation');installSource='automatic';}
  let workspace,workspaceSource;
  if(has(options,'workspace')){workspace=directory(options.workspace,process.cwd(),'Explicit workspace');workspaceSource='explicit';}
  else if(env.MAXPLUS2_WORKSPACE!==undefined&&env.MAXPLUS2_WORKSPACE!==''){workspace=directory(env.MAXPLUS2_WORKSPACE,process.cwd(),'MAXPLUS2_WORKSPACE');workspaceSource='environment';}
  else if(typeof config.maxplus2Local?.workspaceRelative==='string'&&!path.isAbsolute(config.maxplus2Local.workspaceRelative)){
    try{workspace=directory(config.maxplus2Local.workspaceRelative,sourceDirectory,'Configured relative workspace');workspaceSource='local-config-relative';}
    catch(error){warnings.push(`${error.message}; using the source parent workspace`);}
  }
  if(!workspace){workspace=fs.realpathSync(path.dirname(sourceDirectory));workspaceSource='source-parent';
    if(local?.env?.MAXPLUS2_WORKSPACE)warnings.push('Ignoring absolute workspace from copied MCP JSON; use --workspace / -Workspace or MAXPLUS2_WORKSPACE, or regenerate a relative local config');}
  if(local?.args?.some(arg=>typeof arg==='string'&&path.basename(arg)==='server.mjs'&&path.resolve(sourceDirectory,arg)!==server))warnings.push('Ignoring a copied server path; launching server.mjs beside this startup script');
  return {sourceDirectory,server,configPath,installRoot:found.root,executable:found.executable,installSource,workspace,workspaceSource,node:process.execPath,warnings};
}
export async function probeLocalCompiler(settings) {
  const result=await runProcess(settings.executable,buildProbeArgs({version:true}),{cwd:settings.installRoot,timeoutMs:10000});
  if(!result.ok||!/^MAX\+plus II\s*\r?\nVersion /mi.test(result.stdout))throw new Error(`Selected compiler version probe failed (${result.code??'no exit code'}): ${result.stderr||result.stdout}`);
  return {executable:settings.executable,code:result.code,versionText:result.stdout.trim().slice(0,2000),durationMs:result.durationMs};
}
export function parseStartupArguments(argv,allowed=['--serve','--check','--root','--workspace','--config']) {
  const options={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];if(!allowed.includes(key)||has(options,key))throw new Error(`Unknown or duplicate option: ${key}`);
    if(['--serve','--check','--apply','--overwrite','--help'].includes(key))options[key]=true;
    else {if(i+1>=argv.length||argv[i+1].startsWith('--'))throw new Error(`Missing value for ${key}`);options[key]=argv[++i];}
  }
  return options;
}
export function startupOptions(args) {
  return {...(has(args,'--root')?{installRoot:args['--root']}:{}),...(has(args,'--workspace')?{workspace:args['--workspace']}:{}),...(has(args,'--config')?{configPath:args['--config']}:{}),...(has(args,'--source')?{sourceDirectory:args['--source']}: {})};
}
async function main(){
  const args=parseStartupArguments(process.argv.slice(2));
  if(Boolean(args['--serve'])===Boolean(args['--check']))throw new Error('Select exactly one of --serve or --check');
  const settings=resolveLocalStartup(startupOptions(args));
  if(args['--check']){console.log(JSON.stringify({...settings,compiler:await probeLocalCompiler(settings)},null,2));return;}
  for(const warning of settings.warnings)console.error(`[maxplus2-mcp] ${warning}`);
  const child=spawn(process.execPath,[settings.server],{cwd:settings.sourceDirectory,env:{...process.env,MAXPLUS2_ROOT:settings.installRoot,MAXPLUS2_WORKSPACE:settings.workspace},windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(`MAX+plus II MCP launch failed: ${error.message}`);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{child.kill(signal);});
  child.on('close',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`MAX+plus II MCP startup failed: ${error.message}`);process.exitCode=1;});
