/** Refresh embedded custom symbols in existing real circuits. Original CLI
 * compile, vendor EDIF and independent simulator traces are final oracles. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';
import {createSymbol,editSymbol,inspectSymbol} from '../lib/gdf-symbol-editor.mjs';
import {inspectGdfSymbolRefresh,refreshGdfSymbol} from '../lib/gdf-symbol-refresh.mjs';
import {constructGdf} from '../lib/gdf-authoring.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from '../lib/gdf-geometry.mjs';
import {parseNetlist} from '../lib/netlist.mjs';
import {parseTbl,tblTrace,checkTrace} from '../lib/tbl.mjs';
const root=process.env.MAXPLUS2_ROOT??'C:/maxplus2';if(!fs.existsSync(path.join(root,'maxplus2.exe'))){console.log('SKIP original symbol-refresh oracle: MAX+plus II unavailable');process.exit(0);}
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-gdf-symbol-refresh-client-')),client=new PlainMcpClient(workspace),sha=b=>createHash('sha256').update(b).digest('hex');let passed=0,project,file,symbolFile;
const call=(name,args)=>client.call(name,args),job=(name,args)=>client.job(name,args),wire=(x1,y1,x2,y2)=>({operation:'add_wire',x1,y1,x2,y2}),evidence=[];
const symbol=(s,name,x,y,nodeName)=>({operation:'add_symbol',symbolPath:s.path,symbolSha256:s.sha256,name,x,y,...(nodeName?{nodeName}:{})});
async function check(label,fn){await fn();passed++;console.log(`PASS ${label}`);}
function instanceBytes(bytes,name){const p=parseGdfGeometry(bytes).placements.find(p=>p.instanceName===name),ts=tokeniseGdfGeometry(bytes),from=ts.findIndex(t=>t.offset===p.offset),to=ts.findIndex((t,i)=>i>from&&['g','r','t'].includes(t.opcode));return rebuildGdfGeometry(ts.slice(from,to));}
async function verify(label){
  const compiled=await job('maxplus2_run',{root,project:project.project,compile:true});assert.equal(compiled.report?.clean,true,JSON.stringify(compiled));assert.equal(compiled.report?.fresh,true);
  const exported=await job('netlist_export',{root,project:project.project,path:'demo.gdf'});assert.equal(exported.verdict,'verified-export',JSON.stringify(exported.compile));const graph=parseNetlist(fs.readFileSync(exported.netlistJson[0].path,'latin1'));
  for(const [name,direction]of [['A','INPUT'],['B','INPUT'],['C','INPUT'],['Y','OUTPUT']]){assert.ok(graph.ports.some(p=>p.name===name&&p.direction===direction),`${name} port: ${JSON.stringify(graph.ports)}`);assert.ok(graph.nets.some(n=>n.endpoints.some(e=>e.instance===null&&e.port===name)));}
  assert.ok(graph.instances.filter(i=>/^XOR2/i.test(i.cell)).length>=2,'both custom XOR instances are emitted in the synthesized vendor circuit');
  const truth=[0,1,1,0,1,0,0,1],sim=await job('simulate_and_verify',{root,project:project.project});assert.equal(sim.banner,'successful',JSON.stringify(sim));assert.equal(sim.tblCreated,true);const trace=tblTrace(parseTbl(fs.readFileSync(sim.tblPath,'latin1'))),expected=truth.map((Y,i)=>{const row=trace.filter(r=>r.time>=100*i&&r.time<100*(i+1)).at(-1);assert.ok(row);return {time:row.time,outputs:{Y}};});assert.equal(checkTrace(trace,expected,{tolerance:0}).ok,true,JSON.stringify(trace));assert.equal(checkTrace(trace,[{time:expected[0].time,outputs:{Y:1}}],{tolerance:0}).ok,false);
  evidence.push({label,gdfSha256:sha(fs.readFileSync(file)),symbolSha256:sha(fs.readFileSync(symbolFile)),clean:true,counts:graph.counts,truthTable:truth});
}
let original,sym;
try{
  await client.initialize();
  await check('two actual shared custom XOR instances compile and simulate Y=(A XOR B) XOR C',async()=>{
    project=await call('project_create',{name:'demo',device:'EP1K10TC100-1',confirm:true});file=path.join(project.directory,'demo.gdf');symbolFile=path.join(project.directory,'CUSTOMXOR.sym');
    sym=createSymbol({name:'CUSTOMXOR',width:64,height:48,pins:[{name:'A',attributeName:'ISTUB',x:0,y:24,labelX:8,labelY:25},{name:'B',attributeName:'ISTUB',x:0,y:8,labelX:8,labelY:9},{name:'Y',attributeName:'OSTUB',x:64,y:16,labelX:48,labelY:17}],graphics:[{operation:'add_circle',x:32,y:24,radius:4}],texts:[{text:'old graphics',x:8,y:40}]}).buffer;
    fs.writeFileSync(symbolFile,sym);fs.writeFileSync(path.join(project.directory,'CUSTOMXOR.vhd'),'ENTITY CUSTOMXOR IS PORT(A, B: IN BIT; Y: OUT BIT); END CUSTOMXOR;\nARCHITECTURE rtl OF CUSTOMXOR IS BEGIN Y <= A XOR B; END rtl;\n','latin1');
    const blank=await call('gdf_create',{project:project.project,path:'demo.gdf',confirm:true}),input=await call('gdf_symbol_library',{root,path:'prim/input.sym'}),output=await call('gdf_symbol_library',{root,path:'prim/output.sym'}),custom={path:symbolFile,sha256:sha(sym)};
    await call('gdf_construct',{project:project.project,path:'demo.gdf',expectedSha256:blank.sha256,operations:[symbol(input,'inputA',32,296,'A'),symbol(input,'inputB',32,280,'B'),symbol(input,'inputC',32,200,'C'),symbol(custom,'first',272,280),symbol(custom,'second',400,280),symbol(output,'outputY',536,288,'Y'),wire(200,304,272,304),wire(200,288,272,288),wire(200,208,384,208),wire(384,208,384,288),wire(384,288,400,288),wire(336,296,368,296),wire(368,296,368,304),wire(368,304,400,304),wire(464,296,536,296)],confirm:true});
    original=fs.readFileSync(file);assert.equal(parseGdfGeometry(original).definitions.filter(d=>d.name==='CUSTOMXOR').length,1);
    await call('stimulus_write',{project:project.project,path:'demo.vec',inputs:['A','B','C'],outputs:['Y'],rows:Array.from({length:8},(_,i)=>({A:(i>>2)&1,B:(i>>1)&1,C:i&1})),interval:100,confirm:true});await verify('before-refresh');
  });
  await check('selected embedded graph refresh preserves both instance bytes and native logic through a split shared definition',async()=>{
    const info=inspectSymbol(sym);sym=editSymbol(sym,[{operation:'set_circle',recordOffset:info.graphics[0].offset,x:40,y:24,radius:7},{operation:'set_text',recordOffset:info.texts.find(t=>t.text==='old graphics').offset,text:'updated graphics'}]).buffer;fs.writeFileSync(symbolFile,sym);
    const plan=inspectGdfSymbolRefresh(original,sym,{selectors:[{instanceName:'first'}]});assert.equal(plan.canApply,true);assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].pinChanges.length,0);const refreshed=refreshGdfSymbol(original,sym,{selectors:[{instanceName:'first'}]});
    assert.deepEqual(instanceBytes(refreshed.buffer,'first'),instanceBytes(original,'first'));assert.deepEqual(instanceBytes(refreshed.buffer,'second'),instanceBytes(original,'second'));const parsed=parseGdfGeometry(refreshed.buffer),defs=parsed.definitions.filter(d=>d.name==='CUSTOMXOR');assert.equal(defs.length,2);assert.equal(defs[0].primitives[0].center.x,40);assert.equal(defs[1].primitives[0].center.x,32);fs.writeFileSync(file,refreshed.buffer);await verify('selective-graphics-refresh');
  });
  await check('moved pin refuses silent disconnection; explicit refresh plus reconnected original-grid wires compiles and simulates correctly',async()=>{
    const before=fs.readFileSync(file),A=inspectSymbol(sym).pins.find(p=>p.name==='A');sym=editSymbol(sym,[{operation:'set_pin',recordOffset:A.offset,x:0,y:32,labelX:8,labelY:33}]).buffer;fs.writeFileSync(symbolFile,sym);
    const options={selectors:[{instanceName:'first'}]},plan=inspectGdfSymbolRefresh(before,sym,options);assert.equal(plan.canApply,false);assert.ok(plan.blockers.some(b=>b.code==='geometric-contact-change'));assert.throws(()=>refreshGdfSymbol(before,sym,options),e=>e.preview?.canApply===false);assert.deepEqual(fs.readFileSync(file),before);
    const refreshed=refreshGdfSymbol(before,sym,{...options,allowDisconnected:true});assert.deepEqual(instanceBytes(refreshed.buffer,'first'),instanceBytes(before,'first'));const after=parseGdfGeometry(refreshed.buffer),line=after.sheet.wires.find(w=>w.start.x===200&&w.start.y===304&&w.end.x===272&&w.end.y===304);assert.ok(line);assert.deepEqual(after.placements.find(p=>p.instanceName==='first').pins.find(p=>p.name==='A').worldPosition,{x:272,y:312});
    const repaired=constructGdf(refreshed.buffer,[{operation:'delete_wire',recordOffset:line.offset},wire(200,304,240,304),wire(240,304,240,312),wire(240,312,272,312)],()=>{throw new Error('No new symbol insertion is part of reconnection');}).buffer;fs.writeFileSync(file,repaired);assert.deepEqual(instanceBytes(repaired,'first'),instanceBytes(before,'first'));assert.deepEqual(instanceBytes(repaired,'second'),instanceBytes(before,'second'));await verify('pin-refresh-and-explicit-reconnection');
  });
  console.log(`OK passed=${passed} failed=0\nOriginal-vendor shared-symbol refresh and explicit pin reconnection verified.\n${JSON.stringify(evidence,null,2)}`);
}finally{await client.close();assert.equal(path.dirname(path.resolve(workspace)),path.resolve(os.tmpdir()));assert.match(path.basename(workspace),/^mp2-gdf-symbol-refresh-client-/);fs.rmSync(workspace,{recursive:true,force:true});}
