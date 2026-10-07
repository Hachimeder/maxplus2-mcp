/** Standalone modern SYM editing. Offsets address the original input buffer.
 * Native framing/attribute provenance is exposed separately from compiler proof.
 * Defaults under h/u and unrelated graphical records retain their exact bytes.
 */
import {createHash} from 'node:crypto';
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from './gdf-geometry.mjs';
import {gdfString,MAX_GDF_TEXT_BYTES} from './gdf-properties.mjs';
import {inspectPinLabels} from './gdf-pin-labels.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const ATTRIBUTE_NAMES=['DOC','SYM_NAME','ISTUB','OSTUB','IOSTUB','PIN_NAME','NODE_NAME','PIN_DEFAULT','PIN_ASSIGN','TITLE','FIELD_TITLE','RESERVED_11','RESERVED_12','RESERVED_13','RESERVED_14','RESERVED_15','PART','TURBO_BIT','SECURITY_BIT','MACRO_NAME','DESIGN_NAME_VALUE','COMPANY','COMPANY_VALUE','DESIGNER','DESIGNER_VALUE','SHEET_SIZE','SHEET_SIZE_VALUE','EPLD','NUMBER','NUMBER_VALUE','REVISION','REVISION_VALUE','DATE','DATE_VALUE','SHEET_NUMBER','SHEET_NUMBER_VALUE','SHEET_OF','SHEET_OF_VALUE','TURBO','SECURITY','PROBE_NAME','NET_ID','CHIP_ASSIGN','CLIQUE','ATTRIB','TIMING','UNUSED_ISTUB','UNUSED_OSTUB','UNUSED_IOSTUB','BUBBLE','PROPERTY','CONST_NAME','CONST_VALUE','PARAM_NAME','PARAM_VALUE','NEW_PROP'];
const PIN_NAMES=new Set(['ISTUB','OSTUB','IOSTUB','UNUSED_ISTUB','UNUSED_OSTUB','UNUSED_IOSTUB']);
const PIN_CODES=new Set([2,3,4,46,47,48]);
const PHASE={k:2,l:3,m:4,n:5,o:6,q:7,p:7};
export const SYMBOL_ATTRIBUTE_SOURCE=Object.freeze({binary:'gedmain.dll',sha256:'0b4e1829b6898f78977d2328daad0d85a4377ed30110bae841b7c91de3bbb32c',tableVA:'0x10045104',uiEnumeratesIndexesVA:'0x10005d74',uiSelectsCurrentAttributeVA:'0x10005d97',evidence:'research/gdf-native-reader/attribute-names.json',readerPinVA:'gio.dll:0x1001899b',readerGraphicsVA:'gio.dll:0x10017140',readerDefaultsVA:'gio.dll:0x1001804d',defaultPinLookupVA:'gio.dll:0x1000e667',componentTypeVA:'gio.dll:0x1000b1c0'});
const FIELDS={
  rename_symbol:['operation','name','nameAttributeName'],set_extent:['operation','width','height'],
  translate:['operation','recordOffset','dx','dy'],
  set_line:['operation','recordOffset','x1','y1','x2','y2'],
  set_circle:['operation','recordOffset','x','y','radius'],
  set_arc:['operation','recordOffset','cx','cy','startX','startY','endX','endY','radius','startAngleDegrees','sweepAngleDegrees'],
  set_text:['operation','recordOffset','text'],set_text_position:['operation','recordOffset','x','y'],
  set_text_display:['operation','recordOffset','editable','color','visible','zoom','orientation'],
  set_graphic_style:['operation','recordOffset','startDot','endDot','style','thick','filled'],
  set_pin:['operation','recordOffset','name','x','y','labelX','labelY','attributeName'],
  add_pin:['operation','name','x','y','labelX','labelY','attributeName'],delete_pin:['operation','recordOffset'],
  add_line:['operation','x1','y1','x2','y2','startDot','endDot','style','thick'],
  add_circle:['operation','x','y','radius','filled'],
  add_arc:['operation','cx','cy','startX','startY','endX','endY','radius','startAngleDegrees','sweepAngleDegrees','startDot','endDot'],
  add_text:['operation','text','x','y'],delete_graphic:['operation','recordOffset'],
};
function int(v,n,min=-32768,max=32767){if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${n} must be an integer from ${min} through ${max}`);return v;}
function grid(v,n){int(v,n);if(v%8)throw new Error(`${n} must lie on the 8-unit pin grid`);return v;}
function printable(v,n,max=MAX_GDF_TEXT_BYTES){if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/u.test(v))throw new Error(`${n} must be bounded printable Latin-1`);return v;}
function symbolName(v){printable(v,'symbol name',128);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))throw new Error('New symbol name must be an HDL identifier');return v;}
function nameCode(v){if(!['SYM_NAME','MACRO_NAME'].includes(v))throw new Error('nameAttributeName must be SYM_NAME or MACRO_NAME');return ATTRIBUTE_NAMES.indexOf(v);}
function pinName(v){printable(v,'pin name',128);if(!v.trim())throw new Error('Pin name must be nonempty');return v;}
function pinCode(v){if(!PIN_NAMES.has(v))throw new Error('attributeName must be an original ISTUB/OSTUB/IOSTUB or UNUSED_* name');return ATTRIBUTE_NAMES.indexOf(v);}
function boolean(v,n){if(typeof v!=='boolean')throw new Error(`${n} must be boolean`);return v;}
function keys(v,allowed,label){if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(`${label} must be an object`);for(const k of Object.keys(v))if(!allowed.includes(k))throw new Error(`Unexpected ${k} for ${label}`);}
function fields(op){keys(op,FIELDS[op?.operation]??[],op?.operation??'operation');if(!FIELDS[op.operation])throw new Error('Unsupported SYM editing operation');if(FIELDS[op.operation].includes('recordOffset'))int(op.recordOffset,'recordOffset',0,16777216);}
function paired(op,a,b){if((op[a]===undefined)!==(op[b]===undefined))throw new Error(`${a} and ${b} must be supplied together`);return op[a]!==undefined;}
function label(token,value){
  const r=token.textRecord;if(!r)throw new Error('Missing native text record');printable(value,'text');
  if(r.lengthType==='u8'&&value.length>255)throw new Error('Legacy s text is limited to 255 bytes; its framing is preserved');
  const prefix=Buffer.from(token.body.subarray(0,r.payloadOffset-token.offset));
  if(r.lengthType==='u8')prefix.writeUInt8(value.length,r.lengthOffset-token.offset);else prefix.writeUInt16LE(value.length,r.lengthOffset-token.offset);
  return Buffer.concat([prefix,Buffer.from(value,'latin1'),token.body.subarray(r.payloadOffset+r.length-token.offset)]);
}
function textToken(type,text,x,y,flags=0x61,nativeType=7){const b=Buffer.alloc(9);b[0]=0x71;b[1]=type;b.writeInt16LE(int(x,'x'),3);b.writeInt16LE(int(y,'y'),5);b.writeUInt16LE(flags,7);return {opcode:'q',nativeType,attrType:type,body:Buffer.concat([b,gdfString(text)])};}
function pinToken(x,y){const b=Buffer.alloc(5);b[0]=0x70;b.writeInt16LE(grid(x,'x'),1);b.writeInt16LE(grid(y,'y'),3);return {opcode:'p',body:b};}
function lineToken(op){const v=['x1','y1','x2','y2'].map(k=>int(op[k],k));if(v[0]===v[2]&&v[1]===v[3])throw new Error('A graphic line cannot have zero length');const opcode=v[1]===v[3]?'k':v[0]===v[2]?'l':'m',b=Buffer.alloc(11);b[0]=opcode.charCodeAt(0);v.forEach((n,i)=>b.writeInt16LE(n,1+2*i));b.writeUInt16LE(styleFlags(op,'line',0),9);return {opcode,body:b};}
function circleToken(op){const b=Buffer.alloc(9);b[0]=0x6f;writeCircle(b,op);b.writeUInt16LE(styleFlags(op,'circle',0),7);return {opcode:'o',body:b};}
function writeCircle(b,op){b.writeInt16LE(int(op.x,'x'),1);b.writeInt16LE(int(op.y,'y'),3);b.writeUInt16LE(int(op.radius,'radius',1,65535),5);}
function arcToken(op){const b=Buffer.alloc(21);b[0]=0x6e;writeArc(b,op);b.writeUInt16LE(styleFlags(op,'arc',0),19);return {opcode:'n',body:b};}
function writeArc(b,op){['cx','cy','startX','startY','endX','endY'].forEach((k,i)=>b.writeInt16LE(int(op[k],k),1+2*i));['radius','startAngleDegrees','sweepAngleDegrees'].forEach((k,i)=>b.writeUInt16LE(int(op[k],k,k==='radius'?1:0,k==='radius'?65535:360),13+2*i));}
function styleFlags(op,kind,old){
  const allowed=kind==='line'?['startDot','endDot','style','thick']:kind==='circle'?['filled']:['startDot','endDot'];
  for(const k of ['startDot','endDot','style','thick','filled'])if(op[k]!==undefined&&!allowed.includes(k))throw new Error(`${k} is unsupported on a ${kind}`);
  let flags=old;const bits=kind==='line'?{startDot:1,endDot:2,thick:32}:kind==='circle'?{filled:1}:{startDot:16,endDot:32};
  for(const [k,mask]of Object.entries(bits))if(op[k]!==undefined)flags=boolean(op[k],k)?flags|mask:flags&~mask;
  if(op.style!==undefined)flags=(flags&~28)|(int(op.style,'style',0,7)<<2);return flags;
}
/** Reusable native primitive encoder. Root GDF drawing lines must request
 * lineOpcode:'m'; auto k/l inside SYM definitions is graphical, not electrical.
 */
export function encodeGraphic(operation,{lineOpcode='auto'}={}){
  fields(operation);let token;
  if(operation.operation==='add_line'){
    token=lineToken(operation);
    if(!['auto','k','l','m'].includes(lineOpcode))throw new Error('lineOpcode must be auto/k/l/m');
    if(lineOpcode==='k'&&operation.y1!==operation.y2||lineOpcode==='l'&&operation.x1!==operation.x2)throw new Error('Explicit k/l opcode requires its native horizontal/vertical geometry');
    if(lineOpcode!=='auto'){token.opcode=lineOpcode;token.body[0]=lineOpcode.charCodeAt(0);}
  }else if(operation.operation==='add_circle')token=circleToken(operation);
  else if(operation.operation==='add_arc')token=arcToken(operation);
  else throw new Error('encodeGraphic supports add_line/add_circle/add_arc');
  return token;
}
/** Pure primitive field editor. Caller validates file scope/version/ownership.
 * Returns {body,before,after}; keeps native opcode and unknown flag bits exact.
 */
export function editGraphic(token,operation){
  fields(operation);const kind={k:'line',l:'line',m:'line',n:'arc',o:'circle'}[token?.opcode];if(!kind||!Buffer.isBuffer(token.body))throw new Error('editGraphic requires a decoded native primitive token');
  const body=Buffer.from(token.body);let before,after;
  if(operation.operation==='translate'){
    int(operation.dx,'dx');int(operation.dy,'dy');const offsets=kind==='line'?[1,3,5,7]:kind==='arc'?[1,3,5,7,9,11]:[1,3];before=offsets.map(n=>body.readInt16LE(n));after=before.map((v,i)=>int(v+(i%2?operation.dy:operation.dx),'translated coordinate'));offsets.forEach((o,i)=>body.writeInt16LE(after[i],o));
  }else if(operation.operation==='set_line'){
    if(kind!=='line')throw new Error('set_line requires a line');after=['x1','y1','x2','y2'].map(k=>int(operation[k],k));if(after[0]===after[2]&&after[1]===after[3])throw new Error('A graphic line cannot have zero length');if(token.opcode==='k'&&after[1]!==after[3]||token.opcode==='l'&&after[0]!==after[2])throw new Error('Existing k/l lines must keep their native orientation/opcode');before=[1,3,5,7].map(n=>body.readInt16LE(n));after.forEach((v,i)=>body.writeInt16LE(v,1+2*i));
  }else if(operation.operation==='set_circle'){if(kind!=='circle')throw new Error('set_circle requires a circle');before=[body.readInt16LE(1),body.readInt16LE(3),body.readUInt16LE(5)];writeCircle(body,operation);after=[operation.x,operation.y,operation.radius];}
  else if(operation.operation==='set_arc'){if(kind!=='arc')throw new Error('set_arc requires an arc');before=[1,3,5,7,9,11].map(n=>body.readInt16LE(n)).concat([13,15,17].map(n=>body.readUInt16LE(n)));writeArc(body,operation);after=['cx','cy','startX','startY','endX','endY','radius','startAngleDegrees','sweepAngleDegrees'].map(k=>operation[k]);}
  else if(operation.operation==='set_graphic_style'){if(!['startDot','endDot','style','thick','filled'].some(k=>operation[k]!==undefined))throw new Error('set_graphic_style requires a style field');const offset={line:9,circle:7,arc:19}[kind];before=body.readUInt16LE(offset);after=styleFlags(operation,kind,before);body.writeUInt16LE(after,offset);}
  else throw new Error('Unsupported primitive editing operation');
  return {body,before,after};
}
function standalone(buffer){
  const parsed=parseGdfGeometry(buffer),tokens=tokeniseGdfGeometry(buffer);
  if(parsed.header.magic!=='SYM'||parsed.definitions.length||parsed.placements.length)throw new Error('Editing requires a standalone modern SYM, not an embedded/shared GDF definition');
  const end=tokens.findIndex(t=>['h','u','t'].includes(t.opcode)),graph=tokens.slice(1,end),defaults=tokens.slice(end,-1);
  let phase=0;
  for(const t of defaults){if(t.opcode==='h'){if(phase)throw new Error('Ambiguous or repeated default SYM markers');phase=8;}else if(t.opcode==='u'){if(phase===10)throw new Error('Repeated SYM parameter marker');phase=10;}else if(t.opcode!=='q'||t.nativeType!==phase)throw new Error('SYM defaults must contain only h/q* and u/q* blocks');}
  const name=graph.filter(t=>t.opcode==='q'&&[1,19].includes(t.attrType));if(name.length!==1||!name[0].text)throw new Error('SYM requires exactly one graphical SYM_NAME or MACRO_NAME');
  const map=new Map(graph.map(t=>[t.offset,t]));
  for(const pin of parsed.sheet.pins){const a=map.get(Number(pin.attributeId.split(':')[1])),p=map.get(pin.offset);if(!a||!p||graph[graph.indexOf(p)-1]!==a||a.nativeType!==7||a.lineTextContext)throw new Error('SYM pin must immediately follow its graphical q attribute');}
  if(!rebuildGdfGeometry(tokens).equals(buffer))throw new Error('SYM token framing does not round-trip');
  return {parsed,tokens,graph,defaults,name:name[0],map};
}
function direction(code){return {2:'input',3:'output',4:'bidirectional',46:'input',47:'output',48:'bidirectional'}[code]??'undetermined';}
function attrSummary(a){return {...a,attributeName:ATTRIBUTE_NAMES[a.kindCode]??null};}
/** Inspect actual pin attribute names; directions are symbol-interface directions.
 * The INPUT border symbol, for example, has an OSTUB facing the inner circuit.
 */
export function inspectSymbol(buffer){
  const s=standalone(buffer),attrs=new Map(s.parsed.sheet.attributes.map(a=>[a.id,a]));
  const pins=s.parsed.sheet.pins.map(p=>{const a=attrs.get(p.attributeId),refs=s.defaults.filter(t=>t.opcode==='q'&&PIN_CODES.has(t.attrType)&&t.text.toUpperCase()===p.name.toUpperCase());return {...p,direction:direction(p.nativeAttributeType),directionScope:'symbol-interface',attributeName:ATTRIBUTE_NAMES[p.nativeAttributeType]??null,unused:[46,47,48].includes(p.nativeAttributeType),attributeOffset:a.offset,labelPosition:a.position,labelDisplay:a.display,associatedDefaultOffsets:refs.map(t=>t.offset)};});
  return {format:s.parsed.format,sha256:hash(buffer),bytes:buffer.length,header:s.parsed.header,symbolName:s.name.text,nameRecordOffset:s.name.offset,nameAttributeName:ATTRIBUTE_NAMES[s.name.attrType],extent:s.parsed.sheet.extent,extentRecordOffset:s.graph[1].offset,pins,graphics:s.parsed.sheet.primitives,texts:s.parsed.sheet.attributes.filter(a=>a.nativeType===7).map(attrSummary),defaults:s.parsed.sheet.attributes.filter(a=>[8,10].includes(a.nativeType)).map(attrSummary),markers:s.parsed.sheet.markers,attributeSource:SYMBOL_ATTRIBUTE_SOURCE,pinAttributeNames:[...PIN_NAMES],note:'Direction names are original symbol-interface attributes. They do not infer top-level port roles, hierarchy behavior or circuit connections. Native compiler/export/simulator verification is required. Header and h/u defaults are retained verbatim during edits; offsets address this exact SHA-256.'};
}

/** Apply one transaction. No disk I/O, hash guard, preview or backup occurs here. */
export function editSymbol(buffer,operations){
  const s=standalone(buffer),before=inspectSymbol(buffer);
  if(!Array.isArray(operations)||!operations.length||operations.length>1000)throw new Error('operations must contain 1 through 1000 entries');
  const graph=[...s.graph],replacements=new Map(),removed=new Set(),claimed=new Set(),changes=[];
  const pinMap=new Map(before.pins.map(p=>[p.offset,p])),graphics=new Map(before.graphics.map(g=>[g.offset,g]));
  const attrMap=new Map(s.parsed.sheet.attributes.filter(a=>a.nativeType===7).map(a=>[a.offset,a]));
  function claim(...offsets){for(const offset of offsets){if(claimed.has(offset))throw new Error('A SYM source record may be changed only once per transaction');claimed.add(offset);}}
  function insert(token){const phase=PHASE[token.opcode],at=graph.findIndex(t=>!t.lineTextContext&&(PHASE[t.opcode]??0)>phase);graph.splice(at<0?graph.length:at,0,token);}
  function graphicText(t){if(!t||t.opcode!=='q'||t.nativeType!==7||t.lineTextContext)throw new Error('recordOffset must address graphical text outside h/u and line-annotation blocks');return t;}
  for(const op of operations){
    fields(op);let token=op.recordOffset===undefined?null:s.map.get(op.recordOffset),body,b=undefined,a=undefined,target=op.operation;
    if(FIELDS[op.operation].includes('recordOffset')&&!token)throw new Error('recordOffset is outside the standalone SYM graphics block');
    if(op.operation==='rename_symbol'){claim(s.name.offset);body=label(s.name,symbolName(op.name));if(op.nameAttributeName!==undefined)body[1]=nameCode(op.nameAttributeName);replacements.set(s.name.offset,body);b={name:s.name.text,nameAttributeName:ATTRIBUTE_NAMES[s.name.attrType]};a={name:op.name,nameAttributeName:ATTRIBUTE_NAMES[body[1]]};}
    else if(op.operation==='set_extent'){const t=s.graph[1];claim(t.offset);const v=[grid(op.width,'width'),grid(op.height,'height')];if(v.some(n=>n<=0))throw new Error('Symbol extents must be positive');body=Buffer.from(t.body);v.forEach((n,i)=>body.writeUInt16LE(n,1+2*i));replacements.set(t.offset,body);b=before.extent;a={width:op.width,height:op.height};}
    else if(op.operation==='add_pin'){
      const q=textToken(pinCode(op.attributeName),pinName(op.name),op.labelX,op.labelY,0x68),p=pinToken(op.x,op.y);insert(q);graph.splice(graph.indexOf(q)+1,0,p);a={name:op.name,position:{x:op.x,y:op.y},labelPosition:{x:op.labelX,y:op.labelY},attributeName:op.attributeName};
    }else if(op.operation==='set_pin'||op.operation==='delete_pin'){
      const p=pinMap.get(op.recordOffset);if(!p)throw new Error('recordOffset must be the pin p record returned by inspectSymbol');const q=s.map.get(p.attributeOffset);claim(p.offset,q.offset);b=p;
      if(op.operation==='delete_pin'){if(p.associatedDefaultOffsets.length)throw new Error('Pin has associated original instance defaults; deleting it would orphan them');removed.add(p.offset);removed.add(q.offset);a=null;}
      else{
        if(!['name','x','labelX','attributeName'].some(k=>op[k]!==undefined)&&op.y===undefined&&op.labelY===undefined)throw new Error('set_pin requires at least one pin field');
        if(p.associatedDefaultOffsets.length&&(op.name!==undefined||op.attributeName!==undefined))throw new Error('Pin has associated original instance defaults; name/type changes require explicit default handling');
        let qb=Buffer.from(q.body),pb=Buffer.from(token.body);
        if(op.name!==undefined)qb=label(q,pinName(op.name));if(op.attributeName!==undefined)qb[1]=pinCode(op.attributeName);
        if(paired(op,'x','y')){pb.writeInt16LE(grid(op.x,'x'),1);pb.writeInt16LE(grid(op.y,'y'),3);}
        if(paired(op,'labelX','labelY')){qb.writeInt16LE(int(op.labelX,'labelX'),3);qb.writeInt16LE(int(op.labelY,'labelY'),5);}
        replacements.set(q.offset,qb);replacements.set(token.offset,pb);a={name:op.name??p.name,position:op.x===undefined?p.position:{x:op.x,y:op.y},labelPosition:op.labelX===undefined?p.labelPosition:{x:op.labelX,y:op.labelY},attributeName:op.attributeName??p.attributeName};
      }
    }else if(op.operation.startsWith('add_')){
      if(op.operation==='add_text'){printable(op.text,'text');token=textToken(0,op.text,op.x,op.y);}
      else if(op.operation==='add_line')token=lineToken(op);
      else if(op.operation==='add_circle')token=circleToken(op);
      else if(op.operation==='add_arc'){if(s.parsed.header.version<3&&(op.startDot||op.endDot))throw new Error('Version-2 arc endpoint dots are cleared by the original reader');token=arcToken(op);}
      insert(token);a={...op};delete a.operation;
    }else{
      claim(token.offset);const g=graphics.get(token.offset),attr=attrMap.get(token.offset);body=Buffer.from(token.body);
      if(op.operation==='delete_graphic'){
        if(!g&&(!attr||attr.kindCode!==0||before.pins.some(p=>p.attributeOffset===token.offset)))throw new Error('Only primitive graphics and free DOC text may be deleted with delete_graphic');
        if(g&&graph[graph.indexOf(token)+1]?.opcode==='i')throw new Error('Deleting a primitive with a line-annotation block requires explicit annotation handling');if(attr)graphicText(token);removed.add(token.offset);b=g??attr;a=null;
      }else if(op.operation==='translate'){
        if(!g&&(!attr||attr.kindCode!==0||before.pins.some(p=>p.attributeOffset===token.offset)))throw new Error('translate requires a primitive or free DOC text; pin/label coordinates use explicit operations');if(attr)graphicText(token);
        int(op.dx,'dx');int(op.dy,'dy');const offs={k:[1,3,5,7],l:[1,3,5,7],m:[1,3,5,7],n:[1,3,5,7,9,11],o:[1,3],q:[3,5]}[token.opcode];b=offs.map(o=>body.readInt16LE(o));a=b.map((v,i)=>int(v+(i%2?op.dy:op.dx),'translated coordinate'));offs.forEach((o,i)=>body.writeInt16LE(a[i],o));
      }else if(op.operation==='set_line'){
        if(g?.kind!=='line')throw new Error('set_line requires a symbol line');const v=['x1','y1','x2','y2'].map(k=>int(op[k],k));if(v[0]===v[2]&&v[1]===v[3])throw new Error('A graphic line cannot have zero length');if(token.opcode==='k'&&v[1]!==v[3]||token.opcode==='l'&&v[0]!==v[2])throw new Error('Existing k/l lines must keep their native orientation/opcode');b=token.values;a=v;v.forEach((v,i)=>body.writeInt16LE(v,1+2*i));
      }else if(op.operation==='set_circle'){if(g?.kind!=='circle')throw new Error('set_circle requires a symbol circle');writeCircle(body,op);b=g;a={center:{x:op.x,y:op.y},radius:op.radius};}
      else if(op.operation==='set_arc'){if(g?.kind!=='arc')throw new Error('set_arc requires a symbol arc');writeArc(body,op);b=g;a={...op};delete a.operation;delete a.recordOffset;}
      else if(op.operation==='set_graphic_style'){
        if(!g)throw new Error('set_graphic_style requires a primitive');if(!['startDot','endDot','style','thick','filled'].some(k=>op[k]!==undefined))throw new Error('set_graphic_style requires a style field');if(s.parsed.header.version<3&&g.kind==='arc'&&(op.startDot||op.endDot))throw new Error('Version-2 arc endpoint dots are cleared by the original reader');b=token.flags;a=styleFlags(op,g.kind,b);body.writeUInt16LE(a,{line:9,circle:7,arc:19}[g.kind]);
      }else if(op.operation==='set_text'){
        graphicText(token);if(attr?.kindCode!==0||before.pins.some(p=>p.attributeOffset===token.offset))throw new Error('set_text requires a free graphical DOC; names/pins/properties use explicit operations');b=token.text;a=printable(op.text,'text');body=label(token,a);
      }else if(op.operation==='set_text_position'){graphicText(token);b=attr.position;a={x:int(op.x,'x'),y:int(op.y,'y')};body.writeInt16LE(a.x,3);body.writeInt16LE(a.y,5);}
      else if(op.operation==='set_text_display'){
        graphicText(token);if(!['editable','color','visible','zoom','orientation'].some(k=>op[k]!==undefined))throw new Error('set_text_display requires a display field');b=token.flags;a=b;for(const[k,m]of Object.entries({editable:1,visible:32,zoom:64}))if(op[k]!==undefined)a=boolean(op[k],k)?a|m:a&~m;if(op.color!==undefined)a=(a&~30)|(int(op.color,'color',0,15)<<1);if(op.orientation!==undefined)a=(a&~0x380)|(int(op.orientation,'orientation',0,7)<<7);body.writeUInt16LE(a,7);
      }
      if(!removed.has(token.offset))replacements.set(token.offset,body);
    }
    changes.push({operation:op.operation,...(op.recordOffset===undefined?{}:{recordOffset:op.recordOffset}),target,before:b??null,after:a??null});
  }
  const planned=[s.tokens[0],...graph.filter(t=>!removed.has(t.offset)).map(t=>({...t,body:replacements.get(t.offset)??t.body})),...s.defaults,s.tokens.at(-1)],result=rebuildGdfGeometry(planned),checked=standalone(result),after=inspectSymbol(result),names=new Set();
  for(const p of after.pins){const folded=p.name.toUpperCase();if(names.has(folded))throw new Error('Resulting symbol has duplicate pin names (case-insensitive)');names.add(folded);}
  if(checked.tokens.length!==planned.length||checked.tokens.some((t,i)=>t.opcode!==planned[i].opcode||(t.opcode==='q'&&t.nativeType!==planned[i].nativeType)))throw new Error('SYM edit would alter record framing or native attribute ownership');
  if(!checked.tokens[0].body.equals(s.tokens[0].body)||!Buffer.concat(checked.defaults.map(t=>t.body)).equals(Buffer.concat(s.defaults.map(t=>t.body))))throw new Error('SYM edit changed header or original default instance bytes');
  const duplicateCounts=bytes=>{const counts=new Map();for(const d of inspectPinLabels(bytes).duplicates){const k=JSON.stringify([d.text,d.position]);counts.set(k,(counts.get(k)??0)+1);}return counts;},oldDuplicates=duplicateCounts(buffer);
  for(const [key,count] of duplicateCounts(result))if(count>(oldDuplicates.get(key)??0))throw new Error('A visible native pin label already occupies this text/anchor. Do not add a duplicate DOC; position the native label with labelX/labelY, or explicitly hide it before adding custom text.');
  return {buffer:result,changes,note:'Standalone SYM graphics/pins changed only at explicit original offsets. Header/version and h/u default instance/parameter bytes remain exact. Pin moves do not redraw stub lines or alter existing GDF copies. Arc endpoints/radius/angles are independent original fields; no geometric consistency is inferred. Original offsets may change; inspect the new bytes and SHA-256 before another edit. Compile/export/simulate the isolated consuming project to verify its source interface and connections.'};
}

/** Clone with a new native name. Caller chooses a new scoped filename. */
export function cloneSymbol(buffer,options={}){
  keys(options,['name','nameAttributeName','operations'],'cloneSymbol');const {name,nameAttributeName='MACRO_NAME',operations=[]}=options;
  if(!Array.isArray(operations))throw new Error('operations must be an array');return editSymbol(buffer,[{operation:'rename_symbol',name,nameAttributeName},...operations]);
}
/** Create an original-format v6 symbol with minimal NET_ID defaults. Source logic
 * is external (e.g. same-named VHDL/TDF/GDF); drawing graphics do not define it.
 */
export function createSymbol(options={}){
  keys(options,['name','nameAttributeName','width','height','pins','graphics','texts'],'createSymbol');const {name,nameAttributeName='MACRO_NAME',width=64,height=64,pins=[],graphics=[],texts=[]}=options;symbolName(name);const type=nameCode(nameAttributeName);grid(width,'width');grid(height,'height');if(width<=0||height<=0)throw new Error('Symbol extents must be positive');
  if(![pins,graphics,texts].every(Array.isArray)||pins.length+graphics.length+texts.length>998)throw new Error('Symbol collections must be arrays with at most 998 total items');
  const head=Buffer.from('53594d0000000600006503020244','hex'),extent=Buffer.alloc(5);extent[0]=0x6a;extent.writeUInt16LE(width,1);extent.writeUInt16LE(height,3);
  const initial=Buffer.concat([head,Buffer.from('f'),extent,textToken(type,name,0,height-8,0x6e).body,Buffer.from('h'),textToken(41,'0',0,0,0x61,8).body,Buffer.from('t')]);
  const ops=[];for(const p of pins){keys(p,['name','x','y','labelX','labelY','attributeName'],'pin');ops.push({operation:'add_pin',...p});}for(const g of graphics){keys(g,FIELDS[g?.operation]??[],'graphic');if(!['add_line','add_circle','add_arc'].includes(g.operation))throw new Error('New graphics require add_line/add_circle/add_arc operations');ops.push(g);}for(const t of texts){keys(t,['text','x','y'],'text');ops.push({operation:'add_text',...t});}
  const edited=ops.length?editSymbol(initial,ops):{buffer:initial,changes:[],note:'New SYM v6 header, native name attribute and default NET_ID were constructed from independently recovered framing.'};
  return {...edited,changes:[{operation:'create_symbol',after:{name,nameAttributeName,width,height}},...edited.changes]};
}
