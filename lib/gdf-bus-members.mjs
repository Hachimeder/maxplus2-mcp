/** Explicit-range source bit topology. Private MAX+plus II cases are checked
 * in test/gdf-v09-connectivity-oracle.mjs. No synthesis or SDK dependency.
 * Unknown parameterized macro widths remain unresolved, never guessed.
 */
import {parseGdfGeometry} from './gdf-geometry.mjs';

function signalHeader(text){
 if(typeof text!=='string')return null;
 const m=/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)(?:\.\.(\d+))?\])?$/.exec(text);
 if(!m)return null;
 const base=m[1].toUpperCase();
 if(m[3]===undefined){const index=m[2]===undefined?null:Number(m[2]);if(index!==null&&!Number.isSafeInteger(index))return null;return {text,base,vector:false,index,width:1};}
 const first=Number(m[2]),last=Number(m[3]);if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||Math.abs(first-last)>4095)return null;
 return {text,base,vector:true,first,last,width:Math.abs(first-last)+1};
}
function expandSignal(header){
 if(!header.vector){const {index,...rest}=header;return {...rest,members:[{name:index===null?header.base:`${header.base}[${index}]`,index}]};}
 const {first,last,base}=header,step=first>last?-1:1,members=[];for(let i=first;;i+=step){members.push({name:`${base}[${i}]`,index:i});if(i===last)break;}
 return {...header,members};
}
export function declaredGdfSignal(text){
 const header=signalHeader(text);return header?expandSignal(header):null;
}
class Union{constructor(n=0){this.p=Array.from({length:n},(_,i)=>i);}add(){const n=this.p.length;this.p.push(n);return n;}find(i){while(this.p[i]!==i){this.p[i]=this.p[this.p[i]];i=this.p[i];}return i;}join(a,b){a=this.find(a);b=this.find(b);if(a!==b)this.p[Math.max(a,b)]=Math.min(a,b);}}
const same=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y;
const on=(p,w)=>w.orientation==='horizontal'?p.y===w.start.y&&p.x>=Math.min(w.start.x,w.end.x)&&p.x<=Math.max(w.start.x,w.end.x):p.x===w.start.x&&p.y>=Math.min(w.start.y,w.end.y)&&p.y<=Math.max(w.start.y,w.end.y);
const endpoint=(p,w)=>same(p,w.start)||same(p,w.end);
function touches(a,b){
 if(a.orientation===b.orientation){const axis=a.orientation==='horizontal'?'x':'y',fixed=axis==='x'?'y':'x';return a.start[fixed]===b.start[fixed]&&Math.max(Math.min(a.start[axis],a.end[axis]),Math.min(b.start[axis],b.end[axis]))<=Math.min(Math.max(a.start[axis],a.end[axis]),Math.max(b.start[axis],b.end[axis]));}
 const h=a.orientation==='horizontal'?a:b,v=a.orientation==='vertical'?a:b,p={x:v.start.x,y:h.start.y};return on(p,h)&&on(p,v)&&endpoint(p,h)&&endpoint(p,v);
}

/** Returns per-bit terminals for explicit ranges and scalar member aliases.
 * WIRE maps listed range positions; actual bit indices are retained in each
 * terminal. complete=false when any bundle/interface width is unresolved.
 */
