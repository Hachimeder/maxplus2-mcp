/** Author a new design with MCP tools, compile & simulate via the actual vendor. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {TOOLS} from '../server.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {parseTbl,tblTrace,checkTrace} from '../lib/tbl.mjs';
const install=detectInstall();
if(!install){console.log('SKIP: MAX+plus II unavailable');process.exit(0);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-new-design-'));let passed=0;
const call=(name,args)=>TOOLS.find(t=>t.name===name).handler(args);
try {
  const source=`LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY demo IS PORT (A,B : IN STD_LOGIC; Q : OUT STD_LOGIC); END demo;\nARCHITECTURE rtl OF demo IS BEGIN Q <= A XOR B; END rtl;\n`;
  const created=await call('project_create',{workspace:dir,name:'demo',device:'EP1K10TC100-1',source,confirm:true});
  assert.ok(fs.existsSync(created.project));passed++;
  const compiled=await call('maxplus2_run',{project:created.project,compile:true,root:install.root,timeoutMs:120000});
  assert.equal(compiled.printedUsageBanner,false);assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));assert.equal(compiled.report?.fresh,true);passed++;
  const compiledAgain=await call('maxplus2_run',{project:created.project,compile:true,root:install.root,timeoutMs:120000});
  assert.ok(compiledAgain.artifactsUpdated.some(a=>a.ext==='.rpt'),'existing report must be marked freshly rewritten');passed++;
  await call('stimulus_write',{project:created.project,path:'demo.vec',inputs:['A','B'],outputs:['Q'],rows:[{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}],interval:100,confirm:true});
  assert.ok(fs.readFileSync(path.join(created.directory,'demo.vec'),'latin1').includes('INTERVAL 100;'));passed++;
  const simulated=await call('simulate_and_verify',{project:created.project,root:install.root,timeoutMs:120000});
  assert.equal(simulated.banner,'successful',JSON.stringify(simulated));assert.equal(simulated.tblCreated,true);passed++;
  const trace=tblTrace(parseTbl(fs.readFileSync(simulated.tblPath,'latin1')));
  // TBL is event based: choose the final settled event inside each known
  // stimulus interval, then assert the independently specified truth table.
  const expectations=[0,1,1,0].map((Q,i)=>{
    const row=trace.filter(r=>r.time>=i*100 && r.time<(i+1)*100).at(-1);
    assert.ok(row,`no observation in stimulus interval ${i}`);
    return {time:row.time,outputs:{Q}};
  });
  assert.equal(checkTrace(trace,expectations,{tolerance:0}).ok,true,JSON.stringify(trace));passed++;
  assert.equal(checkTrace(trace,[{time:expectations[1].time,outputs:{Q:0}}],{tolerance:0}).ok,false);passed++;
  console.log(`OK  passed=${passed} failed=0\nNew XOR project: created, compiled twice, timed four-pattern VEC converted, simulated and outputs verified. All files were temporary.`);
} catch(err){console.error(`FAILURES  passed=${passed} failed=1\n${err.stack}`);process.exitCode=1;}
finally{fs.rmSync(dir,{recursive:true,force:true});}
