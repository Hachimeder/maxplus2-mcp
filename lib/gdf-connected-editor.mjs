/** Moves/rotates placements and reconnects each previously touching scalar pin.
 * Existing wires and labels remain byte-for-byte. New Manhattan extensions are
 * checked against every terminal partition before the transaction can commit. */
import {parseGdfGeometry,tokeniseGdfGeometry} from './gdf-geometry.mjs';
import {editGdfGeometry} from './gdf-editor.mjs';
import {constructGdf} from './gdf-authoring.mjs';
import {inspectGdfConnections,gdfTerminalPartitions,pointOnGdfWire} from './gdf-connections.mjs';

const eq=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y;
const key=p=>`${p.x},${p.y}`;
function integer(v,k,min,max){if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${k} must be an integer from ${min} to ${max}`);return v;}
function box(inst,def){const m=inst.transform.matrix;if(!m)return null;const ps=[[0,0],[def.extent.width,0],[0,def.extent.height],[def.extent.width,def.extent.height]].map(([x,y])=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]}));return {left:Math.min(...ps.map(p=>p.x)),right:Math.max(...ps.map(p=>p.x)),bottom:Math.min(...ps.map(p=>p.y)),top:Math.max(...ps.map(p=>p.y))};}
class Heap{constructor(){this.a=[];}push(v){const a=this.a;a.push(v);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p].f<=v.f)break;a[i]=a[p];i=p;}a[i]=v;}pop(){const a=this.a,v=a[0],t=a.pop();if(a.length){let i=0;while(2*i+1<a.length){let j=2*i+1;if(j+1<a.length&&a[j+1].f<a[j].f)j++;if(a[j].f>=t.f)break;a[i]=a[j];i=j;}a[i]=t;}return v;}get size(){return this.a.length;}}
function route(start,end,blocked,bounds,budget){
 if(eq(start,end))return [start];
 const h=p=>Math.abs(p.x-end.x)/8+Math.abs(p.y-end.y)/8;
 const open=new Heap(),seen=new Map(),prev=new Map();open.push({...start,k:key(start),g:0,f:h(start)});seen.set(key(start),0);
 while(open.size){const p=open.pop();if(p.g!==seen.get(p.k))continue;if(++budget.used>budget.max)throw new Error('Route search budget exceeded; move a smaller selection or choose an explicit route');if(eq(p,end)){const out=[end];let k=p.k;while(prev.has(k)){const prior=prev.get(k);out.push(prior.point);k=prior.key;}return out.reverse();}
  for(const [dx,dy] of [[8,0],[0,8],[-8,0],[0,-8]]){const q={x:p.x+dx,y:p.y+dy};if(q.x<bounds.left||q.x>bounds.right||q.y<bounds.bottom||q.y>bounds.top)continue;if(blocked(q,p))continue;const k=key(q),g=p.g+1;if(g>=(seen.get(k)??Infinity))continue;seen.set(k,g);prev.set(k,{point:{x:p.x,y:p.y},key:p.k});open.push({...q,k,g,f:g+h(q)});}
 }
 throw new Error(`No collision-free grid route between (${start.x},${start.y}) and (${end.x},${end.y}); use explicit gdf_construct wiring`);
}
function segments(points){const out=[];let a=points[0],b=points[1];if(!b)return out;for(let i=2;i<points.length;i++){const c=points[i];if((a.x===b.x&&b.x===c.x)||(a.y===b.y&&b.y===c.y)){b=c;continue;}out.push({start:a,end:b,orientation:a.y===b.y?'horizontal':'vertical'});a=b;b=c;}out.push({start:a,end:b,orientation:a.y===b.y?'horizontal':'vertical'});return out;}
function splitWires(buffer,pointsByOffset){
 const ts=tokeniseGdfGeometry(buffer);
 return Buffer.concat(ts.map(t=>{const points=pointsByOffset.get(t.offset);if(!points?.length)return t.body;const axis=t.opcode==='k'?'x':'y',start={x:t.values[0],y:t.values[1]},end={x:t.values[2],y:t.values[3]},sign=end[axis]>=start[axis]?1:-1,ps=[start,...[...new Map(points.map(p=>[key(p),p])).values()].sort((a,b)=>sign*(a[axis]-b[axis])),end];return Buffer.concat(ps.slice(1).map((p,i)=>{const b=Buffer.from(t.body);[ps[i].x,ps[i].y,p.x,p.y].forEach((v,j)=>b.writeInt16LE(v,1+2*j));const flags=(t.flags&~3)|(i===0?t.flags&1:1)|(i===ps.length-2?t.flags&2:2);b.writeUInt16LE(flags,9);return b;}));}));
}

export function moveGdfConnected(buffer,{edits,maxRouteSteps=100000}={}){
 if(!Array.isArray(edits)||!edits.length||edits.length>100)throw new Error('edits requires 1..100 placement changes');
 integer(maxRouteSteps,'maxRouteSteps',100,1000000);
 const before=parseGdfGeometry(buffer);if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Connected editing requires GDF version 6');
 const seen=new Set();
 for(const e of edits){if(!e||typeof e!=='object'||Array.isArray(e))throw new Error('Expected a placement edit');for(const k of Object.keys(e))if(!['recordOffset','dx','dy','orientation'].includes(k))throw new Error(`Unexpected connected edit field ${k}`);integer(e.recordOffset,'recordOffset',0,16777216);if(seen.has(e.recordOffset))throw new Error('Duplicate selected placement');seen.add(e.recordOffset);if(!before.placements.some(p=>p.offset===e.recordOffset))throw new Error('recordOffset must select an original symbol placement');if(e.dx===undefined&&e.dy===undefined&&e.orientation===undefined)throw new Error('Supply a displacement and/or orientation');for(const k of ['dx','dy'])if(e[k]!==undefined){integer(e[k],k,-65535,65535);if(e[k]%8)throw new Error('Connected displacement must lie on the electrical grid8');}if(e.orientation!==undefined)integer(e.orientation,'orientation',0,7);}
 const old=inspectGdfConnections(buffer);if(!old.completeScalarTopology)throw new Error('Connected edit requires fully understood scalar topology; inspect gdf_connections and resolve bus/unknown-label diagnostics first');
 let changed=buffer;const changes=[];
 for(const e of edits){if(e.dx!==undefined||e.dy!==undefined){const r=editGdfGeometry(changed,[{operation:'translate',recordOffset:e.recordOffset,dx:e.dx??0,dy:e.dy??0}]);changed=r.buffer;changes.push(...r.changes);}if(e.orientation!==undefined){const r=editGdfGeometry(changed,[{operation:'set_orientation',recordOffset:e.recordOffset,orientation:e.orientation}]);changed=r.buffer;changes.push(...r.changes);}}
 const afterPlacement=parseGdfGeometry(changed),netOf=new Map(),wireNet=new Map();for(const net of old.nets){for(const t of net.terminals)netOf.set(t.key,net.id);for(const w of net.wires)wireNet.set(w.recordOffset,net.id);}
 const allPins=afterPlacement.placements.flatMap((inst,i)=>inst.pins.map((p,j)=>({...p,key:`${i}/${j}`,placementOffset:inst.offset,net:netOf.get(`${i}/${j}`)}))),newPinByKey=new Map(allPins.map(p=>[p.key,p])),newPinsAt=new Map(),existing=before.sheet.wires.map(w=>({...w,net:wireNet.get(w.offset)})),added=[],routes=[];
 for(const p of allPins){const k=key(p.worldPosition);if(!newPinsAt.has(k))newPinsAt.set(k,[]);newPinsAt.get(k).push(p);}
 const definitions=new Map(afterPlacement.definitions.map(d=>[d.id,d])),boxes=afterPlacement.placements.map(p=>box(p,definitions.get(p.definitionId))).filter(Boolean);
 const coords=[...existing.flatMap(w=>[w.start,w.end]),...before.placements.flatMap(i=>i.pins.map(p=>p.worldPosition)),...allPins.map(p=>p.worldPosition)].filter(Boolean);
 const extent=coords.reduce((b,p)=>({left:Math.min(b.left,p.x),right:Math.max(b.right,p.x),bottom:Math.min(b.bottom,p.y),top:Math.max(b.top,p.y)}),{left:0,right:0,bottom:0,top:0});
 const bounds={left:Math.max(-32768,Math.floor((extent.left-128)/8)*8),right:Math.min(32760,Math.ceil((extent.right+128)/8)*8),bottom:Math.max(-32768,Math.floor((extent.bottom-128)/8)*8),top:Math.min(32760,Math.ceil((extent.top+128)/8)*8)};
 const budget={used:0,max:maxRouteSteps},collisions={used:0,max:4000000},splits=new Map(),oldPins=before.placements.flatMap((inst,i)=>inst.pins.map((p,j)=>({...p,key:`${i}/${j}`,placementOffset:inst.offset}))),oldPinCounts=new Map();
 const probe=()=>{if(++collisions.used>collisions.max)throw new Error('Route collision comparison budget exceeded; move a smaller drawing/selection or use explicit wires');};
 const any=(items,predicate)=>items.some(item=>{probe();return predicate(item);});
 for(const p of oldPins){const k=key(p.worldPosition);oldPinCounts.set(k,(oldPinCounts.get(k)??0)+1);}
 for(const p of oldPins.filter(p=>seen.has(p.placementOffset))){
  const q=newPinByKey.get(p.key);if(eq(p.worldPosition,q.worldPosition))continue;
  const touchingWires=existing.filter(w=>{probe();return pointOnGdfWire(p.worldPosition,w);});
  const touched=touchingWires.length||oldPinCounts.get(key(p.worldPosition))>1;
  if(!touched)continue;
  const start=p.worldPosition,end=q.worldPosition;for(const point of [start,end])for(const v of [point.x,point.y])if(!Number.isSafeInteger(v)||v%8||v<-32768||v>32760)throw new Error('Connected pin world coordinates must be grid8 signed16');
  for(const w of touchingWires)if(!eq(start,w.start)&&!eq(start,w.end)){if(!splits.has(w.offset))splits.set(w.offset,[]);splits.get(w.offset).push(start);}
  if(any(existing,w=>w.net===q.net&&pointOnGdfWire(end,w))||any(newPinsAt.get(key(end))??[],t=>t.key!==q.key&&t.net===q.net)){changes.push({operation:'retain_existing_pin_connection',terminal:p.key,pin:p.name,from:start,to:end});continue;}
  const net=netOf.get(p.key),obstacles=[...existing,...added].filter(w=>w.net!==net);
  const blocked=(point,from)=>any(obstacles,w=>eq(point,w.start)||eq(point,w.end)||from&&(point.y===from.y&&w.orientation==='horizontal'&&point.y===w.start.y&&Math.min(Math.max(point.x,from.x),Math.max(w.start.x,w.end.x))>Math.max(Math.min(point.x,from.x),Math.min(w.start.x,w.end.x))||point.x===from.x&&w.orientation==='vertical'&&point.x===w.start.x&&Math.min(Math.max(point.y,from.y),Math.max(w.start.y,w.end.y))>Math.max(Math.min(point.y,from.y),Math.min(w.start.y,w.end.y))))||any(newPinsAt.get(key(point))??[],p=>p.net!==net)||(!eq(point,start)&&!eq(point,end)&&any(boxes,b=>point.x>b.left&&point.x<b.right&&point.y>b.bottom&&point.y<b.top));
  if(any(obstacles,w=>pointOnGdfWire(start,w)||pointOnGdfWire(end,w))||blocked(start)||blocked(end))throw new Error('A selected pin overlaps another source net after this move');
  const path=route(start,end,blocked,bounds,budget),ss=segments(path);added.push(...ss.map(w=>({...w,net})));routes.push({terminal:p.key,instanceName:before.placements[p.placementIndex??Number(p.key.split('/')[0])].instanceName,pin:p.name,from:start,to:end,segments:ss});
 }
 const operations=added.map(w=>({operation:'add_wire',x1:w.start.x,y1:w.start.y,x2:w.end.x,y2:w.end.y}));
 if(operations.length>1000)throw new Error('Generated route requires more than 1000 wire segments');
 if(splits.size)changed=splitWires(changed,splits);
 if(operations.length)changed=constructGdf(changed,operations,()=>{throw new Error('No symbol source required');}).buffer;
 const verified=inspectGdfConnections(changed),beforePartitions=gdfTerminalPartitions(old),afterPartitions=gdfTerminalPartitions(verified);
 if(!verified.completeScalarTopology||JSON.stringify(beforePartitions)!==JSON.stringify(afterPartitions))throw new Error('Connected edit would change source pin connections or named-net membership; transaction refused. Inspect placement overlap or choose an explicit route.');
 return {buffer:changed,changes:[...changes,...[...splits].map(([recordOffset,points])=>({operation:'split_wire_at_previous_pin',recordOffset,points})),...routes.map(r=>({operation:'reconnect_pin',...r}))],connectionCheck:{preserved:true,terminalPartitions:beforePartitions.length,pins:old.counts.pins,splitWires:splits.size,addedSegments:added.length,routeSteps:budget.used,collisionComparisons:collisions.used,collisionComparisonLimit:collisions.max},note:'Original wires retained except splits at moved pins previously touching wire interiors; their flags and original annotation payloads are preserved. New grid8 Manhattan extensions reconnect moved pins. Every source terminal partition and scalar named-net membership was checked. Original compiler/export/simulation must validate behavior. Bus topology and macro internals are not expanded. Inspect fresh offsets after applying.'};
}
