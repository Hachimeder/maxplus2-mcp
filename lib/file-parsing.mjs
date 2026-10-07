/** File-first structured inspection. No GUI or agent-specific runtime. */
import fs from 'node:fs';
import path from 'node:path';
import {sha256} from './workspace.mjs';
import {parseAcf} from './acf.mjs';
import {readGdf,scanTextRecords} from './gdf.mjs';
import {readScfWaveforms} from './scf.mjs';
import {parseTbl,tblTrace} from './tbl.mjs';
import {parseReport} from './report.mjs';
import {gdfGeometryPage} from './gdf-tools.mjs';

const formats={'.gdf':'gdf','.scf':'scf','.acf':'acf','.tbl':'tbl','.rpt':'report','.pin':'report','.summary':'report','.edf':'edif','.edo':'edif','.edif':'edif'};
const page=(all,offset,limit)=>({items:all.slice(offset,offset+limit),total:all.length,offset,returned:Math.max(0,Math.min(limit,all.length-offset)),nextOffset:offset+limit<all.length?offset+limit:null,truncated:offset>0||offset+limit<all.length});

export function netlistPage(parsed,a={}){
  let view=parsed,selectedCell=null;
  if(a.cell){
    const found=parsed.libraries.flatMap(l=>l.cells.filter(c=>a.cell===c.id||a.cell===`${l.id}/${c.id}`).map(c=>({library:l.id,cell:c})));
    if(found.length!==1)throw new Error('EDIF cell must resolve uniquely; use library/cell from the library inventory');
    const views=found[0].cell.views.filter(v=>v.type==='NETLIST');if(views.length!==1)throw new Error('selected cell has no unique NETLIST view');
    view=views[0];selectedCell={library:found[0].library,id:found[0].cell.id,view:view.id};
  }
  const offset=a.offset??0;let limit=a.limit??20;
  const nets=a.net?view.nets.filter(n=>n.id===a.net||n.name===a.net):view.nets;
  let endpointLimit=a.endpointLimit??20,result;
  const endpointOffset=a.endpointOffset??0;
  do{
    const netRows=page(nets,offset,limit);
    const items=netRows.items.map(n=>({...n,endpoints:n.endpoints.slice(endpointOffset,endpointOffset+endpointLimit),drivers:undefined,loads:undefined,totalEndpoints:n.endpoints.length,endpointOffset,
      nextEndpointOffset:endpointOffset+endpointLimit<n.endpoints.length?endpointOffset+endpointLimit:null,endpointsTruncated:endpointOffset>0||endpointOffset+endpointLimit<n.endpoints.length}));
    result={format:parsed.format,version:parsed.version,name:parsed.name,design:parsed.design,selectedCell,
      ports:page(view.ports,offset,limit),instances:page(view.instances,offset,limit),nets:{...netRows,items},
      counts:{ports:view.ports.length,instances:view.instances.length,nets:view.nets.length,endpoints:view.nets.reduce((sum,n)=>sum+n.endpoints.length,0)},
      libraries:parsed.libraries.map(l=>({id:l.id,name:l.name,cellCount:l.cells.length,cells:l.cells.slice(0,100).map(c=>({id:c.id,name:c.name,viewCount:c.views.length})),cellsTruncated:l.cells.length>100})),
      provenance:parsed.provenance,validation:parsed.validation,understood:parsed.understood,limitations:parsed.limitations,limit,endpointLimit};
    if(JSON.stringify(result).length<=38000)break;
    if(limit>1)limit=Math.max(1,Math.floor(limit/2));else if(endpointLimit>1)endpointLimit=Math.max(1,Math.floor(endpointLimit/2));else break;
  }while(true);
  return result;
}

export function scfPage(bytes,a={}){
  let eventLimit=a.limit??20,signalLimit=a.signalLimit??5;
  const signalOffset=a.signalOffset??0;
  let result;
  do{
    const parsed=readScfWaveforms(bytes,{signal:a.signal,startTime:a.startTime,endTime:a.endTime,offset:a.offset??0,limit:eventLimit});
    const signals=parsed.signals.slice(signalOffset,signalOffset+signalLimit);
    result={...parsed,signals,selectedSignalCount:parsed.signals.length,signalOffset,returnedSignals:signals.length,
      nextSignalOffset:signalOffset+signals.length<parsed.signals.length?signalOffset+signals.length:null,
      eventLimit,signalLimit,signalPageTruncated:signalOffset>0||signalOffset+signals.length<parsed.signals.length};
    if(JSON.stringify(result).length<=38000)break;
    if(eventLimit>1)eventLimit=Math.max(1,Math.floor(eventLimit/2));else if(signalLimit>1)signalLimit--;else break;
  }while(true);
  return result;
}

export async function parseProjectFile(filename,a={}){
  const stat=fs.statSync(filename);
  if(!stat.isFile()||stat.size>16*1024*1024)throw new Error('structured parser requires a regular file no larger than 16 MiB');
  const bytes=fs.readFileSync(filename),format=a.format&&a.format!=='auto'?a.format:formats[path.extname(filename).toLowerCase()];
  if(!format)throw new Error('unsupported structured format; use project_read_file for text or select gdf/scf/acf/tbl/report/edif explicitly');
  const identity={path:filename,bytes:bytes.length,sha256:sha256(bytes),format};
  const offset=a.offset??0,limit=a.limit??100;let data;
  if(format==='scf')data=scfPage(bytes,a);
  else if(format==='gdf'){
    const decoded=readGdf(bytes),texts=scanTextRecords(bytes);
    data={...decoded,geometry:gdfGeometryPage(bytes,a),text:{...decoded.text,labels:decoded.text.labels.slice(offset,offset+limit),pinLike:decoded.text.pinLike.slice(offset,offset+limit)},textRecords:page(texts,offset,limit),
      limits:'Visible text is direct binary evidence. Connectivity requires netlist_export; that export describes the synthesized circuit.'};
  }else if(format==='acf'){
    const parsed=parseAcf(bytes.toString('latin1'));
    data={lineCount:parsed.lineCount,sections:page(parsed.sections.map(s=>({...s,entries:s.entries.slice(0,100),totalEntries:s.entries.length,entriesTruncated:s.entries.length>100})),offset,limit)};
  }else if(format==='tbl'){
    const parsed=parseTbl(bytes.toString('latin1'));const {rows,...header}=parsed;
    data={...header,trace:page(tblTrace(parsed),offset,limit)};
  }else if(format==='report')data=parseReport(bytes.toString('latin1'),{maxDiagnostics:limit});
  else if(format==='edif'){
    const {parseNetlist}=await import('./netlist.mjs');data=netlistPage(parseNetlist(bytes.toString('latin1')),a);
  }else throw new Error('unsupported structured parser format');
  return {...identity,data};
}
