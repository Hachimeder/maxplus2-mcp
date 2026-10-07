#!/usr/bin/env node
/** Generate a reviewable client-neutral stdio config beside the selected source. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveLocalStartup,probeLocalCompiler,parseStartupArguments,startupOptions} from './local-startup.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function makeLocalMcpConfig(settings) {
  return {mcpServers:{maxplus2:{command:process.execPath,args:[settings.server],env:{MAXPLUS2_ROOT:settings.installRoot,MAXPLUS2_WORKSPACE:settings.workspace}}},maxplus2Local:{schemaVersion:1,workspaceRelative:path.relative(settings.sourceDirectory,settings.workspace)||'.'}};
}
export function saveLocalMcpConfig(file,bytes,{overwrite=false,expectedSha256}={}) {
  const exists=fs.existsSync(file),previous=exists?fs.readFileSync(file):null;
  if(exists&&!overwrite)throw new Error('Local config already exists; inspect its hash and use --overwrite --expected-sha256 to replace it');
  if(exists&&(!/^[a-f0-9]{64}$/i.test(expectedSha256??'')||digest(previous)!==expectedSha256.toLowerCase()))throw new Error('Existing local config hash changed or --expected-sha256 is missing');
  if(!exists&&expectedSha256!==undefined)throw new Error('Expected existing config is missing');
  let backup=null;
  if(exists){backup=file+`.backup.${Date.now()}.${randomUUID()}.json`;fs.writeFileSync(backup,previous,{flag:'wx'});if(digest(fs.readFileSync(backup))!==digest(previous))throw new Error('Config backup hash mismatch');}
  const staged=file+`.staging.${randomUUID()}`;
  try{fs.writeFileSync(staged,bytes,{flag:'wx'});if(exists){if(!fs.existsSync(file)||digest(fs.readFileSync(file))!==expectedSha256.toLowerCase())throw new Error('Config changed before replacement');fs.renameSync(staged,file);}else{fs.copyFileSync(staged,file,fs.constants.COPYFILE_EXCL);}}
  finally{if(fs.existsSync(staged))fs.unlinkSync(staged);}
  const sha256=digest(bytes);if(digest(fs.readFileSync(file))!==sha256)throw new Error('Saved config hash mismatch');
  return {path:file,sha256,previousSha256:previous?digest(previous):null,backup};
}
async function main(){
  const args=parseStartupArguments(process.argv.slice(2),['--help','--root','--workspace','--config','--source','--output','--apply','--overwrite','--expected-sha256']);
  if(args['--help']){console.log('node scripts/configure-local.mjs [--root INSTALL] [--workspace WORKSPACE] [--source MCP_SOURCE] [--config INPUT_JSON] [--output OUTPUT_JSON] [--apply] [--overwrite --expected-sha256 HASH]\nDefault: probe compiler and print a preview; --apply writes the source-local output. No global client settings are changed.');return;}
  const settings=resolveLocalStartup(startupOptions(args)),compiler=await probeLocalCompiler(settings),config=makeLocalMcpConfig(settings),bytes=Buffer.from(JSON.stringify(config,null,2)+'\n');
  const output=path.resolve(settings.sourceDirectory,args['--output']??'mcp-config.local.json');
  if(!fs.existsSync(path.dirname(output)))throw new Error(`Output parent directory does not exist: ${path.dirname(output)}`);
  const existing=fs.existsSync(output)?digest(fs.readFileSync(output)):null;
  const plan={preview:!args['--apply'],path:output,sourceDirectory:settings.sourceDirectory,workspace:settings.workspace,installRoot:settings.installRoot,node:process.execPath,compiler,warnings:settings.warnings,previousSha256:existing,nextSha256:digest(bytes),config};
  if(args['--apply'])Object.assign(plan,{applied:true,...saveLocalMcpConfig(output,bytes,{overwrite:Boolean(args['--overwrite']),expectedSha256:args['--expected-sha256']})});
  console.log(JSON.stringify(plan,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`MAX+plus II MCP configuration failed: ${error.message}`);process.exitCode=1;});
