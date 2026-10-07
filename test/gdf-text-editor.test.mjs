import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {createSymbol} from '../lib/gdf-symbol-editor.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {gdfString} from '../lib/gdf-properties.mjs';
import {editDrawingText} from '../lib/gdf-text-editor.mjs';
const texts=b=>parseGdfGeometry(b).sheet.attributes.filter(a=>a.kindCode===0&&a.nativeType===7);
const add=(buffer,text='Note',x=128,y=256)=>editDrawingText(buffer,[{operation:'add_text',text,x,y}]).buffer;
function q({type=0,font=0,flags=0x61,label=gdfString('Note'),fontBytes=Buffer.alloc(0),alternative=Buffer.alloc(0)}={}) {
  const b=Buffer.alloc(9);b[0]=0x71;b[1]=type;b[2]=font;b.writeInt16LE(-16,3);b.writeInt16LE(24,5);b.writeUInt16LE(flags,7);
  return Buffer.concat([b,fontBytes,label,alternative]);
}
const sheetWith=bytes=>Buffer.concat([createBlankGdf().subarray(0,-1),bytes,Buffer.from('t')]);
test('add root DOC records with explicit display and report usable output offsets',()=>{
  const blank=createBlankGdf(),copy=Buffer.from(blank),r=editDrawingText(blank,[{operation:'add_text',text:'Hello',x:-123,y:457,color:15,editable:false,visible:true,zoom:false,orientation:7}]);
  assert.deepEqual(blank,copy);const a=texts(r.buffer)[0];assert.equal(a.kindCode,0);assert.deepEqual(a.position,{x:-123,y:457});
  assert.deepEqual(a.display,{editable:false,color:15,visible:true,zoom:false,orientation:7});assert.equal(a.offset,r.changes[0].resultingRecordOffset);
});
test('multiple operations on one original offset keep working string lengths correct',()=>{
  const b=add(createBlankGdf()),offset=texts(b)[0].offset;
  const changed=editDrawingText(b,[{operation:'set_text',recordOffset:offset,text:'A long first replacement'},
    {operation:'set_text_position',recordOffset:offset,x:200,y:-17},{operation:'set_text_display',recordOffset:offset,color:9,zoom:false},
    {operation:'set_text',recordOffset:offset,text:'Short'}]);
  const a=texts(changed.buffer)[0];assert.equal(a.text,'Short');assert.deepEqual(a.position,{x:200,y:-17});assert.equal(a.display.color,9);assert.equal(a.display.zoom,false);
  assert.deepEqual(changed.changes.map(c=>c.resultingRecordOffset),[offset,offset,offset,offset]);
});
test('all orientation and color values write only their evidenced masks',()=>{
  const b=sheetWith(q({flags:0xdc61})),offset=texts(b)[0].offset;
  for(let orientation=0;orientation<8;orientation++)for(let color=0;color<16;color++){
    const changed=editDrawingText(b,[{operation:'set_text_display',recordOffset:offset,orientation,color}]).buffer,a=texts(changed)[0];
    assert.equal(a.display.orientation,orientation);assert.equal(a.display.color,color);assert.equal(a.rawFlags&0xfc00,0xdc61&0xfc00);
    const left=Buffer.from(changed);left.writeUInt16LE(0xdc61,offset+7);assert.deepEqual(left,b);
  }
});
test('toggle all editable/visible/zoom combinations without changing other bytes',()=>{
  const b=sheetWith(q({flags:0xbca9})),offset=texts(b)[0].offset;
  for(let bits=0;bits<8;bits++){
    const requested={editable:!!(bits&1),visible:!!(bits&2),zoom:!!(bits&4)},result=editDrawingText(b,[{operation:'set_text_display',recordOffset:offset,...requested}]).buffer;
    const a=texts(result)[0];for(const [key,value]of Object.entries(requested))assert.equal(a.display[key],value);
    assert.equal(a.rawFlags&~0x61,0xbca9&~0x61);
  }
});
test('custom font, stored metrics and alternative legacy string are retained exactly',()=>{
  const metrics=Buffer.from('80002800','hex'),fontBytes=Buffer.concat([gdfString('Arial'),metrics]),alternative=Buffer.concat([Buffer.from([0x73,3]),Buffer.from('Alt\0','latin1')]);
  const b=sheetWith(q({font:4,fontBytes,alternative})),before=tokeniseGdfGeometry(b).find(t=>t.opcode==='q'),offset=before.offset;
  const r=editDrawingText(b,[{operation:'set_text',recordOffset:offset,text:'A much longer main label'},{operation:'set_text_position',recordOffset:offset,x:40,y:80}]).buffer;
  const a=texts(r)[0],after=tokeniseGdfGeometry(r).find(t=>t.opcode==='q');assert.equal(a.font,'Arial');assert.deepEqual(a.metrics,{width:128,height:40});assert.equal(a.alternative,'Alt');
  assert.deepEqual(after.body.subarray(9,after.textRecord.offset-after.offset),before.body.subarray(9,before.textRecord.offset-before.offset));
  assert.deepEqual(after.body.subarray(after.alternativeRecord.offset-after.offset),alternative);
});
test('legacy s framing stays s and refuses length overflow atomically',()=>{
  const label=Buffer.concat([Buffer.from([0x73,4]),Buffer.from('Note\0','latin1')]),b=sheetWith(q({label})),offset=texts(b)[0].offset;
  const changed=editDrawingText(b,[{operation:'set_text',recordOffset:offset,text:'x'.repeat(255)}]).buffer,a=texts(changed)[0];assert.equal(a.textRecord.lengthType,'u8');assert.equal(a.text.length,255);
  assert.throws(()=>editDrawingText(b,[{operation:'set_text',recordOffset:offset,text:'x'.repeat(256)}]),/255/);assert.deepEqual(b,sheetWith(q({label})));
});
test('add then delete reproduces every original byte',()=>{
  const blank=createBlankGdf(),b=add(blank),offset=texts(b)[0].offset;
  const removed=editDrawingText(b,[{operation:'delete_text',recordOffset:offset}]);assert.deepEqual(removed.buffer,blank);assert.equal(removed.changes[0].resultingRecordOffset,null);
});
test('root DOCs after a wire NODE_NAME can be edited without stealing line ownership',()=>{
  const b=constructGdf(createBlankGdf(),[{operation:'add_wire',x1:0,y1:0,x2:80,y2:0,nodeName:'NET'},{operation:'add_annotation',x:80,y:80,text:'Free note'}]).buffer;
  const note=texts(b)[0],tokens=tokeniseGdfGeometry(b),qToken=tokens.find(t=>t.offset===note.offset);assert.equal(qToken.lineTextContext,true);
  const result=editDrawingText(b,[{operation:'set_text_display',recordOffset:note.offset,visible:false},{operation:'add_text',text:'Second',x:160,y:160}]).buffer;
  const sheet=parseGdfGeometry(result).sheet;assert.equal(sheet.primitives[0].annotations[0].text,'NET');assert.deepEqual(texts(result).map(a=>a.text),['Free note','Second']);
  const deleted=editDrawingText(result,[{operation:'delete_text',recordOffset:texts(result)[0].offset}]).buffer;assert.equal(parseGdfGeometry(deleted).sheet.primitives[0].annotations[0].text,'NET');
});
test('reject NODE_NAME, line-owned DOC, pin DOC, instance DOC and shared definition DOC',()=>{
  const labelled=constructGdf(createBlankGdf(),[{operation:'add_wire',x1:0,y1:0,x2:80,y2:0,nodeName:'NET'}]).buffer;
  const net=parseGdfGeometry(labelled).sheet.primitives[0].annotations[0];assert.throws(()=>editDrawingText(labelled,[{operation:'delete_text',recordOffset:net.offset}]),/free root q DOC/);
  const wire=tokeniseGdfGeometry(labelled).find(t=>t.opcode==='k').body,lineDoc=sheetWith(Buffer.concat([wire,Buffer.from('i'),q()]));
  const lineAttr=parseGdfGeometry(lineDoc).sheet.primitives[0].annotations[0];assert.throws(()=>editDrawingText(lineDoc,[{operation:'set_text',recordOffset:lineAttr.offset,text:'No'}]),/free root q DOC/);
  const pinBody=Buffer.from('7000000000','hex'),pinDoc=sheetWith(Buffer.concat([q(),pinBody]));assert.throws(()=>editDrawingText(pinDoc,[{operation:'delete_text',recordOffset:texts(pinDoc)[0].offset}]),/free root q DOC/);
  const sym=createSymbol({name:'CUSTOM',texts:[{text:'Inside definition',x:0,y:0}]}).buffer,sha=createHash('sha256').update(sym).digest('hex');
  const instance=constructGdf(createBlankGdf(),[{operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:sha,name:'custom1',x:80,y:80}],()=>({path:'custom.sym',bytes:sym})).buffer;
  const g=parseGdfGeometry(instance),definition=g.definitions[0].attributes.find(a=>a.kindCode===0),alias=g.placements[0].attributes.find(a=>a.kindCode===0);
  for(const offset of [definition.offset,alias.offset])assert.throws(()=>editDrawingText(instance,[{operation:'delete_text',recordOffset:offset}]),/free root q DOC/);
});
test('preserve embedded definitions, defaults, primitive and source-header bytes',()=>{
  const sym=createSymbol({name:'CUSTOM'}).buffer,sha=createHash('sha256').update(sym).digest('hex');
  const b=constructGdf(createBlankGdf(),[{operation:'add_wire',x1:0,y1:0,x2:80,y2:0},{operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:sha,name:'custom1',x:80,y:80},{operation:'add_annotation',x:0,y:80,text:'Root'}],()=>({path:'custom.sym',bytes:sym})).buffer;
  const old=tokeniseGdfGeometry(b),offset=texts(b)[0].offset,result=editDrawingText(b,[{operation:'set_text',recordOffset:offset,text:'Longer root text'},{operation:'add_text',x:160,y:160,text:'New'}]).buffer;
  const next=tokeniseGdfGeometry(result),end=old.findIndex(t=>t.opcode==='g'),nextEnd=next.findIndex(t=>t.opcode==='g');
  assert.deepEqual(Buffer.concat(old.slice(end).map(t=>t.body)),Buffer.concat(next.slice(nextEnd).map(t=>t.body)));
  assert.deepEqual(old[0].body,next[0].body);assert.deepEqual(old.find(t=>t.opcode==='k').body,next.find(t=>t.opcode==='k').body);
});
test('invalid later step, edit-after-delete and unknown fields leave source untouched',()=>{
  const b=add(createBlankGdf()),copy=Buffer.from(b),offset=texts(b)[0].offset;
  for(const operations of [[{operation:'set_text',recordOffset:offset,text:'Changed'},{operation:'set_text_display',recordOffset:offset,color:16}],
    [{operation:'delete_text',recordOffset:offset},{operation:'set_text_position',recordOffset:offset,x:0,y:0}],
    [{operation:'set_text_display',recordOffset:offset}],[{operation:'set_text_position',recordOffset:offset,x:32768,y:0}],
    [{operation:'set_text',recordOffset:offset,text:'汉字'}],[{operation:'add_text',x:0,y:0,text:'a\nb'}],
    [{operation:'delete_text',recordOffset:offset,extra:true}],[{operation:'set_text_display',recordOffset:offset,visible:1}]])assert.throws(()=>editDrawingText(b,operations));
  assert.deepEqual(b,copy);
});
test('reject SYM and unsupported modern GDF versions',()=>{
  const sym=createSymbol({name:'CUSTOM'}).buffer;assert.throws(()=>editDrawingText(sym,[{operation:'add_text',x:0,y:0,text:'No'}]),/GDF version 6/);
  const older=Buffer.from(createBlankGdf());older.writeUInt16LE(5,6);assert.throws(()=>editDrawingText(older,[{operation:'add_text',x:0,y:0,text:'No'}]),/GDF version 6/);
});
