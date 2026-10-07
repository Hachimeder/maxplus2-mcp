/** Independent vendor acceptance: no VEC exists in edited SCF simulation directories. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {TOOLS} from '../server.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {parseTbl,tblTrace} from '../lib/tbl.mjs';
import {inspectScfStructure,editScfStructure,createScfStructure} from '../lib/scf-structure.mjs';
const install=detectInstall();
if(!install){console.log('SKIP: MAX+plus II unavailable');process.exit(0);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scf-structure-e2e-'));
const call=(name,args)=>TOOLS.find(t=>t.name===name).handler(args);
const source='LIBRARY IEEE;\nUSE IEEE.STD_LOGIC_1164.ALL;\nENTITY demo IS PORT (A,B,C : IN STD_LOGIC; Q : OUT STD_LOGIC); END demo;\nARCHITECTURE rtl OF demo IS BEGIN Q <= A XOR B XOR C; END rtl;\n';
let passed=0;
try {
  const created=await call('project_create',{workspace:dir,name:'demo',device:'EP1K10TC100-1',source,confirm:true});
  const compiled=await call('maxplus2_run',{project:created.project,compile:true,root:install.root,timeoutMs:120000});
  assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));passed++;
  fs.writeFileSync(path.join(created.directory,'demo.vec'),['UNIT ns;','START 0;','STOP 600;','INTERVAL 100;',
    'INPUTS A B C;','OUTPUTS Q;','PATTERN','0 1 0','1 0 1',';',''].join('\n'),'ascii');
  const baseline=await call('simulate_and_verify',{project:created.project,root:install.root,timeoutMs:120000});
  assert.equal(baseline.verdict,'verified',JSON.stringify(baseline));const original=fs.readFileSync(path.join(created.directory,'demo.scf'));
  assert.equal(inspectScfStructure(original).complete,true);passed++;
  async function simulate(label,buffer,{sourceOverride,expectedMissing=[]}={}) {
    const work=path.join(dir,label);fs.mkdirSync(work);
    for(const file of fs.readdirSync(created.directory))if(/\.(acf|vhd|snf|cnf)$/i.test(file))fs.copyFileSync(path.join(created.directory,file),path.join(work,file));
    fs.writeFileSync(path.join(work,'demo.scf'),buffer);assert.equal(fs.existsSync(path.join(work,'demo.vec')),false);
    if(sourceOverride){fs.writeFileSync(path.join(work,'demo.vhd'),sourceOverride,'ascii');const result=await call('maxplus2_run',{project:path.join(work,'demo.acf'),compile:true,root:install.root,timeoutMs:120000});assert.equal(result.report?.clean,true,JSON.stringify(result));}
    const result=await call('simulate_and_verify',{project:path.join(work,'demo.acf'),root:install.root,timeoutMs:120000});
    assert.equal(result.verdict,'verified',JSON.stringify(result));assert.deepEqual(result.undrivenNodes,expectedMissing);
    if(!expectedMissing.length)assert.equal(result.counts.warnings,0);
    const text=fs.readFileSync(result.tblPath,'latin1'),parsed=parseTbl(text),trace=tblTrace(parsed);
    assert.equal(inspectScfStructure(fs.readFileSync(path.join(work,'demo.scf'))).complete,true);
    return {result,text,parsed,trace};
  }
  {
    const buffer=editScfStructure(original,[{type:'reorder',signals:['C','Q','B','A']}]).buffer,result=await simulate('reorder',buffer);
    assert.match(result.text,/INPUTS C B A\s*;/);assert.equal(result.trace[0].rawInputs.C[0],'0');assert.equal(result.trace[0].rawInputs.B[0],'1');
    passed++;console.log('PASS reorder: independently read vendor TBL columns C B A');
  }
  const grouped=editScfStructure(original,[{type:'group',name:'PAIR',members:['B','A'],radix:'HEX'}]).buffer;
  for(const radix of ['BIN','OCT','DEC','HEX']) {
    const buffer=editScfStructure(grouped,[{type:'radix',signal:'PAIR',radix}]).buffer,result=await simulate('group-'+radix,buffer);
    assert.match(result.text,/GROUP CREATE PAIR = B A\s*;/);
    if(radix==='HEX')assert.match(result.text,/INPUTS PAIR C\s*;/);
    else assert.ok(result.text.includes(`INPUTS PAIR\\${radix} C`),result.text);
    assert.match(result.text,radix==='BIN'?/0\.0> 10 0 = 1/:/0\.0> 2 0 = 1/);
    passed++;console.log(`PASS ${radix}: group B A ordering and radix accepted by vendor TBL`);
  }
  {
    const buffer=editScfStructure(grouped,[{type:'rename',signal:'PAIR',name:'LONGER_PAIR'},{type:'radix',signal:'LONGER_PAIR',radix:'BIN'}]).buffer,result=await simulate('rename-group',buffer);
    assert.match(result.text,/GROUP CREATE LONGER_PAIR = B A\s*;/);assert.ok(result.text.includes('INPUTS LONGER_PAIR\\BIN C'));passed++;
    console.log('PASS rename group: new record/name sizes accepted independently');
  }
  {
    const buffer=editScfStructure(grouped,[{type:'ungroup',signal:'PAIR'}]).buffer,result=await simulate('ungroup',buffer);
    assert.match(result.text,/INPUTS B A C\s*;/);assert.equal(/GROUP CREATE/.test(result.text),false);passed++;
    console.log('PASS ungroup: vendor returns independent scalar columns in group member order');
  }
  for(const durationNs of [250,900.1]) {
    const buffer=editScfStructure(original,[{type:'duration',durationNs}]).buffer,result=await simulate('duration-'+durationNs,buffer);
    assert.equal(result.trace.at(-1).time,durationNs);assert.equal(inspectScfStructure(buffer).timeRange.editorEndTicks,durationNs*10);passed++;
    console.log(`PASS duration ${durationNs} ns: vendor ended at requested shortened/extended horizon`);
  }
  {
    const buffer=editScfStructure(original,[{type:'delete_input',signal:'C'},{type:'add_input',name:'C',events:[{time:0,value:0},{time:125.5,value:1}]}]).buffer,result=await simulate('delete-add',buffer);
    assert.equal(result.trace.find(r=>r.time===125.5).rawInputs.C[0],'1');
    const settled=result.trace.filter(r=>r.time<=150).at(-1);assert.equal(settled.rawValues.Q,'0');passed++;
    console.log('PASS delete/add input: new 125.5 ns transition drives XOR output 0 after settling');
  }
  {
    const buffer=editScfStructure(original,[{type:'delete_input',signal:'A'}]).buffer,result=await simulate('delete-first',buffer,{expectedMissing:['A']});
    assert.match(result.text,/INPUTS B C\s*;/);assert.equal(result.trace[0].rawValues.Q,'X');passed++;
    console.log('PASS delete first ID: vendor reports expected missing A and returns B/C stimuli with X output');
  }
  {
    const buffer=editScfStructure(original,[{type:'rename',signal:'C',name:'C_RENAMED'}]).buffer;
    const result=await simulate('rename-scalar',buffer,{sourceOverride:source.replace(/\bC\b/g,'C_RENAMED')});
    assert.match(result.text,/INPUTS A B C_RENAMED\s*;/);assert.equal(result.trace.find(r=>r.time===100).rawInputs.C_RENAMED[0],'1');passed++;
    console.log('PASS rename scalar: separately recompiled netlist accepts new input name and original events');
  }
  {
    const buffer=createScfStructure({durationNs:600,inputs:[{name:'A',events:[{time:0,value:0},{time:125.5,value:1},{time:250,value:'X'},{time:350,value:'Z'}]},{name:'B'},{name:'C'}]}).buffer;
    const result=await simulate('create',buffer);assert.match(result.text,/INPUTS A B C\s*;/);
    for(const [time,value] of [[0,'0'],[125.5,'1'],[250,'X'],[350,'Z']])assert.equal(result.trace.find(r=>r.time===time).rawInputs.A[0],value);
    passed++;console.log('PASS create: vendor reads canonical input-only file including fractional time, X and Z');
  }
  {
    const prefix=Buffer.from(original.subarray(0,52));prefix.writeUInt16LE(0,38);prefix.writeUInt32LE(2,46);prefix.writeUInt16LE(0,50);
    const short=Buffer.concat([prefix,original.subarray(66)]),buffer=editScfStructure(short,[{type:'duration',durationNs:250}]).buffer;
    const result=await simulate('short-preamble',buffer);assert.equal(result.trace.at(-1).time,250);passed++;
    console.log('PASS shorter vendor preamble: absent editor-end field preserved and independent simulation ends at 250 ns');
  }
  console.log(`OK passed=${passed} failed=0`);
  if(process.env.SCF_STRUCTURE_KEEP_FIXTURES)console.log('Fixtures retained at '+dir);
} catch(error){console.error(`FAIL passed=${passed} failed=1\n${error.stack}\nArtifacts: ${dir}`);process.exitCode=1;}
finally{if(!process.env.SCF_STRUCTURE_KEEP_FIXTURES&&!process.exitCode)fs.rmSync(dir,{recursive:true,force:true});}
