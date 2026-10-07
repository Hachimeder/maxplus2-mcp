/** Modern GDF construction using recovered records and original SYM prototypes.
 * Source offsets always refer to the input file. Untouched record bytes are kept.
 * This writer constructs geometry; compiler/simulator evidence decides behavior. */
import {createHash} from 'node:crypto';
import {parseGdfGeometry,tokeniseGdfGeometry} from './gdf-geometry.mjs';
import {gdfString,replaceGdfLabel,writeParameterTokens,formatParameters,parameterSummary,MAX_GDF_TEXT_BYTES,MCP_INSTANCE_NAME_PREFIX} from './gdf-properties.mjs';
import {AUTO_NET_ID_MIN,AUTO_NET_ID_MAX,nativeGdfIdentityKey,assertGdfIdentities} from './gdf-identities.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const PHASE={k:2,l:3,m:4,n:5,o:6,q:7,p:7};
const FIELDS={
  add_symbol:['operation','symbolPath','symbolSha256','name','nodeName','x','y','orientation','parameters'],
  delete_symbol:['operation','recordOffset'],
  add_wire:['operation','x1','y1','x2','y2','bus','startDot','endDot','nodeName'],
  delete_wire:['operation','recordOffset'],
  set_node_name:['operation','recordOffset','nodeName'],
  set_wire_name:['operation','recordOffset','nodeName'],
  clear_wire_name:['operation','recordOffset'],
  set_parameters:['operation','recordOffset','parameters'],
  clear_parameters:['operation','recordOffset'],
  normalize_net_ids:['operation'],
  add_annotation:['operation','x','y','text'],
  delete_annotation:['operation','recordOffset'],
};
function int(v,name,min=-32768,max=32767){if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return v;}
function grid(v,name){int(v,name);if(v%8)throw new Error(`${name} must lie on the 8-unit electrical grid`);return v;}
function text(v,name,max=MAX_GDF_TEXT_BYTES){if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/u.test(v))throw new Error(`${name} must be bounded printable Latin-1`);return v;}
function identifier(v){text(v,'instance name',128);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))throw new Error('instance name must be an HDL identifier');return v;}
function nodeName(v){text(v,'nodeName',128);if(!/^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:\.\.\d+)?\])?$/.test(v))throw new Error('nodeName must be an identifier, bit or bus such as A[3..0]');return v;}
const encodeString=gdfString;
function replaceLabel(token,value){
  text(value,'text');const r=token.textRecord;if(!r)throw new Error('attribute lacks decoded text');
  return replaceGdfLabel(token,value);
}
function placement(x,y,orientation){const b=Buffer.alloc(6);b[0]=0x72;b.writeInt16LE(grid(x,'x'),1);b.writeInt16LE(grid(y,'y'),3);b[5]=int(orientation,'orientation',0,7);return b;}
function opCheck(op){
  if(!op||typeof op!=='object'||Array.isArray(op)||!FIELDS[op.operation])throw new Error('Unsupported GDF construction operation');
  for(const k of Object.keys(op))if(!FIELDS[op.operation].includes(k))throw new Error(`Unexpected ${k} for ${op.operation}`);
  if(op.operation.startsWith('delete_')||op.operation.startsWith('set_')||op.operation.startsWith('clear_'))int(op.recordOffset,'recordOffset',0,16777216);
}

export function createBlankGdf({width=1904,height=1232}={}){
  int(width,'width',8,32760);int(height,'height',8,32760);grid(width,'width');grid(height,'height');
  const bytes=Buffer.from('4744460000000600006503020244666a0000000074','hex');
  bytes.writeUInt16LE(width,16);bytes.writeUInt16LE(height,18);parseGdfGeometry(bytes);return bytes;
}

