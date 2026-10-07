/** Evidence-bounded MAX+plus II 10.2 SCF structure editing. See docs/SCF-STRUCTURE.md. */
import {parseScfRecords, readScfWaveforms} from './scf.mjs';

const RADICES = Object.freeze({BIN:0, OCT:1, DEC:2, HEX:3});
const RADIX_NAMES = ['BIN','OCT','DEC','HEX'];
const VALUE_CODES = new Map([[0,0],[1,1],['X',2],['Z',3]]);
const asBuffer = b => Buffer.isBuffer(b) ? b : Buffer.from(b);
const fail = message => { throw new Error(message); };
const strict = (value, keys, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) fail(message);
};
function nameBytes(name) {
  if(typeof name!=='string'||!name.length||name.length>255||/[\s\x00-\x1f\x7f]/.test(name)||[...name].some(c=>c.charCodeAt(0)>255))
    fail('SCF names must contain 1..255 Latin-1 characters without whitespace or control characters');
  return Buffer.from(name+'\0','latin1');
}
function ticksFor(ns, label='durationNs') {
  const scaled=ns*10,ticks=Math.round(scaled);
  if(typeof ns!=='number'||!Number.isFinite(ns)||ticks<1||ticks>0xffffffff||Math.abs(scaled-ticks)>1e-7)
    fail(`${label} must be positive, representable by uint32 ticks and an exact multiple of 0.1 ns`);
  return ticks;
}
function framed(buffer,start,end) {
  const records=[];let at=start;
  while(at<end) {
    if(at+6>end) return {records,complete:false,opaqueStart:at};
    const length=buffer.readUInt32LE(at+2),size=length+6;
    if(size>end-at) return {records,complete:false,opaqueStart:at};
    records.push({tag:buffer.readUInt16LE(at),start:at,size,payloadStart:at+6,payloadLength:length});at+=size;
  }
  return {records,complete:true,opaqueStart:null};
}
function model(input) {
  const buffer=asBuffer(input),parsed=parseScfRecords(buffer),problems=[...parsed.problems];
  if(parsed.header.version!==4) problems.push('structure writing requires version 4');
  if(!parsed.complete) return {buffer,parsed,problems,complete:false};
  const groupStart=parsed.groups[0]?.start??parsed.firstRecordOffset;
  const timedPrefix=groupStart===66&&buffer.readUInt16LE(38)===1&&buffer.readUInt16LE(44)===2&&buffer.readUInt32LE(46)===16&&buffer.readUInt16LE(50)===1;
  const untimedPrefix=groupStart===52&&buffer.readUInt16LE(38)===0&&buffer.readUInt16LE(44)===2&&buffer.readUInt32LE(46)===2&&buffer.readUInt16LE(50)===0;
  const prefixKnown=timedPrefix||untimedPrefix,editorEndOffset=timedPrefix?52:null;
  if(!prefixKnown) problems.push('unrecognized preamble: expected an evidenced 52-byte or 66-byte prefix');
  const wave=readScfWaveforms(buffer,{limit:10000}),byIndex=new Map(wave.signals.filter(s=>s.role!=='bus').map(s=>[s.index,s]));
  const scalars=parsed.records.map(r=>({...r,bytes:Buffer.from(buffer.subarray(r.start,r.start+r.size)),wave:byIndex.get(r.index)}));
  const groups=parsed.groups.map(r=>({...r,nameLength:buffer.readUInt16LE(r.start+8),memberIndices:[...r.memberIndices],bytes:Buffer.from(buffer.subarray(r.start,r.start+r.size))}));
  for(const scalar of scalars) if(!scalar.wave?.decoded) problems.push(`undecoded scalar ${scalar.name}`);
  const names=[...scalars,...groups].map(s=>s.name.toUpperCase());
  if(new Set(names).size!==names.length)problems.push('duplicate or case-colliding scalar/group names');
  if(new Set(groups.map(g=>g.index)).size!==groups.length)problems.push('duplicate group IDs');
  for(const g of groups) {
    if(new Set(g.memberIndices).size!==g.width||g.memberIndices.some(id=>!byIndex.has(id)))problems.push(`group ${g.name} has duplicate or unavailable members`);
  }
  const tail=framed(buffer,parsed.tailOffset,buffer.length),orderRecords=tail.records.filter(r=>r.tag===0x102),settingsRecords=tail.records.filter(r=>r.tag===0x101);
  const orderRecord=orderRecords.length===1?orderRecords[0]:null,settingsRecord=settingsRecords.length===1?settingsRecords[0]:null;
  let display=[];
  if(orderRecord&&orderRecord.payloadLength>=6&&(orderRecord.payloadLength-6)%6===0) {
    for(let at=orderRecord.payloadStart+6;at<orderRecord.start+orderRecord.size;at+=6) {
      const type=buffer.readUInt16LE(at),index=buffer.readUInt16LE(at+2),flags=buffer.readUInt16LE(at+4);
      const signal=type===1?scalars.find(s=>s.index===index):type===3?groups.find(s=>s.index===index):null;
      display.push({type,index,flags,name:signal?.name??null});
      if(!signal)problems.push(`unrecognized display reference type=${type} ID=${index}`);
    }
    if(new Set(display.map(d=>`${d.type}:${d.index}`)).size!==display.length)problems.push('duplicate display references');
  } else problems.push('missing or malformed unique display order record (tag 0x102)');
  if(!settingsRecord||settingsRecord.payloadLength!==18)problems.push('missing or malformed unique display settings record (tag 0x101)');
  else if(buffer.readUInt16LE(settingsRecord.payloadStart)!==display.length)problems.push('display row count disagrees with order record');
  return {buffer,parsed,problems,complete:!problems.length,prefixKnown,editorEndOffset,scalars,groups,tail,orderRecord,settingsRecord,display,
    prefix:Buffer.from(buffer.subarray(0,groupStart)),durationTicks:parsed.header.durationTicks};
}

