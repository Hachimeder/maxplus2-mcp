/** MAX+plus II 10.2 SCF reader. See docs/SCF-FORMAT.md for controlled evidence. */
const MAGIC = Buffer.from('SCF\0', 'ascii');
export const HEADER_SIZE = 0x1c;
export const SCF_TICK_NS = 0.1;
const PREFIX = 10;
const VALUES = new Map([[0, 0], [1, 1], [2, 'X'], [3, 'Z']]);
const asBuffer = b => Buffer.isBuffer(b) ? b : Buffer.from(b);

export function parseScfHeader(input) {
  const buffer = asBuffer(input);
  if (buffer.length < HEADER_SIZE) throw new Error('file too short to be an .scf');
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error('bad SCF magic (expected 53434600)');
  const timebase = buffer.readUInt32LE(0x14);
  const durationNs = timebase / 10;
  return { marker: buffer.readUInt32LE(4), version: buffer.readUInt16LE(6),
    maxNameLength: buffer.readUInt16LE(10), timebase, durationTicks: timebase,
    durationNs, tickNs: SCF_TICK_NS,
    timebaseText: durationNs >= 1000 ? `${durationNs / 1000}us` : `${durationNs}ns`,
    timebaseUnits: durationNs * 1000, signalCount: buffer.readUInt16LE(0x1a),
    groupCount:buffer.length >= 30 ? buffer.readUInt16LE(28) : null };
}

function recordAt(buffer, offset) {
  if (offset + PREFIX > buffer.length) return null;
  const kindTag = buffer.readUInt16LE(offset);
  const declaredSize = buffer.readUInt32LE(offset + 2);
  const size = declaredSize + 6;
  const nameLength = buffer.readUInt16LE(offset + 8);
  if (size < PREFIX + 1 || offset + size > buffer.length || nameLength < 1
      || offset + PREFIX + nameLength > offset + size) return null;
  const nameEnd = offset + PREFIX + nameLength - 1;
  if (buffer[nameEnd] !== 0 || buffer.subarray(offset + PREFIX, nameEnd).includes(0)) return null;
  const name = buffer.subarray(offset + PREFIX, nameEnd).toString('latin1');
  if (!name || /[\x00-\x1f]/.test(name)) return null;
  return { index: buffer.readUInt16LE(offset + 6), name, kindTag,
    nameLength, kind: nameLength, start: offset, size, declaredSize,
    waveformStart: nameEnd + 1, waveformEnd: offset + size,
    waveformLength: offset + size - nameEnd - 1 };
}

function walkFrom(buffer, header, first) {
  const records = []; let offset = first; let previousIndex = 0;
  for (let i = 0; i < header.signalCount; i++) {
    const r = recordAt(buffer, offset);
    // Bus groups can refer to omitted scalar IDs; IDs are ordered, not contiguous.
    if (!r || r.kindTag !== 5 || r.index <= previousIndex) return null;
    records.push(r); offset += r.size; previousIndex = r.index;
  }
  return {records, end: offset};
}

export function findFirstRecord(input, from = HEADER_SIZE) {
  const buffer = asBuffer(input), header = parseScfHeader(buffer);
  for (let o = from; o + PREFIX + 1 <= buffer.length; o++) {
    if (buffer.readUInt16LE(o) !== 5 || buffer.readUInt16LE(o + 6) !== 1) continue;
    const walk = walkFrom(buffer, header, o);
    if (walk && (walk.end === buffer.length || (walk.end + 6 <= buffer.length && buffer.readUInt16LE(walk.end) === 6))) return o;
  }
  return -1;
}

function busGroups(buffer, first) {
  if (buffer.length < 30 || first === null) return [];
  const count = buffer.readUInt16LE(28);
  if (!count) return [];
  for (let o = HEADER_SIZE; o + PREFIX <= first; o++) {
    if (buffer.readUInt16LE(o) !== 3) continue;
    const groups = []; let at = o;
    for (let i = 0; i < count; i++) {
      const r = recordAt(buffer, at);
      if (!r || r.kindTag !== 3 || r.waveformStart + 4 > r.waveformEnd) break;
      const width = buffer.readUInt16LE(r.waveformStart);
      if (!width || r.waveformStart + 4 + width * 2 !== r.waveformEnd) break;
      const members = Array.from({length:width}, (_, k) => buffer.readUInt16LE(r.waveformStart + 2 + k * 2));
      groups.push({index:r.index, name:r.name, width, memberIndices:members,
        displayCode:buffer.readUInt16LE(r.waveformEnd - 2), start:r.start, size:r.size});
      at += r.size;
    }
    if (groups.length === count && at === first) return groups;
  }
  return [];
}

