import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {createSymbol} from '../lib/gdf-symbol-editor.mjs';
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from '../lib/gdf-geometry.mjs';
import {encodeGdfText,decodeGdfText,encodeGdfString,inspectGdfTextToken,inspectGdfTextFormats,replaceGdfTextToken,editGdfTextFormats,GDF_FONT_EVIDENCE} from '../lib/gdf-text-format.mjs';

function annotated(text='Note',options={}) {
  return editGdfTextFormats(createBlankGdf(),[{operation:'add_text',text,x:80,y:160,...options}]).buffer;
}
function doc(buffer){return tokeniseGdfGeometry(buffer).find(t=>t.opcode==='q'&&t.attrType===0&&t.nativeType===7);}
function edit(buffer,operation){return editGdfTextFormats(buffer,[{recordOffset:doc(buffer).offset,...operation}]).buffer;}
test('Windows-936 encodes Chinese and Euro exactly; no WHATWG substitutions',()=>{
  const bytes=encodeGdfText('中文原理图 €',{encoding:'windows-936'});
  assert.equal(bytes.toString('hex'),'d6d0cec4d4adc0edcdbc2080');assert.equal(decodeGdfText(bytes,{encoding:'windows-936'}),'中文原理图 €');
  assert.equal(decodeGdfText(Buffer.from('a2e3a3a0','hex'),{encoding:'windows-936'}),'\ue76c\ue5e5');
  assert.equal(encodeGdfText('\ue76c\ue5e5',{encoding:'windows-936'}).toString('hex'),'a2e3a3a0');
  assert.throws(()=>decodeGdfText(Buffer.from('ff','hex'),{encoding:'windows-936'}),/Invalid/);
  assert.throws(()=>encodeGdfText('\uf8f5',{encoding:'windows-936'}),/represented exactly/);
});
test('selected encoding never guesses UTF-8 or changes raw Latin-1 decoding',()=>{
  const bytes=Buffer.from('d6d0cec4','hex');assert.equal(decodeGdfText(bytes),'ÖÐÎÄ');
  assert.throws(()=>encodeGdfText('中文'),/Latin-1/);assert.throws(()=>decodeGdfText(bytes,{encoding:'gbk'}),/encoding/);
  assert.throws(()=>encodeGdfText('🙂',{encoding:'windows-936'}),/represented exactly/);
});
test('strict invalid sequence and controls reject instead of replacement',()=>{
  for(const hex of ['81','8130','817f','feff','ff'])assert.throws(()=>decodeGdfText(Buffer.from(hex,'hex'),{encoding:'windows-936'}),/Windows-936/);
  for(const value of ['a\0b','a\rb','a\tb','\u0080','\ud800','a\nb'])assert.throws(()=>encodeGdfText(value,{encoding:'windows-936'}));
  assert.equal(decodeGdfText(encodeGdfText('中\n文',{encoding:'windows-936',multiline:true}),{encoding:'windows-936'}),'中\n文');
});
test('limit counts encoded bytes and retains legacy framing',()=>{
  assert.equal(encodeGdfText('中'.repeat(1023),{encoding:'windows-936'}).length,2046);
  assert.throws(()=>encodeGdfText('中'.repeat(1024),{encoding:'windows-936'}),/2047/);
  assert.equal(encodeGdfString('中'.repeat(127),{encoding:'windows-936',framing:'s'})[1],254);
  assert.throws(()=>encodeGdfString('中'.repeat(128),{encoding:'windows-936',framing:'s'}),/255/);
});
test('add a custom font and Simplified Chinese DOC in one transaction',()=>{
  const b=annotated('中文原理图',{encoding:'windows-936',fontSpecification:'宋体,18',width:150,height:28}),a=inspectGdfTextFormats(b,{encoding:'windows-936'}).attributes[0];
  assert.equal(a.fontCode,4);assert.equal(a.fontSpecification.value,'宋体,18');assert.equal(a.text.value,'中文原理图');
  assert.deepEqual(a.metrics,{width:150,height:28});assert.deepEqual(a.position,{x:80,y:160});assert.equal(a.rawFlags,0x61);
  assert.throws(()=>annotated('中文',{encoding:'windows-936'}),/Windows font/);
});
test('font change keeps main/alternative strings and unknown flags byte exact',()=>{
  const b=annotated(),t=doc(b),prefix=Buffer.from(t.body.subarray(0,9));prefix.writeUInt16LE(0xfea9,7);
  const alternative=Buffer.concat([Buffer.from([0x73,3]),Buffer.from('ALT\0','ascii')]);
  const tokens=tokeniseGdfGeometry(b),target=tokens.find(x=>x.offset===t.offset);target.body=Buffer.concat([prefix,encodeGdfString('Note'),alternative]);
  const original=rebuildGdfGeometry(tokens),changed=edit(original,{operation:'set_font',fontSpecification:'Arial,18',width:45,height:25}),next=doc(changed);
  assert.equal(next.font,'Arial,18');assert.deepEqual(next.metrics,[45,25]);assert.equal(next.flags,0xfea9);assert.equal(next.text,'Note');assert.equal(next.alternative,'ALT');
  assert.deepEqual(next.body.subarray(next.alternativeRecord.offset-next.offset),alternative);
  const restored=edit(changed,{operation:'set_font',fontCode:0});assert.deepEqual(restored,original);
});
test('repeated edits use original offsets and never mutate the source',()=>{
  const b=annotated(),copy=Buffer.from(b),offset=doc(b).offset;
  const result=editGdfTextFormats(b,[{operation:'set_font',recordOffset:offset,fontSpecification:'Arial,18',width:40,height:25},
    {operation:'set_text',recordOffset:offset,text:'中文',encoding:'windows-936',width:48,height:25},
    {operation:'set_metrics',recordOffset:offset,width:64,height:30}]);
  assert.deepEqual(b,copy);assert.equal(result.changes.length,3);assert.equal(result.changes[2].resultingRecordOffset,offset);
  const a=inspectGdfTextFormats(result.buffer,{encoding:'windows-936'}).attributes[0];assert.equal(a.text.value,'中文');assert.deepEqual(a.metrics,{width:64,height:30});
});
test('all four original bitmap fonts preserve text and reject invented custom metrics',()=>{
  const b=annotated();for(let code=0;code<4;code++){const a=doc(edit(b,{operation:'set_font',fontCode:code}));assert.equal(a.fontCode,code);assert.equal(a.text,'Note');assert.equal(a.metrics,undefined);}
  assert.throws(()=>edit(b,{operation:'set_font',fontCode:4}),/0 through 3/);
  assert.throws(()=>edit(b,{operation:'set_metrics',width:100,height:25}),/Built-in DOC/);
});
test('custom fonts require explicit glyph measurements and bounded font bytes',()=>{
  const b=annotated();assert.throws(()=>edit(b,{operation:'set_font',fontSpecification:'Arial,18'}),/width and height/);
  assert.throws(()=>edit(b,{operation:'set_font',fontSpecification:'a'.repeat(64),width:20,height:20}),/63/);
  assert.throws(()=>edit(b,{operation:'set_font',fontSpecification:'宋'.repeat(32),encoding:'windows-936',width:20,height:20}),/63/);
  const custom=edit(b,{operation:'set_font',fontSpecification:'Arial,18',width:40,height:25});
  assert.throws(()=>edit(custom,{operation:'set_text',text:'New'}),/glyph bounds/);
  assert.throws(()=>edit(custom,{operation:'set_metrics',width:32768,height:25}),/32767/);
  assert.throws(()=>edit(custom,{operation:'set_font',fontCode:1,fontSpecification:'Arial,18',width:40,height:25}),/not both/);
});
test('legacy s text framing stays s across CP936 replacement and bounded overflow',()=>{
  const b=annotated('Start',{fontSpecification:'Arial,18',width:40,height:25}),tokens=tokeniseGdfGeometry(b),t=tokens.find(x=>x.opcode==='q');
  t.body=Buffer.concat([t.body.subarray(0,t.textRecord.offset-t.offset),encodeGdfString('Start',{framing:'s'})]);
  const legacy=rebuildGdfGeometry(tokens),changed=edit(legacy,{operation:'set_text',text:'中文',encoding:'windows-936',width:48,height:25});
  assert.equal(doc(changed).textRecord.lengthType,'u8');assert.throws(()=>edit(legacy,{operation:'set_text',text:'中'.repeat(128),encoding:'windows-936',width:3000,height:25}),/255/);
});
test('standalone SYM DOC edits preserve name, pins and defaults',()=>{
  const sym=createSymbol({name:'CUSTOM',pins:[{name:'A',attributeName:'ISTUB',x:0,y:8,labelX:8,labelY:8}],texts:[{text:'Documentation',x:24,y:48}]}).buffer;
  const before=tokeniseGdfGeometry(sym),target=doc(sym),result=editGdfTextFormats(sym,[{operation:'set_font',recordOffset:target.offset,fontSpecification:'Arial,12',width:100,height:18}]).buffer;
  const after=tokeniseGdfGeometry(result);assert.equal(before.length,after.length);
  for(let i=0;i<before.length;i++)if(before[i].offset!==target.offset)assert.deepEqual(after[i].body,before[i].body);
  assert.equal(parseGdfGeometry(result).sheet.pins[0].name,'A');assert.equal(parseGdfGeometry(result).sheet.attributes.find(a=>a.kindCode===19).text,'CUSTOM');
});
test('electrical names, pin DOCs, instance aliases and shared definitions are excluded',()=>{
  const labelled=constructGdf(createBlankGdf(),[{operation:'add_wire',x1:0,y1:0,x2:80,y2:0,nodeName:'NET'}]).buffer;
  const net=parseGdfGeometry(labelled).sheet.primitives[0].annotations[0];assert.throws(()=>editGdfTextFormats(labelled,[{operation:'set_font',recordOffset:net.offset,fontCode:1}]),/free root q DOC/);
  const sym=createSymbol({name:'CUSTOM',texts:[{text:'Shared',x:0,y:0}]}).buffer,sha=createHash('sha256').update(sym).digest('hex');
  const gdf=constructGdf(createBlankGdf(),[{operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:sha,name:'instance',x:80,y:80}],()=>({path:'custom.sym',bytes:sym})).buffer;
  const parsed=parseGdfGeometry(gdf);for(const a of [...parsed.definitions[0].attributes,...parsed.placements[0].attributes].filter(a=>a.kindCode===0))assert.throws(()=>editGdfTextFormats(gdf,[{operation:'set_font',recordOffset:a.offset,fontCode:1}]),/free root q DOC/);
});
test('invalid later operation is atomic and unknown fields are not silently ignored',()=>{
  const b=annotated(),copy=Buffer.from(b),offset=doc(b).offset;
  assert.throws(()=>editGdfTextFormats(b,[{operation:'set_font',recordOffset:offset,fontCode:1},{operation:'set_metrics',recordOffset:offset,width:4,height:0}]));
  assert.deepEqual(b,copy);assert.throws(()=>edit(b,{operation:'set_font',fontCode:1,ignored:true}),/Unexpected/);
  assert.throws(()=>editGdfTextFormats(b,[{operation:'set_text',recordOffset:offset,text:'New',width:10}]),/supplied together/);
});
test('low-level q replacement preserves native parameter offset and alternative tail',()=>{
  const prefix=Buffer.alloc(9);prefix[0]=0x71;prefix[1]=55;prefix[2]=4;
  const metrics=Buffer.from('50002000','hex'),alternative=encodeGdfString('ALT',{framing:'s'}),tail=Buffer.from('3412','hex');
  const token={opcode:'q',nativeType:10,offset:0,body:Buffer.concat([prefix,encodeGdfString('Arial,8'),metrics,encodeGdfString('A=1'),alternative,tail])};
  const changed=replaceGdfTextToken(token,{fontSpecification:'Arial,12',width:70,height:24});
  assert.deepEqual(changed.subarray(-alternative.length-tail.length),Buffer.concat([alternative,tail]));
  assert.equal(inspectGdfTextToken({...token,body:changed}).text.value,'A=1');
});
test('all vendor custom-font records retain exact string framing and nontext bytes',t=>{
  const root=process.env.MAXPLUS2_ROOT??'C:/maxplus2',library=path.join(root,'max2lib');if(!fs.existsSync(library)){t.skip('MAX+plus II vendor library unavailable');return;}
  let files=0,custom=0;function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(/\.(gdf|sym)$/i.test(file)){
    const bytes=fs.readFileSync(file),tokens=tokeniseGdfGeometry(bytes);assert.deepEqual(rebuildGdfGeometry(tokens),bytes);files++;
    for(const t of tokens.filter(t=>t.opcode==='q'&&t.fontCode>=4)){custom++;assert.deepEqual(replaceGdfTextToken(t,{}),t.body);}
  }}}walk(library);assert.ok(files>=500);assert.ok(custom>1000);console.log(`Native font corpus: ${files} files, ${custom} custom-font q records byte exact`);
});
test('Windows/.NET CP936 full single/double-byte decoder oracle',t=>{
  if(process.platform!=='win32'){t.skip('Windows code-page oracle requires Windows');return;}
  const pwsh=process.env.MAXPLUS2_TEST_PWSH??'pwsh.exe';
  try{assert.match(execFileSync(pwsh,['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8',windowsHide:true}).trim(),/^7\./);}
  catch(error){if(error.code==='ENOENT'){t.skip('PowerShell 7 unavailable');return;}throw error;}
  const script="$codec=[System.Text.Encoding]::GetEncoding(936,[System.Text.EncoderExceptionFallback]::new(),[System.Text.DecoderExceptionFallback]::new()); $table=[byte[]]::new(131072); [Array]::Fill[byte]($table,255); for($i=0;$i -lt 256;$i++){try{$s=$codec.GetString([byte[]]@($i));if($s.Length -eq 1){$table[$i*2]=[byte]([int]$s[0] -band 255);$table[$i*2+1]=[byte]([int]$s[0] -shr 8)}}catch{}}; for($lead=129;$lead -le 254;$lead++){for($trail=64;$trail -le 254;$trail++){if($trail -eq 127){continue};try{$s=$codec.GetString([byte[]]@($lead,$trail));if($s.Length -eq 1){$i=($lead -shl 8)+$trail;$table[$i*2]=[byte]([int]$s[0] -band 255);$table[$i*2+1]=[byte]([int]$s[0] -shr 8)}}catch{}}}; [Convert]::ToBase64String($table)";
  const native=Buffer.from(execFileSync(pwsh,['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',maxBuffer:1024*1024,windowsHide:true}).trim(),'base64');
  assert.equal(createHash('sha256').update(native).digest('hex'),'870b0e10027778244b3b7095d4715cbd3e3570bddb7bc5350884e5c1731f451a');let mappings=0;
  for(let code=0;code<65536;code++) {
    if(code>=256&&((code>>>8)<129||(code>>>8)>254||(code&255)<64||(code&255)>254||(code&255)===127))continue;
    const cp=code===255?65535:native.readUInt16LE(2*code),bytes=Buffer.from(code<256?[code]:[code>>>8,code&255]);
    if(cp===65535)assert.throws(()=>decodeGdfText(bytes,{encoding:'windows-936'}));
    else {mappings++;const text=decodeGdfText(bytes,{encoding:'windows-936'});assert.equal(text,String.fromCharCode(cp));if(cp>=32&&!(cp>=127&&cp<=159))assert.equal(decodeGdfText(encodeGdfText(text,{encoding:'windows-936'}),{encoding:'windows-936'}),text);}
  }
  assert.equal(mappings,24069);console.log(`Windows/.NET CP936 oracle: ${mappings} mappings and every invalid sequence checked; only FF differs from strict Win32`);
});
test('Win32 MultiByteToWideChar strict CP936 table is the exact bundled oracle',t=>{
  if(process.platform!=='win32'){t.skip('Win32 code-page oracle requires Windows');return;}
  const pwsh=process.env.MAXPLUS2_TEST_PWSH??'pwsh.exe';
  const cs='using System;using System.Runtime.InteropServices;public static class MaxplusCp936OracleUtf16{[DllImport("kernel32.dll",SetLastError=true,ExactSpelling=true)]private static extern int MultiByteToWideChar(uint cp,uint flags,byte[] input,int size,[Out]ushort[] output,int outputSize);public static byte[] Table(){byte[] table=new byte[131072];for(int i=0;i<table.Length;i++)table[i]=255;ushort[] chars=new ushort[2];for(int code=0;code<65536;code++){if(code>=256&&((code>>8)<129||(code>>8)>254||(code&255)<64||(code&255)>254||(code&255)==127))continue;byte[] bytes=code<256?new byte[]{(byte)code}:new byte[]{(byte)(code>>8),(byte)code};int count=MultiByteToWideChar(936,8,bytes,bytes.Length,chars,2);if(count==1){table[code*2]=(byte)chars[0];table[code*2+1]=(byte)(chars[0]>>8);}}return table;}}';
  const script="Add-Type -TypeDefinition @'\n"+cs+"\n'@; [Convert]::ToBase64String([MaxplusCp936OracleUtf16]::Table())";
  let output;try{output=execFileSync(pwsh,['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',maxBuffer:1024*1024,windowsHide:true});}
  catch(error){if(error.code==='ENOENT'){t.skip('PowerShell 7 unavailable');return;}throw error;}
  const native=Buffer.from(output.trim(),'base64');assert.equal(native.length,131072);assert.equal(createHash('sha256').update(native).digest('hex'),GDF_FONT_EVIDENCE.cp936TableSha256);
  let mappings=0;for(let code=0;code<65536;code++){const cp=native.readUInt16LE(code*2);if(cp===65535)continue;mappings++;assert.equal(decodeGdfText(Buffer.from(code<256?[code]:[code>>>8,code&255]),{encoding:'windows-936'}),String.fromCharCode(cp));}
  assert.equal(mappings,24069);console.log('Strict Win32 CP936 oracle: 24069 exact mappings, hash verified');
});
