/** Public GDF reader backed by the recovered strict grammar. The former arity
 * guesses and 00-76 byte scan are retired; they missed valid text and geometry. */
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from './gdf-geometry.mjs';
export const MAGIC=Buffer.from([0x47,0x44,0x46,0]);
export const ARITY={f:1,g:1,h:1,i:1,u:1,t:1,j:5,p:5,k:11,l:11,m:11,n:21,o:9,r:6,q:-1,s:-1,v:-1};
export function tokeniseGdf(buffer){
  const records=tokeniseGdfGeometry(buffer).map(t=>({...t,start:t.offset}));
  records.resyncs=0;return records;
}
export const rebuildGdf=rebuildGdfGeometry;
export function scanTextRecords(buffer){
  const records=[];
  for(const token of tokeniseGdfGeometry(buffer)){
    for(const r of [token.fontOffset===undefined?null:{offset:token.fontOffset,text:token.font},token.textRecord,token.alternativeRecord]){
      if(!r)continue;
      const prefix=buffer[r.offset]===0x73?2:3;
      records.push({offset:r.offset,payloadOffset:r.offset+prefix,length:Buffer.byteLength(r.text,'latin1'),text:r.text});
    }
  }
  return records;
}
export function readGdf(buffer){
  const parsed=parseGdfGeometry(buffer),records=tokeniseGdf(buffer),texts=scanTextRecords(buffer);
  const counts={};for(const r of records)counts[r.opcode]=(counts[r.opcode]??0)+1;
  const isFont=t=>/^(Arial|Courier|Times|Helvetica)/i.test(t);
  const labels=texts.filter(t=>!isFont(t.text)).map(t=>t.text),fonts=texts.filter(t=>isFont(t.text)).map(t=>t.text);
  const titleBlock={},keys=['TITLE','DESIGNER','COMPANY','DATE','SHEET','REV','NUMBER','SIZE','EPLD','SECURITY','TURBO'];
  for(let i=0;i<texts.length;i++)if(keys.includes(texts[i].text.toUpperCase())&&texts[i+1])titleBlock[texts[i].text.toUpperCase()]=texts[i+1].text;
  return {format:parsed.format,fileSize:buffer.length,recordCount:records.length,opcodeHistogram:counts,text:{count:texts.length,fonts:[...new Set(fonts)],labels:[...new Set(labels)],pinLike:[...new Set(labels.filter(l=>/^[A-Za-z_|\\][A-Za-z0-9_\[\].\\|:]*$/.test(l)&&l.length<=16))]},titleBlock,
    understood:{container:true,text:true,geometry:true,connectivity:false,writable:parsed.understood.writable},opcodeWalkResyncs:0,geometryCounts:parsed.counts,coordinateSystem:parsed.coordinateSystem,
    note:'Strict modern GDF/SYM grammar. gdf_geometry returns paginated original positions, definitions and world pins; gdf_edit changes supported existing version-6 geometry. Circuit connectivity requires netlist_export.'};
}
export function compareGdf(a,b){
  const sa=new Set(readGdf(a).text.labels),sb=new Set(readGdf(b).text.labels);
  return {onlyInA:[...sa].filter(x=>!sb.has(x)).sort(),onlyInB:[...sb].filter(x=>!sa.has(x)).sort(),shared:[...sa].filter(x=>sb.has(x)).sort(),aLabels:sa.size,bLabels:sb.size};
}
