import fs from 'node:fs';
import path from 'node:path';
import {parseGdfGeometry} from './gdf-geometry.mjs';
import {scopedPath,sha256,editGdfFile} from './workspace.mjs';

const str=description=>({type:'string',description});
const int=(description,minimum,maximum)=>({type:'integer',minimum,maximum,description});
const page=(items,offset,limit)=>({items:items.slice(offset,offset+limit),total:items.length,offset,returned:Math.max(0,Math.min(limit,items.length-offset)),nextOffset:offset+limit<items.length?offset+limit:null,truncated:offset>0||offset+limit<items.length});

// Each child array has its own page metadata; large text never silently disappears.
function bounded(value,offset,limit,textLimit){
  if(Array.isArray(value))return {...page(value,offset,limit),items:value.slice(offset,offset+limit).map(v=>bounded(v,offset,limit,textLimit))};
  if(!value||typeof value!=='object')return value;
  const result={};
  for(const [key,v] of Object.entries(value)){
    if(typeof v==='string'&&v.length>textLimit){result[key]=v.slice(0,textLimit);result[key+'Length']=v.length;result[key+'Truncated']=true;}
    else result[key]=Array.isArray(v)&&['matrix','orientationCodes','endpointDots'].includes(key)?v:bounded(v,offset,limit,textLimit);
  }
  return result;
}
export function gdfGeometryPage(bytes,a={}){
  const parsed=parseGdfGeometry(bytes),view=a.view??'sheet';
  const rows=view==='placements'?parsed.placements:view==='definitions'?parsed.definitions:parsed.sheet.primitives.concat(parsed.sheet.attributes,parsed.sheet.pins).sort((x,y)=>x.offset-y.offset);
  let limit=a.limit??20,childLimit=a.childLimit??10,textLimit=1024,result;
  do{
    const selected=page(rows,a.offset??0,limit);
    result={format:parsed.format,header:parsed.header,coordinateSystem:parsed.coordinateSystem,sheet:{id:parsed.sheet.id,extent:parsed.sheet.extent},counts:parsed.counts,understood:parsed.understood,limitations:parsed.limitations,view,
      records:{...selected,items:selected.items.map(v=>bounded(v,a.childOffset??0,childLimit,textLimit))},limit,childOffset:a.childOffset??0,childLimit,textLimit};
    if(JSON.stringify(result).length<=36000)break;
    if(limit>1)limit=Math.max(1,Math.floor(limit/2));else if(childLimit>1)childLimit=Math.max(1,Math.floor(childLimit/2));else if(textLimit>128)textLimit=Math.floor(textLimit/2);else throw new Error('GDF page exceeds result budget; narrow the view');
  }while(true);
  return result;
}

export function gdfTools({defaultWorkspace,resolveAcf}){
  const scope=a=>a.project?path.dirname(resolveAcf(a.project,a.workspace)):fs.realpathSync(a.workspace??defaultWorkspace);
  const file={project:str('Existing ACF project; file paths stay inside its directory.'),workspace:str('Workspace scope when no project is given.'),path:str('GDF/SYM file inside the chosen project/workspace.')};
  const fields={recordOffset:int('Record byte offset from a fresh gdf_geometry response.',0,16777216),operation:{type:'string',enum:['translate','set_orientation','set_line','set_text'],description:'Change only the selected existing geometry or free annotation.'},dx:int('Horizontal displacement in editor units.',-65535,65535),dy:int('Vertical displacement; positive is up.',-65535,65535),orientation:int('Original rotation/mirror code.',0,7),x1:int('Line start x.',-32768,32767),y1:int('Line start y.',-32768,32767),x2:int('Line end x.',-32768,32767),y2:int('Line end y.',-32768,32767),text:{...str('Free annotation Latin-1 text; logical names cannot be edited here.'),maxLength:2047}};
  return [{
    name:'gdf_geometry',title:'Read original schematic geometry',description:'Strictly decode GDF/SYM v2..6 coordinates, wires/buses, symbol definitions, original instances, rotations/mirrors, stretched world pin positions and local text anchors. No compiler or GUI needed. Paginated root records and nested collections preserve offsets/counts. Geometry does not prove connectivity; use netlist_export for circuit connections.',
    inputSchema:{type:'object',additionalProperties:false,required:['path'],properties:{...file,view:{type:'string',enum:['sheet','placements','definitions'],description:'Collection to inspect; default sheet.'},offset:int('Root collection offset; default zero.',0,1000000),limit:int('Root records per page; default 20, reduced to fit budget.',1,100),childOffset:int('Offset in each nested pins/attributes/primitives collection.',0,1000000),childLimit:int('Items per nested collection; default 10, reduced to fit budget.',1,100)}},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},sideEffects:'none',reversibility:'not-applicable',actsOn:'gdf-file',
    handler:a=>{const p=scopedPath(scope(a),a.path);if(!fs.statSync(p).isFile()||fs.statSync(p).size>16*1024*1024)throw new Error('GDF parser requires a regular file up to 16 MiB');const bytes=fs.readFileSync(p);return {path:p,bytes:bytes.length,sha256:sha256(bytes),...gdfGeometryPage(bytes,a)};},
  },{
    name:'gdf_edit',title:'Edit existing schematic geometry',description:'Preview/apply lossless GDF v6 root line coordinates, translations, symbol orientation or free annotation text. Existing records only. Requires fresh file SHA-256, rejects unsupported targets/overflow, preserves unrelated bytes and backs up before atomic replacement. Moving a symbol does not move its wires; recompile/export to verify circuit behavior.',
    inputSchema:{type:'object',additionalProperties:false,required:['path','expectedSha256','edits'],properties:{...file,expectedSha256:{...str('SHA-256 returned by the latest GDF read.'),minLength:64,maxLength:64},confirm:{type:'boolean',description:'Apply when true; otherwise preview. Session authorization suffices, no new user approval is implied.'},edits:{type:'array',minItems:1,maxItems:100,description:'One operation per original record offset. Observe again after text edits.',items:{type:'object',additionalProperties:false,required:['recordOffset','operation'],properties:fields,anyOf:[{properties:{operation:{enum:['translate']}},required:['dx','dy']},{properties:{operation:{enum:['set_orientation']}},required:['orientation']},{properties:{operation:{enum:['set_line']}},required:['x1','y1','x2','y2']},{properties:{operation:{enum:['set_text']}},required:['text']}]}}}},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},sideEffects:'destructive',reversibility:'reversible-by-backup',actsOn:'gdf-file',handler:a=>editGdfFile(scope(a),a),
  }];
}
