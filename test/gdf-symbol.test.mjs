import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createSymbol,cloneSymbol,editSymbol,inspectSymbol,encodeGraphic,editGraphic,SYMBOL_ATTRIBUTE_SOURCE} from '../lib/gdf-symbol-editor.mjs';
import {tokeniseGdfGeometry,rebuildGdfGeometry} from '../lib/gdf-geometry.mjs';
import {constructGdf,createBlankGdf,readSymbolPrototype} from '../lib/gdf-authoring.mjs';
const pins=[{name:'A',attributeName:'ISTUB',x:0,y:24,labelX:8,labelY:25},{name:'Y',attributeName:'OSTUB',x:64,y:24,labelX:48,labelY:25}];
const arc={operation:'add_arc',cx:32,cy:24,startX:48,startY:24,endX:32,endY:40,radius:16,startAngleDegrees:0,sweepAngleDegrees:90,startDot:true};
const initial=()=>createSymbol({name:'CUSTOM',width:64,height:48,pins,graphics:[{operation:'add_line',x1:0,y1:24,x2:8,y2:24},arc,{operation:'add_circle',x:32,y:24,radius:8}],texts:[{text:'label',x:16,y:16}]}).buffer;
const defaults=b=>{const ts=tokeniseGdfGeometry(b),at=ts.findIndex(t=>['h','u'].includes(t.opcode));return Buffer.concat(ts.slice(at,-1).map(t=>t.body));};

