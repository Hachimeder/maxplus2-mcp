import {parseTbl} from './tbl.mjs';

const UNIT_NS = new Map([['fs', 0.000001], ['ps', 0.001], ['ns', 1], ['us', 1000], ['µs', 1000], ['μs', 1000], ['ms', 1000000], ['s', 1000000000]]);
const RADIX = new Map([['HEX',16], ['BIN',2], ['BINARY',2], ['OCT',8], ['OCTAL',8], ['DEC',10], ['DECIMAL',10], ['UNS',10]]);
const MAX_BYTES = 32 * 1024 * 1024;

function integer(value, name, fallback, min, max) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}
function finite(value, name, fallback, min = 0) {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be finite and >= ${min}`);
  return n;
}
function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const fraction = mantissa.split('.')[1]?.length??0;
  return {integer:BigInt(mantissa.replace('.','')),scale:fraction-Number(exponent)};
}
function addTime(a,b) {
  const x = decimalParts(a), y = decimalParts(b), scale = Math.max(x.scale,y.scale);
  const sum = x.integer * 10n ** BigInt(scale-x.scale) + y.integer * 10n ** BigInt(scale-y.scale);
  return Number(`${sum}e${-scale}`);
}
function widthOf(name, groups) {
  const group = groups[name];
  if (group) return group.length;
  const m = /\[(\d+)\.\.(\d+)\]$/.exec(name);
  if (!m) return 1;
  const first = Number(m[1]), last = Number(m[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw new Error(`Unsafe signal range: ${name}`);
  return Math.abs(first - last) + 1;
}

/** Validate the native table before parseTbl can allocate expanded input bits. */
function readTable(text, options = {}) {
  if (typeof text !== 'string') throw new Error('TBL input must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('TBL exceeds the 32 MiB analysis budget');
  const maxRows = integer(options.maxRows, 'maxRows', 200000, 1, 1000000);
  const maxComparisons = integer(options.maxComparisons, 'maxComparisons', 2000000, 1, 10000000);
  const lines = text.split(/\r?\n/), groups = Object.create(null), groupNameKeys = new Set(), declarations = [], rawRows = [];
  const fields = new Map();
  let pattern = false, terminated = false, groupMembers = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%')) continue;
    if (terminated) throw new Error(`Unexpected content after TBL PATTERN terminator at line ${i + 1}`);
    if (pattern) {
      if (line === ';') { terminated = true; pattern = false; continue; }
      if (!/^\d+(?:\.\d+)?\s*>/.test(line)) throw new Error(`Malformed TBL pattern at line ${i + 1}`);
      if (rawRows.length >= maxRows) throw new Error(`TBL row budget exceeded (${maxRows})`);
      rawRows.push({line:i + 1, raw:lines[i]});
      continue;
    }
    if (/^PATTERN\s*$/i.test(line)) {
      if (fields.has('PATTERN')) throw new Error('Duplicate TBL PATTERN section');
      fields.set('PATTERN',true); pattern = true; continue;
    }
    let m = /^GROUP\s+CREATE\s+(\S+)\s*=\s*(.*?)\s*;$/i.exec(line);
    if (m) {
      if (Object.prototype.hasOwnProperty.call(Object.prototype,m[1])) throw new Error(`Unsupported reserved TBL GROUP name: ${m[1]}`);
      if (m[1].length > 256) throw new Error('TBL GROUP name exceeds 256 characters');
      if (groupNameKeys.has(m[1].toUpperCase())) throw new Error(`Duplicate or case-colliding TBL GROUP: ${m[1]}`);
      if (groupNameKeys.size >= 2000) throw new Error('TBL GROUP declaration budget exceeded (2000)');
      groupNameKeys.add(m[1].toUpperCase());
      const members = [];
      for (const member of m[2].matchAll(/\S+/g)) {
        if (members.length >= 4096) throw new Error(`TBL GROUP width must be 1..4096: ${m[1]}`);
        if (++groupMembers > 100000) throw new Error('TBL GROUP member budget exceeded (100000)');
        if (member[0].length > 256) throw new Error('TBL GROUP member name exceeds 256 characters');
        members.push(member[0]);
      }
      if (!members.length) throw new Error(`TBL GROUP width must be 1..4096: ${m[1]}`);
      groups[m[1]] = members;
      continue;
    }
    m = /^(INPUTS?|OUTPUTS?|BURIED)\s*(.*?)\s*;$/i.exec(line);
    if (m) {
      const type = /^INPUT/i.test(m[1]) ? 'input' : /^OUTPUT/i.test(m[1]) ? 'output' : 'buried';
      for (const name of m[2].trim().split(/\s+/).filter(Boolean)) {
        if (name.length > 256) throw new Error('TBL signal name exceeds 256 characters');
        if (Object.prototype.hasOwnProperty.call(Object.prototype,name)) throw new Error(`Unsupported reserved TBL signal name: ${name}`);
        declarations.push({name,type});
        if (declarations.length > 2000) throw new Error('TBL signal declaration budget exceeded (2000)');
      }
      continue;
    }
    m = /^(UNIT|RADIX)\s+(\S+)\s*;$/i.exec(line);
    if (m) {
      const name = m[1].toUpperCase();
      if (fields.has(name)) throw new Error(`Duplicate TBL ${name}`);
      fields.set(name,m[2]); continue;
    }
    if (/^(GROUP|INPUTS?|OUTPUTS?|BURIED|UNIT|RADIX|PATTERN)\b/i.test(line)) throw new Error(`Malformed TBL header at line ${i + 1}`);
  }
  if (!fields.has('PATTERN') || !terminated) throw new Error('TBL requires one terminated PATTERN section');
  if (!rawRows.length) throw new Error('TBL PATTERN has no rows');
  const sourceUnit = fields.get('UNIT'), factor = UNIT_NS.get(String(sourceUnit).toLowerCase());
  if (!factor) throw new Error(`Unsupported or missing TBL UNIT: ${sourceUnit ?? '(missing)'}`);
  const radix = String(fields.get('RADIX') ?? '').toUpperCase();
  if (!RADIX.has(radix)) throw new Error(`Unsupported or missing TBL RADIX: ${radix || '(missing)'}`);
  const names = new Map();
  let expandedInputWidth = 0, inputIndex = 0;
  for (const signal of declarations) {
    const key = signal.name.toUpperCase();
    if (names.has(key)) throw new Error(`Case-insensitive TBL signal collision: ${names.get(key).name} / ${signal.name}`);
    signal.width = widthOf(signal.name, groups);
    if (!Number.isSafeInteger(signal.width) || signal.width < 1 || signal.width > 4096) throw new Error(`TBL signal width must be 1..4096: ${signal.name}`);
    if (signal.type === 'input') { expandedInputWidth += signal.width; signal.inputIndex = inputIndex++; }
    names.set(key,signal);
  }
  if (!declarations.length) throw new Error('TBL declares no signals');
  if (expandedInputWidth * rawRows.length > 8000000) throw new Error('TBL expanded input-bit budget exceeded (8000000)');
  if (declarations.length * rawRows.length > 4000000) throw new Error('TBL decoded-cell budget exceeded (4000000)');
  const parsed = parseTbl(text);
  if (parsed.problems.length) throw new Error(`Malformed TBL: ${parsed.problems[0].message} at line ${parsed.problems[0].line}`);
  if (parsed.rows.length !== rawRows.length || parsed.rows.some(r=>r.unparsed)) throw new Error('Malformed or unparsed TBL data rows');
  const rhsCount = parsed.outputs.length + parsed.buried.length;
  let previous = -Infinity;
  for (const row of parsed.rows) {
    const rawTime = /^\s*(\d+(?:\.\d+)?)/.exec(row.raw)[1];
    const timeNs = Number(`${rawTime}e${Math.round(Math.log10(factor))}`);
    if (!Number.isFinite(timeNs) || timeNs > Number.MAX_SAFE_INTEGER || timeNs < 0 || timeNs <= previous) throw new Error(`TBL times must be finite, nonnegative and strictly increasing within the safe numeric range (line ${row.line})`);
    if (row.values.length !== rhsCount) throw new Error(`Malformed TBL output token count at line ${row.line}: expected ${rhsCount}, received ${row.values.length}`);
    row.timeNs = timeNs; previous = timeNs;
  }
  return {parsed, names, signals:declarations, sourceUnit, factor, radix, maxComparisons, comparisons:0};
}
function consume(table) {
  if (++table.comparisons > table.maxComparisons) throw new Error(`TBL comparison budget exceeded (${table.maxComparisons})`);
}

function decodeToken(token, radix, width) {
  if (token === null || token === undefined || token === '') return {rawToken:token ?? null,value:null,valueDecimal:null,state:'missing',radix,width};
  const rawToken = String(token), s = rawToken.toUpperCase();
  if (s.length > 4096) throw new Error('TBL value token exceeds the 4096-character budget');
  if (/^[XZU-]+$/.test(s)) return {rawToken,value:null,valueDecimal:null,state:/^X+$/.test(s)?'X':/^Z+$/.test(s)?'Z':'unknown',radix,width};
  const base = RADIX.get(radix), digits = {2:/^[01]+$/,8:/^[0-7]+$/,10:/^[0-9]+$/,16:/^[0-9A-F]+$/}[base];
  if (!digits.test(s)) {
    if (/^[0-9A-FXZU-]+$/.test(s) && /[XZU-]/.test(s)) {
      const known = s.replace(/[XZU-]/g,'0');
      if (digits.test(known)) return {rawToken,value:null,valueDecimal:null,state:'mixed_unknown',radix,width};
    }
    throw new Error(`Invalid ${radix} TBL value token: ${rawToken}`);
  }
  let n = 0n;
  const ceiling = 1n << BigInt(width);
  for (const char of s) {
    n = n * BigInt(base) + BigInt(parseInt(char,base));
    if (n >= ceiling) throw new Error(`TBL value ${rawToken.slice(0,128)} exceeds ${width} bits`);
  }
  const value = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  return {rawToken,value,valueDecimal:n.toString(),state:value === null?'unsafe_integer':'known',radix,width};
}
function readSignal(table, row, signal) {
  consume(table);
  if (!signal) return {name:null,rawToken:null,rawTokens:[],value:null,valueDecimal:null,state:'missing',width:null,radix:table.radix};
  if (signal.type === 'input') {
    const input = row.inputs[signal.inputIndex];
    const radix = row.inputLayout === 'expanded' ? 'BIN' : table.radix;
    return {name:signal.name,...decodeToken(input.rawTokens.join(''),radix,signal.width),rawTokens:[...input.rawTokens]};
  }
  return {name:signal.name,...decodeToken(row.named[signal.name],table.radix,signal.width),rawTokens:row.named[signal.name] == null?[]:[row.named[signal.name]]};
}
function signalName(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${name} must be a nonempty signal name of <= 256 characters`);
  return value;
}
function catalog(table) {
  const rows = table.parsed.rows;
  return {format:'MAX+plus II TBL',sourceUnit:table.sourceUnit,unit:'ns',radix:table.radix,rowCount:rows.length,firstTimeNs:rows[0].timeNs,lastTimeNs:rows.at(-1).timeNs,signals:table.signals,caseMatching:'case-insensitive; colliding declarations are rejected'};
}

