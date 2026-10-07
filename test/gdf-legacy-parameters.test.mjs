import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createBlankGdf,constructGdf,readSymbolPrototype} from '../lib/gdf-authoring.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {gdfString,replaceGdfLabel} from '../lib/gdf-properties.mjs';
import {legacyGdfDeclarationSummary,readGdfLegacyDeclarations,editGdfLegacyDeclarations} from '../lib/gdf-legacy-parameters.mjs';
import {detectInstall} from '../lib/runtime.mjs';
import {sha256} from '../lib/workspace.mjs';
const root=detectInstall()?.root;assert.ok(root);
const resolve=p=>({path:p,bytes:fs.readFileSync(p)});
function add(kind,name,x=128){const symbolPath=path.join(root,'max2lib',kind==='lpm_constant'?'mega_lpm/lpm_constant.sym':`prim/${kind}.sym`);return {operation:'add_symbol',symbolPath,symbolSha256:sha256(fs.readFileSync(symbolPath)),name,x,y:400,...(kind==='lpm_constant'?{parameters:{LPM_WIDTH:4,LPM_CVALUE:5}}:{})};}
const build=ops=>constructGdf(createBlankGdf(),ops,resolve).buffer;
const fixture=()=>build([add('constant','constantDeclaration'),add('param','parameterDeclaration',512),add('lpm_constant','value',896),{operation:'add_wire',x1:0,y1:0,x2:64,y2:0,nodeName:'OTHER'}]);
function untouched(before,after,offsets){const old=tokeniseGdfGeometry(before),next=tokeniseGdfGeometry(after);assert.equal(old.length,next.length);for(let i=0;i<old.length;i++)if(!offsets.has(old[i].offset))assert.deepEqual(next[i].body,old[i].body);}

test('original CONSTANT and PARAM prototypes use h attributes rather than u assignment blocks',()=>{
  for(const [kind,codes,name,value] of [['constant',[51,52],'CONSTANT_NAME','CONSTANT_VALUE'],['param',[53,54],'PARAMETER_NAME','<none>']]){
    const file=path.join(root,'max2lib/prim',kind+'.sym'),bytes=fs.readFileSync(file),hash=sha256(bytes),prototype=readSymbolPrototype(bytes),summary=legacyGdfDeclarationSummary({offset:null,symbolName:prototype.symbolName,attributes:prototype.parsed.sheet.attributes});
    assert.equal(summary.writable,true);assert.equal(summary.name,name);assert.equal(summary.value,value);assert.equal(summary.format,'native-h-declaration-pair');
    assert.deepEqual(prototype.defaults.filter(t=>codes.includes(t.attrType)).map(t=>[t.nativeType,t.attrType]),codes.map(c=>[8,c]));assert.equal(prototype.parsed.sheet.pins.length,0);assert.equal(sha256(fs.readFileSync(file)),hash);
  }
});

test('editing two real declarations preserves geometry, IDs, aliases, wires and unrelated modern parameter bytes',()=>{
  const bytes=fixture(),old=readGdfLegacyDeclarations(bytes),before=parseGdfGeometry(bytes),changed=new Set(old.flatMap(p=>[p.nameRecordOffset,p.valueRecordOffset]));
  const result=editGdfLegacyDeclarations(bytes,[{recordOffset:old[0].recordOffset,name:'SOURCE_C',value:5},{recordOffset:old[1].recordOffset,name:'BUS_WIDTH',value:4}]),p=parseGdfGeometry(result.buffer);
  assert.deepEqual(readGdfLegacyDeclarations(result.buffer).map(d=>[d.declarationKind,d.name,d.value]),[['constant','SOURCE_C','5'],['parameter-default','BUS_WIDTH','4']]);
  untouched(bytes,result.buffer,changed);assert.deepEqual(result.counts.before,result.counts.after);
  assert.deepEqual(p.placements.map(p=>[p.netIdText,p.instanceName,p.instanceNameSource,p.position]),before.placements.map(p=>[p.netIdText,p.instanceName,p.instanceNameSource,p.position]));
  assert.deepEqual(p.sheet.wires.map(w=>[w.start,w.end,w.annotations.map(a=>a.text)]),before.sheet.wires.map(w=>[w.start,w.end,w.annotations.map(a=>a.text)]));
});

test('declaration label replacement preserves original font metrics, flags and every unrelated token',()=>{
  const bytes=fixture(),summary=readGdfLegacyDeclarations(bytes)[0],tokens=tokeniseGdfGeometry(bytes);
  const styled=Buffer.concat(tokens.map(t=>{
    if(t.offset!==summary.nameRecordOffset)return t.body;
    const head=Buffer.from(t.body.subarray(0,9));head[2]=4;head.writeUInt16LE(0xa871,7);return Buffer.concat([head,gdfString('Times New Roman'),Buffer.from([40,0,16,0]),t.body.subarray(t.textRecord.offset-t.offset)]);
  })),old=readGdfLegacyDeclarations(styled)[0],result=editGdfLegacyDeclarations(styled,[{recordOffset:old.recordOffset,name:'LONGER_CONSTANT_NAME',value:'2^4-1'}]);
  untouched(styled,result.buffer,new Set([old.nameRecordOffset,old.valueRecordOffset]));
  const prior=parseGdfGeometry(styled).placements[0].attributes.find(a=>a.kindCode===51),next=parseGdfGeometry(result.buffer).placements[0].attributes.find(a=>a.kindCode===51);
  assert.deepEqual(next.font,prior.font);assert.deepEqual(next.metrics,prior.metrics);assert.equal(next.rawFlags,prior.rawFlags);assert.equal(next.text,'LONGER_CONSTANT_NAME');
});