export function parseScfRecords(input) {
  const buffer = asBuffer(input), header = parseScfHeader(buffer);
  const first = findFirstRecord(buffer);
  if (first < 0) return {header, records:[], groups:[], parsed:0, expected:header.signalCount,
    preambleLength:null, firstRecordOffset:null, tailOffset:null, tailLength:null, complete:false,
    problems:['no complete SCF scalar record chain found: size, name, tag or ordered signal index is invalid'], tailDecoded:false};
  const walk = walkFrom(buffer, header, first);
  const groups=busGroups(buffer,first), groupsComplete=groups.length===header.groupCount;
  return {header, records:walk.records, groups, groupsComplete, parsed:walk.records.length,
    expected:header.signalCount, preambleLength:first - HEADER_SIZE, firstRecordOffset:first,
    tailOffset:walk.end, tailLength:buffer.length - walk.end,
    problems:groupsComplete?[]:[`display group count ${header.groupCount} could not be decoded completely`], complete:true,
    tailDecoded:false, tailNote:'Display and editor trailer bytes are preserved but not interpreted.'};
}

function decodeWaveform(buffer, r, durationTicks) {
  const problems = [], w = r.waveformStart;
  if (r.waveformLength < 21) return {decoded:false, segments:[], events:[], problems:['waveform prefix/count is truncated']};
  const count = buffer.readUInt32LE(w + 17);
  const roleCode = buffer.readUInt16LE(w);
  const width = buffer.readUInt16LE(w + 6);
  if (width !== 1) problems.push(`unsupported scalar width field ${width}`);
  if (count > Math.floor((r.waveformLength - 21) / 8) || 21 + count * 8 !== r.waveformLength) problems.push('segment count does not match the record byte length');
  if (!count) problems.push('waveform has no segments');
  if (problems.length) return {decoded:false, roleCode, width, segmentCount:count, segments:[], events:[], problems};
  const segments = [], events = []; let ticks = 0, previous;
  for (let i = 0; i < count; i++) {
    const at = w + 21 + i * 8, duration = buffer.readUInt32LE(at);
    const flags = buffer.readUInt16LE(at + 4), valueCode = buffer.readUInt16LE(at + 6);
    const value = VALUES.get(valueCode);
    if (!duration) problems.push(`segment ${i} has zero duration`);
    if (flags !== 0) problems.push(`segment ${i} has unsupported flags ${flags}`);
    if (value === undefined) problems.push(`segment ${i} has unsupported logic value code ${valueCode}`);
    const segment = {startTime:ticks / 10, endTime:(ticks + duration) / 10,
      duration:duration / 10, startTicks:ticks, durationTicks:duration, value:value ?? null, valueCode};
    segments.push(segment);
    if (value !== previous) events.push({time:ticks / 10, ticks, value:value ?? null});
    previous = value; ticks += duration;
  }
  if (ticks !== durationTicks) problems.push(`segment durations total ${ticks} ticks; header declares ${durationTicks}`);
  return {decoded:problems.length === 0, roleCode, role:({1:'input',2:'output',3:'internal'})[roleCode] ?? 'unknown',
    width, segmentCount:count, durationNs:ticks / 10, segments, events, problems};
}

