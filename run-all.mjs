#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const native=process.argv.includes('--native');
const nativeUnits=new Set(['gdf-identities.test.mjs','gdf-legacy-parameters.test.mjs','gdf-properties.test.mjs','gdf-v09-connected.test.mjs']);
const files=fs.readdirSync(path.join(root,'test')).filter(n=>n.endsWith('.test.mjs')).sort();
const env={...process.env};
if(!native){delete env.MAXPLUS2_ROOT;delete env.MAXPLUS2_WORKSPACE;}
if(native&&(!env.MAXPLUS2_ROOT||!fs.existsSync(path.join(env.MAXPLUS2_ROOT,'maxplus2.exe')))){
 console.error('Native tests require MAXPLUS2_ROOT pointing to your own MAX+plus II installation.');process.exit(1);
}
const scripts=files.filter(n=>native||!nativeUnits.has(n));
scripts.push('mcp-file-e2e.mjs');
if(native)scripts.push('practice-mcp.e2e.mjs','v09-files-mcp.e2e.mjs','extended-files-e2e.mjs','authoring-e2e.mjs','netlist-e2e.mjs','scf-events.e2e.mjs','scf-structure.e2e.mjs','v09-scf-editor.e2e.mjs','hierarchy-cache-e2e.mjs','gdf-symbol-e2e.mjs','gdf-symbol-refresh-e2e.mjs','gdf-properties-e2e.mjs','gdf-construction-e2e.mjs','desktop-native-e2e.mjs');
let failed=0,passed=0,skipped=0,checks=0;
for(const name of scripts){
 const result=spawnSync(process.execPath,[...(name.endsWith('.test.mjs')?['--test']:[]),path.join(root,'test',name),...(name==='mcp-file-e2e.mjs'&&!native?['--file-only']:[])],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
 const out=(result.stdout??'')+(result.stderr??'');
 const counts=out.match(/passed=(\d+) failed=(\d+)/);
 const count=out.match(/^(?:ℹ|#) pass (\d+)\s*$/m);
 const skip=out.match(/^(?:ℹ|#) skipped (\d+)\s*$/m);
 checks+=Number(counts?.[1]??count?.[1]??0);skipped+=Number(skip?.[1]??0);
 if(result.status!==0||result.error||Number(counts?.[2]??0)>0){failed++;console.error('FAIL '+name);console.error(out);if(result.error)console.error(result.error.message);}
 else{passed++;console.log('PASS '+name+(count||counts?' ('+(counts?.[1]??count?.[1])+' checks)':''));}
}
console.log(JSON.stringify({mode:native?'native':'portable',suitesPassed:passed,suitesFailed:failed,checksPassed:checks,testsSkipped:skipped,optionalNativeSuites:native?0:nativeUnits.size}));
process.exitCode=failed?1:0;