/** Split SYM graphical definition from its h/u default instance attributes. */
export function readSymbolPrototype(bytes){
  const parsed=parseGdfGeometry(bytes),tokens=tokeniseGdfGeometry(bytes);
  if(parsed.header.magic!=='SYM'||parsed.definitions.length||parsed.placements.length)throw new Error('symbol source must be a standalone modern SYM');
  const body=tokens.slice(1,-1),split=body.findIndex(t=>['h','u'].includes(t.opcode));
  const graph=split<0?body:body.slice(0,split),defaults=split<0?[]:body.slice(split);
  const symbolName=parsed.sheet.attributes.find(a=>a.nativeType===7&&[1,19].includes(a.kindCode))?.text;
  if(!symbolName)throw new Error('SYM lacks its original symbol name');
  if(parsed.header.version<3)for(const t of graph.filter(t=>t.opcode==='n')){t.body=Buffer.from(t.body);t.flags&=~0x30;t.body.writeUInt16LE(t.flags,19);}
  return {symbolName,parsed,graph,defaults,sha256:hash(bytes)};
}

// Unknown upper flag bits and byte offsets are not semantic graph identity.
function signature(graph){
  return JSON.stringify(graph.map(t=>{
    const out={op:t.opcode};if(t.values)out.values=t.values;
    if(t.opcode==='q')Object.assign(out,{type:t.attrType,font:t.fontCode,flags:t.flags&0x3ff,text:t.text,alternative:t.alternative,fontName:t.font,metrics:t.metrics,parameterOffset:t.parameterOffset});
    else if(t.flags!==undefined)out.flags=t.flags&({n:0x30,o:1}[t.opcode]??63);
    return out;
  }));
}

