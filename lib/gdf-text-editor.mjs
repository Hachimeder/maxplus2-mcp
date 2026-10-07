/** Root GDF DOC text editing, based on the same native q fields as SYM editing.
 * Names, pins, line-owned NODE_NAME and h/u defaults are outside this scope. */
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from './gdf-geometry.mjs';
import {gdfString,MAX_GDF_TEXT_BYTES} from './gdf-properties.mjs';

const DISPLAY_FIELDS=['editable','color','visible','zoom','orientation'];
const FIELDS={
  add_text:['operation','text','x','y',...DISPLAY_FIELDS],
  set_text:['operation','recordOffset','text'],
  set_text_position:['operation','recordOffset','x','y'],
  set_text_display:['operation','recordOffset',...DISPLAY_FIELDS],
  delete_text:['operation','recordOffset'],
};
function integer(value,name,min=-32768,max=32767) {
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return value;
}
function check(op) {
  if(!op||typeof op!=='object'||Array.isArray(op)||!Object.hasOwn(FIELDS,op.operation))throw new Error('Unsupported root DOC text operation');
  for(const key of Object.keys(op))if(!FIELDS[op.operation].includes(key))throw new Error(`Unexpected ${key} for ${op.operation}`);
  const required=op.operation==='add_text'?['text','x','y']:op.operation==='set_text'?['recordOffset','text']:op.operation==='set_text_position'?['recordOffset','x','y']:['recordOffset'];
  for(const key of required)if(!Object.hasOwn(op,key))throw new Error(`Missing ${key} for ${op.operation}`);
  if(op.operation!=='add_text')integer(op.recordOffset,'recordOffset',0,16777216);
}
function text(value) {gdfString(value);return value;}
function flagsFor(op,flags) {
  for(const [name,mask] of Object.entries({editable:1,visible:32,zoom:64})) {
    if(op[name]!==undefined){if(typeof op[name]!=='boolean')throw new Error(`${name} must be boolean`);flags=op[name]?flags|mask:flags&~mask;}
  }
  if(op.color!==undefined)flags=(flags&~0x1e)|(integer(op.color,'color',0,15)<<1);
  if(op.orientation!==undefined)flags=(flags&~0x380)|(integer(op.orientation,'orientation',0,7)<<7);
  return flags;
}
function display(flags) {return {editable:!!(flags&1),color:(flags>>>1)&15,visible:!!(flags&32),zoom:!!(flags&64),orientation:(flags>>>7)&7};}
function summary(token) {return {text:token.text,position:{x:token.body.readInt16LE(3),y:token.body.readInt16LE(5)},rawFlags:token.body.readUInt16LE(7),display:display(token.body.readUInt16LE(7))};}
function encodeText(op) {
  const prefix=Buffer.alloc(9);prefix[0]=0x71;prefix.writeInt16LE(integer(op.x,'x'),3);prefix.writeInt16LE(integer(op.y,'y'),5);prefix.writeUInt16LE(flagsFor(op,0x61),7);
  return {opcode:'q',nativeType:7,attrType:0,text:text(op.text),body:Buffer.concat([prefix,gdfString(op.text)]),added:true};
}
function replaceText(token,value) {
  text(value);const r=token.textRecord;
  if(r.lengthType==='u8'&&value.length>255)throw new Error('Legacy s DOC text must remain at most 255 bytes');
  const prefix=Buffer.from(token.body.subarray(0,r.payloadOffset-token.offset));
  if(r.lengthType==='u8')prefix.writeUInt8(value.length,r.lengthOffset-token.offset);
  else if(r.lengthType==='u16')prefix.writeUInt16LE(value.length,r.lengthOffset-token.offset);
  else throw new Error('Unsupported root DOC string framing');
  const oldLength=r.length;
  token.body=Buffer.concat([prefix,Buffer.from(value,'latin1'),token.body.subarray(r.payloadOffset+oldLength-token.offset)]);
  token.text=value;token.textRecord={...r,length:value.length,end:r.end+value.length-oldLength};
}

/** All recordOffset values identify ORIGINAL input records, including repeat edits
 * to one DOC. No input bytes or filesystem state are changed by this transaction. */