/** Returns offsets, known display references and explicit limits; never mutates input. */
export function inspectScfStructure(input) {
  const m=model(input),header=m.parsed.header;
  return {header,fileSize:m.buffer.length,complete:m.complete,problems:m.problems,
    scalars:(m.scalars??[]).map(s=>({index:s.index,name:s.name,role:s.wave?.role??'unknown',start:s.start,size:s.size,
      nameSpan:{offset:s.start+10,length:s.nameLength},waveformSpan:{offset:s.waveformStart,length:s.waveformLength},
      groupedCode:s.waveformLength>=17?m.buffer.readUInt16LE(s.waveformStart+15):null,decoded:!!s.wave?.decoded})),
    groups:(m.groups??[]).map(g=>({index:g.index,name:g.name,width:g.width,memberIndices:g.memberIndices,
      members:g.memberIndices.map(id=>m.scalars.find(s=>s.index===id)?.name??null),radix:RADIX_NAMES[g.displayCode]??null,
      displayCode:g.displayCode,start:g.start,size:g.size})),
    displayOrder:m.display??[],
    metadataRecords:(m.tail?.records??[]).map(r=>({...r,interpretedFields:r.tag===0x101?['displayRowCount']:r.tag===0x102?['displayReferences']:[]})),
    opaqueTail:m.tail?.complete===false?{offset:m.tail.opaqueStart,length:m.buffer.length-m.tail.opaqueStart}:null,
    timeRange:{startTime:0,endTime:header.durationNs,unit:'ns',tickNs:0.1,
      editorEndTicks:m.editorEndOffset!==null&&m.editorEndOffset!==undefined?m.buffer.readUInt32LE(m.editorEndOffset):null},
    supportedOperations:['rename','reorder','group','ungroup','radix','duration','add_input','delete_input'],
    note:'Only evidenced names, scalar stimuli, display references, bus radix and duration fields are editable. Other metadata remains opaque.'};
}