test('new SYM frames original header/name/pins/default NET_ID and exact token round trip',()=>{
  const b=initial(),s=inspectSymbol(b);assert.equal(s.header.magic,'SYM');assert.equal(s.header.version,6);assert.equal(s.header.rawHex,'53594d0000000600006503020244');assert.equal(s.symbolName,'CUSTOM');assert.equal(s.nameAttributeName,'MACRO_NAME');assert.equal(s.defaults[0].attributeName,'NET_ID');assert.equal(s.defaults[0].nativeType,8);assert.deepEqual(s.pins.map(p=>[p.name,p.attributeName,p.direction,p.directionScope]),[['A','ISTUB','input','symbol-interface'],['Y','OSTUB','output','symbol-interface']]);assert.deepEqual(rebuildGdfGeometry(tokeniseGdfGeometry(b)),b);assert.equal(readSymbolPrototype(b).symbolName,'CUSTOM');
  assert.equal(SYMBOL_ATTRIBUTE_SOURCE.tableVA,'0x10045104');assert.match(SYMBOL_ATTRIBUTE_SOURCE.sha256,/^[a-f0-9]{64}$/);
});
test('native name attribute selection distinguishes primitive and macro source names',()=>{
  const primitive=createSymbol({name:'XOR',nameAttributeName:'SYM_NAME'}).buffer;assert.equal(inspectSymbol(primitive).nameAttributeName,'SYM_NAME');
  assert.equal(inspectSymbol(editSymbol(primitive,[{operation:'rename_symbol',name:'UNKNOWN'}]).buffer).nameAttributeName,'SYM_NAME');
  assert.equal(inspectSymbol(cloneSymbol(primitive,{name:'CUSTOM'}).buffer).nameAttributeName,'MACRO_NAME');
  assert.equal(inspectSymbol(cloneSymbol(primitive,{name:'AND2',nameAttributeName:'SYM_NAME'}).buffer).nameAttributeName,'SYM_NAME');
  assert.throws(()=>cloneSymbol(primitive,{name:'X',unexpected:true}),/Unexpected/);assert.throws(()=>createSymbol({name:'X',nameAttributeName:'DOC'}),/nameAttributeName/);
});
test('clone pin name/anchor/type transaction preserves header, defaults, font and unknown flags',()=>{
  const b=initial(),prior=Buffer.from(b),s=inspectSymbol(b),p=s.pins[0],q=tokeniseGdfGeometry(b).find(t=>t.offset===p.attributeOffset);b.writeUInt16LE(q.flags|0xa000,q.offset+7);const before=inspectSymbol(b),result=cloneSymbol(b,{name:'CLONE',operations:[{operation:'set_pin',recordOffset:p.offset,name:'IN',x:-8,y:32,labelX:1,labelY:33,attributeName:'IOSTUB'}]}),after=inspectSymbol(result.buffer);
  assert.deepEqual(b.subarray(0,14),result.buffer.subarray(0,14));assert.deepEqual(defaults(result.buffer),defaults(b));assert.equal(after.symbolName,'CLONE');assert.equal(after.pins[0].name,'IN');assert.equal(after.pins[0].attributeName,'IOSTUB');assert.deepEqual(after.pins[0].position,{x:-8,y:32});assert.deepEqual(after.pins[0].labelPosition,{x:1,y:33});assert.equal(after.texts.find(t=>t.offset===after.pins[0].attributeOffset).rawFlags,before.texts.find(t=>t.offset===p.attributeOffset).rawFlags);assert.ok(result.changes.length===2);assert.ok(!prior.equals(b));
});
test('primitive translation covers arc cache points while preserving radius, angles and flags',()=>{
  const b=initial(),s=inspectSymbol(b),a=s.graphics.find(g=>g.kind==='arc'),before=Buffer.from(b),r=editSymbol(b,[{operation:'translate',recordOffset:a.offset,dx:-4,dy:6}]),after=inspectSymbol(r.buffer).graphics.find(g=>g.kind==='arc');assert.deepEqual(after.center,{x:a.center.x-4,y:a.center.y+6});assert.deepEqual(after.start,{x:a.start.x-4,y:a.start.y+6});assert.deepEqual(after.end,{x:a.end.x-4,y:a.end.y+6});assert.equal(after.radius,a.radius);assert.equal(after.startAngleDegrees,a.startAngleDegrees);assert.equal(after.sweepAngleDegrees,a.sweepAngleDegrees);assert.equal(after.rawFlags,a.rawFlags);assert.deepEqual(b,before);
});
test('circle/arc explicit fields and native display/style masks retain upper opaque flags',()=>{
  const b=initial(),s=inspectSymbol(b),c=s.graphics.find(g=>g.kind==='circle'),a=s.graphics.find(g=>g.kind==='arc'),t=s.texts.find(t=>t.text==='label');b.writeUInt16LE(0xabf0,c.offset+7);b.writeUInt16LE(0xe470,t.offset+7);
  const r=editSymbol(b,[{operation:'set_circle',recordOffset:c.offset,x:20,y:-20,radius:60000},{operation:'set_arc',recordOffset:a.offset,cx:0,cy:0,startX:40,startY:0,endX:0,endY:40,radius:40,startAngleDegrees:0,sweepAngleDegrees:90},{operation:'set_text_display',recordOffset:t.offset,visible:true,color:2,orientation:7}]),after=inspectSymbol(r.buffer);assert.equal(after.graphics.find(g=>g.kind==='circle').radius,60000);assert.equal(after.graphics.find(g=>g.kind==='circle').rawFlags,0xabf0);assert.equal(after.texts.find(a=>a.text==='label').rawFlags&0xfc00,0xe470&0xfc00);
  const c2=after.graphics.find(g=>g.kind==='circle');const edited=editSymbol(r.buffer,[{operation:'set_graphic_style',recordOffset:c2.offset,filled:true}]);assert.equal(inspectSymbol(edited.buffer).graphics.find(g=>g.kind==='circle').rawFlags,0xabf1);
});
test('legacy s payload, custom font, metrics, alternative text and default bytes survive text edit',()=>{
  const b=initial(),ts=tokeniseGdfGeometry(b),t=ts.find(t=>t.opcode==='q'&&t.text==='label'),head=Buffer.from(t.body.subarray(0,9));head[2]=4;
  const str=v=>Buffer.from([0x73,v.length,...Buffer.from(v,'latin1'),0]),metrics=Buffer.from([16,0,8,0]);t.body=Buffer.concat([head,str('Arial,7'),metrics,str('label'),str('ALT')]);const input=rebuildGdfGeometry(ts),info=inspectSymbol(input),doc=info.texts.find(t=>t.text==='label'),out=editSymbol(input,[{operation:'set_text',recordOffset:doc.offset,text:'changed'}]).buffer,nt=tokeniseGdfGeometry(out).find(t=>t.text==='changed');assert.equal(nt.textRecord.opcode,'s');assert.equal(nt.font,'Arial,7');assert.deepEqual(nt.metrics,[16,8]);assert.equal(nt.alternative,'ALT');assert.equal(nt.alternativeRecord.opcode,'s');assert.deepEqual(defaults(out),defaults(input));
});
test('add/delete pins and graphics retain original reader phases and unaffected records',()=>{
  const b=initial(),s=inspectSymbol(b),r=editSymbol(b,[{operation:'delete_pin',recordOffset:s.pins[0].offset},{operation:'add_pin',name:'B',attributeName:'UNUSED_ISTUB',x:0,y:8,labelX:8,labelY:9},{operation:'add_line',x1:0,y1:0,x2:4,y2:4},{operation:'add_circle',x:20,y:20,radius:2,filled:true},{operation:'add_text',text:'note',x:8,y:8},{operation:'delete_graphic',recordOffset:s.texts.find(t=>t.text==='label').offset}]),after=inspectSymbol(r.buffer);assert.deepEqual(after.pins.map(p=>p.name),['Y','B']);assert.equal(after.pins[1].unused,true);assert.equal(after.graphics.length,s.graphics.length+2);assert.ok(after.texts.some(t=>t.text==='note'));assert.ok(!after.texts.some(t=>t.text==='label'));assert.deepEqual(defaults(r.buffer),defaults(b));
});
test('symbol source/hash changes and same-name graphical replacements are caught by existing construction',()=>{
  const b=initial(),s=inspectSymbol(b),op={operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:s.sha256,name:'instance1',x:0,y:0},g=constructGdf(createBlankGdf(),[op],()=>({path:'custom.sym',bytes:b})).buffer,changed=editSymbol(b,[{operation:'set_extent',width:72,height:48}]).buffer;
  assert.throws(()=>constructGdf(createBlankGdf(),[op],()=>({path:'custom.sym',bytes:changed})),/source changed/);
  assert.throws(()=>constructGdf(g,[{...op,name:'instance2',symbolSha256:inspectSymbol(changed).sha256}],()=>({path:'custom.sym',bytes:changed})),/same-name symbol definition differs/);
});
test('associated instance pin defaults are preserved and unsafe orphaning changes are rejected',()=>{
  const b=initial(),ts=tokeniseGdfGeometry(b),p=inspectSymbol(b).pins[0],q=ts.find(t=>t.offset===p.attributeOffset),h=ts.findIndex(t=>t.opcode==='h');ts.splice(h+1,0,{opcode:'q',body:Buffer.from(q.body)});const input=rebuildGdfGeometry(ts),s=inspectSymbol(input);assert.equal(s.pins[0].associatedDefaultOffsets.length,1);
  assert.throws(()=>editSymbol(input,[{operation:'set_pin',recordOffset:p.offset,name:'NEW'}]),/associated original instance defaults/);assert.throws(()=>editSymbol(input,[{operation:'delete_pin',recordOffset:p.offset}]),/associated original instance defaults/);const out=editSymbol(input,[{operation:'set_pin',recordOffset:p.offset,x:-8,y:24}]).buffer;assert.deepEqual(defaults(input),defaults(out));
});
test('malformed scope, defaults, unsupported attributes, duplicates and partial coordinates fail atomically',()=>{
  const b=initial(),s=inspectSymbol(b),before=Buffer.from(b);
  assert.throws(()=>editSymbol(createBlankGdf(),[{operation:'rename_symbol',name:'x'}]),/standalone modern SYM/);
  for(const ops of [[{operation:'set_pin',recordOffset:s.pins[0].offset,x:1,y:24}],[{operation:'set_pin',recordOffset:s.pins[0].offset,x:8}],[{operation:'set_pin',recordOffset:s.pins[0].offset,attributeName:'INPUT'}],[{operation:'set_pin',recordOffset:s.pins[0].offset,name:'Y'}],[{operation:'set_text',recordOffset:s.defaults[0].offset,text:'x'}],[{operation:'set_text',recordOffset:s.nameRecordOffset,text:'X'}],[{operation:'set_extent',width:72,height:48},{operation:'set_extent',width:80,height:48}],[{operation:'add_text',x:0,y:0,text:'bad\0'}]])assert.throws(()=>editSymbol(b,ops));assert.deepEqual(b,before);
  assert.throws(()=>createSymbol({name:'X',pins:[{...pins[0],defaultValue:'1'}]}),/Unexpected/);assert.throws(()=>createSymbol({name:'X',extra:true}),/Unexpected/);
});
test('reusable primitive helpers encode root m lines and edit exact unsigned radius/opaque flags',()=>{
  const line=encodeGraphic({operation:'add_line',x1:0,y1:0,x2:8,y2:0},{lineOpcode:'m'});assert.equal(line.opcode,'m');assert.equal(line.body[0],0x6d);
  const circle=encodeGraphic({operation:'add_circle',x:0,y:0,radius:40000});circle.body.writeUInt16LE(0xabf0,7);const r=editGraphic(circle,{operation:'set_graphic_style',recordOffset:0,filled:true});assert.equal(r.body.readUInt16LE(7),0xabf1);assert.equal(r.body.readUInt16LE(5),40000);assert.equal(circle.body.readUInt16LE(7),0xabf0);
});
test('modern original library SYMs inspect without normalizing any bytes',{skip:!fs.existsSync(path.join(process.env.MAXPLUS2_ROOT ?? '__installation_not_configured__','max2lib'))},()=>{
  const files=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\.sym$/i.test(e.name))files.push(p);}}walk(path.join(process.env.MAXPLUS2_ROOT ?? '__installation_not_configured__','max2lib'));let checked=0,legacy=0;
  for(const f of files){const b=fs.readFileSync(f);if(b.readUInt16LE(6)<2){legacy++;continue;}const s=inspectSymbol(b);assert.equal(s.bytes,b.length);const originals=tokeniseGdfGeometry(b);assert.deepEqual(rebuildGdfGeometry(originals),b);const cloned=cloneSymbol(b,{name:'TEST_CLONE'}).buffer,clonedTokens=tokeniseGdfGeometry(cloned);assert.equal(originals.length,clonedTokens.length);for(let i=0;i<originals.length;i++)if(originals[i].offset!==s.nameRecordOffset)assert.deepEqual(clonedTokens[i].body,originals[i].body);assert.equal(inspectSymbol(cloned).nameAttributeName,'MACRO_NAME');checked++;}assert.ok(checked>=500);console.log(`Original SYM corpus: ${checked} modern exact round trips and unrelated-byte-preserving clones; ${legacy} legacy files excluded.`);
});
