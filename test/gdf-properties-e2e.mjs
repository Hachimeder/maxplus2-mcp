/** Original compiler/simulator proof of instance parameters and named nets,
 * including bus-to-scalar member mapping authored from an empty GDF. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';
import {parseTbl,tblTrace,checkTrace} from '../lib/tbl.mjs';
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-properties-client-')),client=new PlainMcpClient(workspace);
const call=(name,args)=>client.call(name,args),job=(name,args)=>client.job(name,args);let passed=0;
const check=async(label,fn)=>{await fn();passed++;console.log(`PASS ${label}`);};
const symbols={};
async function symbol(kind,name,x,y,nodeName,parameters){const p=kind==='constant'?'mega_lpm/lpm_constant.sym':`prim/${kind}.sym`;symbols[kind]??=await call('gdf_symbol_library',{path:p,limit:100});const s=symbols[kind];return {operation:'add_symbol',symbolPath:s.path,symbolSha256:s.sha256,name,x,y,...(nodeName?{nodeName}:{}),...(parameters?{parameters}:{})};}
const wire=(x1,y1,x2,y2,nodeName,bus=false)=>({operation:'add_wire',x1,y1,x2,y2,...(nodeName?{nodeName}:{}),bus});
async function create(name,operations){const p=await call('project_create',{name,device:'EP1K10TC100-1',confirm:true}),b=await call('gdf_create',{project:p.project,path:name+'.gdf',confirm:true});await call('gdf_construct',{project:p.project,path:name+'.gdf',expectedSha256:b.sha256,operations,confirm:true});return {...p,path:name+'.gdf'};}
const read=(p,view='placements')=>call('gdf_geometry',{project:p.project,path:p.path,view,limit:100,childLimit:100});
async function edit(p,operations){const g=await read(p);return call('gdf_construct',{project:p.project,path:p.path,expectedSha256:g.sha256,operations,confirm:true});}
async function compile(p){const r=await job('maxplus2_run',{project:p.project,compile:true});assert.equal(r.report?.clean,true,JSON.stringify(r));assert.equal(r.report?.fresh,true);return r;}
async function stimulus(p,inputs,outputs,rows){await call('stimulus_write',{project:p.project,path:path.basename(p.path,'.gdf')+'.vec',inputs,outputs,rows,interval:100,confirm:true});}
async function simulate(p,expected){const r=await job('simulate_and_verify',{project:p.project});assert.equal(r.banner,'successful',JSON.stringify(r));assert.equal(r.tblCreated,true);const trace=tblTrace(parseTbl(fs.readFileSync(r.tblPath,'latin1'))),expectations=expected.map((outputs,i)=>{const row=trace.filter(r=>r.time>=100*i&&r.time<100*(i+1)).at(-1);assert.ok(row,`missing settled event in interval ${i}`);return {time:row.time,outputs};});assert.equal(checkTrace(trace,expectations,{tolerance:0}).ok,true,JSON.stringify(trace));const key=Object.keys(expected[0])[0];assert.equal(checkTrace(trace,[{time:expectations[0].time,outputs:{[key]:1-expected[0][key]}}],{tolerance:0}).ok,false);return trace;}
let labelled,scalar,bus;
try{
  await check('plain MCP exposes parameter templates, operation schemas and current server version',async()=>{const r=await client.initialize();assert.equal(r.serverInfo.version,'0.10.1');const t=await client.request('tools/list');assert.ok(t.tools.length>=50);const s=await call('gdf_symbol_library',{path:'mega_lpm/lpm_constant.sym',limit:100});assert.deepEqual(s.parameterTemplate.entries.map(p=>p.name).sort(),['LPM_CVALUE','LPM_WIDTH']);});
  await check('remote scalar wires joined by NODE_NAME compile and simulate XOR without touching geometry',async()=>{
    labelled=await create('named',[await symbol('input','inputA',32,296,'A'),await symbol('input','inputB',32,280,'B'),await symbol('not','invert1',208,288),await symbol('not','invert2',328,288),await symbol('xor','gate',416,280),await symbol('output','outputY',552,288,'Y'),wire(200,304,208,304),wire(256,304,280,304,'REMOTE_A'),wire(304,304,328,304,'REMOTE_A'),wire(376,304,416,304),wire(200,288,416,288),wire(480,296,552,296,'Y'),{operation:'add_annotation',x:128,y:400,text:'Free note after the named wire'}]);
    const g=await read(labelled,'sheet');assert.equal(g.records.items.find(p=>p.text==='Free note after the named wire').nativeType,7);assert.equal(g.counts.sheetPrimitives,6);
    await compile(labelled);await stimulus(labelled,['A','B'],['Y'],[{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}]);await simulate(labelled,[{Y:0},{Y:1},{Y:1},{Y:0}]);
  });
  await check('renaming both disconnected wire labels preserves their actual electrical connection',async()=>{
    const g=await read(labelled,'sheet'),lines=g.records.items.filter(p=>p.annotations?.items?.some(a=>a.text==='REMOTE_A'));assert.equal(lines.length,2);await edit(labelled,lines.map(p=>({operation:'set_wire_name',recordOffset:p.offset,nodeName:'RENAMED_A'})));await compile(labelled);await simulate(labelled,[{Y:0},{Y:1},{Y:1},{Y:0}]);
  });
  await check('a parameterized scalar constant and XOR are accepted and simulated as a buffer',async()=>{
    scalar=await create('params',[await symbol('input','inputA',32,296,'A'),await symbol('constant','value',128,240,undefined,{LPM_WIDTH:1,LPM_CVALUE:0}),await symbol('xor','gate',272,280),await symbol('output','outputY',408,288,'Y'),wire(200,304,272,304),wire(240,256,272,256),wire(272,256,272,288),wire(336,296,408,296)]);
    await compile(scalar);await stimulus(scalar,['A'],['Y'],[{A:0},{A:1}]);await simulate(scalar,[{Y:0},{Y:1}]);
  });
  await check('changing a real instance parameter changes behavior to inversion, and invalid width has no verified export',async()=>{
    const g=await read(scalar),value=g.records.items.find(p=>p.instanceName==='value');assert.deepEqual(value.parameters.entries.items.map(p=>p.value),['0','1']);await edit(scalar,[{operation:'set_parameters',recordOffset:value.offset,parameters:{LPM_WIDTH:1,LPM_CVALUE:1}}]);
    const compiled=await compile(scalar);assert.equal(compiled.compilerCache.invalidated,true);assert.ok(fs.existsSync(compiled.compilerCache.backup));await simulate(scalar,[{Y:1},{Y:0}]);
    const current=await read(scalar),offset=current.records.items.find(p=>p.instanceName==='value').offset,invalid=await edit(scalar,[{operation:'set_parameters',recordOffset:offset,parameters:{LPM_WIDTH:0,LPM_CVALUE:1}}]);
    const r=await job('netlist_export',{project:scalar.project,path:scalar.path});assert.equal(r.verdict,'not-verified');assert.equal(r.exportPaths.length,0);
    await call('project_restore_file',{project:scalar.project,path:scalar.path,backup:invalid.backup,backupSha256:invalid.previousSha256,expectedSha256:invalid.nextSha256,confirm:true});assert.deepEqual(fs.readFileSync(path.join(scalar.directory,scalar.path)),fs.readFileSync(invalid.backup));
  });
  await check('a real four-bit bus and scalar member labels pass all 16 input patterns independently',async()=>{
    const ops=[await symbol('input','inputA',32,1008,'A[3..0]'),await symbol('constant','value',128,800,undefined,{LPM_WIDTH:4,LPM_CVALUE:5}),wire(200,1016,248,1016,'A[3..0]',true),wire(240,816,288,816,'VALUE[3..0]',true)];
    for(let i=0;i<4;i++){const y=864-i*96;ops.push(await symbol('xor','gate'+i,448,y),await symbol('output','out'+i,584,y+8,'Y'+i),wire(400,y+24,448,y+24,`A[${i}]`),wire(400,y+8,448,y+8,`VALUE[${i}]`),wire(512,y+16,584,y+16));}
    bus=await create('busmap',ops);await compile(bus);await stimulus(bus,[{name:'A',nodes:['A[3]','A[2]','A[1]','A[0]']}],['Y0','Y1','Y2','Y3'],Array.from({length:16},(_,A)=>({A})));
    await simulate(bus,Array.from({length:16},(_,A)=>Object.fromEntries([0,1,2,3].map(i=>['Y'+i,((A^5)>>i)&1]))));
  });
  await check('changing the four-bit constant preserves bit mapping and verifies another 16 patterns',async()=>{
    const g=await read(bus),v=g.records.items.find(p=>p.instanceName==='value');await edit(bus,[{operation:'set_parameters',recordOffset:v.offset,parameters:{LPM_WIDTH:4,LPM_CVALUE:10}}]);await compile(bus);await simulate(bus,Array.from({length:16},(_,A)=>Object.fromEntries([0,1,2,3].map(i=>['Y'+i,((A^10)>>i)&1]))));
  });
  console.log(`OK passed=${passed} failed=0\nOriginal-vendor behavior: remote NODE_NAME connection, parameter-controlled inversion, and 32 named-bus member truth cases.`);
}finally{await client.close();assert.equal(path.dirname(path.resolve(workspace)),path.resolve(os.tmpdir()));assert.match(path.basename(workspace),/^mp2-gdf-properties-client-/);fs.rmSync(workspace,{recursive:true,force:true});}