export function constructGdf(buffer,operations,resolveSymbol){
  const before=parseGdfGeometry(buffer);
  if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Construction supports GDF version 6 only');
  if(!Array.isArray(operations)||!operations.length||operations.length>1000)throw new Error('operations must contain 1 through 1000 entries');
  const tokens=tokeniseGdfGeometry(buffer),rootEnd=tokens.findIndex(t=>['g','t'].includes(t.opcode));
  const root=tokens.slice(1,rootEnd),groups=[];
  for(const d of before.definitions){
    const next=before.definitions.find(n=>n.offset>d.offset)?.offset??buffer.length;
    const members=tokens.filter(t=>t.offset>=d.offset&&t.offset<next&& !['g','t'].includes(t.opcode));
    const first=members.findIndex(t=>t.opcode==='r');
    const graph=first<0?members:members.slice(0,first),instances=[];
    for(const p of d.instances){const end=d.instances.find(n=>n.offset>p.offset)?.offset??next;instances.push({placement:p,tokens:members.filter(t=>t.offset>=p.offset&&t.offset<end)});}
    groups.push({name:d.name,graph,instances,existed:true,originalInstances:instances.length});
  }
  const replacements=new Map(),removed=new Set(),touched=new Set(),changes=[],sources=[];
  const allInstances=()=>groups.flatMap(g=>g.instances);
  function claim(offset){if(touched.has(offset))throw new Error('A source record may be changed only once per construction transaction');touched.add(offset);}
  function insertRoot(token){const phase=PHASE[token.opcode];const at=root.findIndex(t=>t.nativeType!==11&&!t.lineTextContext&&(PHASE[t.opcode]??0)>phase);root.splice(at<0?root.length:at,0,token);}
  function requirePlacement(offset){const found=allInstances().find(i=>i.placement.offset===offset);if(!found||found.deleted)throw new Error('recordOffset is not an existing symbol placement');return found;}
  function labelToken(name,wire){nodeName(name);const head=Buffer.alloc(9);head[0]=0x71;head[1]=6;head.writeInt16LE(wire.start.x,3);head.writeInt16LE(wire.start.y,5);head.writeUInt16LE(0x61,7);return {opcode:'q',nativeType:11,attrType:6,text:name,body:Buffer.concat([head,encodeString(name)])};}
  function requireWire(offset){const wire=before.sheet.primitives.find(p=>p.offset===offset&&['scalar-wire','bus-wire'].includes(p.electricalRole));if(!wire)throw new Error('recordOffset is not a root electrical wire');return wire;}
  function allocateId(){const ids=new Set(allInstances().filter(i=>!i.deleted&&i.placement.netId!==null).map(i=>i.placement.netId));for(let id=AUTO_NET_ID_MIN;id<=AUTO_NET_ID_MAX;id++)if(!ids.has(id))return id;throw new Error('No free native NET_ID in the supported 1..32767 automatic-allocation range');}
  function aliasToken(name){identifier(name);const prefix=Buffer.alloc(9);prefix[0]=0x71;return {opcode:'q',nativeType:8,attrType:0,text:MCP_INSTANCE_NAME_PREFIX+name,body:Buffer.concat([prefix,gdfString(MCP_INSTANCE_NAME_PREFIX+name)])};}
  function addAlias(ts,name){if(ts.some(t=>t.opcode==='q'&&t.nativeType===8&&t.attrType===0&&t.text.startsWith(MCP_INSTANCE_NAME_PREFIX)))throw new Error('Symbol defaults already contain a reserved MCP alias');const token=aliasToken(name),at=ts.findIndex(t=>t.opcode==='u');if(at<0)ts.push(token);else ts.splice(at,0,token);}
  for(const op of operations){
    opCheck(op);
    if(op.operation==='add_symbol'){
      identifier(op.name);if(typeof op.symbolPath!=='string'||typeof op.symbolSha256!=='string'||!/^[a-f0-9]{64}$/i.test(op.symbolSha256))throw new Error('add_symbol requires symbolPath and symbolSha256 from a fresh library read');
      const resolved=resolveSymbol(op.symbolPath);if(hash(resolved.bytes)!==op.symbolSha256.toLowerCase())throw new Error('symbol source changed; read its SHA-256 again');
      const prototype=readSymbolPrototype(resolved.bytes),orientation=op.orientation??0,head=placement(op.x,op.y,orientation);
      let same=groups.filter(g=>g.name?.toUpperCase()===prototype.symbolName.toUpperCase());
      if(same.some(g=>signature(g.graph)!==signature(prototype.graph)))throw new Error('Existing same-name symbol definition differs from the selected SYM; use an isolated drawing');
      let group=same[0];if(!group){group={name:prototype.symbolName,graph:prototype.graph.map(t=>({...t,offset:undefined})),instances:[],existed:false,originalInstances:0};groups.push(group);}
      let defaults=prototype.defaults.map(t=>({...t,body:Buffer.from(t.body)}));
      const names=defaults.filter(t=>t.opcode==='q'&&t.attrType===41),netId=allocateId();
      if(names.length!==1)throw new Error('SYM requires one unambiguous default NET_ID attribute');
      names[0].body=replaceLabel(names[0],String(netId));addAlias(defaults,op.name);
      const nodes=defaults.filter(t=>t.opcode==='q'&&t.attrType===5);
      if(['INPUT','OUTPUT','BIDIR'].includes(prototype.symbolName.toUpperCase())&&op.nodeName===undefined)throw new Error('I/O border symbols require nodeName');
      if(op.nodeName!==undefined){nodeName(op.nodeName);if(nodes.length!==1)throw new Error('Selected SYM has no unique node-name attribute');nodes[0].body=replaceLabel(nodes[0],op.nodeName);}
      if(op.parameters!==undefined)defaults=writeParameterTokens(defaults,op.parameters);
      for(const t of defaults)t.offset=undefined;
      group.instances.push({placement:{offset:null,instanceName:op.name,instanceNameSource:'hidden-DOC-alias',netId,netIdText:String(netId),nodeName:op.nodeName??nodes[0]?.text,symbolName:prototype.symbolName},tokens:[{opcode:'r',body:head},...defaults],added:true});
      sources.push({path:resolved.path,sha256:prototype.sha256,symbolName:prototype.symbolName});
      changes.push({operation:op.operation,name:op.name,netId,symbolName:prototype.symbolName,nodeName:op.nodeName??null,position:{x:op.x,y:op.y},orientation,parameters:op.parameters!==undefined?formatParameters(op.parameters).entries:undefined});
    }else if(op.operation==='normalize_net_ids'){
      const active=allInstances().filter(i=>!i.deleted),seen=new Set(),reservedNames=new Set(active.map(i=>i.placement.instanceName?.toUpperCase()).filter(Boolean)),aliases=new Set(active.filter(i=>i.placement.instanceNameSource==='hidden-DOC-alias').map(i=>i.placement.instanceName?.toUpperCase()).filter(Boolean));
      for(const inst of allInstances().filter(i=>!i.deleted)){
        const old=inst.placement.netId,key=nativeGdfIdentityKey(inst.placement);
        if(old!==null&&(key===null||!seen.has(key))){if(key!==null)seen.add(key);continue;}
        const attrs=inst.tokens.filter(t=>t.opcode==='q'&&t.nativeType===8&&t.attrType===41);if(attrs.length!==1)throw new Error('Cannot normalize an ambiguous or missing NET_ID');if(inst.placement.offset!==null)claim(inst.placement.offset);
        const id=allocateId(),previousNetIdText=inst.placement.netIdText;
        let name=inst.placement.instanceName,source=inst.placement.instanceNameSource;
        if(source==='native-NET_ID'){
          if(old===null){
            if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name??'')||name.length>128||aliases.has(name.toUpperCase())){
              const base=`mcp_instance_${id}`;name=base;let suffix=2;while(reservedNames.has(name.toUpperCase()))name=`${base}_${suffix++}`;
            }
            addAlias(inst.tokens,name);reservedNames.add(name.toUpperCase());aliases.add(name.toUpperCase());source='hidden-DOC-alias';
          }else name=String(id);
        }
        const body=replaceLabel(attrs[0],String(id));if(attrs[0].offset===undefined)attrs[0].body=body;else replacements.set(attrs[0].offset,body);
        inst.placement={...inst.placement,netId:id,netIdText:String(id),instanceName:name,instanceNameSource:source};
        const nextKey=nativeGdfIdentityKey(inst.placement);if(nextKey!==null)seen.add(nextKey);
        changes.push({operation:op.operation,recordOffset:inst.placement.offset,name,previousNetId:old,previousNetIdText,netId:id});
      }
    }else if(op.operation==='delete_symbol'){
      claim(op.recordOffset);const inst=requirePlacement(op.recordOffset);inst.deleted=true;
      changes.push({operation:op.operation,recordOffset:op.recordOffset,name:inst.placement.instanceName,note:'Attached wires remain; delete/reconnect them explicitly.'});
    }else if(op.operation==='add_wire'){
      for(const k of ['x1','y1','x2','y2'])grid(op[k],k);
      for(const k of ['bus','startDot','endDot'])if(op[k]!==undefined&&typeof op[k]!=='boolean')throw new Error(`${k} must be boolean`);
      if(op.x1===op.x2&&op.y1===op.y2)throw new Error('A wire cannot have zero length');
      if(op.x1!==op.x2&&op.y1!==op.y2)throw new Error('Electrical wires must be horizontal or vertical');
      const opcode=op.y1===op.y2?'k':'l',bytes=Buffer.alloc(11);bytes[0]=opcode.charCodeAt(0);
      ['x1','y1','x2','y2'].forEach((k,i)=>bytes.writeInt16LE(op[k],1+2*i));bytes.writeUInt16LE((op.bus?32:0)|(op.startDot?1:0)|(op.endDot?2:0),9);
      const token={opcode,body:bytes};insertRoot(token);if(op.nodeName!==undefined){const at=root.indexOf(token);root.splice(at+1,0,{opcode:'i',body:Buffer.from('i')},labelToken(op.nodeName,{start:{x:op.x1,y:op.y1}}));}changes.push({operation:op.operation,start:{x:op.x1,y:op.y1},end:{x:op.x2,y:op.y2},bus:op.bus??false,nodeName:op.nodeName});
    }else if(['set_wire_name','clear_wire_name'].includes(op.operation)){
      claim(op.recordOffset);const wire=requireWire(op.recordOffset),labels=(wire.annotations??[]).filter(a=>a.kindCode===6),at=root.findIndex(t=>t.offset===wire.offset);
      if(labels.length>1)throw new Error('Wire has ambiguous multiple node names');
      if(op.operation==='clear_wire_name'){
        if(!labels.length)throw new Error('Wire has no node name to clear');removed.add(labels[0].offset);
        if(root[at+1]?.opcode==='i'&&(wire.annotations?.length??0)===1)removed.add(root[at+1].offset);
      }else{
        nodeName(op.nodeName);if(labels.length){const token=root.find(t=>t.offset===labels[0].offset);replacements.set(token.offset,replaceLabel(token,op.nodeName));}
        else{if(wire.annotations?.length)throw new Error('Wire has non-name annotations; adding a first name would reinterpret their native types');const label=labelToken(op.nodeName,wire);if(root[at+1]?.opcode==='i')root.splice(at+2,0,label);else root.splice(at+1,0,{opcode:'i',body:Buffer.from('i')},label);}
      }changes.push({operation:op.operation,recordOffset:op.recordOffset,before:labels[0]?.text??null,after:op.nodeName??null});
    }else if(['set_parameters','clear_parameters'].includes(op.operation)){
      claim(op.recordOffset);const inst=requirePlacement(op.recordOffset),prior=parameterSummary(inst.tokens.filter(t=>t.opcode==='q'));
      inst.tokens=writeParameterTokens(inst.tokens,op.operation==='clear_parameters'?undefined:op.parameters);
      changes.push({operation:op.operation,recordOffset:op.recordOffset,name:inst.placement.instanceName,before:prior.entries,after:op.operation==='clear_parameters'?[]:formatParameters(op.parameters).entries});
    }else if(op.operation==='delete_wire'){
      claim(op.recordOffset);const wire=before.sheet.primitives.find(p=>p.offset===op.recordOffset&&['scalar-wire','bus-wire'].includes(p.electricalRole));
      if(!wire)throw new Error('recordOffset is not a root electrical wire');
      removed.add(wire.offset);for(const a of wire.annotations??[])removed.add(a.offset);
      const at=root.findIndex(t=>t.offset===wire.offset);if(root[at+1]?.opcode==='i')removed.add(root[at+1].offset);
      changes.push({operation:op.operation,recordOffset:op.recordOffset,removedAnnotations:wire.annotations?.length??0});
    }else if(op.operation==='set_node_name'){
      claim(op.recordOffset);nodeName(op.nodeName);const inst=requirePlacement(op.recordOffset),attrs=inst.tokens.filter(t=>t.opcode==='q'&&t.attrType===5);
      if(attrs.length!==1)throw new Error('Existing placement has no unique node-name attribute');
      replacements.set(attrs[0].offset,replaceLabel(attrs[0],op.nodeName));changes.push({operation:op.operation,recordOffset:op.recordOffset,before:inst.placement.nodeName,after:op.nodeName});inst.placement={...inst.placement,nodeName:op.nodeName};
    }else if(op.operation==='add_annotation'){
      int(op.x,'x');int(op.y,'y');text(op.text,'text');const prefix=Buffer.alloc(9);prefix[0]=0x71;prefix.writeInt16LE(op.x,3);prefix.writeInt16LE(op.y,5);prefix.writeUInt16LE(0x61,7);
      insertRoot({opcode:'q',nativeType:7,body:Buffer.concat([prefix,encodeString(op.text)])});changes.push({operation:op.operation,position:{x:op.x,y:op.y},text:op.text});
    }else{
      claim(op.recordOffset);const a=before.sheet.attributes.find(a=>a.offset===op.recordOffset&&a.kindCode===0&&a.nativeType===7);
      if(!a||before.sheet.pins.some(p=>p.attributeId===a.id))throw new Error('recordOffset is not a free root annotation');removed.add(a.offset);changes.push({operation:op.operation,recordOffset:op.recordOffset,text:a.text});
    }
  }
  const emit=ts=>ts.filter(t=>!removed.has(t.offset)).map(t=>({...t,body:replacements.get(t.offset)??t.body}));
  const planned=[tokens[0],...emit(root)];
  for(const g of groups){const active=g.instances.filter(i=>!i.deleted);if(!active.length&&g.originalInstances)continue;planned.push({opcode:'g',body:Buffer.from([0x67])},...emit(g.graph));for(const i of active)planned.push(...emit(i.tokens));}
  planned.push({opcode:'t',body:Buffer.from([0x74])});const result=Buffer.concat(planned.map(t=>t.body));
  const after=parseGdfGeometry(result);
  assertGdfIdentities(after.placements);
  const actual=tokeniseGdfGeometry(result);
  if(actual.length!==planned.length||actual.some((t,i)=>t.opcode==='q'&&t.nativeType!==planned[i].nativeType))throw new Error('Construction would change a native text context; existing attribute ownership must be preserved');
  return {buffer:result,changes,sources,counts:{before:before.counts,after:after.counts},note:'Construction changed explicit source records only. Symbol definitions/defaults came from hashed SYM sources. Deleted symbols do not delete wires; dangling wires, junctions, bus relationships and logic must be checked with original compiler/simulator. All record offsets may change; read the resulting file again.'};
}
