/** Source topology: preserves every original instance and pin. This is not the
 * optimized compiler netlist. Buses/ambiguous labels are reported separately. */
import {parseGdfGeometry} from './gdf-geometry.mjs';

const same=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y;
export const pointOnGdfWire=(p,w)=>w.orientation==='horizontal'?p.y===w.start.y&&p.x>=Math.min(w.start.x,w.end.x)&&p.x<=Math.max(w.start.x,w.end.x):p.x===w.start.x&&p.y>=Math.min(w.start.y,w.end.y)&&p.y<=Math.max(w.start.y,w.end.y);
const endAt=(p,w)=>same(p,w.start)||same(p,w.end);
function contact(a,b){
 if(a.orientation===b.orientation){
  if(a.orientation==='horizontal'&&a.start.y!==b.start.y||a.orientation==='vertical'&&a.start.x!==b.start.x)return null;
  const axis=a.orientation==='horizontal'?'x':'y';
  const lo=Math.max(Math.min(a.start[axis],a.end[axis]),Math.min(b.start[axis],b.end[axis]));
  const hi=Math.min(Math.max(a.start[axis],a.end[axis]),Math.max(b.start[axis],b.end[axis]));
  if(lo>hi)return null;
  const p=a.orientation==='horizontal'?{x:lo,y:a.start.y}:{x:a.start.x,y:lo};
  return {point:p,kind:lo===hi?'endpoint':'overlap',joins:true};
 }
 const h=a.orientation==='horizontal'?a:b,v=a.orientation==='vertical'?a:b,p={x:v.start.x,y:h.start.y};
 if(!pointOnGdfWire(p,h)||!pointOnGdfWire(p,v))return null;
 // Interior/interior crossings have no endpoint to attach; explicit junctions
 // are represented as split segments meeting at their endpoints.
 const joins=endAt(p,h)&&endAt(p,v);
 return {point:p,kind:joins?'endpoint':endAt(p,h)||endAt(p,v)?'unsplit-T':'crossing',joins};
}
export function gdfSignalName(text,{expand=true}={}){
 if(typeof text!=='string')return null;
 const m=/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)(?:\.\.(\d+))?\])?$/.exec(text);
 if(!m)return null;
 if(m[3]!==undefined){const a=Number(m[2]),b=Number(m[3]);if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||Math.abs(a-b)>4095)return null;const step=a>b?-1:1,members=[];if(expand)for(let i=a;;i+=step){members.push(`${m[1]}[${i}]`);if(i===b)break;}return {text,key:text.toUpperCase(),vector:true,width:Math.abs(a-b)+1,members};}
 if(m[2]!==undefined&&!Number.isSafeInteger(Number(m[2])))return null;
 return {text,key:m[2]===undefined?m[1].toUpperCase():`${m[1].toUpperCase()}[${Number(m[2])}]`,vector:false,members:[text]};
}
class Union{constructor(n){this.p=Array.from({length:n},(_,i)=>i);}find(i){while(i!==this.p[i]){this.p[i]=this.p[this.p[i]];i=this.p[i];}return i;}join(a,b){a=this.find(a);b=this.find(b);if(a!==b)this.p[Math.max(a,b)]=Math.min(a,b);}}

