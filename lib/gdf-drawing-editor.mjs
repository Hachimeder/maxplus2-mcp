/** Complete root graphical primitive edits, separate from electrical authoring. */
import {parseGdfGeometry,tokeniseGdfGeometry} from './gdf-geometry.mjs';
import {encodeGraphic,editGraphic} from './gdf-symbol-editor.mjs';
const PHASE={k:2,l:3,m:4,n:5,o:6,q:7,p:7};
export function editDrawingGraphics(buffer,operations){
 const before=parseGdfGeometry(buffer);if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Root graphic authoring requires GDF version 6');
 if(!Array.isArray(operations)||!operations.length||operations.length>200)throw new Error('operations must contain 1 through 200 changes');
 const tokens=tokeniseGdfGeometry(buffer),end=tokens.findIndex(t=>['g','t'].includes(t.opcode)),root=tokens.slice(1,end),primitives=new Map(before.sheet.primitives.map(p=>[p.offset,p])),replaced=new Map(),removed=new Set(),seen=new Set(),changes=[];
 for(const op of operations){
  if(['add_line','add_circle','add_arc'].includes(op?.operation)){
   const token=encodeGraphic(op,{lineOpcode:'m'}),phase=PHASE[token.opcode],at=root.findIndex(t=>t.nativeType!==11&&!t.lineTextContext&&(PHASE[t.opcode]??0)>phase);root.splice(at<0?root.length:at,0,token);changes.push({operation:op.operation,opcode:token.opcode,parameters:{...op}});continue;
  }
  if(!op||!Number.isSafeInteger(op.recordOffset)||!primitives.has(op.recordOffset))throw new Error('recordOffset must identify an existing root graphical primitive');
  if(seen.has(op.recordOffset))throw new Error('A primitive may be changed only once per transaction');seen.add(op.recordOffset);
  const primitive=primitives.get(op.recordOffset),token=tokens.find(t=>t.offset===op.recordOffset);
  if(op.operation==='delete_graphic'){
   if(Object.keys(op).some(k=>!['operation','recordOffset'].includes(k)))throw new Error('Unexpected delete_graphic field');
   if(['scalar-wire','bus-wire'].includes(primitive.electricalRole))throw new Error('Use gdf_construct delete_wire to remove electrical wires and their labels');
   removed.add(token.offset);changes.push({operation:op.operation,recordOffset:token.offset,kind:primitive.kind});
  }else{const edited=editGraphic(token,op);replaced.set(token.offset,edited.body);changes.push({operation:op.operation,recordOffset:token.offset,before:edited.before,after:edited.after});}
 }
 const planned=[tokens[0],...root.filter(t=>!removed.has(t.offset)).map(t=>({...t,body:replaced.get(t.offset)??t.body})),...tokens.slice(end)],result=Buffer.concat(planned.map(t=>t.body)),after=parseGdfGeometry(result),actual=tokeniseGdfGeometry(result);
 if(actual.length!==planned.length||actual.some((t,i)=>t.opcode==='q'&&t.nativeType!==planned[i].nativeType))throw new Error('Graphic edit would reinterpret an existing native text context');
 if(after.placements.length!==before.placements.length||after.definitions.length!==before.definitions.length)throw new Error('Graphic edit changed electrical instance structure');
 return {buffer:result,changes,counts:{before:before.counts,after:after.counts},note:'Original root graphical line/circle/arc records were created, resized, restyled or deleted. Shared symbol definitions and unselected bytes are retained. Drawing lines use opcode m and have no electrical wire role; use gdf_construct for wires. Re-read offsets and verify actual editor layout; cached arc endpoints and radius are explicit original fields.'};
}