test('same values produce identical bytes and new source expressions stay opaque',()=>{
  const bytes=fixture(),first=readGdfLegacyDeclarations(bytes)[0],result=editGdfLegacyDeclarations(bytes,[{recordOffset:first.recordOffset,name:'SOURCE_C',value:'OTHER_C + 1'}]).buffer,next=readGdfLegacyDeclarations(result)[0];
  assert.equal(next.value,'OTHER_C + 1');assert.deepEqual(editGdfLegacyDeclarations(result,[{recordOffset:next.recordOffset,name:next.name,value:next.value}]).buffer,result);
});

test('missing, duplicated, alternate, mixed u or mismatched declaration forms refuse edits transactionally',()=>{
  const bytes=fixture(),summary=readGdfLegacyDeclarations(bytes)[0],tokens=tokeniseGdfGeometry(bytes),name=tokens.find(t=>t.offset===summary.nameRecordOffset),value=tokens.find(t=>t.offset===summary.valueRecordOffset);
  const variants=[
    Buffer.concat(tokens.filter(t=>t.offset!==value.offset).map(t=>t.body)),
    Buffer.concat(tokens.flatMap(t=>t.offset===name.offset?[t.body,t.body]:[t.body])),
    Buffer.concat(tokens.map(t=>t.offset===name.offset?Buffer.concat([t.body,gdfString('UNCHECKED_ALTERNATIVE')]):t.body)),
    Buffer.concat(tokens.map(t=>{if(t.offset!==value.offset)return t.body;const body=Buffer.from(t.body);body[1]=54;return body;})),
    Buffer.concat(tokens.flatMap(t=>t.offset===tokens.find(t=>t.opcode==='g'&&t.offset>value.offset).offset?[Buffer.from('u'),Buffer.concat([replaceGdfLabel(name,'WIDTH'),Buffer.from([0,0])]),t.body]:[t.body])),
  ];
  for(const variant of variants){const before=Buffer.from(variant),d=readGdfLegacyDeclarations(variant)[0];assert.equal(d.writable,false);assert.throws(()=>editGdfLegacyDeclarations(variant,[{recordOffset:d.recordOffset,name:'SOURCE_C',value:1}]),/unambiguous/);assert.deepEqual(variant,before);}
});

test('ordinary logic legacy u/53/54 is recognized as unsupported rather than interpreted as a declaration',()=>{
  const bytes=build([add('not','gate')]),q=(kind,text)=>{const head=Buffer.alloc(9);head[0]=0x71;head[1]=kind;return Buffer.concat([head,gdfString(text),Buffer.from([0,0])]);},legacy=Buffer.concat([bytes.subarray(0,-1),Buffer.from('u'),q(53,'WIDTH'),q(54,'4'),bytes.subarray(-1)]),d=readGdfLegacyDeclarations(legacy)[0];
  assert.equal(d.writable,false);assert.equal(d.declarationKind,null);assert.equal(d.symbolName,'NOT');assert.throws(()=>editGdfLegacyDeclarations(legacy,[{recordOffset:d.recordOffset,name:'WIDTH',value:8}]),/u properties/);
});

test('invalid names, values, offsets, repeated edits and unsupported versions keep input bytes unchanged',()=>{
  const bytes=fixture(),d=readGdfLegacyDeclarations(bytes)[0],valid={recordOffset:d.recordOffset,name:'SOURCE_C',value:5};
  for(const edit of [{...valid,name:'bad-name'},{...valid,name:'N'.repeat(129)},{...valid,value:''},{...valid,value:'5\nOTHER=1'},{...valid,value:'中文'},{...valid,value:'5'.repeat(257)},{...valid,value:Infinity},{...valid,value:true},{...valid,recordOffset:0},{...valid,extra:1}]){
    assert.throws(()=>editGdfLegacyDeclarations(bytes,[edit]));assert.deepEqual(bytes,fixture());
  }
  assert.throws(()=>editGdfLegacyDeclarations(bytes,[valid,valid]),/only once/);assert.throws(()=>editGdfLegacyDeclarations(bytes,[valid,{...valid,recordOffset:readGdfLegacyDeclarations(bytes)[1].recordOffset,value:''}]));
  const old=Buffer.from(bytes);old.writeUInt16LE(5,6);assert.throws(()=>editGdfLegacyDeclarations(old,[valid]),/version 6/);assert.throws(()=>editGdfLegacyDeclarations(bytes,[]));
});