export function inspectGdfBusMembers(buffer,{maxComparisons=2000000,maxBits=100000}={}){
 if(!Number.isSafeInteger(maxComparisons)||maxComparisons<1||maxComparisons>10000000)throw new Error('maxComparisons must be 1..10000000');
 if(!Number.isSafeInteger(maxBits)||maxBits<1||maxBits>1000000)throw new Error('maxBits must be 1..1000000');
 const g=parseGdfGeometry(buffer);if(g.header.magic!=='GDF')throw new Error('Bit topology requires a GDF file');
 const wires=[...g.sheet.wires,...g.sheet.buses].sort((a,b)=>a.offset-b.offset),pins=[],pinsByInstance=new Map(),diagnostics=[];let diagnosticCount=0;
 const note=d=>{diagnosticCount++;if(diagnostics.length<1000)diagnostics.push(d);};
 const declarations=new Map();let declaredMembers=0;
 // A single native range may contain 4096 members, but repeated interfaces
 // share it for this query. Validate a fixed total budget before allocating
 // any member objects; maxBits cannot enlarge this parsing budget.
 const declared=text=>{if(declarations.has(text))return declarations.get(text);const header=signalHeader(text);if(!header){declarations.set(text,null);return null;}if(declaredMembers+header.width>100000)throw new Error('Declared signal member generation exceeds fixed 100000-member query budget');declaredMembers+=header.width;const value=expandSignal(header);declarations.set(text,value);return value;};
 let comparisons=0;const spend=()=>{if(++comparisons>maxComparisons)throw new Error('Bit topology comparison budget exceeded');};
 for(const inst of g.placements){
  const border=['INPUT','OUTPUT','BIDIR'].includes(inst.symbolName?.toUpperCase()),wire=inst.symbolName?.toUpperCase()==='WIRE';
  const owned=[];for(const p of inst.pins){const text=border?inst.nodeName:p.name,signal=declared(text),unresolved=!wire&&!signal&&!/^\d+$/.test(text??''),pin={vertex:wires.length+pins.length,instanceName:inst.instanceName,recordOffset:inst.offset,pinOffset:p.offset,pinName:p.name,position:p.worldPosition,symbolName:inst.symbolName,declared:signal,border,wire,bundle:wire||unresolved?null:Boolean(signal?.vector),direction:[2,46].includes(p.nativeAttributeType)?'input':[3,47].includes(p.nativeAttributeType)?'output':[4,48].includes(p.nativeAttributeType)?'bidirectional':'undetermined'};if(unresolved)note({code:'pin-range-or-name-unresolved',recordOffset:inst.offset,pinOffset:p.offset,pinName:p.name});pins.push(pin);owned.push(pin);}pinsByInstance.set(inst.offset,owned);
 }
 if(wires.length+pins.length>100000)throw new Error('Bit topology exceeds 100000 conductors/terminals');
 const physical=new Union(wires.length+pins.length),contacts=new Map();
 wires.forEach((a,i)=>{for(let j=i+1;j<wires.length;j++){spend();if(a.thick===wires[j].thick&&touches(a,wires[j]))physical.join(i,j);}});
 for(const p of pins){
  if(!p.position){note({code:'unknown-pin-transform',recordOffset:p.recordOffset,pinOffset:p.pinOffset});continue;}
  const hit=[];wires.forEach((w,i)=>{spend();if(on(p.position,w))hit.push(i);});contacts.set(p.vertex,hit);
  if(p.wire){const families=new Set(hit.map(i=>wires[i].thick));if(families.size===1)p.bundle=[...families][0];else if(families.size>1)note({code:'ambiguous-WIRE-pin-width',recordOffset:p.recordOffset,pinOffset:p.pinOffset});}
 }
 // A free WIRE pin inherits the family of its other pin; range width is still
 // obtained from named conductor components, not from this boolean family.
 for(const inst of g.placements.filter(p=>p.symbolName?.toUpperCase()==='WIRE')){const pair=pinsByInstance.get(inst.offset);if(pair.length===2){if(pair[0].bundle===null&&pair[1].bundle!==null)pair[0].bundle=pair[1].bundle;if(pair[1].bundle===null&&pair[0].bundle!==null)pair[1].bundle=pair[0].bundle;}else note({code:'unsupported-WIRE-interface',recordOffset:inst.offset});}
 for(const p of pins)for(const i of contacts.get(p.vertex)||[]){if(p.bundle===wires[i].thick)physical.join(p.vertex,i);else note({code:'unresolved-pin-bundle-contact',recordOffset:p.recordOffset,pinOffset:p.pinOffset,wireOffset:wires[i].offset});}
 const positions=new Map();for(const p of pins){if(!p.position)continue;const key=p.position.x+','+p.position.y,prev=positions.get(key)||[];for(const q of prev){spend();if(p.bundle!==null&&p.bundle===q.bundle)physical.join(p.vertex,q.vertex);}prev.push(p);positions.set(key,prev);}
 const components=new Map(),component=v=>{const key=physical.find(v);if(!components.has(key))components.set(key,{key,bundle:null,pins:[],wires:[],labels:[],slots:[]});return components.get(key);};
 wires.forEach((w,i)=>{const c=component(i);c.bundle=w.thick;c.wires.push(w);for(const a of w.annotations||[])if(a.kindCode===6)c.labels.push({text:a.text,declared:declared(a.text),wireOffset:w.offset,attributeOffset:a.offset,origin:'wire'});});
 for(const p of pins){const c=component(p.vertex);c.pins.push(p);if(c.bundle===null)c.bundle=p.bundle;if(p.border&&p.declared)c.labels.push({text:p.declared.text,declared:p.declared,recordOffset:p.recordOffset,pinOffset:p.pinOffset,origin:'border'});else if(p.declared?.vector)c.labels.push({text:p.declared.text,declared:p.declared,recordOffset:p.recordOffset,pinOffset:p.pinOffset,origin:'macro-pin'});}
 const bits=new Union(),named=new Map(),attachments=[];
 const slot=()=>{if(bits.p.length>=maxBits)throw new Error('Bit topology expansion exceeds maxBits');return bits.add();};
 function alias(v,name){if(named.has(name))bits.join(v,named.get(name));else named.set(name,v);}
 for(const c of components.values()){
  const ranges=c.labels.filter(l=>l.declared?.vector),widths=new Set(ranges.map(l=>l.declared.width));
  if(c.bundle===null){note({code:'unresolved-component-family',component:c.key});continue;}
  if(c.bundle&&widths.size!==1){note({code:widths.size?'conflicting-bus-widths':'bus-width-unresolved',component:c.key,ranges:ranges.map(l=>l.text)});continue;}
  const width=c.bundle?[...widths][0]:1;if(attachments.length+width*(c.wires.length+c.pins.length+c.labels.length)>Math.min(2000000,maxBits*8))throw new Error('Bit topology attachment expansion limit exceeded');c.slots=Array.from({length:width},slot);
  for(const l of c.labels){if(!l.declared){note({code:'unsupported-signal-name',component:c.key,text:l.text});continue;}if(l.declared.vector!==c.bundle){note({code:'signal-family-conflict',component:c.key,text:l.text});continue;}
   // Macro pin names belong to this instance. They establish the interface
   // width and terminal member indices, never global remote signal aliases.
   if(l.origin==='macro-pin')continue;
   l.declared.members.forEach((m,i)=>{alias(c.slots[i],m.name);attachments.push({vertex:c.slots[i],kind:'alias',name:m.name,origin:l.origin,wireOffset:l.wireOffset,attributeOffset:l.attributeOffset,recordOffset:l.recordOffset,memberOrdinal:i});});
  }
  for(const p of c.pins){
   if(c.bundle&&!p.declared?.vector&&!p.wire){note({code:'macro-pin-range-unresolved',recordOffset:p.recordOffset,pinOffset:p.pinOffset});continue;}
   const members=p.wire?c.slots.map(()=>({name:null,index:null})):c.bundle?p.declared.members:[{name:p.pinName,index:null}];
   members.forEach((m,i)=>attachments.push({vertex:c.slots[i],kind:'terminal',instanceName:p.instanceName,recordOffset:p.recordOffset,pinOffset:p.pinOffset,pinName:p.pinName,symbolName:p.symbolName,direction:p.direction,member:c.bundle?m.name:null,logicalIndex:m.index,memberOrdinal:i,bundle:c.bundle,transparent:p.wire,scope:p.border?'global-port':'instance-local'}));
  }
  c.wires.forEach(w=>c.slots.forEach((v,i)=>attachments.push({vertex:v,kind:'wire',wireOffset:w.offset,memberOrdinal:i,bundle:c.bundle})));
 }
 const bridges=[];
 for(const inst of g.placements.filter(p=>p.symbolName?.toUpperCase()==='WIRE')){
  const pair=pinsByInstance.get(inst.offset);if(pair.length!==2)continue;
  const a=component(pair[0].vertex),b=component(pair[1].vertex);
  if(!a.slots.length||!b.slots.length||a.slots.length!==b.slots.length){note({code:'WIRE-member-width-unresolved',recordOffset:inst.offset,widths:[a.slots.length,b.slots.length]});continue;}
  a.slots.forEach((v,i)=>bits.join(v,b.slots[i]));bridges.push({recordOffset:inst.offset,pinOffsets:pair.map(p=>p.pinOffset),width:a.slots.length,memberMapping:'listed-range-order',components:[a.key,b.key]});
 }
 const groups=new Map();for(const a of attachments){const id=bits.find(a.vertex);if(!groups.has(id))groups.set(id,{id:`source-bit:${id}`,aliases:[],terminals:[],wires:[],bundle:false});const n=groups.get(id);n.bundle||=Boolean(a.bundle);const value={...a};delete value.vertex;delete value.kind;if(a.kind==='alias')n.aliases.push(value);else if(a.kind==='terminal')n.terminals.push(value);else n.wires.push(value);}
 const nets=[...groups.values()];for(const n of nets){n.names=[...new Set(n.aliases.map(a=>a.name))].sort();n.terminalKeys=n.terminals.map(p=>`${p.recordOffset}/${p.pinOffset}/${p.member??(p.bundle?'@'+p.memberOrdinal:'')}`).sort();}
 return {counts:{components:components.size,bitNets:nets.length,expandedSlots:bits.p.length,declaredMembers,distinctDeclarations:declarations.size,bridges:bridges.length,diagnostics:diagnosticCount},nets,bridges,diagnostics,diagnosticsReturned:diagnostics.length,diagnosticsTruncated:diagnosticCount>diagnostics.length,complete:diagnosticCount===0,comparisons,limitations:['Only explicit numeric ranges and exact scalar member aliases are expanded. Parameter-dependent macro pin ranges and hierarchy bodies remain unresolved.','WIRE maps positions in the listed ranges; it can change signal names and reverse logical bit indices.','This source bit model preserves pins and does not evaluate gates, infer constants, or prove original compiler acceptance.']};
}