/** Discover only columns actually present in the native TBL, including visible inputs. */
export function inspectWaveformSignals(text, options = {}) {
  const table = readTable(text,options);
  // Validate every token; a catalog cannot claim malformed native data is usable.
  for (const row of table.parsed.rows) for (const signal of table.signals) readSignal(table,row,signal);
  return {...catalog(table),comparisons:table.comparisons,limitations:['Hidden SCF driving rows absent from the TBL are not reconstructed.','TBL display rows do not prove saved GUI row order or zoom.']};
}

/** Analyse point-in-time results gated by a real scalar valid signal. No design-specific meaning is inferred. */
export function analyseWaveformResults(text, options = {}) {
  const table = readTable(text,options);
  const validName = signalName(options.validSignal,'validSignal');
  if (!Array.isArray(options.dataSignals) || !options.dataSignals.length || options.dataSignals.length > 64) throw new Error('dataSignals must contain 1..64 signal names');
  const requested = options.dataSignals.map(n=>signalName(n,'dataSignals item'));
  if (new Set(requested.map(n=>n.toUpperCase())).size !== requested.length) throw new Error('dataSignals contains duplicate or case-colliding names');
  const kindName = options.kindSignal == null ? null : signalName(options.kindSignal,'kindSignal');
  const edge = options.edge ?? 'rising';
  if (edge !== 'rising' && edge !== 'samples') throw new Error('edge must be rising or samples');
  const settleNs = finite(options.settleNs,'settleNs',0), paddingNs = finite(options.paddingNs,'paddingNs',1000);
  const rows = table.parsed.rows, firstTime = rows[0].timeNs, lastTime = rows.at(-1).timeNs;
  const startTimeNs = finite(options.startTimeNs,'startTimeNs',firstTime), endTimeNs = finite(options.endTimeNs,'endTimeNs',lastTime);
  if (startTimeNs > endTimeNs) throw new Error('startTimeNs must be <= endTimeNs');
  const maxEvents = integer(options.maxEvents,'maxEvents',100000,1,200000);
  const offset = integer(options.offset,'offset',0,0,Number.MAX_SAFE_INTEGER), limit = integer(options.limit,'limit',100,1,1000);
  const valid = table.names.get(validName.toUpperCase());
  if (valid && valid.width !== 1) throw new Error(`validSignal must be scalar: ${valid.name}`);
  const data = requested.map(name=>({requested:name,signal:table.names.get(name.toUpperCase())}));
  const kind = kindName ? table.names.get(kindName.toUpperCase()) : null;
  const missingSignals = [...new Set([!valid?validName:null,...data.filter(s=>!s.signal).map(s=>s.requested),kindName&&!kind?kindName:null].filter(Boolean))];
  const base = {...catalog(table),validSignal:valid?.name??validName,dataSignals:data.map(s=>s.signal?.name??s.requested),kindSignal:kind?.name??kindName,edge,settleNs,startTimeNs,endTimeNs,missingSignals};
  const events = [], uncertainValidEntries = [], windows = [], validValues = [];
  let total = 0, firstEventTimeNs = null, lastEventTimeNs = null, lastSampleTimeNs = null;
  let unknownValidRows = 0, uncertainValidEntryCount = 0, sampled = 0, unknownDataEvents = 0, failedSamples = 0, open = null;
  // Validate all tokens, not only selected columns, so corrupt hidden RHS values never pass analysis.
  for (let i = 0; i < rows.length; i++) {
    let value = null;
    for (const signal of table.signals) {
      const decoded = readSignal(table,rows[i],signal);
      if (signal === valid) value = decoded;
    }
    validValues.push(value);
    if (value?.value === 1) {
      if (open === null) open = i;
    } else {
      if (open !== null) { windows.push({startIndex:open,endIndex:i,endTimeNs:rows[i].timeNs,closed:true}); open = null; }
      if (valid && value?.state !== 'known' && rows[i].timeNs >= startTimeNs && rows[i].timeNs <= endTimeNs) unknownValidRows++;
    }
  }
  if (open !== null) windows.push({startIndex:open,endIndex:rows.length,endTimeNs:lastTime,closed:false});
  let windowIndex = 0, lookup = 0;
  for (let i = 0; i < rows.length && valid; i++) {
    consume(table);
    const v = validValues[i], previous = i ? validValues[i-1] : null;
    if (v?.value !== 1) continue;
    const timeNs = rows[i].timeNs;
    if (timeNs < startTimeNs || timeNs > endTimeNs) continue;
    const initial = i === 0;
    if (!initial && previous?.value !== 0 && previous?.value !== 1) {
      uncertainValidEntryCount++;
      if (uncertainValidEntries.length < 100) uncertainValidEntries.push({timeNs:rows[i].timeNs,line:rows[i].line,previousState:previous?.state??'missing',previousRawToken:previous?.rawToken??null});
    }
    if (edge === 'rising' && !initial && previous?.value !== 0) continue;
    if (total >= maxEvents) throw new Error(`TBL event budget exceeded (${maxEvents}); narrow startTimeNs/endTimeNs`);
    while (windows[windowIndex]?.endIndex <= i) { consume(table); windowIndex++; }
    const window = windows[windowIndex], sampleTimeNs = addTime(timeNs,settleNs);
    let status = 'sampled';
    if (!Number.isFinite(sampleTimeNs) || sampleTimeNs > lastTime) status = 'outside_table';
    else if (sampleTimeNs > endTimeNs) status = 'outside_requested_window';
    else if (window.closed && sampleTimeNs >= window.endTimeNs) status = 'outside_valid_window';
    while (lookup + 1 < rows.length && rows[lookup + 1].timeNs <= sampleTimeNs) { consume(table); lookup++; }
    const event = {index:total,timeNs,sourceTime:rows[i].time,line:rows[i].line,initial,sampleTimeNs,validWindow:{startTimeNs:rows[window.startIndex].timeNs,endTimeNs:window.endTimeNs,endExclusive:window.closed},sampled:status==='sampled',status,values:{},kind:null};
    if (event.sampled) {
      event.sampleRowTimeNs = rows[lookup].timeNs; event.sampleRowLine = rows[lookup].line;
      event.valid = readSignal(table,rows[lookup],valid);
      for (const selected of data) event.values[selected.signal?.name??selected.requested] = {...readSignal(table,rows[lookup],selected.signal),name:selected.signal?.name??selected.requested};
      if (kindName) event.kind = {...readSignal(table,rows[lookup],kind),name:kind?.name??kindName};
      sampled++;
      const unknown = Object.values(event.values).some(v=>v.state!=='known') || (event.kind && event.kind.state!=='known');
      if (unknown) { event.status = 'unknown_values'; unknownDataEvents++; }
    } else {
      failedSamples++;
      for (const selected of data) event.values[selected.signal?.name??selected.requested] = {name:selected.signal?.name??selected.requested,rawToken:null,rawTokens:[],value:null,valueDecimal:null,state:selected.signal?'not_sampled':'missing',width:selected.signal?.width??null,radix:table.radix};
    }
    if (total >= offset && total-offset < limit) events.push(event);
    firstEventTimeNs ??= timeNs; lastEventTimeNs = timeNs; lastSampleTimeNs = sampleTimeNs; total++;
  }
  const window = total ? {startTimeNs:Math.max(firstTime,addTime(firstEventTimeNs,-paddingNs)),endTimeNs:Math.min(lastTime,addTime(Math.max(lastEventTimeNs,lastSampleTimeNs),paddingNs)),paddingNs,source:'valid events',instruction:'Use the original Waveform Editor Time Range for this interval; this analysis does not save SCF zoom or row layout.'} : null;
  const items = events, nextOffset = offset + items.length < total ? offset + items.length : null;
  const status = missingSignals.length?'missing_signals':failedSamples?'sampling_failed':unknownDataEvents||unknownValidRows||uncertainValidEntryCount?'unknown_values':total?'complete':'no_valid_events';
  return {...base,status,totalEvents:total,sampledEvents:sampled,failedSamples,unknownDataEvents,unknownValidRows,uncertainValidEntryCount,uncertainValidEntries,uncertainValidEntriesTruncated:uncertainValidEntryCount>uncertainValidEntries.length,firstEventTimeNs,lastEventTimeNs,recommendedWindow:window,events:{total,offset,limit,returned:items.length,nextOffset,truncated:offset>0||nextOffset!==null,items},comparisons:table.comparisons,limitations:['Data held while valid is low is not a new result.','Rising requires a known 0 -> 1 transition; the first native row may instead be explicitly marked initial.','Unknown -> 1 is reported as uncertain and is not counted as a proven rising edge.','Samples mode means native rows with valid=1, not uniform periodic sampling.','Hidden SCF signals absent from the TBL are missing; saved GUI row order and zoom cannot be inferred.','Complete analysis of numeric events does not prove functional correctness of the design.']};
}
