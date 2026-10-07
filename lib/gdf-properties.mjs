/** Modern GDF instance property blocks. Assignment values are source expressions,
 * never executed or evaluated here; the original compiler validates semantics. */
export const MAX_GDF_TEXT_BYTES=2047; // Native reader uses fixed 2048-byte buffers.
export const MCP_INSTANCE_NAME_PREFIX='@mcp-instance-name:';
export function gdfString(value,{multiline=false}={}){
  if(typeof value!=='string'||value.length>MAX_GDF_TEXT_BYTES||/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u0100-\uffff]/u.test(value)||(!multiline&&value.includes('\n')))throw new Error(`GDF text must be at most ${MAX_GDF_TEXT_BYTES} printable Latin-1 bytes${multiline?' with LF separators':''}`);
  const b=Buffer.from(value,'latin1'),head=Buffer.alloc(3);head[0]=0x76;head.writeUInt16LE(b.length,1);return Buffer.concat([head,b,Buffer.from([0])]);
}
export function formatParameters(parameters){
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw new Error('parameters must be a complete assignment object');
  const keys=Object.keys(parameters);if(!keys.length||keys.length>100)throw new Error('parameters must contain 1 through 100 assignments');
  const seen=new Set(),entries=[];
  for(const key of keys){const name=key.toUpperCase();if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)||['__PROTO__','CONSTRUCTOR','PROTOTYPE'].includes(name)||seen.has(name))throw new Error('parameter names must be unique identifiers (case-insensitive)');seen.add(name);
    const v=parameters[key];if(typeof v!=='string'&&!Number.isSafeInteger(v))throw new Error('parameter value must be a source expression string or safe integer');
    const value=String(v).trim();if(!value||value.length>256||/[\r\n]/.test(value))throw new Error('parameter values must be nonempty single-line expressions up to 256 bytes');gdfString(value);entries.push({name,value});}
  entries.sort((a,b)=>a.name.localeCompare(b.name));const text=entries.map(p=>`${p.name}=${p.value}`).join('\n');gdfString(text,{multiline:true});return {text,entries};
}
function assignments(text){
  const entries=[],seen=new Set();for(const line of text.split(/\r?\n/).filter(s=>s.trim())){const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);if(!m||seen.has(m[1].toUpperCase()))return null;seen.add(m[1].toUpperCase());entries.push({name:m[1],value:m[2]});}return entries;
}
export function parameterSummary(attributes){
  const records=attributes.filter(t=>t.nativeType===10),supported=records.length===0||(records.length===1&&[50,55].includes(records[0].kindCode??records[0].attrType)&&!records[0].alternative&&assignments(records[0].text)!==null);
  return {format:supported?'modern-assignment-block':'unsupported-legacy-or-ambiguous',writable:supported,recordOffsets:records.map(t=>t.offset),entries:supported&&records.length?assignments(records[0].text):[],note:'Values are original source expressions. set_parameters replaces the complete assignment map; the original compiler validates types, ranges and dependencies.'};
}
export function parameterTemplate(attributes){
  const entries=attributes.filter(a=>(a.kindCode??a.attrType)===50&&a.nativeType===7).flatMap(a=>assignments(a.text)??[]);
  return {entries,note:'Symbol-declared property template only; blank values require explicit assignments. Compiler-side defaults/dependencies are not inferred.'};
}
export function replaceGdfLabel(token,value,options){
  const r=token.textRecord;if(!r)throw new Error('attribute lacks decoded text');return Buffer.concat([token.body.subarray(0,r.offset-token.offset),gdfString(value,options),token.body.subarray(r.end-token.offset)]);
}
function propertyToken(parameters){
  const formatted=formatParameters(parameters),head=Buffer.alloc(13);head[0]=0x71;head[1]=55;head.writeUInt16LE(0x61,7);
  const lines=formatted.text.split('\n');head.writeInt16LE((Math.max(...lines.map(s=>s.length))*4+10)&~7,9);head.writeInt16LE(lines.length*8,11);
  return {opcode:'q',nativeType:10,attrType:55,text:formatted.text,body:Buffer.concat([head,gdfString(formatted.text,{multiline:true}),Buffer.from([0,0])])};
}
export function writeParameterTokens(tokens,parameters){
  const attrs=tokens.filter(t=>t.opcode==='q'&&t.nativeType===10),summary=parameterSummary(attrs);if(!summary.writable)throw new Error('Parameter editing requires one unambiguous modern assignment block; legacy property records are preserved');
  const result=tokens.filter(t=>t.opcode!=='u'&&t.nativeType!==10),next=parameters===undefined?null:propertyToken(parameters);
  if(next){if(attrs.length){next.body=replaceGdfLabel(attrs[0],next.text,{multiline:true});next.attrType=attrs[0].attrType;}result.push({opcode:'u',body:Buffer.from('u')},next);}return result;
}
