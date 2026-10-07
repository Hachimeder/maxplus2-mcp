/** File-only pin label diagnostics and conservative duplicate DOC cleanup. */
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from './gdf-geometry.mjs';
const PIN_TYPES=new Set([2,3,4,46,47,48]);
const same=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y;
const width=a=>a.fontCode<4?((a.text.length*(a.fontCode===2?12:[1,3].includes(a.fontCode)?10:8)+10)&~7):null;
function groups(g){return [{...g.sheet,name:g.header.magic==='SYM'?g.sheet.attributes.find(a=>[1,19].includes(a.kindCode))?.text:null,instances:[]},...g.definitions];}
export function inspectPinLabels(buffer){
 const g=parseGdfGeometry(buffer),duplicates=[],pinCollisions=[];let comparisons=0;
 for(const [definitionIndex,d] of groups(g).entries()){
  const attrs=new Map(d.attributes.map(a=>[a.id,a])),pins=d.pins.map(p=>({p,a:attrs.get(p.attributeId)})).filter(({p,a})=>PIN_TYPES.has(p.nativeAttributeType)&&a?.display.visible);
  const byAnchor=new Map();
  for(const {p,a} of pins){const key=JSON.stringify([a.text,a.position.x,a.position.y]);if(!byAnchor.has(key))byAnchor.set(key,[]);byAnchor.get(key).push({p,a});}
  for(const doc of d.attributes.filter(a=>a.nativeType===7&&a.kindCode===0&&a.display.visible)){
   for(const {p,a} of byAnchor.get(JSON.stringify([doc.text,doc.position.x,doc.position.y]))??[]){
    // Different fonts/orientations/aliases can be intentional annotations.
    const exactStyle=doc.fontCode===a.fontCode&&doc.font===a.font&&JSON.stringify(doc.metrics)===JSON.stringify(a.metrics)&&doc.alternative===a.alternative&&doc.display.orientation===a.display.orientation&&doc.display.zoom===a.display.zoom;
    duplicates.push({definitionIndex,symbolName:d.name,docOffset:doc.offset,pinOffset:p.offset,pinLabelOffset:a.offset,text:doc.text,position:a.position,removable:exactStyle,renderedCount:definitionIndex===0?1:d.instances.length});
   }
  }
  const left=pins.filter(({p,a})=>p.position.x===0&&a.display.orientation===0&&width(a)!==null),right=pins.filter(({p,a})=>p.position.x===d.extent.width&&a.display.orientation===0&&width(a)!==null);
  for(const r of right){const hits=left.filter(l=>{if(++comparisons>2000000)throw new Error('Pin label comparison budget exceeded; narrow the file/symbol');return l.a.position.y===r.a.position.y&&l.a.position.x<r.a.position.x+width(r.a)&&r.a.position.x<l.a.position.x+width(l.a);});if(!hits.length)continue;
   const row=left.filter(l=>l.a.position.y===r.a.position.y),paddedX=d.extent.width-24-width(r.a),tightX=d.extent.width-16-width(r.a),fits=x=>x>=24&&row.every(l=>l.a.position.x+width(l.a)+8<=x),nextX=fits(paddedX)?paddedX:tightX,canAlign=fits(nextX);
   pinCollisions.push({definitionIndex,symbolName:d.name,pinLabelOffset:r.a.offset,text:r.a.text,position:r.a.position,overlaps: hits.map(l=>l.a.text),suggestedX:nextX,canAlign,renderedCount:definitionIndex===0?1:d.instances.length});
  }
 }
 return {duplicates,pinCollisions,counts:{duplicateRecords:duplicates.length,removableDuplicateRecords:new Set(duplicates.filter(d=>d.removable).map(d=>d.docOffset)).size,renderedDuplicateLabels:duplicates.reduce((n,d)=>n+d.renderedCount,0),sameRowPinCollisions:pinCollisions.length},note:'Exact visible pin/DOC text and anchor matches; cleanup additionally requires equal font, orientation, zoom and alternative text. Same-row bounds use original fixed-font width estimates, not complete rendered glyph bounds. DOC screen color follows the native Text palette; pin names use Symbol Pinstub Names. Other annotations and general layout collisions require original-editor inspection.'};
}
function electrical(g){return JSON.stringify({header:g.header,sheetPins:g.sheet.pins.map(p=>[p.name,p.nativeAttributeType,p.position]),placements:g.placements.map(p=>({symbolName:p.symbolName,instanceName:p.instanceName,netId:p.netId,position:p.position,transform:p.transform.code,attributes:p.attributes.map(a=>[a.nativeType,a.kindCode,a.text,a.position,a.rawFlags]),pins:p.pins.map(a=>[a.name,a.nativeAttributeType,a.localPosition,a.worldPosition])}))});}
export function cleanupPinLabels(buffer,{alignOverlappingRightPins=false}={}){
 if(typeof alignOverlappingRightPins!=='boolean')throw new Error('alignOverlappingRightPins must be boolean');
 const g=parseGdfGeometry(buffer);if(!['SYM','GDF'].includes(g.header.magic)||g.header.version!==6)throw new Error('Pin label cleanup requires modern GDF/SYM version 6');
 const before=inspectPinLabels(buffer),tokens=tokeniseGdfGeometry(buffer),remove=new Set(before.duplicates.filter(d=>d.removable).map(d=>d.docOffset)),changes=[...remove].map(recordOffset=>({operation:'delete_duplicate_pin_doc',recordOffset,...before.duplicates.find(d=>d.docOffset===recordOffset)})),moves=new Map();
 if(alignOverlappingRightPins)for(const c of before.pinCollisions){if(!c.canAlign)throw new Error(`Cannot safely separate ${c.symbolName} pin ${c.text}; resize/re-layout explicitly`);moves.set(c.pinLabelOffset,c.suggestedX);changes.push({operation:'align_right_pin_label',recordOffset:c.pinLabelOffset,before:c.position,after:{x:c.suggestedX,y:c.position.y},symbolName:c.symbolName,text:c.text});}
 const retained=tokens.filter(t=>!remove.has(t.offset)).map(t=>{if(!moves.has(t.offset))return t;const body=Buffer.from(t.body);body.writeInt16LE(moves.get(t.offset),3);return {...t,body};}),result=rebuildGdfGeometry(retained),actual=tokeniseGdfGeometry(result),after=parseGdfGeometry(result);
 if(actual.length!==retained.length||actual.some((t,i)=>!t.body.equals(retained[i].body)||t.opcode==='q'&&(t.nativeType!==retained[i].nativeType||Boolean(t.lineTextContext)!==Boolean(retained[i].lineTextContext))))throw new Error('Label cleanup would reinterpret a native record; refused');
 if(electrical(g)!==electrical(after))throw new Error('Label cleanup would change pin positions or instance/electrical identities; refused');
 for(const offset of remove){const t=tokens.find(t=>t.offset===offset),i=tokens.indexOf(t);if(t.opcode!=='q'||t.nativeType!==7||t.attrType!==0||t.lineTextContext||tokens[i+1]?.opcode==='p')throw new Error('Only free graphical DOC may be deleted');}
 const counts={before:before.counts,after:inspectPinLabels(result).counts},preserved={electricalRecords:true,pinConnectionPoints:true,instanceBytes:true,unrelatedRecordBytes:true};
 return {buffer:result,changes,counts,preserved,connectionCheck:{...preserved,...counts},note:before.note};
}
