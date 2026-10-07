/** Refresh selected embedded SYM definitions without rewriting instance r/h/u.
 * Geometric contacts are conservative evidence, never a circuit netlist claim.
 */
import {createHash} from 'node:crypto';
import {parseGdfGeometry,tokeniseGdfGeometry,rebuildGdfGeometry} from './gdf-geometry.mjs';
import {readSymbolPrototype} from './gdf-authoring.mjs';
import {inspectSymbol} from './gdf-symbol-editor.mjs';
import {assertGdfIdentities} from './gdf-identities.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const folded=s=>s.toUpperCase();
const pointKey=p=>p?`${p.x},${p.y}`:null;
const samePoint=(a,b)=>pointKey(a)===pointKey(b);
const PIN_CODES=new Set([2,3,4,46,47,48]);
const NAME_TYPES=new Set([1,19]);
const MAX_SELECTED=1000,MAX_SELECTED_PINS=100000,MAX_CONTACTS=200000,MAX_CONTACT_CANDIDATES=2000000;
const NOTE='Only selected embedded symbol graphics were refreshed. Header, root sheet/wires and every instance r/h/u segment retain original bytes, including NET_ID, DOC alias, parameters, position and orientation. Shared definitions may split into consecutive groups to preserve untouched instances. SYM defaults are not imported. Pin interfaces and geometric wire/pin contacts are reported; geometry alone does not prove circuit connectivity. Offsets change; inspect the resulting GDF and compile/export/simulate its isolated project.';
function integer(v,n,max=16777216){if(!Number.isSafeInteger(v)||v<0||v>max)throw new Error(`${n} must be a bounded nonnegative integer`);}
function object(o,keys,label){if(!o||typeof o!=='object'||Array.isArray(o))throw new Error(`${label} must be an object`);for(const k of Object.keys(o))if(!keys.includes(k))throw new Error(`Unexpected ${k} in ${label}`);}
function pinMap(pins,label){const result=new Map();for(const p of pins){if(typeof p.name!=='string'||!p.name.trim())throw new Error(`${label} has an empty/unsupported pin name`);const k=folded(p.name);if(result.has(k))throw new Error(`${label} has ambiguous duplicate pin names`);result.set(k,p);}return result;}
function direction(code){return {2:'input',3:'output',4:'bidirectional',46:'input',47:'output',48:'bidirectional'}[code]??'undetermined';}
function summary(p){return p?{name:p.name,nativeAttributeType:p.nativeAttributeType,direction:direction(p.nativeAttributeType),localPosition:p.localPosition??p.position,labelPosition:p.labelPosition??null,worldPosition:p.worldPosition??null}:null;}
function labels(pins,attributes){const map=new Map(attributes.map(a=>[a.id,a.position]));return pins.map(p=>({...p,labelPosition:map.get(p.attributeId)??null}));}

