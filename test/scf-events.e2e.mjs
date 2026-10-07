/** Independent SCF oracle: author VEC, vendor converts it, compare parser to VEC and vendor TBL. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {TOOLS} from '../server.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {describeScf,parseScfRecords,readScfWaveforms,editScfWaveforms} from '../lib/scf.mjs';
import {parseTbl,tblTrace} from '../lib/tbl.mjs';
const install=detectInstall();
if(!install){console.log('SKIP: MAX+plus II unavailable');process.exit(0);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scf-events-'));
const call=(name,args)=>TOOLS.find(t=>t.name===name).handler(args);
let passed=0;
const fixtures=new Map();
try {
  const source='LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY demo IS PORT (A,B : IN STD_LOGIC; Q : OUT STD_LOGIC); END demo;\nARCHITECTURE rtl OF demo IS BEGIN Q <= A XOR B; END rtl;\n';
  const created=await call('project_create',{workspace:dir,name:'demo',device:'EP1K10TC100-1',source,confirm:true});
  const compiled=await call('maxplus2_run',{project:created.project,compile:true,root:install.root,timeoutMs:120000});
  assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));passed++;
  const cases=[
    ['zero','ns',100,600,[0,0,0,0]],['one','ns',100,600,[1,1,1,1]],
    ['rise','ns',100,600,[0,1,1,1]],['fall','ns',100,600,[1,0,0,0]],
    ['toggle','ns',100,600,[0,1,0,1]],['slow','ns',200,1200,[0,1,0,1]],
    ['micro','us',0.1,0.6,[0,1,0,1]],['fraction','ns',12.3,73.8,[0,1,0,1]],
    ['unknown','ns',100,600,['X','X','X','X']],['impedance','ns',100,600,['Z','Z','Z','Z']],
    ['all-values','ns',100,600,[0,1,'X','Z']],
  ];
  for(const [name,unit,interval,stop,values] of cases) {
    const work=path.join(dir,name);fs.mkdirSync(work);
    for(const f of fs.readdirSync(created.directory)) if(/\.(acf|vhd|snf|cnf)$/i.test(f))fs.copyFileSync(path.join(created.directory,f),path.join(work,f));
    fs.writeFileSync(path.join(work,'demo.vec'),['% SCF independent oracle %',`UNIT ${unit};`,'START 0;',`STOP ${stop};`,`INTERVAL ${interval};`,'INPUTS A B;','OUTPUTS Q;','PATTERN',...values.map(v=>`${v} 0`),';',''].join('\n'),'ascii');
    const result=await call('simulate_and_verify',{project:path.join(work,'demo.acf'),root:install.root,timeoutMs:120000});
    assert.equal(result.banner,'successful',JSON.stringify({name,...result}));
    const buffer=fs.readFileSync(path.join(work,'demo.scf')), wave=readScfWaveforms(buffer);
    const trace=tblTrace(parseTbl(fs.readFileSync(result.tblPath,'latin1')));
    for(const row of trace.filter(r=>r.time<wave.header.durationNs)) {
      for(const s of wave.signals) {
        const expected=s.role==='input'?row.rawInputs[s.name]?.[0]:row.rawValues[s.name];
        if(expected!==undefined)assert.equal(String(s.segments.find(v=>v.startTime<=row.time&&row.time<v.endTime)?.value),expected,`${name} vendor TBL ${s.name} at ${row.time}`);
      }
    }
    console.log(`  PASS ${name}: ${wave.header.durationNs} ns; all SCF scalar values match VEC patterns and vendor TBL events`);
    fixtures.set(name,{buffer,work,values,interval:interval*(unit==='us'?1000:1),duration:stop*(unit==='us'?1000:1)});
    assert.equal(wave.recordFraming,true);assert.equal(wave.waveformEncoding,true,JSON.stringify(wave.problems));
    const a=wave.signals.find(s=>s.name==='A');
    for(let i=0;i<values.length;i++)assert.equal(a.segments.find(s=>s.startTime<=i*interval*(unit==='us'?1000:1)+0.01&&s.endTime>i*interval*(unit==='us'?1000:1)+0.01)?.value,values[i],`${name} pattern ${i}`);
    assert.equal(wave.header.durationNs,stop*(unit==='us'?1000:1));passed++;
  }
  const original=fixtures.get('zero'), work=path.join(dir,'native-edited');fs.mkdirSync(work);
  for(const f of fs.readdirSync(original.work))if(/\.(acf|vhd|snf|cnf)$/i.test(f))fs.copyFileSync(path.join(original.work,f),path.join(work,f));
  const events=[{time:0,value:1},{time:125.5,value:0},{time:250,value:'X'},{time:350,value:'Z'},{time:475.2,value:1}];
  const edited=editScfWaveforms(original.buffer,[{signal:'A',events}]);
  fs.writeFileSync(path.join(work,'demo.scf'),edited.buffer);
  assert.equal(fs.existsSync(path.join(work,'demo.vec')),false);
  const result=await call('simulate_and_verify',{project:path.join(work,'demo.acf'),root:install.root,timeoutMs:120000});
  assert.equal(result.banner,'successful',JSON.stringify(result));
  const trace=tblTrace(parseTbl(fs.readFileSync(result.tblPath,'latin1')));
  for(const event of events)assert.equal(trace.find(r=>r.time===event.time)?.rawInputs.A[0],String(event.value),'vendor must read exact new SCF value at its requested time');
  const reread=readScfWaveforms(fs.readFileSync(path.join(work,'demo.scf')),{signal:'A'});
  assert.deepEqual(reread.signals[0].events.map(({time,value})=>({time,value})),events);
  passed++;console.log('  PASS native edit: no VEC present; vendor Simulator read all new 0/1/X/Z input events, including 125.5 ns and 475.2 ns');
  const busSource='LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY busdemo IS PORT (A : IN STD_LOGIC_VECTOR(3 DOWNTO 0); Q : OUT STD_LOGIC_VECTOR(3 DOWNTO 0)); END busdemo;\nARCHITECTURE rtl OF busdemo IS BEGIN Q <= A; END rtl;\n';
  const bus=await call('project_create',{workspace:dir,name:'busdemo',device:'EP1K10TC100-1',source:busSource,confirm:true});
  const busCompiled=await call('maxplus2_run',{project:bus.project,compile:true,root:install.root,timeoutMs:120000});
  assert.equal(busCompiled.report?.clean,true,JSON.stringify(busCompiled));
  fs.writeFileSync(path.join(bus.directory,'busdemo.vec'),['UNIT ns;','START 0;','STOP 600;','INTERVAL 100;','INPUTS A3 A2 A1 A0;','OUTPUTS Q3 Q2 Q1 Q0;','PATTERN','0 0 0 1','1 0 1 0','X 0 1 Z','0 1 1 0',';',''].join('\n'),'ascii');
  const busResult=await call('simulate_and_verify',{project:bus.project,root:install.root,timeoutMs:120000});
  assert.equal(busResult.banner,'successful',JSON.stringify(busResult));
  const busWave=readScfWaveforms(fs.readFileSync(path.join(bus.directory,'busdemo.scf')));
  assert.equal(busWave.waveformEncoding,true,JSON.stringify(busWave.problems));
  for(const [i,bits] of ['0001','1010','X01Z','0110'].entries()) {
    const actual=[3,2,1,0].map(bit=>busWave.signals.find(s=>s.name===`A${bit}`).segments.find(s=>s.startTime<=i*100+0.01&&s.endTime>i*100+0.01)?.value).join('');
    assert.equal(actual,bits);
  }
  passed++;console.log('  PASS native vector: four-bit bus stimulus, including mixed X/Z, matches known bit order');
  if(process.env.SCF_KEEP_FIXTURES){console.log('Fixtures retained at '+dir);}
  console.log(`OK  passed=${passed} failed=0`);
} catch(err){console.error(`FAILURES  passed=${passed} failed=1\n${err.stack}\nArtifacts: ${dir}`);process.exitCode=1;}
finally{if(!process.env.SCF_KEEP_FIXTURES&&!process.exitCode)fs.rmSync(dir,{recursive:true,force:true});}