function renameRecord(record,name) {
  const old=record.bytes,nameBuffer=nameBytes(name),bytes=Buffer.concat([old.subarray(0,10),nameBuffer,old.subarray(10+record.nameLength)]);
  bytes.writeUInt32LE(bytes.length-6,2);bytes.writeUInt16LE(nameBuffer.length,8);
  record.name=name;record.nameLength=nameBuffer.length;record.bytes=bytes;record.size=bytes.length;
}
const waveOffset=s=>10+s.nameLength;
function replaceEvents(scalar, events, endTicks) {
  const relative=waveOffset(scalar),bytes=Buffer.alloc(relative+21+events.length*8);
  scalar.bytes.copy(bytes,0,0,relative+17);bytes.writeUInt32LE(bytes.length-6,2);bytes.writeUInt32LE(events.length,relative+17);
  for(let i=0;i<events.length;i++) {
    const at=relative+21+i*8;bytes.writeUInt32LE((events[i+1]?.ticks??endTicks)-events[i].ticks,at);
    bytes.writeUInt16LE(events[i].valueCode,at+6);
  }
  scalar.bytes=bytes;scalar.size=bytes.length;
}
function validateEvents(events,endTicks) {
  if(!Array.isArray(events)||!events.length||events.length>100000)fail('events must contain 1..100000 events');
  const normalized=[];let previous=-1;
  for(const e of events) {
    strict(e,['time','value'],'events require only time and value');
    const scaled=e.time*10,ticks=Math.round(scaled),value=typeof e.value==='string'?e.value.toUpperCase():e.value,valueCode=VALUE_CODES.get(value);
    if(typeof e.time!=='number'||!Number.isFinite(e.time)||e.time<0||Math.abs(scaled-ticks)>1e-7||ticks<=previous||ticks>=endTicks)
      fail('event times must strictly increase, use exact 0.1 ns steps and precede the simulation end');
    if(valueCode===undefined)fail('event values must be 0, 1, X or Z');
    if(!normalized.length&&ticks!==0)fail('the first event must be at time 0');
    if(normalized.at(-1)?.valueCode!==valueCode)normalized.push({ticks,value,valueCode});previous=ticks;
  }
  return normalized;
}
function groupBytes(group) {
  const n=nameBytes(group.name),out=Buffer.alloc(10+n.length+4+group.memberIndices.length*2),w=10+n.length;
  out.writeUInt16LE(3);out.writeUInt32LE(out.length-6,2);out.writeUInt16LE(group.index,6);out.writeUInt16LE(n.length,8);n.copy(out,10);
  out.writeUInt16LE(group.memberIndices.length,w);group.memberIndices.forEach((id,i)=>out.writeUInt16LE(id,w+2+i*2));
  out.writeUInt16LE(group.displayCode,out.length-2);return out;
}
function refreshNames(m) {
  for(const d of m.display)d.name=(d.type===1?m.scalars:m.groups).find(s=>s.index===d.index)?.name??null;
}
function build(m) {
  const prefix=Buffer.from(m.prefix);prefix.writeUInt16LE(m.scalars.length,26);prefix.writeUInt16LE(m.groups.length,28);
  prefix.writeUInt32LE(m.durationTicks,20);
  const tailChunks=[];
  for(const r of m.tail.records) {
    let bytes=Buffer.from(m.buffer.subarray(r.start,r.start+r.size));
    if(r===m.settingsRecord)bytes.writeUInt16LE(m.display.length,6);
    if(r===m.orderRecord) {
      bytes=Buffer.alloc(12+m.display.length*6);m.buffer.copy(bytes,0,r.start,r.payloadStart+6);bytes.writeUInt32LE(bytes.length-6,2);
      m.display.forEach((d,i)=>{const at=12+i*6;bytes.writeUInt16LE(d.type,at);bytes.writeUInt16LE(d.index,at+2);bytes.writeUInt16LE(d.flags,at+4);});
    }
    tailChunks.push(bytes);
  }
  if(!m.tail.complete)tailChunks.push(m.buffer.subarray(m.tail.opaqueStart));
  return Buffer.concat([prefix,...m.groups.map(g=>g.bytes),...m.scalars.map(s=>s.bytes),...tailChunks]);
}
function requireRefSafe(m) {
  if(!m.tail.complete||m.tail.records.some(r=>![6,0x101,0x102,0x104].includes(r.tag)))
    fail('ID or membership edits require an entirely framed trailer containing only the evidenced tags 6, 0x101, 0x102 and 0x104');
}
function groupedCode(s) {return s.bytes.readUInt16LE(waveOffset(s)+15);}
function setGrouped(s,grouped) {
  if(![0,1].includes(groupedCode(s)))fail(`unsupported grouped field for ${s.name}`);
  s.bytes.writeUInt16LE(grouped?1:0,waveOffset(s)+15);
}
function uniqueName(m,name,ignore=null) {
  nameBytes(name);if([...m.scalars,...m.groups].some(s=>s!==ignore&&s.name.toUpperCase()===name.toUpperCase()))fail(`SCF name already exists: ${name}`);
}
function nextId(records) {const id=Math.max(0,...records.map(s=>s.index))+1;if(id>0xffff)fail('SCF ID capacity exceeded');return id;}
function radixCode(radix) {if(typeof radix!=='string'||RADICES[radix.toUpperCase()]===undefined)fail('radix must be BIN, OCT, DEC or HEX');return RADICES[radix.toUpperCase()];}