export function inspectGdfConnections(buffer,{maxComparisons=2000000}={}){
 const g=parseGdfGeometry(buffer);if(g.header.magic!=='GDF')throw new Error('Source connections require a GDF file');
 if(!Number.isSafeInteger(maxComparisons)||maxComparisons<1||maxComparisons>10000000)throw new Error('maxComparisons must be 1..10000000');
 const diagnostics=[],diagnosticCodes=new Set(),wires=[...g.sheet.wires,...g.sheet.buses].sort((a,b)=>a.offset-b.offset),terminals=[];let diagnosticCount=0;
 const addDiagnostic=d=>{diagnosticCount++;diagnosticCodes.add(d.code);if(diagnostics.length<1000)diagnostics.push(d);};
 for(let i=0;i<g.placements.length;i++){
  const inst=g.placements[i];
  if(!inst.transform.understood)addDiagnostic({severity:'error',code:'unknown-placement-transform',recordOffset:inst.offset});
  inst.pins.forEach((p,j)=>{const text=['INPUT','OUTPUT','BIDIR','WIRE'].includes(inst.symbolName?.toUpperCase())?inst.nodeName:p.name,name=gdfSignalName(text,{expand:false});if(/[\[\]]/.test(text??'')&&!name)addDiagnostic({severity:'warning',code:'pin-range-unresolved',recordOffset:inst.offset,pinOffset:p.offset,text});terminals.push({key:`${i}/${j}`,placementIndex:i,pinIndex:j,instanceName:inst.instanceName,netId:inst.netId,symbolName:inst.symbolName,recordOffset:inst.offset,pinOffset:p.offset,name:p.name,worldPosition:p.worldPosition,nativeAttributeType:p.nativeAttributeType,direction:[2,46].includes(p.nativeAttributeType)?'input':[3,47].includes(p.nativeAttributeType)?'output':[4,48].includes(p.nativeAttributeType)?'bidirectional':'undetermined',bundle:Boolean(name?.vector)});});
 }
 if(wires.length+terminals.length>100000)throw new Error('Source topology exceeds 100000 conductors/terminals');
 const u=new Union(wires.length+terminals.length),joins=[],crossings=[];let comparisons=0,joinCount=0,crossingCount=0;
 const spend=()=>{if(++comparisons>maxComparisons)throw new Error('Source topology comparison budget exceeded; reduce drawing complexity');};
 for(let i=0;i<wires.length;i++)for(let j=i+1;j<wires.length;j++){
  spend();const c=contact(wires[i],wires[j]);if(!c)continue;
  const compatible=wires[i].thick===wires[j].thick;
  if(c.joins&&compatible){u.join(i,j);joinCount++;if(joins.length<1000)joins.push({wireOffsets:[wires[i].offset,wires[j].offset],...c});}
  else {crossingCount++;if(crossings.length<1000)crossings.push({wireOffsets:[wires[i].offset,wires[j].offset],...c,joins:false,reason:compatible?'no-shared-endpoint':'scalar-bus-contact'});}
 }
 const byPlacement=new Map();terminals.forEach((p,j)=>{if(!byPlacement.has(p.placementIndex))byPlacement.set(p.placementIndex,[]);byPlacement.get(p.placementIndex).push([p,j]);});
 const at=new Map();terminals.forEach((p,i)=>{if(!p.worldPosition)return;const k=`${p.worldPosition.x},${p.worldPosition.y}`,old=at.get(k)??[];for(const j of old){spend();if(p.bundle===terminals[j].bundle)u.join(wires.length+i,wires.length+j);}old.push(i);at.set(k,old);});
 terminals.forEach((p,i)=>{if(!p.worldPosition)return;wires.forEach((w,j)=>{spend();if(pointOnGdfWire(p.worldPosition,w)){if(p.bundle===w.thick)u.join(wires.length+i,j);else addDiagnostic({severity:'warning',code:'scalar-bus-pin-contact',terminal:p.key,wireOffset:w.offset});}});});
 const physicalRoots=Array.from({length:wires.length+terminals.length},(_,i)=>u.find(i));
 // WIRE is a transparent primitive, not a two-pin logic function. Its two
 // sides may have different names, so name conflicts use pre-WIRE components.
 g.placements.forEach((inst,i)=>{if(inst.symbolName?.toUpperCase()!=='WIRE')return;const ps=byPlacement.get(i)??[];if(ps.length!==2||ps[0][0].bundle!==ps[1][0].bundle){addDiagnostic({severity:'error',code:'unsupported-wire-interface',recordOffset:inst.offset});return;}u.join(wires.length+ps[0][1],wires.length+ps[1][1]);});
 const labels=[];
 wires.forEach((w,i)=>{for(const a of w.annotations??[])if(a.kindCode===6)labels.push({vertex:i,text:a.text,wireOffset:w.offset,attributeOffset:a.offset,bundle:w.thick});});
 g.placements.forEach((inst,i)=>{if(!['INPUT','OUTPUT','BIDIR','WIRE'].includes(inst.symbolName?.toUpperCase()))return;const ps=byPlacement.get(i)??[];if(inst.nodeName&&ps.length)labels.push({vertex:wires.length+ps[0][1],text:inst.nodeName,recordOffset:inst.offset,bundle:ps[0][0].bundle});});
 const named=new Map(),nameCache=new Map();let expandedMembers=0;
 const parseLabel=text=>{const k=text.toUpperCase();if(nameCache.has(k))return nameCache.get(k);const name=gdfSignalName(text,{expand:false});if(name?.vector){if(expandedMembers+name.width>100000)throw new Error('Source bus member expansion budget exceeded (100000 unique members)');expandedMembers+=name.width;name.members=gdfSignalName(text).members;}nameCache.set(k,name);return name;};
 const physicalNames=new Map();
 for(const label of labels){const name=parseLabel(label.text);label.parsed=name;if(!name){addDiagnostic({severity:'warning',code:'unsupported-signal-name',text:label.text,attributeOffset:label.attributeOffset,recordOffset:label.recordOffset});continue;}if(label.bundle!==name.vector){addDiagnostic({severity:'warning',code:'signal-width-not-resolved',text:label.text,wireOffset:label.wireOffset,recordOffset:label.recordOffset});continue;}const key=(label.bundle?'bus:':'scalar:')+name.key;if(named.has(key))u.join(label.vertex,named.get(key));else named.set(key,label.vertex);}
 for(const label of labels.filter(l=>l.parsed&&!l.bundle)){const k=physicalRoots[label.vertex];if(!physicalNames.has(k))physicalNames.set(k,[]);physicalNames.get(k).push(label);}
 for(const [component,ls] of physicalNames){const explicit=new Set(ls.filter(l=>l.wireOffset!==undefined).map(l=>l.parsed.key)),names=new Set(ls.map(l=>l.parsed.key));if(explicit.size>1||explicit.size&&names.size>1)addDiagnostic({severity:'error',code:'multiple-signal-names',physicalComponent:component,names:[...names],note:'Conflicting explicit wire names, or a wire label differing from an attached border pin.'});}
 const groups=new Map();const group=v=>{const k=u.find(v);if(!groups.has(k))groups.set(k,{id:`source-net:${k}`,wires:[],terminals:[],labels:[],bundle:false});return groups.get(k);};
 wires.forEach((w,i)=>{const n=group(i);n.wires.push({recordOffset:w.offset,start:w.start,end:w.end,endpointDots:w.endpointDots});n.bundle=w.thick;});
 terminals.forEach((p,i)=>{const n=group(wires.length+i);n.terminals.push(p);n.bundle=p.bundle;});
 labels.forEach(l=>group(l.vertex).labels.push({...l,vertex:undefined}));
 const nets=[...groups.values()];
 for(const n of nets){
  n.names=[...new Set(n.labels.map(l=>l.text))];n.terminalKeys=n.terminals.map(p=>p.key).sort();
  n.drivers=n.terminals.filter(p=>p.direction==='output'&&p.symbolName?.toUpperCase()!=='WIRE').map(p=>p.key);
  n.sinks=n.terminals.filter(p=>p.direction==='input'&&p.symbolName?.toUpperCase()!=='WIRE').map(p=>p.key);
  if(n.bundle){n.members=n.labels.filter(l=>l.parsed?.vector).map(l=>({name:l.text,members:l.parsed.members}));addDiagnostic({severity:'warning',code:'bus-member-topology-unresolved',net:n.id,names:n.names});}
  else if(n.terminals.length===1&&n.terminals[0].symbolName?.toUpperCase()!=='WIRE')addDiagnostic({severity:'warning',code:'unconnected-pin',terminal:n.terminals[0].key,instanceName:n.terminals[0].instanceName,pin:n.terminals[0].name});
  if(!n.bundle&&n.drivers.length>1)addDiagnostic({severity:'warning',code:'multiple-drivers',net:n.id,terminals:n.drivers,note:'Bidirectional, tri-state and wired-logic legality requires the original compiler.'});
  if(!n.bundle&&n.sinks.length&&!n.drivers.length&&!n.terminals.some(p=>p.direction==='bidirectional'))addDiagnostic({severity:'warning',code:'no-known-driver',net:n.id,terminals:n.sinks});
 }
 return {format:g.format,coordinateSystem:g.coordinateSystem,counts:{placements:g.placements.length,pins:terminals.length,wires:g.sheet.wires.length,buses:g.sheet.buses.length,nets:nets.length,joins:joinCount,crossings:crossingCount,diagnostics:diagnosticCount},nets,joins,crossings,diagnostics,detailTruncation:{diagnosticsReturned:diagnostics.length,diagnosticsTruncated:diagnosticCount>diagnostics.length,joinsReturned:joins.length,joinsTruncated:joinCount>joins.length,crossingsReturned:crossings.length,crossingsTruncated:crossingCount>crossings.length},expandedMembers,completeScalarTopology:!['unknown-placement-transform','pin-range-unresolved','unsupported-wire-interface','unsupported-signal-name','multiple-signal-names','signal-width-not-resolved','scalar-bus-pin-contact','bus-member-topology-unresolved'].some(code=>diagnosticCodes.has(code)),comparisons,limitations:['Source topology retains unsynthesized placement and pin identities; it does not expand macro bodies or prove logic equivalence.','Wires connect at shared endpoints. Interior crossings and unsplit T contacts remain separate, even with displayed endpoint dots.','Bus bundles and declared member names are reported; scalar taps, member permutations and hierarchical bus expansion require the original compiler.','Pin directions come from original native attributes; tri-state resolution and driver legality need original compilation.']};
}

/** Stable over placement coordinate changes and root wire insertion. */
export function gdfTerminalPartitions(model){return model.nets.filter(n=>n.terminals.length).map(n=>({terminals:n.terminalKeys,names:[...new Set(n.labels.filter(l=>l.parsed&&!l.bundle).map(l=>l.parsed.key))].sort()})).sort((a,b)=>a.terminals.join(',').localeCompare(b.terminals.join(',')));}
