/** Conservative root-wire pruning. Pure Node; no GUI, compiler or SDK session.
 * Only anonymous, unannotated leaf segments in a pin-bearing physical network
 * are removed. Every peeling round checks original source pins and bit aliases.
 * Source offsets select input records; surviving token bodies are never changed.
 */
import {parseGdfGeometry,tokeniseGdfGeometry} from './gdf-geometry.mjs';
import {inspectGdfConnections,gdfTerminalPartitions,pointOnGdfWire} from './gdf-connections.mjs';
import {inspectGdfBusMembers} from './gdf-bus-members.mjs';

export const GDF_CLEANUP_COMPARISON_LIMIT=4000000;
const same=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y;
const endAt=(point,wire)=>same(point,wire.start)?0:same(point,wire.end)?1:-1;
function integer(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return value;}
class Union {
 constructor(count){this.parent=Array.from({length:count},(_,i)=>i);}
 find(i){while(this.parent[i]!==i){this.parent[i]=this.parent[this.parent[i]];i=this.parent[i];}return i;}
 join(a,b){a=this.find(a);b=this.find(b);if(a!==b)this.parent[Math.max(a,b)]=Math.min(a,b);}
}
function contact(a,b){
 if(a.thick!==b.thick)return null;
 if(a.orientation===b.orientation){
  const axis=a.orientation==='horizontal'?'x':'y',fixed=axis==='x'?'y':'x';
  if(a.start[fixed]!==b.start[fixed])return null;
  const lo=Math.max(Math.min(a.start[axis],a.end[axis]),Math.min(b.start[axis],b.end[axis])),hi=Math.min(Math.max(a.start[axis],a.end[axis]),Math.max(b.start[axis],b.end[axis]));
  if(lo>hi)return null;
  if(lo<hi)return {overlap:true};
  const p=a.orientation==='horizontal'?{x:lo,y:a.start.y}:{x:a.start.x,y:lo};
  return {ends:[endAt(p,a),endAt(p,b)]};
 }
 const h=a.orientation==='horizontal'?a:b,v=a.orientation==='vertical'?a:b,p={x:v.start.x,y:h.start.y};
 if(!pointOnGdfWire(p,h)||!pointOnGdfWire(p,v))return null;
 const ends=[endAt(p,a),endAt(p,b)];
 // Interior crossings and unsplit T contacts are not native electrical joins.
 return ends.every(end=>end>=0)?{ends}:null;
}

/** Canonical per-bit source partition independent of root-byte deletions.
 * Member ordinals identify transparent WIRE pins; their aliases and logical
 * indices are retained as separate semantic facts, including range reversals.
 */