function groups(buffer,parsed,tokens){
  const starts=tokens.map((t,i)=>t.opcode==='g'?i:-1).filter(i=>i>=0),result=[];
  for(const[index,start]of starts.entries()){
    const end=starts[index+1]??tokens.length-1,members=tokens.slice(start,end),definition=parsed.definitions[index];
    if(!definition||members[1]?.offset!==definition.offset)throw new Error('GDF reusable definition markers are ambiguous');
    const placementStarts=members.map((t,i)=>t.opcode==='r'?i:-1).filter(i=>i>=0),first=placementStarts[0]??-1,graph=members.slice(1,first<0?members.length:first),instances=[];
    if(placementStarts.length!==definition.instances.length)throw new Error('GDF instance records and sharedgraph ownership disagree');
    for(const [n,p]of definition.instances.entries()){
      const from=placementStarts[n],to=placementStarts[n+1]??members.length;if(members[from].offset!==p.offset)throw new Error('GDF instance record order is ambiguous');
      instances.push({placement:p,tokens:members.slice(from,to),bytes:buffer.subarray(p.offset,members[to-1].end)});
    }
    result.push({index,definition,marker:members[0],graph,instances,raw:members});
  }
  if(result.length!==parsed.definitions.length)throw new Error('GDF definition and sharedgraph marker counts disagree');
  return {root:tokens.slice(0,starts[0]??tokens.length-1),groups:result,terminal:tokens.at(-1)};
}
function selection(parsed,selectors){
  if(!Array.isArray(selectors)||!selectors.length||selectors.length>MAX_SELECTED)throw new Error(`selectors must contain 1 through ${MAX_SELECTED} entries`);
  const selected=new Set(),offsets=new Map(parsed.placements.map(p=>[p.offset,p])),names=new Map();for(const p of parsed.placements){if(p.instanceName===null)continue;const k=folded(p.instanceName);if(!names.has(k))names.set(k,[]);names.get(k).push(p);}
  for(const selector of selectors){
    object(selector,['recordOffset','definitionIndex','instanceName'],'selector');const keys=Object.keys(selector);if(keys.length!==1)throw new Error('Each selector requires exactly one recordOffset, definitionIndex or instanceName');
    let matches;
    if(keys[0]==='recordOffset'){integer(selector.recordOffset,'recordOffset');const p=offsets.get(selector.recordOffset);matches=p?[p]:[];}
    else if(keys[0]==='definitionIndex'){integer(selector.definitionIndex,'definitionIndex',1000000);const d=parsed.definitions[selector.definitionIndex];matches=d?.instances??[];}
    else{const name=selector.instanceName;if(typeof name!=='string'||!name||name.length>128)throw new Error('instanceName selector must be a bounded nonempty string');matches=names.get(folded(name))??[];if(matches.length>1)throw new Error('instanceName is ambiguous; select an original recordOffset instead');}
    if(!matches.length)throw new Error('Selector does not address an existing GDF instance');
    for(const p of matches){if(selected.has(p.offset))throw new Error('Selectors overlap; each instance may be refreshed once');selected.add(p.offset);}
    if(selected.size>MAX_SELECTED)throw new Error(`Refresh is limited to ${MAX_SELECTED} selected instances per transaction`);
  }
  return selected;
}