/** Ordered, atomic in-memory transaction. The caller handles SHA checks and file writes. */
export function editScfStructure(input, operations) {
  const m=model(input);if(!m.complete)fail('cannot edit unsupported or malformed SCF structure: '+m.problems.join('; '));
  if(!Array.isArray(operations)||!operations.length||operations.length>1000)fail('operations must contain 1..1000 operations');
  const changes=[];
  for(const op of operations) {
    if(!op||typeof op.type!=='string')fail('each structure operation requires a type');
    switch(op.type) {
      case 'rename': {
        strict(op,['type','signal','name'],'rename requires only type, signal and name');
        const s=[...m.scalars,...m.groups].find(s=>s.name===op.signal);if(!s)fail(`SCF signal not found: ${op.signal}`);
        if(op.name!==s.name)uniqueName(m,op.name,s);const previousName=s.name;renameRecord(s,op.name);
        changes.push({type:op.type,previousName,name:s.name,index:s.index});break;
      }
      case 'reorder': {
        strict(op,['type','signals'],'reorder requires only type and signals');refreshNames(m);
        if(!Array.isArray(op.signals)||op.signals.length!==m.display.length||new Set(op.signals).size!==op.signals.length||op.signals.some(n=>!m.display.some(d=>d.name===n)))
          fail('reorder signals must be a complete, unique permutation of the current display names');
        const previousOrder=m.display.map(d=>d.name);m.display=op.signals.map(n=>m.display.find(d=>d.name===n));
        changes.push({type:op.type,previousOrder,signals:[...op.signals]});break;
      }
      case 'group': {
        strict(op,['type','name','members','radix'],'group requires only type, name, members and optional radix');requireRefSafe(m);uniqueName(m,op.name);
        if(!Array.isArray(op.members)||op.members.length<2||op.members.length>0xffff||new Set(op.members).size!==op.members.length)fail('group members must be 2..65535 unique scalar names');
        const members=op.members.map(n=>m.scalars.find(s=>s.name===n));
        if(members.some(s=>!s))fail('every group member must be an existing scalar');
        if(members.some(s=>!['input','output','internal'].includes(s.wave.role))||new Set(members.map(s=>s.wave.role)).size!==1)fail('group members must share the same input/output/internal role');
        if(members.some(s=>m.groups.some(g=>g.memberIndices.includes(s.index))||!m.display.some(d=>d.type===1&&d.index===s.index)))fail('group members must be individually displayed and ungrouped');
        const memberIndices=members.map(s=>s.index),group={index:nextId(m.groups),name:op.name,memberIndices,width:members.length,displayCode:radixCode(op.radix??'HEX')};
        group.nameLength=nameBytes(group.name).length;group.bytes=groupBytes(group);m.groups.push(group);
        const positions=m.display.map((d,i)=>d.type===1&&memberIndices.includes(d.index)?i:-1).filter(i=>i>=0),first=Math.min(...positions);
        m.display=m.display.flatMap((d,i)=>i===first?[{type:3,index:group.index,flags:0,name:group.name}]:positions.includes(i)?[]:[d]);
        members.forEach(s=>setGrouped(s,true));changes.push({type:op.type,name:group.name,members:[...op.members],radix:RADIX_NAMES[group.displayCode]});break;
      }
      case 'ungroup': {
        strict(op,['type','signal'],'ungroup requires only type and signal');requireRefSafe(m);
        const group=m.groups.find(g=>g.name===op.signal);if(!group)fail(`SCF display group not found: ${op.signal}`);
        const members=group.memberIndices.map(id=>m.scalars.find(s=>s.index===id));
        if(members.some(s=>!s)||members.some(s=>m.groups.some(g=>g!==group&&g.memberIndices.includes(s.index))))fail('cannot ungroup unavailable or shared members');
        m.display=m.display.flatMap(d=>d.type===3&&d.index===group.index?members.map(s=>({type:1,index:s.index,flags:0,name:s.name})):[d]);
        m.groups=m.groups.filter(g=>g!==group);members.forEach(s=>setGrouped(s,false));
        changes.push({type:op.type,name:group.name,members:members.map(s=>s.name)});break;
      }
      case 'radix': {
        strict(op,['type','signal','radix'],'radix requires only type, signal and radix');
        const group=m.groups.find(g=>g.name===op.signal);if(!group)fail('radix editing requires an existing display group');
        const previousRadix=RADIX_NAMES[group.displayCode]??null;group.displayCode=radixCode(op.radix);group.bytes.writeUInt16LE(group.displayCode,group.bytes.length-2);
        changes.push({type:op.type,signal:group.name,previousRadix,radix:RADIX_NAMES[group.displayCode]});break;
      }
      case 'duration': {
        strict(op,['type','durationNs'],'duration requires only type and durationNs');const end=ticksFor(op.durationNs),previous=m.durationTicks;
        for(const s of m.scalars) {
          const w=waveOffset(s),count=s.bytes.readUInt32LE(w+17),events=[];let atTicks=0;
          for(let i=0;i<count;i++){const at=w+21+i*8,duration=s.bytes.readUInt32LE(at),valueCode=s.bytes.readUInt16LE(at+6);if(atTicks<end)events.push({ticks:atTicks,valueCode});atTicks+=duration;}
          replaceEvents(s,events,end);
        }
        m.durationTicks=end;if(m.editorEndOffset!==null)m.prefix.writeUInt32LE(end,m.editorEndOffset);
        changes.push({type:op.type,previousDurationNs:previous/10,durationNs:end/10,extensionPolicy:'hold the final value',shorteningPolicy:'truncate segments at the new end'});break;
      }
      case 'add_input': {
        strict(op,['type','name','events'],'add_input requires only type, name and optional events');requireRefSafe(m);uniqueName(m,op.name);
        if(m.scalars.length>=0xffff)fail('SCF signal count capacity exceeded');
        const inputTemplate=m.scalars.find(s=>s.wave.role==='input');
        const n=nameBytes(op.name),w=10+n.length,bytes=Buffer.alloc(w+21),index=nextId(m.scalars);
        bytes.writeUInt16LE(5);bytes.writeUInt16LE(index,6);bytes.writeUInt16LE(n.length,8);n.copy(bytes,10);
        if(inputTemplate)inputTemplate.bytes.copy(bytes,w,waveOffset(inputTemplate),waveOffset(inputTemplate)+17);
        else Buffer.from('0100010003000100000100000100000000','hex').copy(bytes,w);
        bytes.writeUInt16LE(0,w+15);const s={index,name:op.name,nameLength:n.length,bytes,wave:{role:'input'}};
        replaceEvents(s,validateEvents(op.events??[{time:0,value:0}],m.durationTicks),m.durationTicks);m.scalars.push(s);m.display.push({type:1,index,flags:0,name:s.name});
        changes.push({type:op.type,name:s.name,index});break;
      }
      case 'delete_input': {
        strict(op,['type','signal'],'delete_input requires only type and signal');requireRefSafe(m);
        const s=m.scalars.find(s=>s.name===op.signal);if(!s||s.wave.role!=='input')fail('delete_input requires an existing scalar input');
        if(m.scalars.length===1)fail('at least one scalar record must remain');
        if(m.groups.some(g=>g.memberIndices.includes(s.index)))fail('ungroup a signal before deleting a group member');
        m.scalars=m.scalars.filter(v=>v!==s);m.display=m.display.filter(d=>!(d.type===1&&d.index===s.index));
        // The original reader and vendor use ID 1 as the first scalar anchor. Preserve gaps otherwise.
        const shift=m.scalars[0].index-1;
        if(shift){for(const v of m.scalars){v.index-=shift;v.bytes.writeUInt16LE(v.index,6);}for(const g of m.groups){g.memberIndices=g.memberIndices.map(id=>id-shift);g.bytes=groupBytes(g);}for(const d of m.display)if(d.type===1)d.index-=shift;}
        changes.push({type:op.type,name:s.name,previousIndex:s.index,reindexedBy:shift});break;
      }
      default:fail(`unsupported SCF structure operation: ${op.type}`);
    }
    refreshNames(m);
  }
  const output=build(m),verified=inspectScfStructure(output);
  if(!verified.complete)fail('edited SCF failed validation: '+verified.problems.join('; '));
  return {buffer:output,changes,durationNs:m.durationTicks/10,unit:'ns',
    note:'Structure edits preserve opaque fields. Renamed/added input names must exist in the compiled netlist; output/internal traces remain stale until the vendor Simulator runs again.'};
}

