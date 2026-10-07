/** Original CLI oracle for SYM cloning, pin/name/position editing, new symbols
 * and consumed interfaces. Runs in owned TEMP projects; never touches max2lib. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';
import {createSymbol,cloneSymbol,editSymbol,inspectSymbol} from '../lib/gdf-symbol-editor.mjs';
import {parseTbl,tblTrace,checkTrace} from '../lib/tbl.mjs';
import {parseNetlist} from '../lib/netlist.mjs';
const root=process.env.MAXPLUS2_ROOT??'C:/maxplus2';
if(!fs.existsSync(path.join(root,'maxplus2.exe'))){console.log('SKIP original SYM compiler oracle: MAX+plus II unavailable');process.exit(0);}
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-symbol-client-')),client=new PlainMcpClient(workspace),sha=b=>createHash('sha256').update(b).digest('hex'),hashes=new Map();let passed=0;
const call=(n,a)=>client.call(n,a),job=(n,a)=>client.job(n,a),wire=(x1,y1,x2,y2)=>({operation:'add_wire',x1,y1,x2,y2});
async function check(label,fn){await fn();passed++;console.log(`PASS ${label}`);}
function vendor(name){const p=path.join(root,'max2lib','prim',name+'.sym'),b=fs.readFileSync(p);hashes.set(p,sha(b));return b;}
async function library(name){return call('gdf_symbol_library',{root,path:`prim/${name}.sym`,limit:100});}
function symbol(s,name,x,y,nodeName){return {operation:'add_symbol',symbolPath:s.path,symbolSha256:s.sha256,name,x,y,...(nodeName?{nodeName}:{})};}
const source=(name,expr,two=true)=>`ENTITY ${name} IS PORT(A${two?', B':''}: IN BIT; Y: OUT BIT); END ${name};\nARCHITECTURE rtl OF ${name} IS BEGIN Y <= ${expr}; END rtl;\n`;
async function prepare(name,sym,hdl,inputs,positions){
  const p=await call('project_create',{name,device:'EP1K10TC100-1',confirm:true}),local=path.join(p.directory,inspectSymbol(sym).symbolName+'.sym');fs.writeFileSync(local,sym);fs.writeFileSync(local.replace(/\.sym$/i,'.vhd'),hdl,'latin1');
  const blank=await call('gdf_create',{project:p.project,path:name+'.gdf',confirm:true}),input=await library('input'),output=await library('output'),s={path:local,sha256:sha(sym)},ops=[symbol(s,'custom',272,280)];
  for(const [i,pin]of inputs.entries()){const localY=positions[pin],y=280+localY-8;ops.push(symbol(input,'in'+pin,32,y,pin),wire(200,y+8,272,y+8));}
  const out=positions.Y;ops.push(symbol(output,'outY',456,280+out.y-8,'Y'),wire(272+out.x,280+out.y,456,280+out.y));
  await call('gdf_construct',{project:p.project,path:name+'.gdf',expectedSha256:blank.sha256,operations:ops,confirm:true});return {...p,path:name+'.gdf',local};
}
async function verify(p,inputs,rows,expected){
  const compiled=await job('maxplus2_run',{root,project:p.project,compile:true});assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));assert.equal(compiled.report?.fresh,true);
  const exported=await job('netlist_export',{root,project:p.project,path:p.path});assert.equal(exported.verdict,'verified-export',JSON.stringify(exported.compile));const full=parseNetlist(fs.readFileSync(exported.netlistJson[0].path,'latin1')),ports=full.ports;
  for(const name of inputs)assert.ok(ports.some(p=>p.name===name&&p.direction==='INPUT'),`${name} exported as INPUT`);assert.ok(ports.some(p=>p.name==='Y'&&p.direction==='OUTPUT'));
  const nets=full.nets;for(const name of [...inputs,'Y'])assert.ok(nets.some(n=>n.endpoints.some(e=>e.instance===null&&(e.portBitName===name||e.port===name))),`compiled EDIF contains external endpoint ${name}`);
  await call('stimulus_write',{project:p.project,path:path.basename(p.path,'.gdf')+'.vec',inputs,outputs:['Y'],rows,interval:100,confirm:true});
  const sim=await job('simulate_and_verify',{root,project:p.project});assert.equal(sim.banner,'successful',JSON.stringify(sim));assert.equal(sim.tblCreated,true);const trace=tblTrace(parseTbl(fs.readFileSync(sim.tblPath,'latin1'))),expectations=expected.map((Y,i)=>{const row=trace.filter(r=>r.time>=i*100&&r.time<(i+1)*100).at(-1);assert.ok(row,`missing interval ${i}`);return {time:row.time,outputs:{Y}};});assert.equal(checkTrace(trace,expectations,{tolerance:0}).ok,true,JSON.stringify(trace));assert.equal(checkTrace(trace,[{time:expectations[0].time,outputs:{Y:1-expected[0]}}],{tolerance:0}).ok,false);
  return {project:p.project,sourceSha256:sha(fs.readFileSync(p.local)),vendorCompileClean:compiled.report.clean,exportedPorts:ports.map(p=>({name:p.name,direction:p.direction})),exportedCounts:full.counts,truthTable:expected};
}
let cloned,created;const evidence=[];
try{
  await client.initialize();
  await check('clone original XOR with renamed pins, moved connection points and explicit internal graphics',async()=>{
    const original=vendor('xor'),s=inspectSymbol(original),output=s.pins.find(p=>p.name==='1'),A=s.pins.find(p=>p.name==='2'),B=s.pins.find(p=>p.name==='3'),line=s.graphics.find(g=>g.kind==='line'),arc=s.graphics.find(g=>g.kind==='arc');
    cloned=cloneSymbol(original,{name:'CUSTOMXOR',operations:[{operation:'set_extent',width:96,height:48},{operation:'set_pin',recordOffset:output.offset,name:'Y',x:80,y:24,labelX:64,labelY:25,attributeName:'OSTUB'},{operation:'set_pin',recordOffset:A.offset,name:'A',x:0,y:32,labelX:8,labelY:33,attributeName:'ISTUB'},{operation:'set_pin',recordOffset:B.offset,name:'B',x:0,y:8,labelX:8,labelY:9,attributeName:'ISTUB'},{operation:'translate',recordOffset:line.offset,dx:4,dy:4},{operation:'set_arc',recordOffset:arc.offset,cx:32,cy:24,startX:48,startY:24,endX:32,endY:40,radius:16,startAngleDegrees:0,sweepAngleDegrees:90},{operation:'add_circle',x:64,y:24,radius:3},{operation:'add_text',text:'Custom XOR',x:8,y:40}]});
    const p=await prepare('cloned',cloned.buffer,source('CUSTOMXOR','A XOR B'),['A','B'],{A:32,B:8,Y:{x:80,y:24}}),g=await call('gdf_geometry',{project:p.project,path:p.path,view:'placements',limit:100,childLimit:100}),custom=g.records.items.find(p=>p.instanceName==='custom');assert.deepEqual(custom.pins.items.map(p=>[p.name,p.worldPosition]),[['Y',{x:352,y:304}],['A',{x:272,y:312}],['B',{x:272,y:288}]]);
    evidence.push(await verify(p,['A','B'],[{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}],[0,1,1,0]));
  });
  await check('create fresh native symbol, remove provisional pin, add output and set original OSTUB attribute',async()=>{
    const initial=createSymbol({name:'CUSTOMNOT',width:80,height:48,pins:[{name:'A',attributeName:'ISTUB',x:0,y:24,labelX:8,labelY:25},{name:'REMOVE',attributeName:'ISTUB',x:0,y:8,labelX:8,labelY:9}],graphics:[{operation:'add_line',x1:8,y1:8,x2:64,y2:24},{operation:'add_line',x1:64,y1:24,x2:8,y2:40},{operation:'add_line',x1:8,y1:40,x2:8,y2:8},{operation:'add_circle',x:68,y:24,radius:4}],texts:[{text:'Custom inverter',x:8,y:40}]}).buffer,s=inspectSymbol(initial);
    const added=editSymbol(initial,[{operation:'delete_pin',recordOffset:s.pins.find(p=>p.name==='REMOVE').offset},{operation:'add_pin',name:'Y',attributeName:'ISTUB',x:80,y:24,labelX:64,labelY:25}]).buffer,after=inspectSymbol(added);
    created=editSymbol(added,[{operation:'set_pin',recordOffset:after.pins.find(p=>p.name==='Y').offset,attributeName:'OSTUB'},{operation:'set_text',recordOffset:after.texts.find(t=>t.text==='Custom inverter').offset,text:'NOT A'}]);assert.deepEqual(inspectSymbol(created.buffer).pins.map(p=>[p.name,p.attributeName]),[['A','ISTUB'],['Y','OSTUB']]);
    const p=await prepare('created',created.buffer,source('CUSTOMNOT','NOT A',false),['A'],{A:24,Y:{x:80,y:24}});evidence.push(await verify(p,['A'],[{A:0},{A:1}],[1,0]));
  });
  await check('original installed symbols remain byte-identical after native oracle',async()=>{for(const[p,h]of hashes)assert.equal(sha(fs.readFileSync(p)),h);});
  console.log(`OK passed=${passed} failed=0\nOriginal compiler/export/simulator: cloned renamed/moved XOR and authored inverter interfaces accepted.\n${JSON.stringify(evidence,null,2)}`);
}finally{
  await client.close();assert.equal(path.dirname(path.resolve(workspace)),path.resolve(os.tmpdir()));assert.match(path.basename(workspace),/^mp2-gdf-symbol-client-/);fs.rmSync(workspace,{recursive:true,force:true});
}