function wireIndex(parsed){
  const horizontal=new Map(),vertical=new Map();
  for(const w of [...parsed.sheet.wires,...parsed.sheet.buses]){const map=w.opcode==='k'?horizontal:vertical,k=w.opcode==='k'?w.start.y:w.start.x;if(!map.has(k))map.set(k,[]);map.get(k).push(w);}
  return {horizontal,vertical};
}
function placedPinIndex(parsed,originalOffsets){
  const map=new Map();for(const[i,p]of parsed.placements.entries())for(const pin of p.pins){const key=pointKey(pin.worldPosition);if(!key)continue;if(!map.has(key))map.set(key,[]);map.get(key).push({key:`pin:${originalOffsets[i]}:${folded(pin.name)}`,kind:'pin',recordOffset:originalOffsets[i],instanceName:p.instanceName,pinName:pin.name,position:pin.worldPosition});}return map;
}
function contacts(pin,placementOffset,index,wires,budget){
  if(!pin?.worldPosition)return[];const p=pin.worldPosition,items=[];
  const candidate=()=>{if(++budget.candidates>MAX_CONTACT_CANDIDATES)throw new Error('Refresh geometric contact analysis exceeds its bounded candidate budget');},add=item=>{if(++budget.value>MAX_CONTACTS)throw new Error('Refresh geometric contact analysis exceeds its bounded contact budget');items.push(item);};
  for(const [map,k,a]of [[wires.horizontal,p.y,'x'],[wires.vertical,p.x,'y']])for(const w of map.get(k)??[]){candidate();if(p[a]<Math.min(w.start[a],w.end[a])||p[a]>Math.max(w.start[a],w.end[a]))continue;add({key:`wire:${w.offset}`,kind:w.electricalRole,recordOffset:w.offset,at:samePoint(p,w.start)||samePoint(p,w.end)?'endpoint':'interior',position:p});}
  const own=`pin:${placementOffset}:${folded(pin.name)}`;for(const other of index.get(pointKey(p))??[]){candidate();if(other.key!==own)add(other);}return items.sort((a,b)=>a.key.localeCompare(b.key));
}
function compareInterface(oldPins,newPins){
  const old=pinMap(oldPins,'Existing definition'),next=pinMap(newPins,'SYM source'),added=[],removed=[],changed=[];
  for(const[k,p]of old){const n=next.get(k);if(!n)removed.push(summary(p));else if(p.name!==n.name||p.nativeAttributeType!==n.nativeAttributeType)changed.push({before:summary(p),after:summary(n),fields:[...(p.name!==n.name?['name']:[]),...(p.nativeAttributeType!==n.nativeAttributeType?['nativeAttributeType']:[])]});}
  for(const[k,p]of next)if(!old.has(k))added.push(summary(p));return {added,removed,changed,changedInterface:Boolean(added.length||removed.length||changed.length),unchanged:old.size-removed.length-changed.length};
}
function prepare(buffer,symbolBuffer,options={}){
  object(options,['selectors','allowDisconnected','allowInterfaceChanges'],'refresh options');for(const k of ['allowDisconnected','allowInterfaceChanges'])if(options[k]!==undefined&&typeof options[k]!=='boolean')throw new Error(`${k} must be boolean`);
  const parsed=parseGdfGeometry(buffer);if(parsed.header.magic!=='GDF'||parsed.header.version!==6)throw new Error('Symbol refresh supports a modern GDF version 6 only');assertGdfIdentities(parsed.placements);
  const symbol=inspectSymbol(symbolBuffer),prototype=readSymbolPrototype(symbolBuffer),selected=selection(parsed,options.selectors),tokens=tokeniseGdfGeometry(buffer),split=groups(buffer,parsed,tokens),blockers=[],pending=[],planned=[...split.root];
  if(!rebuildGdfGeometry(tokens).equals(buffer))throw new Error('Original GDF framing does not round-trip');
  const sourcePins=pinMap(symbol.pins,'SYM source');if(symbol.pins.some(p=>!PIN_CODES.has(p.nativeAttributeType)))throw new Error('SYM source contains unsupported pin attribute semantics');let pinsToCompare=0;
  for(const group of split.groups){
    const chosen=group.instances.filter(i=>selected.has(i.placement.offset));if(!chosen.length){planned.push(...group.raw);continue;}
    const names=group.definition.attributes.filter(a=>a.nativeType===7&&NAME_TYPES.has(a.kindCode));if(names.length!==1)throw new Error('Selected GDF definition has an ambiguous original native name');
    if(folded(group.definition.name??'')!==folded(symbol.symbolName)||names[0].kindCode!==({SYM_NAME:1,MACRO_NAME:19}[symbol.nameAttributeName]))throw new Error('Refresh requires the same symbol name and native SYM_NAME/MACRO_NAME type; replacing a different symbol type would reinterpret preserved instance attributes');
    const oldDefinitionPins=pinMap(group.definition.pins,'Existing definition');
    const interfaceChanges=compareInterface(labels(group.definition.pins,group.definition.attributes),symbol.pins),graphBefore=rebuildGdfGeometry(group.graph),graphAfter=rebuildGdfGeometry(prototype.graph),graphChanged=!graphBefore.equals(graphAfter);
    if(interfaceChanges.changedInterface&&!options.allowInterfaceChanges)blockers.push({code:'interface-change',definitionIndex:group.index,instanceOffsets:chosen.map(i=>i.placement.offset),message:'Pin names/types were added, removed or changed; allowInterfaceChanges is required.'});
    for(const i of chosen){pinsToCompare+=i.placement.pins.length+symbol.pins.length;if(pinsToCompare>MAX_SELECTED_PINS)throw new Error('Refresh pin comparison exceeds its bounded pin budget');
      for(const attr of i.placement.attributes.filter(a=>a.nativeType===8&&PIN_CODES.has(a.kindCode))){
        const old=oldDefinitionPins.get(folded(attr.text)),next=sourcePins.get(folded(attr.text));
        if(old&&!next)blockers.push({code:'orphaned-instance-pin-default',recordOffset:i.placement.offset,attributeOffset:attr.offset,pinName:attr.text,message:'Preserved instance pin attribute would lose its definition pin. This refresh cannot rewrite or drop instance defaults.'});
        else if(old&&next&&direction(old.nativeAttributeType)!==direction(next.nativeAttributeType))blockers.push({code:'instance-pin-default-direction-change',recordOffset:i.placement.offset,attributeOffset:attr.offset,pinName:attr.text,message:'Preserved instance pin attribute would refer to a pin with a different direction; use a separate explicit instance-attribute workflow.'});
      }
      pending.push({group,instance:i,interfaceChanges,graphChanged,graphBeforeSha256:hash(graphBefore),graphAfterSha256:hash(graphAfter)});
    }
    if(!graphChanged){planned.push(...group.raw);continue;}
    // Keep original instance sequence: each contiguous selection run gets a g/f
    // graph. Unselected placements continue to use their original definition.
    let run=[];let mode=null;const emit=()=>{if(!run.length)return;planned.push(group.marker,...(mode?prototype.graph:group.graph),...run.flatMap(i=>i.tokens));run=[];};
    for(const i of group.instances){const chosen=selected.has(i.placement.offset);if(mode!==null&&mode!==chosen)emit();mode=chosen;run.push(i);}emit();
  }
  planned.push(split.terminal);const result=rebuildGdfGeometry(planned),after=parseGdfGeometry(result),actual=tokeniseGdfGeometry(result);
  if(actual.length!==planned.length||actual.some((t,i)=>t.opcode!==planned[i].opcode||(t.opcode==='q'&&t.nativeType!==planned[i].nativeType)))throw new Error('Refresh would change record framing or native text ownership');
  if(after.placements.length!==parsed.placements.length)throw new Error('Refresh changed the number of instances');assertGdfIdentities(after.placements);
  const afterSplit=groups(result,after,actual),oldInstances=split.groups.flatMap(g=>g.instances),newInstances=afterSplit.groups.flatMap(g=>g.instances);
  for(let i=0;i<oldInstances.length;i++)if(!newInstances[i].bytes.equals(oldInstances[i].bytes))throw new Error('Refresh changed an original instance placement/default/parameter segment');
  if(!rebuildGdfGeometry(afterSplit.root).equals(rebuildGdfGeometry(split.root)))throw new Error('Refresh changed root sheet or header bytes');
  const originalOffsets=parsed.placements.map(p=>p.offset),beforePinIndex=placedPinIndex(parsed,originalOffsets),afterPinIndex=placedPinIndex(after,originalOffsets),wires=wireIndex(parsed),budget={value:0,candidates:0},afterMap=new Map(after.placements.map((p,i)=>[originalOffsets[i],p])),definitionsAfter=new Map(after.definitions.map((d,i)=>[d.id,{definition:d,index:i}])),changes=[];
  for(const p of pending){
    const old=p.instance.placement,next=afterMap.get(old.offset),nextDefinition=definitionsAfter.get(next.definitionId),oldPins=pinMap(labels(old.pins,p.group.definition.attributes),'Old instance'),newPins=pinMap(labels(next.pins,nextDefinition.definition.attributes),'Refreshed instance'),pinChanges=[];
    if(!old.transform.understood||!next.transform.understood||[...old.pins,...next.pins].some(pin=>!pin.worldPosition))blockers.push({code:'unknown-world-pin-transform',recordOffset:old.offset,message:'Original/new pin world coordinates cannot be established; safe contact comparison is unavailable.'});
    for(const name of new Set([...oldPins.keys(),...newPins.keys()])){
      const a=oldPins.get(name),b=newPins.get(name),beforeContacts=contacts(a,old.offset,beforePinIndex,wires,budget),afterContacts=contacts(b,old.offset,afterPinIndex,wires,budget),priorKeys=new Set(beforeContacts.map(c=>c.key)),nextContacts=new Map(afterContacts.map(c=>[c.key,c])),lostContacts=beforeContacts.filter(c=>!nextContacts.has(c.key)),newContacts=afterContacts.filter(c=>!priorKeys.has(c.key)),alignmentChanges=beforeContacts.flatMap(c=>{const n=nextContacts.get(c.key);return n&&c.at!==n.at?[{key:c.key,before:c.at,after:n.at}]:[];}),fields=[];
      if(!a)fields.push('added');else if(!b)fields.push('removed');else{if(a.name!==b.name)fields.push('name');if(a.nativeAttributeType!==b.nativeAttributeType)fields.push('nativeAttributeType');if(!samePoint(a.localPosition,b.localPosition))fields.push('localPosition');if(!samePoint(a.labelPosition,b.labelPosition))fields.push('labelPosition');if(!samePoint(a.worldPosition,b.worldPosition))fields.push('worldPosition');}
      if(lostContacts.length||newContacts.length||alignmentChanges.length){fields.push('geometricContacts');if(!options.allowDisconnected)blockers.push({code:'geometric-contact-change',recordOffset:old.offset,pinName:a?.name??b.name,lostContacts:lostContacts.map(c=>c.key),newContacts:newContacts.map(c=>c.key),alignmentChanges,message:'An existing wire/pin contact or wire-end alignment would change; allowDisconnected is required.'});}
      if(fields.length)pinChanges.push({before:summary(a),after:summary(b),fields,contacts:{before:beforeContacts,after:afterContacts,lost:lostContacts,added:newContacts,alignmentChanges}});
    }
    changes.push({operation:'refresh_symbol',recordOffset:old.offset,resultingRecordOffset:next.offset,definitionIndex:p.group.index,resultingDefinitionIndex:nextDefinition.index,instanceName:old.instanceName,symbolName:old.symbolName,sourceSha256:symbol.sha256,graphChanged:p.graphChanged,graphBeforeSha256:p.graphBeforeSha256,graphAfterSha256:p.graphAfterSha256,extent:{before:p.group.definition.extent,after:symbol.extent},interfaceChanges:p.interfaceChanges,pinChanges,preserved:{instanceBytesSha256:hash(p.instance.bytes),netId:old.netId,netIdText:old.netIdText,position:old.position,orientation:old.transform.code,attributeCount:old.attributes.length},effectivePosition:{before:old.effectivePosition,after:next.effectivePosition}});
  }
  const preview={gdfSha256:hash(buffer),symbol:{sha256:symbol.sha256,name:symbol.symbolName,nameAttributeName:symbol.nameAttributeName,bytes:symbolBuffer.length,defaultBytesIgnored:rebuildGdfGeometry(prototype.defaults).length},changes,canApply:blockers.length===0,blockers,counts:{selected:selected.size,definitionsBefore:parsed.definitions.length,definitionsAfter:after.definitions.length,pinChanges:changes.reduce((n,c)=>n+c.pinChanges.length,0),contactChanges:changes.reduce((n,c)=>n+c.pinChanges.filter(p=>p.fields.includes('geometricContacts')).length,0)},note:NOTE};
  return {buffer:result,preview};
}

/** Always returns a reviewable safety preview for valid inputs. Invalid selector,
 * different symbol type, corrupt framing or ambiguous names remain errors. */
export function inspectGdfSymbolRefresh(buffer,symbolBuffer,options){return prepare(buffer,symbolBuffer,options).preview;}
/** Application refuses unacknowledged interface/contact changes. File wrapper
 * owns source/target hash guards, preview, backup and atomic replacement. */
export function refreshGdfSymbol(buffer,symbolBuffer,options){
  const prepared=prepare(buffer,symbolBuffer,options);if(!prepared.preview.canApply){const error=new Error(`Symbol refresh refused: ${prepared.preview.blockers.map(b=>b.code).join(', ')}`);error.preview=prepared.preview;throw error;}
  return {buffer:prepared.buffer,changes:prepared.preview.changes,note:NOTE,counts:prepared.preview.counts,source:prepared.preview.symbol};
}
