/** Actual ordinary stdio client exercises all new transaction boundaries. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';
import {sha256} from '../lib/workspace.mjs';
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-ext-client-')),client=new PlainMcpClient(workspace);
const call=(name,args)=>client.call(name,args),digest=p=>sha256(fs.readFileSync(path.join(workspace,p)));
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function error(name,args,pattern){const r=await client.request('tools/call',{name,arguments:args});assert.equal(r.isError,true);assert.match(r.content[0].text,pattern);}
try{
 await check('standard MCP exposes all new files and corrected native text flag schemas',async()=>{
  assert.equal((await client.initialize()).serverInfo.version,'0.10.1');const r=await client.request('tools/list');
  assert.equal(r.tools.length,68);
  for(const n of ['gdf_graphics_edit','gdf_text_edit','gdf_symbol_refresh','gdf_declarations','gdf_declarations_edit','sym_inspect','sym_edit','sym_create','scf_structure','scf_structure_edit','scf_create'])assert.ok(r.tools.some(t=>t.name===n),n);
  const fields=r.tools.find(t=>t.name==='sym_edit').inputSchema.properties.operations.items.properties;assert.equal(fields.zoom.type,'boolean');assert.equal(fields.color.maximum,15);assert.deepEqual(fields.nameAttributeName.enum,['SYM_NAME','MACRO_NAME']);
  assert.ok(r.tools.find(t=>t.name==='desktop_action').inputSchema.properties.action.enum.includes('invoke_menu'));
  for(const name of ['sym_create','scf_create']){const t=r.tools.find(t=>t.name===name);assert.equal(t.annotations.readOnlyHint,false);assert.equal(t.annotations.destructiveHint,false);}
 });
 await check('GDF graphical creation preview, apply and paginated inspection preserve transaction digest',async()=>{
  const blank=await call('gdf_create',{path:'drawing.gdf',confirm:true});const args={path:'drawing.gdf',expectedSha256:blank.sha256,operations:[{operation:'add_line',x1:32,y1:32,x2:160,y2:64},{operation:'add_circle',x:128,y:128,radius:40},{operation:'add_arc',cx:256,cy:128,startX:296,startY:128,endX:216,endY:128,radius:40,startAngleDegrees:0,sweepAngleDegrees:180}]};
  const preview=await call('gdf_graphics_edit',args);assert.equal(preview.preview,true);assert.equal(digest(args.path),blank.sha256);
  const r=await call('gdf_graphics_edit',{...args,confirm:true});assert.equal(r.result.sha256,preview.nextSha256);assert.equal(sha256(fs.readFileSync(r.backup)),blank.sha256);
  const g=await call('gdf_geometry',{path:args.path,view:'sheet',limit:1});assert.equal(g.records.total,3);assert.equal(g.records.items[0].opcode,'m');
  await error('gdf_graphics_edit',{...args,confirm:true},/changed/);assert.equal(digest(args.path),r.result.sha256);
 });
 await check('SYM creation preserves macro name semantics and creation never overwrites',async()=>{
  const args={path:'custom.sym',name:'CUSTOM',pins:[{name:'A',x:0,y:16,labelX:8,labelY:16,attributeName:'ISTUB'},{name:'Y',x:64,y:16,labelX:40,labelY:16,attributeName:'OSTUB'}],operations:[{operation:'add_circle',x:32,y:32,radius:16},{operation:'add_text',x:8,y:8,text:'DOC'}]};
  const preview=await call('sym_create',args);assert.equal(fs.existsSync(path.join(workspace,args.path)),false);
  const r=await call('sym_create',{...args,confirm:true});assert.equal(r.result.sha256,preview.nextSha256);
  const s=await call('sym_inspect',{path:args.path,limit:1});assert.equal(s.nameAttributeName,'MACRO_NAME');assert.equal(s.pins.total,2);assert.equal(s.pins.items[0].name,'A');
  await error('sym_create',{...args,confirm:true},/exists/);
 });
 await check('SYM text color15 and zoom boolean apply and restore exact bytes',async()=>{
  const s=await call('sym_inspect',{path:'custom.sym',limit:100}),old=s.sha256;
  const text=s.texts.items.find(t=>t.text==='DOC');assert.ok(text);
  const r=await call('sym_edit',{path:'custom.sym',expectedSha256:old,operations:[{operation:'set_text_display',recordOffset:text.offset,color:15,zoom:true,orientation:7}],confirm:true});
  assert.notEqual(r.result.sha256,old);const next=await call('sym_inspect',{path:'custom.sym'});assert.equal(next.texts.items.find(t=>t.text==='DOC').display.color,15);
  await call('project_restore_file',{path:'custom.sym',backup:r.backup,backupSha256:old,expectedSha256:r.result.sha256,confirm:true});assert.equal(digest('custom.sym'),old);
 });
 await check('SYM clone uses a hashed prototype and retains independently editable pins',async()=>{
  const s=await call('sym_inspect',{path:'custom.sym'});await call('sym_create',{path:'clone.sym',name:'CLONE',template:'custom.sym',templateSha256:s.sha256,confirm:true});assert.equal((await call('sym_inspect',{path:'clone.sym'})).symbolName,'CLONE');
  await error('sym_create',{path:'bad.sym',name:'BAD',template:'custom.sym',templateSha256:'0'.repeat(64),confirm:true},/changed/);assert.equal(fs.existsSync(path.join(workspace,'bad.sym')),false);
 });
 await check('GDF text creation, multi-field editing and deletion restore identical source bytes',async()=>{
  const old=digest('drawing.gdf');await call('gdf_text_edit',{path:'drawing.gdf',expectedSha256:old,operations:[{operation:'add_text',x:32,y:240,text:'NOTE',color:15,zoom:true}],confirm:true});
  let g=await call('gdf_geometry',{path:'drawing.gdf',limit:100}),text=g.records.items.find(t=>t.text==='NOTE');assert.ok(text);
  await call('gdf_text_edit',{path:'drawing.gdf',expectedSha256:g.sha256,operations:[{operation:'set_text',recordOffset:text.offset,text:'LONGER NOTE'},{operation:'set_text_position',recordOffset:text.offset,x:64,y:248},{operation:'set_text_display',recordOffset:text.offset,orientation:7}],confirm:true});
  g=await call('gdf_geometry',{path:'drawing.gdf',limit:100});text=g.records.items.find(t=>t.text==='LONGER NOTE');assert.equal(text.display.orientation,7);
  await call('gdf_text_edit',{path:'drawing.gdf',expectedSha256:g.sha256,operations:[{operation:'delete_text',recordOffset:text.offset}],confirm:true});assert.equal(digest('drawing.gdf'),old);
 });
 await check('embedded symbol refresh preserves selected placement and refuses unacknowledged wire contact changes',async()=>{
  await call('gdf_construct',{path:'drawing.gdf',expectedSha256:digest('drawing.gdf'),operations:[{operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:digest('custom.sym'),name:'gate',x:272,y:280},{operation:'add_wire',x1:200,y1:296,x2:272,y2:296}],confirm:true});
  let s=await call('sym_inspect',{path:'custom.sym',limit:100});await call('sym_edit',{path:'custom.sym',expectedSha256:s.sha256,operations:[{operation:'translate',recordOffset:s.graphics.items[0].offset,dx:8,dy:0}],confirm:true});
  const args={path:'drawing.gdf',expectedSha256:digest('drawing.gdf'),template:'custom.sym',templateSha256:digest('custom.sym'),selectors:[{instanceName:'gate'}]};
  const preview=await call('gdf_symbol_refresh',args);assert.equal(preview.preview,true);assert.equal(digest(args.path),args.expectedSha256);const applied=await call('gdf_symbol_refresh',{...args,confirm:true});assert.equal(applied.result.sha256,preview.nextSha256);
  const placements=await call('gdf_geometry',{path:args.path,view:'placements'});assert.equal(placements.records.items[0].instanceName,'gate');assert.deepEqual(placements.records.items[0].position,{x:272,y:280});
  s=await call('sym_inspect',{path:'custom.sym',limit:100});await call('sym_edit',{path:'custom.sym',expectedSha256:s.sha256,operations:[{operation:'set_pin',recordOffset:s.pins.items.find(p=>p.name==='A').offset,x:0,y:24}],confirm:true});
  const blocked={...args,expectedSha256:digest(args.path),templateSha256:digest('custom.sym')};const p=await call('gdf_symbol_refresh',blocked);assert.equal(p.canApply,false);assert.ok(p.blockers.items.some(b=>b.code==='geometric-contact-change'));await error('gdf_symbol_refresh',{...blocked,confirm:true},/blocked/);assert.equal(digest(args.path),blocked.expectedSha256);
 });
 await check('original declaration inspection and edit are exposed through hash/preview/backup MCP transactions',async()=>{
  const s=await call('gdf_symbol_library',{path:'prim/constant.sym',limit:100});await call('gdf_construct',{path:'drawing.gdf',expectedSha256:digest('drawing.gdf'),operations:[{operation:'add_symbol',symbolPath:s.path,symbolSha256:s.sha256,name:'decl',x:64,y:400}],confirm:true});
  const d=await call('gdf_declarations',{path:'drawing.gdf'}),decl=d.declarations.items.find(x=>x.writable);assert.ok(decl);
  const args={path:'drawing.gdf',expectedSha256:d.sha256,edits:[{recordOffset:decl.recordOffset,name:'VALUE',value:1}]};const p=await call('gdf_declarations_edit',args);assert.equal(digest(args.path),d.sha256);
  const r=await call('gdf_declarations_edit',{...args,confirm:true});assert.equal(r.result.sha256,p.nextSha256);assert.equal(sha256(fs.readFileSync(r.backup)),d.sha256);const n=await call('gdf_declarations',{path:args.path});assert.equal(n.declarations.items.find(x=>x.writable).value,'1');
 });
 await check('SCF can be created without VEC, grouped, renamed, reordered and duration extended',async()=>{
  const args={path:'wave.scf',durationNs:125.5,inputs:[{name:'A',events:[{time:0,value:0},{time:12.3,value:1}]},{name:'B',events:[{time:0,value:'X'},{time:40,value:'Z'}]},{name:'C'}]};
  const p=await call('scf_create',args);assert.equal(p.preview,true);assert.equal(fs.existsSync(path.join(workspace,args.path)),false);
  const r=await call('scf_create',{...args,confirm:true});assert.equal(r.result.sha256,p.nextSha256);
  await call('scf_structure_edit',{path:args.path,expectedSha256:r.result.sha256,operations:[{type:'group',name:'BUS',members:['B','A'],radix:'HEX'},{type:'rename',signal:'A',name:'ADDR'},{type:'reorder',signals:['C','BUS']},{type:'duration',durationNs:250}],confirm:true});
  const s=await call('scf_structure',{path:args.path,limit:100});assert.equal(s.complete,true);assert.equal(s.groups.items[0].name,'BUS');assert.equal(s.groups.items[0].radix,'HEX');assert.deepEqual(s.displayOrder.items.map(x=>x.name),['C','BUS']);assert.ok(s.scalars.items.some(x=>x.name==='ADDR'));
 });
 await check('SCF invalid later operation is atomic and stale hashes are rejected',async()=>{
  const old=digest('wave.scf');await error('scf_structure_edit',{path:'wave.scf',expectedSha256:old,operations:[{type:'rename',signal:'C',name:'C_CHANGED'},{type:'delete_input',signal:'MISSING'}],confirm:true},/existing scalar input/);assert.equal(digest('wave.scf'),old);
  await error('scf_structure_edit',{path:'wave.scf',expectedSha256:'0'.repeat(64),operations:[{type:'duration',durationNs:300}],confirm:true},/changed/);
 });
 await check('large nested transaction arrays are marked without changing the complete file',async()=>{
  const inputs=Array.from({length:41},(_,i)=>({name:'IN'+i}));const args={path:'large.scf',durationNs:100,inputs};
  const p=await call('scf_create',args);assert.equal(p.truncated,true);assert.equal(p.changes[0].inputs.length,20);assert.ok(p.truncations.some(t=>t.path==='$.changes[0].inputs'&&t.total===41&&t.returned===20));
  const r=await call('scf_create',{...args,confirm:true});assert.equal(r.result.sha256,p.nextSha256);const all=await call('scf_structure',{path:args.path,limit:100});assert.equal(all.scalars.total,41);assert.equal(all.scalars.items.length,41);
 });
 await check('long inspected text is explicitly marked and retains full original file content',async()=>{
  const original=await call('sym_inspect',{path:'custom.sym',limit:100}),long='Q'.repeat(1500);const text=original.texts.items.find(t=>t.text==='DOC');assert.ok(text);
  const r=await call('sym_edit',{path:'custom.sym',expectedSha256:original.sha256,operations:[{operation:'set_text',recordOffset:text.offset,text:long}],confirm:true});const s=await call('sym_inspect',{path:'custom.sym',limit:100});assert.equal(s.truncated,true);assert.ok(s.truncations.some(t=>t.kind==='string'&&t.total===1500));assert.ok(fs.readFileSync(path.join(workspace,'custom.sym')).includes(Buffer.from(long)));
  await call('project_restore_file',{path:'custom.sym',backup:r.backup,backupSha256:original.sha256,expectedSha256:r.result.sha256,confirm:true});
 });
 await check('clone arguments that would be silently ignored are refused before creating a file',async()=>{
  await error('sym_create',{path:'ignored.sym',name:'IGNORED',template:'custom.sym',templateSha256:digest('custom.sym'),pins:[{name:'A',x:0,y:0,labelX:8,labelY:0,attributeName:'ISTUB'}],confirm:true},/Use operations/);
  await error('sym_create',{path:'orphan.sym',name:'ORPHAN',templateSha256:digest('custom.sym'),confirm:true},/requires a template/);assert.equal(fs.existsSync(path.join(workspace,'ignored.sym')),false);assert.equal(fs.existsSync(path.join(workspace,'orphan.sym')),false);
 });
 await check('new binary tools reject mixed-case backups and scope escapes before preview or apply',async()=>{
  fs.mkdirSync(path.join(workspace,'.mcp-backups'),{recursive:true});fs.copyFileSync(path.join(workspace,'custom.sym'),path.join(workspace,'.mcp-backups','hold.sym'));const old=sha256(fs.readFileSync(path.join(workspace,'.mcp-backups','hold.sym')));
  await error('sym_edit',{path:process.platform==='win32'?'.MCP-BACKUPS/hold.sym':'.mcp-backups/hold.sym',expectedSha256:old,operations:[{operation:'rename_symbol',name:'BAD'}],confirm:true},/reserved/);
  fs.copyFileSync(path.join(workspace,'drawing.gdf'),path.join(workspace,'.mcp-backups','hold.gdf'));
  await error('gdf_symbol_refresh',{path:'.mcp-backups/hold.gdf',expectedSha256:digest('.mcp-backups/hold.gdf'),template:'custom.sym',templateSha256:old,selectors:[{instanceName:'gate'}]},/reserved/);
  await error('scf_create',{path:'../escape.scf',durationNs:20,inputs:[{name:'A'}],confirm:true},/escapes/);
  assert.equal(sha256(fs.readFileSync(path.join(workspace,'.mcp-backups','hold.sym'))),old);
 });
}finally{await client.close();assert.equal(path.dirname(workspace),os.tmpdir());fs.rmSync(workspace,{recursive:true,force:true});}
console.log(`OK passed=${passed} failed=0`);