/** Read scalar events and derived display bus events, with bounded paging. Times are ns. */
export function readScfWaveforms(input, {signal, signals, startTime = 0, endTime = Infinity, offset = 0, limit = 1000} = {}) {
  const buffer = asBuffer(input), parsed = parseScfRecords(buffer);
  if (!Number.isFinite(startTime) || startTime < 0 || !(Number.isFinite(endTime) || endTime === Infinity)
      || endTime < startTime || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid SCF waveform time range or paging');
  const wanted = signal ? [signal] : signals;
  if (wanted !== undefined && (!Array.isArray(wanted) || wanted.some(n => typeof n !== 'string'))) throw new Error('signals must be an array of signal names');
  const all = parsed.records.map(r => ({index:r.index, name:r.name, recordSize:r.size,
    waveformBytes:r.waveformLength, ...decodeWaveform(buffer, r, parsed.header.durationTicks)}));
  const byIndex = new Map(all.map(s => [s.index,s]));
  for (const group of parsed.groups) {
    const members = group.memberIndices.map(i => byIndex.get(i));
    if (members.some(s => !s?.decoded)) {all.push({...group, decoded:false, role:'bus', segments:[], events:[], problems:['one or more bus members are unavailable or undecoded']}); continue;}
    const boundaries = [...new Set([0, ...members.flatMap(s => s.events.map(e => e.ticks)), parsed.header.durationTicks])].sort((a,b) => a-b);
    const segments = [], events = [], cursors=members.map(()=>0); let previous;
    for (let i=0;i<boundaries.length-1;i++) {
      const ticks = boundaries[i], bits = members.map((s,k) => {
        while(cursors[k]+1<s.segments.length && s.segments[cursors[k]].startTicks+s.segments[cursors[k]].durationTicks<=ticks)cursors[k]++;
        return s.segments[cursors[k]]?.value;
      }).join('');
      const value = /^[01]+$/.test(bits) && group.width <= 52 ? Number.parseInt(bits,2) : null;
      if (bits !== previous) events.push({time:ticks/10,ticks,bits,value});
      const duration = boundaries[i+1] - ticks;
      segments.push({startTime:ticks/10,endTime:boundaries[i+1]/10,duration:duration/10,startTicks:ticks,durationTicks:duration,bits,value}); previous=bits;
    }
    all.push({...group, decoded:true, role:'bus', segments, events, problems:[]});
  }
  const selected = wanted ? all.filter(s => wanted.includes(s.name)) : all;
  const missingSignals = wanted ? wanted.filter(n => !selected.some(s => s.name === n)) : [];
  const result = selected.map(s => {
    const segments = s.segments.filter(e => e.endTime > startTime && e.startTime <= endTime);
    const events = s.events.filter(e => e.time >= startTime && e.time <= endTime);
    const activeSegment=s.segments.find(e => e.startTime <= startTime && startTime < e.endTime);
    return {...s, segments:segments.slice(offset,offset+limit), events:events.slice(offset,offset+limit),
      // Segments are half-open: at an event boundary the new segment is active.
      // A bus value of null is meaningful (X/Z), so never fall back to an older value.
      valueAtStart:activeSegment ? activeSegment.value : null,
      ...(s.role==='bus'?{bitsAtStart:activeSegment?.bits ?? null}:{}),
      totalSegments:segments.length,totalEvents:events.length, offset, limit,
      truncated:segments.length > offset+limit || events.length > offset+limit};
  });
  const writableScalarInputs=all.filter(s=>s.role==='input'&&s.decoded).map(s=>s.name);
  return {header:parsed.header,fileSize:buffer.length,recordFraming:parsed.complete,groups:parsed.groups,
    waveformEncoding:parsed.complete && parsed.groupsComplete && all.every(s => s.decoded), signals:result, missingSignals,
    totalSignals:all.length, problems:[...parsed.problems,...all.flatMap(s => s.problems.map(p => `${s.name}: ${p}`))],
    unit:'ns',trailerDecoded:false,writable:writableScalarInputs.length>0&&parsed.header.version===4&&parsed.problems.length===0,
    writableScalarInputs,writeScope:'existing scalar input events, fixed simulation duration; preserve all other bytes'};
}

export function describeScf(input, options = {}) {
  const buffer=asBuffer(input), parsed=parseScfRecords(buffer), waveforms=readScfWaveforms(buffer,options);
  return {...waveforms,totalWaveformBytes:parsed.records.reduce((n,r) => n+r.waveformLength,0),tailBytes:parsed.tailLength,
    understood:{header:true,recordFraming:parsed.complete,trailer:false,waveformEncoding:waveforms.waveformEncoding,writable:waveforms.writable},
    note:'Scalar logic runs and display groups are decoded with times in ns. Unrecognized fields and the editor trailer remain opaque; originals are never modified by reading.'};
}

/** Replace existing scalar input waveforms. Preserve the horizon and every opaque byte. */
export function editScfWaveforms(input, edits) {
  const buffer=asBuffer(input), parsed=parseScfRecords(buffer);
  if(parsed.header.version!==4) throw new Error('SCF writing supports vendor version 4 containers only');
  if (!parsed.complete) throw new Error('cannot edit an SCF whose records do not frame completely');
  if(parsed.problems.length) throw new Error(`cannot edit malformed SCF metadata: ${parsed.problems.join('; ')}`);
  if (!Array.isArray(edits) || edits.length < 1) throw new Error('SCF edits must be a nonempty array');
  const replacements=new Map(), changes=[];
  for (const edit of edits) {
    if (!edit || typeof edit.signal !== 'string' || Object.keys(edit).some(k => !['signal','events'].includes(k))) throw new Error('each SCF edit requires only signal and events');
    if (replacements.has(edit.signal)) throw new Error(`duplicate SCF edit for ${edit.signal}`);
    const r=parsed.records.find(r => r.name === edit.signal);
    if (!r) throw new Error(`SCF scalar signal not found: ${edit.signal}; edit bus member signals individually`);
    const old=decodeWaveform(buffer,r,parsed.header.durationTicks);
    if (!old.decoded) throw new Error(`cannot edit undecoded waveform ${r.name}: ${old.problems.join('; ')}`);
    if (old.role !== 'input') throw new Error(`SCF ${r.name} is ${old.role}; only input stimuli can be edited`);
    if (!Array.isArray(edit.events) || !edit.events.length || edit.events.length > 100000) throw new Error('SCF events must contain between 1 and 100000 events');
    let previousTicks=-1, previousValue;
    const events=[];
    for (const event of edit.events) {
      if (!event || Object.keys(event).some(k => !['time','value'].includes(k)) || !Number.isFinite(event.time) || event.time < 0) throw new Error('SCF event requires time in ns and value 0, 1, X or Z');
      const scaled=event.time*10, ticks=Math.round(scaled);
      if (Math.abs(scaled-ticks)>1e-7) throw new Error('SCF event times must be exact multiples of 0.1 ns');
      if (ticks <= previousTicks || ticks >= parsed.header.durationTicks) throw new Error('SCF event times must increase and precede the existing simulation end');
      const value=typeof event.value==='string' ? event.value.toUpperCase() : event.value;
      const valueCode=[...VALUES].find(([,v]) => v===value)?.[0];
      if (valueCode === undefined) throw new Error('SCF value must be 0, 1, X or Z');
      if (!events.length && ticks !== 0) throw new Error('SCF waveform must have its initial value at time 0');
      if (value !== previousValue) events.push({ticks,value,valueCode});
      previousTicks=ticks;previousValue=value;
    }
    const bytes=Buffer.alloc(r.waveformStart-r.start+21+events.length*8);
    buffer.copy(bytes,0,r.start,r.waveformStart+17);
    bytes.writeUInt32LE(bytes.length-6,2);
    const relative=r.waveformStart-r.start;
    bytes.writeUInt32LE(events.length,relative+17);
    for(let i=0;i<events.length;i++) {
      const at=relative+21+i*8, end=events[i+1]?.ticks ?? parsed.header.durationTicks;
      bytes.writeUInt32LE(end-events[i].ticks,at);bytes.writeUInt16LE(0,at+4);bytes.writeUInt16LE(events[i].valueCode,at+6);
    }
    replacements.set(r.name,bytes);
    changes.push({signal:r.name,previousSegments:old.segmentCount,segments:events.length,
      previousRecordBytes:r.size,recordBytes:bytes.length,events:events.map(e=>({time:e.ticks/10,value:e.value}))});
  }
  const chunks=[buffer.subarray(0,parsed.firstRecordOffset)];
  for(const r of parsed.records)chunks.push(replacements.get(r.name) ?? buffer.subarray(r.start,r.start+r.size));
  chunks.push(buffer.subarray(parsed.tailOffset));
  const output=Buffer.concat(chunks);
  const reread=readScfWaveforms(output,{signals:changes.map(c=>c.signal)});
  if(!reread.recordFraming||reread.signals.some(s=>!s.decoded)) throw new Error('edited SCF failed structural validation');
  return {buffer:output,changes,durationNs:parsed.header.durationNs,unit:'ns',
    note:'Input stimuli changed; existing output/internal traces are stale until the vendor Simulator runs again.'};
}

export function patchScf(input, edits) {
  const out=Buffer.from(input), applied=[];
  for(const {offset,bytes,label} of edits) {
    const src=Buffer.from(bytes);
    if(!Number.isInteger(offset)||offset<0||offset+src.length>out.length) throw new Error(`patch ${label??''} out of range at ${offset}`);
    src.copy(out,offset);applied.push({label,offset,length:src.length});
  }
  return {buffer:out,applied};
}