/** Create a canonical version 4 stimulus using fields reproduced from the vendor oracle. */
export function createScfStructure(options) {
  strict(options,['durationNs','inputs'],'SCF creation requires only durationNs and inputs');const duration=ticksFor(options.durationNs);
  if(!Array.isArray(options.inputs)||!options.inputs.length||options.inputs.length>0xffff)fail('inputs must contain 1..65535 input definitions');
  const prefix=Buffer.from('534346000000040001001e00000000000000000070170000000003000000000000000000000001000200000002001000000001007017000000000100000000000000','hex');
  prefix.writeUInt32LE(duration,20);prefix.writeUInt32LE(duration,52);prefix.writeUInt16LE(options.inputs.length,26);
  const scalars=[],names=new Set();
  options.inputs.forEach((input,i)=>{strict(input,['name','events'],'input definitions require only name and optional events');const n=nameBytes(input.name);
    if(names.has(input.name.toUpperCase()))fail(`SCF name already exists: ${input.name}`);names.add(input.name.toUpperCase());
    const bytes=Buffer.alloc(10+n.length+21);bytes.writeUInt16LE(5);bytes.writeUInt16LE(i+1,6);bytes.writeUInt16LE(n.length,8);n.copy(bytes,10);
    Buffer.from('0100010003000100000100000100000000','hex').copy(bytes,10+n.length);
    const s={index:i+1,name:input.name,nameLength:n.length,bytes};replaceEvents(s,validateEvents(input.events??[{time:0,value:0}],duration),duration);scalars.push(s.bytes);
  });
  const tailPrefix=Buffer.from('0600040000000000000001011200000003000c0004000c0001000100c80000000000','hex');tailPrefix.writeUInt16LE(options.inputs.length,16);
  const display=Buffer.alloc(12+options.inputs.length*6);display.writeUInt16LE(0x102);display.writeUInt32LE(display.length-6,2);
  options.inputs.forEach((_,i)=>{display.writeUInt16LE(1,12+i*6);display.writeUInt16LE(i+1,14+i*6);});
  const buffer=Buffer.concat([prefix,...scalars,tailPrefix,display]),inspection=inspectScfStructure(buffer);
  if(!inspection.complete)fail('created SCF failed validation: '+inspection.problems.join('; '));
  return {buffer,changes:[{type:'create',durationNs:duration/10,inputs:options.inputs.map(s=>s.name)}],durationNs:duration/10,unit:'ns',
    note:'New version 4 input stimulus. Input names must match the compiled netlist; the vendor Simulator will calculate output/internal traces.'};
}