export function gdfCleanupBitPartitions(model,geometry){
 const identities=new Map();geometry.placements.forEach((placement,i)=>placement.pins.forEach((pin,j)=>identities.set(`${placement.offset}/${pin.offset}`,`${i}/${j}`)));
 return model.nets.filter(net=>net.terminals.length||net.names.length).map(net=>({
  names:[...net.names].sort(),
  terminals:net.terminals.map(pin=>{
   const identity=identities.get(`${pin.recordOffset}/${pin.pinOffset}`);
   if(identity===undefined)throw new Error('Bit topology contains an unknown source terminal identity');
   return {key:`${identity}/${pin.bundle?pin.memberOrdinal:''}`,member:pin.member,logicalIndex:pin.logicalIndex,memberOrdinal:pin.memberOrdinal,bundle:pin.bundle,transparent:pin.transparent,scope:pin.scope,direction:pin.direction};
  }).sort((a,b)=>a.key.localeCompare(b.key))
 })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Refuses unsupported semantics before planning any deletion. maxComparisons
 * may reduce, but cannot increase, the fixed whole-transaction 4M work budget.
 */
export function cleanupGdfWires(buffer,{maxComparisons=GDF_CLEANUP_COMPARISON_LIMIT,maxPasses=1000}={}){
 if(!Buffer.isBuffer(buffer))throw new Error('Wire cleanup requires a GDF Buffer');
 if(buffer.length>4*1024*1024)throw new Error('Wire cleanup requires a file up to 4 MiB');
 integer(maxComparisons,'maxComparisons',1,GDF_CLEANUP_COMPARISON_LIMIT);integer(maxPasses,'maxPasses',1,1000);
 const before=parseGdfGeometry(buffer);
 if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Wire cleanup requires GDF version 6');
 if(before.sheet.pins.length)throw new Error('Wire cleanup does not model root-sheet pin declarations');
 if(before.sheet.extraText.length||before.definitions.some(d=>d.extraText.length)||before.placements.some(p=>p.extraText.length))throw new Error('Wire cleanup refuses unresolved expression or alias records');
 const tokens=tokeniseGdfGeometry(buffer),wires=[...before.sheet.wires,...before.sheet.buses].sort((a,b)=>a.offset-b.offset);
 let comparisons=0;
 const spend=()=>{if(++comparisons>maxComparisons)throw new Error('Wire cleanup comparison budget exceeded; transaction refused');};
 function inspect(bytes){
  if(comparisons>=maxComparisons)throw new Error('Wire cleanup comparison budget exceeded; transaction refused');
  const core=inspectGdfConnections(bytes,{maxComparisons:maxComparisons-comparisons});comparisons+=core.comparisons;
  if(core.detailTruncation.diagnosticsTruncated||core.diagnostics.some(d=>d.severity==='error')||!before.sheet.buses.length&&!core.completeScalarTopology)throw new Error('Wire cleanup requires fully understood source connectivity; resolve connection diagnostics first');
  if(comparisons>=maxComparisons)throw new Error('Wire cleanup comparison budget exceeded; transaction refused');
  const bits=inspectGdfBusMembers(bytes,{maxComparisons:maxComparisons-comparisons});comparisons+=bits.comparisons;
  if(!bits.complete)throw new Error('Wire cleanup requires complete explicit bit topology; unresolved bus widths, pins or aliases are refused');
  return {core,bits,geometry:parseGdfGeometry(bytes)};
 }
 const original=inspect(buffer),expectedScalar=JSON.stringify(gdfTerminalPartitions(original.core)),expectedBits=JSON.stringify(gdfCleanupBitPartitions(original.bits,before));
 const union=new Union(wires.length),ends=wires.map(()=>[new Set(),new Set()]),pinProtected=new Set(),overlaps=new Set(),annotated=new Set(),unknownFlags=new Set(),anchorWires=new Set();
 const tokenIndex=new Map(tokens.map((t,i)=>[t.offset,i]));
 wires.forEach((wire,i)=>{
  const next=tokens[tokenIndex.get(wire.offset)+1];
  // Even an empty i span or a graphical q following it is preserved. Deleting
  // only k/l records cannot move text into another native reader context.
  if(wire.annotations?.length||['i','q'].includes(next?.opcode))annotated.add(i);
  if(wire.rawFlags&~63)unknownFlags.add(i);
  if(same(wire.start,wire.end))overlaps.add(i);
 });
 for(let i=0;i<wires.length;i++)for(let j=i+1;j<wires.length;j++){
  spend();const c=contact(wires[i],wires[j]);if(!c)continue;union.join(i,j);
  if(c.overlap){overlaps.add(i);overlaps.add(j);continue;}
  ends[i][c.ends[0]].add(j);ends[j][c.ends[1]].add(i);
 }
 const pins=before.placements.flatMap(placement=>placement.pins.map(pin=>({...pin,transparent:placement.symbolName?.toUpperCase()==='WIRE'})));
 for(const pin of pins){
  if(!pin.worldPosition)throw new Error('Wire cleanup refuses unknown placement transforms');
  let first=-1;
  for(let i=0;i<wires.length;i++){
   spend();if(!pointOnGdfWire(pin.worldPosition,wires[i]))continue;
   pinProtected.add(i);if(!pin.transparent)anchorWires.add(i);
   if(first>=0&&wires[first].thick===wires[i].thick)union.join(first,i);else first=i;
  }
 }
 const anchors=new Set([...anchorWires].map(i=>union.find(i))),isolated=new Set(wires.map((_,i)=>i).filter(i=>!anchors.has(union.find(i))));
 const active=new Uint8Array(wires.length).fill(1),removed=new Set(),changes=[];
 const eligible=i=>active[i]&&!pinProtected.has(i)&&!annotated.has(i)&&!unknownFlags.has(i)&&!overlaps.has(i)&&!isolated.has(i)&&((ends[i][0].size===0)!==(ends[i][1].size===0));
 let queue=wires.map((_,i)=>i).filter(eligible),passes=0,verified=original,changed=buffer;
 while(queue.length){
  if(++passes>maxPasses)throw new Error('Wire cleanup peeling pass budget exceeded; transaction refused');
  // A whole leaf layer is selected before adjacency changes. Two segments
  // cannot cause a pin-bearing component to disappear: every pin conductor,
  // named/annotated conductor and collinear overlap remains protected.
  const layer=queue.filter(eligible),next=new Set();if(!layer.length)break;
  for(const i of layer){active[i]=0;removed.add(wires[i].offset);changes.push({operation:'delete_unattached_wire_tail',recordOffset:wires[i].offset,bus:wires[i].thick,start:wires[i].start,end:wires[i].end,length:Math.abs(wires[i].start.x-wires[i].end.x)+Math.abs(wires[i].start.y-wires[i].end.y),pass:passes});}
  for(const i of layer)for(const set of ends[i])for(const j of set){spend();for(const end of ends[j])if(end.delete(i))next.add(j);}
  const retained=tokens.filter(token=>!removed.has(token.offset));
  changed=Buffer.concat(retained.map(token=>token.body));
  const actual=tokeniseGdfGeometry(changed);
  if(actual.length!==retained.length||actual.some((token,i)=>token.opcode!==retained[i].opcode||token.opcode==='q'&&(token.nativeType!==retained[i].nativeType||Boolean(token.lineTextContext)!==Boolean(retained[i].lineTextContext))))throw new Error('Wire cleanup would reinterpret an existing native attribute context; transaction refused');
  verified=inspect(changed);
  if(JSON.stringify(gdfTerminalPartitions(verified.core))!==expectedScalar||JSON.stringify(gdfCleanupBitPartitions(verified.bits,verified.geometry))!==expectedBits)throw new Error('Wire cleanup would change original source terminals or bit aliases; transaction refused');
  queue=[...next].filter(eligible);
 }
 const length=items=>items.reduce((sum,wire)=>sum+Math.abs(wire.start.x-wire.end.x)+Math.abs(wire.start.y-wire.end.y),0);
 const metrics=model=>({wires:model.core.counts.wires,buses:model.core.counts.buses,totalSegments:model.core.counts.wires+model.core.counts.buses,wireLength:length(model.geometry.sheet.wires),busLength:length(model.geometry.sheet.buses),crossings:model.core.counts.crossings,sourceNets:model.core.counts.nets,bitNets:model.bits.counts.bitNets,pins:model.core.counts.pins});
 return {buffer:changed,changes,counts:{before:metrics(original),after:metrics(verified)},connectionCheck:{preserved:true,scalarTerminalPartitions:gdfTerminalPartitions(original.core).length,bitTerminalPartitions:original.bits.nets.filter(n=>n.terminals.length).length,pins:original.core.counts.pins,removedSegments:removed.size,passes,comparisons,comparisonLimit:maxComparisons,before:metrics(original),after:metrics(verified),protected:{pinConductors:pinProtected.size,annotatedConductors:annotated.size,collinearOverlapsOrZeroLength:overlaps.size,unknownFlagConductors:unknownFlags.size,isolatedWithoutRealPins:isolated.size}},note:'Only anonymous unannotated root electrical leaf segments in physical networks with real pins were deleted. Named/annotated conductors, pin endpoints and internal taps, transparent WIRE pins, isolated networks, overlap segments, all drawing primitives, symbols, text and surviving opaque bytes remain unchanged. Every peeling round preserved stable original terminal partitions and per-bit aliases. Inspect fresh offsets; validate the consuming design with original compile/export/simulation.'};
}