export function editDrawingText(buffer,operations) {
  const before=parseGdfGeometry(buffer);
  if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Root DOC text authoring requires GDF version 6');
  if(!Array.isArray(operations)||!operations.length||operations.length>200)throw new Error('operations must contain 1 through 200 changes');
  const tokens=tokeniseGdfGeometry(buffer),end=tokens.findIndex(t=>['g','t'].includes(t.opcode));
  if(end<0||!rebuildGdfGeometry(tokens).equals(buffer))throw new Error('GDF text edit requires complete lossless token framing');
  const root=tokens.slice(1,end).map(t=>({...t,body:Buffer.from(t.body),textRecord:t.textRecord?{...t.textRecord}:undefined}));
  const pins=new Set(before.sheet.pins.map(p=>p.attributeId));
  const annotations=new Set(before.sheet.attributes.filter(a=>a.kindCode===0&&a.nativeType===7&&a.scope==='graphical-attribute'&&!a.ownerId&&!pins.has(a.id)).map(a=>a.offset));
  const targets=new Map(root.filter(t=>t.opcode==='q'&&t.attrType===0&&t.nativeType===7&&annotations.has(t.offset)).map(t=>[t.offset,t]));
  const removed=new Set(),changes=[],changeTokens=[];
  for(const op of operations) {
    check(op);let token;
    if(op.operation==='add_text') {
      token=encodeText(op);root.push(token);changes.push({operation:op.operation,target:'free-root-DOC',before:null,after:summary(token)});changeTokens.push(token);continue;
    }
    token=targets.get(op.recordOffset);
    if(!token||removed.has(token))throw new Error('recordOffset must identify an undeleted free root q DOC; names, pins, instances and line-owned text are excluded');
    const prior=summary(token);
    if(op.operation==='set_text')replaceText(token,op.text);
    else if(op.operation==='set_text_position'){const x=integer(op.x,'x'),y=integer(op.y,'y');token.body.writeInt16LE(x,3);token.body.writeInt16LE(y,5);}
    else if(op.operation==='set_text_display') {
      if(!DISPLAY_FIELDS.some(key=>op[key]!==undefined))throw new Error('set_text_display requires at least one display field');
      token.body.writeUInt16LE(flagsFor(op,token.body.readUInt16LE(7)),7);
    }else removed.add(token);
    changes.push({operation:op.operation,recordOffset:op.recordOffset,target:'free-root-DOC',before:prior,after:removed.has(token)?null:summary(token)});changeTokens.push(token);
  }
  const planned=[tokens[0],...root.filter(t=>!removed.has(t)),...tokens.slice(end)],result=rebuildGdfGeometry(planned);
  const after=parseGdfGeometry(result),actual=tokeniseGdfGeometry(result);
  if(actual.length!==planned.length||actual.some((t,i)=>t.opcode!==planned[i].opcode||(t.opcode==='q'&&(t.nativeType!==planned[i].nativeType||t.attrType!==planned[i].attrType))))
    throw new Error('Text edit would reinterpret native record ownership or annotation framing');
  if(after.placements.length!==before.placements.length||after.definitions.length!==before.definitions.length||after.sheet.pins.length!==before.sheet.pins.length||after.sheet.primitives.length!==before.sheet.primitives.length)
    throw new Error('Root DOC edit changed electrical or primitive structure');
  const finalByToken=new Map(planned.map((t,i)=>[t,actual[i].offset]));
  changes.forEach((change,i)=>{change.resultingRecordOffset=removed.has(changeTokens[i])?null:finalByToken.get(changeTokens[i])??null;});
  return {buffer:result,changes,note:`Only free root q DOC text changed. Font, stored metrics, alternative strings, upper flag bits and all unselected records are preserved. Coordinates are signed editor units; y is positive upward. Display bits follow the original q reader/writer. Original recordOffset values address the input buffer; re-read offsets and SHA-256 before a later transaction. Text is bounded to ${MAX_GDF_TEXT_BYTES} printable Latin-1 bytes, and legacy s framing stays limited to 255 bytes. Original compiler acceptance establishes file validity; editor glyph layout still requires visual verification.`};
}
