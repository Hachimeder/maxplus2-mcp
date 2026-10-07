/** Project authoring with bounded reads, content hashes and recoverable writes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {editScfWaveforms} from './scf.mjs';
import {editGdfGeometry} from './gdf-editor.mjs';
import {createBlankGdf} from './gdf-authoring.mjs';

export const TEXT_EXTENSIONS = new Set(['.acf', '.vhd', '.vhdl', '.tdf', '.v', '.mif', '.hex', '.vec', '.tbl', '.rpt', '.pin', '.summary', '.inc', '.txt', '.csv', '.edf', '.edif', '.edo', '.vho', '.vo', '.tdo', '.sdo', '.vmo']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RESTORE_BYTES = 128 * 1024 * 1024;
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };

// Resolve existing ancestors as well as nonexistent final components. A project
// junction can alias its own backup store without escaping the workspace.
function physicalPath(p) {
  let ancestor=path.resolve(p); const tail=[];
  while(!fs.existsSync(ancestor)){tail.unshift(path.basename(ancestor));const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('path has no existing ancestor');ancestor=parent;}
  return path.join(fs.realpathSync(ancestor),...tail);
}
const pathKey=p=>process.platform==='win32'?path.normalize(p).toLowerCase():path.normalize(p);
export function isBackupPath(root,p) {
  root=fs.realpathSync(root);
  const reserved=s=>s.split(path.sep).some(part=>pathKey(part)===pathKey('.mcp-backups'));
  const named=reserved(path.resolve(p))||reserved(physicalPath(p));
  return named||inside(pathKey(physicalPath(path.join(root,'.mcp-backups'))),pathKey(physicalPath(p)));
}
export function writablePath(root,input) {
  const p=scopedPath(root,input);
  if(pathKey(physicalPath(p))===pathKey(fs.realpathSync(root))||isBackupPath(root,p))throw new Error('cannot mutate the reserved scope root or backup store');
  return p;
}

export function scopedPath(root, input = '.') {
  root = fs.realpathSync(root);
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('path must be a string without NUL');
  const target = path.resolve(root, input);
  if (!inside(root, target)) throw new Error('path escapes the project/workspace directory');
  // Check every existing ancestor: a junction or symlink must not escape the scope.
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(root, fs.realpathSync(probe))) throw new Error('path escapes through a symlink/junction');
  if (target === root) return target;
  if (path.relative(root, target).split(path.sep).some(p => /[:\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('invalid or reserved file name');
  return target;
}

export function fileDigest(p) {
  const bytes = fs.readFileSync(p);
  return { path: p, bytes: bytes.length, sha256: sha256(bytes) };
}

function readBytes(p,maximum=MAX_FILE_BYTES) {
  if (!fs.statSync(p).isFile()) throw new Error('expected a regular file');
  if (fs.statSync(p).size > maximum) throw new Error(`file exceeds the ${maximum/1024/1024} MiB ${maximum===MAX_FILE_BYTES?'authoring':'restore'} limit`);
  return fs.readFileSync(p);
}
function checkHash(bytes, expected) {
  const actual = sha256(bytes);
  if (expected !== actual) throw new Error(`file changed or expectedSha256 missing; read again. Current SHA-256: ${actual}`);
}
function textBytes(text, encoding = 'latin1') {
  if (!['latin1', 'utf8'].includes(encoding)) throw new Error('encoding must be latin1 or utf8');
  if (typeof text !== 'string') throw new Error('content must be a string');
  if (encoding === 'latin1' && [...text].some(c => c.codePointAt(0) > 255)) throw new Error('non-Latin-1 text would be corrupted; choose encoding:utf8 explicitly');
  const bytes = Buffer.from(text, encoding);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('content exceeds 4 MiB');
  return bytes;
}
function ensureText(p) {
  if (!TEXT_EXTENSIONS.has(path.extname(p).toLowerCase())) throw new Error('binary/unknown format: use specialized GDF/SYM/SCF tools, copy/move or the original editor');
}
function backup(root, p) {
  const dir = scopedPath(root, '.mcp-backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${randomUUID()}-${path.basename(p)}`);
  fs.copyFileSync(p, dest, fs.constants.COPYFILE_EXCL);
  return dest;
}
function atomicWrite(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = path.join(path.dirname(p), `.mcp-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, p); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function inventory(root, { limit = 2000, offset = 0 } = {}) {
  const files = [];
  let visited = 0;
  function walk(dir, depth) {
    if (depth > 16) throw new Error('directory tree exceeds 16 levels; narrow the scope');
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (++visited > 20000) throw new Error('directory tree exceeds 20000 entries; narrow the scope');
      if (['.mcp-backups', '.git', 'node_modules', '.codex'].includes(pathKey(e.name))) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      scopedPath(root, p);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) files.push({ path: path.relative(root, p), bytes: fs.statSync(p).size, text: TEXT_EXTENSIONS.has(path.extname(p).toLowerCase()) });
    }
  }
  walk(root, 0);
  return { root, total: files.length, files: files.slice(offset, offset + limit), nextOffset: offset + limit < files.length ? offset + limit : null };
}

export function readProjectFile(root, args) {
  const p = scopedPath(root, args.path); ensureText(p);
  const bytes = readBytes(p);
  const lines = bytes.toString(args.encoding ?? 'latin1').split(/\r?\n/);
  const start = args.startLine ?? 1;
  const count = args.lineCount ?? 200;
  const selected = []; let chars = 0;
  for (const line of lines.slice(start - 1, start - 1 + count)) {
    if (chars + line.length > 24000) break;
    selected.push(line); chars += line.length + 1;
  }
  return { ...fileDigest(p), encoding: args.encoding ?? 'latin1', totalLines: lines.length, startLine: start, content: selected.join('\n'), nextLine: start - 1 + selected.length < lines.length ? start + selected.length : null };
}

export function searchProject(root, args) {
  const query = args.query;
  if (!query) throw new Error('query cannot be empty');
  const index = inventory(root, { limit: 20000 });
  const matches = []; const skipped = [];
  for (const item of index.files) {
    if (!item.text) continue;
    if (item.bytes > MAX_FILE_BYTES) { skipped.push(item.path); continue; }
    const p = scopedPath(root, item.path);
    const lines = readBytes(p).toString(args.encoding ?? 'latin1').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((args.caseSensitive ? line : line.toLowerCase()).includes(args.caseSensitive ? query : query.toLowerCase())) {
        matches.push({ path: item.path, line: i + 1, text: line.slice(0, 500) });
        if (matches.length >= (args.limit ?? 100)) return { matches, truncated: true, skipped };
      }
    }
  }
  return { matches, truncated: false, skipped };
}

export function changeProjectFile(root, args) {
  const p = writablePath(root, args.path);
  const operation = args.operation ?? 'write';
  const exists = fs.existsSync(p);
  const original = exists ? readBytes(p) : null;
  if (exists) checkHash(original, args.expectedSha256);
  let bytes; let destination;
  if (operation === 'write') { ensureText(p); bytes = textBytes(args.content, args.encoding); }
  else if (operation === 'patch') {
    ensureText(p);
    if (!original) throw new Error('patch requires an existing file');
    let text = original.toString(args.encoding ?? 'latin1');
    if (!args.edits?.length) throw new Error('edits must contain at least one exact replacement');
    for (const e of args.edits) {
      if (!e.find) throw new Error('find must not be empty');
      const count = text.split(e.find).length - 1;
      if (count !== (e.occurrences ?? 1)) throw new Error(`replacement expected ${e.occurrences ?? 1} occurrence(s), found ${count}; no file was changed`);
      text = text.split(e.find).join(e.replace);
    }
    bytes = textBytes(text, args.encoding);
  } else if (['copy', 'move'].includes(operation)) {
    if (!original) throw new Error('source file missing');
    destination = writablePath(root, args.destination);
    if (fs.existsSync(destination)) throw new Error('destination already exists; overwrite it explicitly with a separate write');
    bytes = original;
  } else if (operation === 'delete') {
    if (!original) throw new Error('file missing');
  } else throw new Error('unknown file operation');
  const plan = { operation, path: p, destination, previousSha256: original ? sha256(original) : null, nextSha256: bytes ? sha256(bytes) : null, bytes: bytes?.length ?? 0 };
  if (args.confirm !== true) return { ...plan, preview: true, contentPreview: bytes && TEXT_EXTENSIONS.has(path.extname(p).toLowerCase()) ? bytes.toString(args.encoding ?? 'latin1').slice(0, 4000) : undefined };
  const saved = exists && operation !== 'copy' ? backup(root, p) : null;
  if (operation === 'delete') fs.unlinkSync(p);
  else if (operation === 'move') { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(p, destination); }
  else atomicWrite(destination ?? p, bytes);
  return { ...plan, preview: false, backup: saved, applied: true, result: operation === 'delete' ? null : fileDigest(destination ?? p) };
}

export function restoreProjectFile(root, args) {
  const p = writablePath(root,args.path);
  const source = scopedPath(root,args.backup);
  const backupRoot = scopedPath(root,'.mcp-backups');
  if (!inside(pathKey(physicalPath(backupRoot)),pathKey(physicalPath(source))) || pathKey(physicalPath(source))===pathKey(physicalPath(backupRoot))) throw new Error('restore requires a file from this project backup store and an ordinary destination');
  const bytes=readBytes(source,MAX_RESTORE_BYTES);checkHash(bytes,args.backupSha256);
  const existing=fs.existsSync(p)?readBytes(p,MAX_RESTORE_BYTES):null;
  if(existing)checkHash(existing,args.expectedSha256);
  const plan={path:p,source,restoredSha256:sha256(bytes),previousSha256:existing?sha256(existing):null,bytes:bytes.length};
  if(args.confirm!==true)return {...plan,preview:true};
  const saved=existing?backup(root,p):null;
  atomicWrite(p,bytes);
  return {...plan,preview:false,applied:true,backup:saved,result:fileDigest(p)};
}

/** Apply the independently verified SCF input-event writer with ordinary backups. */
export function editScfFile(root,args){
  const p=writablePath(root,args.path);
  if(path.extname(p).toLowerCase()!=='.scf')throw new Error('SCF input editor requires a .scf file');
  const before=readBytes(p);checkHash(before,args.expectedSha256);
  const edited=editScfWaveforms(before,args.edits);
  if(edited.buffer.length>MAX_FILE_BYTES)throw new Error('edited SCF exceeds 4 MiB authoring limit');
  const changes=edited.changes.map(c=>({...c,totalEvents:c.events.length,events:c.events.slice(0,20),eventsTruncated:c.events.length>20}));
  const plan={path:p,previousSha256:sha256(before),nextSha256:sha256(edited.buffer),bytes:edited.buffer.length,changes,durationNs:edited.durationNs,unit:'ns',note:edited.note};
  if(args.confirm!==true)return {...plan,preview:true};
  const saved=backup(root,p);atomicWrite(p,edited.buffer);
  return {...plan,preview:false,applied:true,backup:saved,result:fileDigest(p),next:'simulate_and_verify; previous output/internal traces are stale after stimulus edits'};
}

export function editGdfFile(root,args,editor=editGdfGeometry){
  const p=writablePath(root,args.path);
  if(path.extname(p).toLowerCase()!=='.gdf')throw new Error('GDF editor requires a .gdf file');
  const before=readBytes(p);checkHash(before,args.expectedSha256);
  const edited=editor(before,args.edits);
  if(edited.buffer.length>MAX_FILE_BYTES)throw new Error('edited GDF exceeds 4 MiB authoring limit');
  const compact=value=>{if(!value||typeof value!=='object')return value;const result={...value};for(const [key,v] of Object.entries(result)){if(typeof v==='string'&&v.length>128&&key!=='path'){result[key+'Length']=v.length;result[key+'Truncated']=true;result[key]=v.slice(0,128);}else if(Array.isArray(v)){result[key]=v.slice(0,10).map(compact);result[key+'Total']=v.length;result[key+'Truncated']=v.length>10;}else if(v&&typeof v==='object')result[key]=compact(v);}return result;};
  const changes=edited.changes.map(compact);
  const sources=edited.sources?[...new Map(edited.sources.map(s=>[s.path+'|'+s.sha256,s])).values()]:undefined;
  let changeLimit=20,sourceLimit=20,plan;do{plan={path:p,previousSha256:sha256(before),nextSha256:sha256(edited.buffer),bytes:edited.buffer.length,changes:changes.slice(0,changeLimit),totalChanges:changes.length,changesTruncated:changes.length>changeLimit,note:edited.note,counts:edited.counts,sources:sources?.slice(0,sourceLimit),totalSources:sources?.length,sourcesTruncated:sources? sources.length>sourceLimit:undefined};if(JSON.stringify(plan).length<=35000)break;if(changeLimit>1)changeLimit=Math.max(1,Math.floor(changeLimit/2));else if(sourceLimit>1)sourceLimit=Math.max(1,Math.floor(sourceLimit/2));else throw new Error('GDF transaction result exceeds budget; narrow the operation batch');}while(true);
  if(args.confirm!==true)return {...plan,preview:true};
  const saved=backup(root,p);atomicWrite(p,edited.buffer);
  return {...plan,preview:false,applied:true,backup:saved,result:fileDigest(p),next:'Read gdf_geometry again for current offsets; export/compile the edited design to verify connectivity.'};
}

export function createGdfFile(root,args){
  const p=writablePath(root,args.path);
  if(path.extname(p).toLowerCase()!=='.gdf')throw new Error('new drawing requires a .gdf path');
  if(fs.existsSync(p))throw new Error('drawing already exists; creation never overwrites files');
  const bytes=createBlankGdf(args),plan={path:p,bytes:bytes.length,sha256:sha256(bytes),width:args.width??1904,height:args.height??1232};
  if(args.confirm!==true)return {...plan,preview:true};
  fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes,{flag:'wx'});
  return {...plan,preview:false,applied:true,next:'gdf_symbol_library -> gdf_construct -> gdf_geometry -> netlist_export/compile -> stimulus_write -> simulate_and_verify'};
}

/** Shared transaction for independently decoded binary editors and creators. */
export function authorBinaryFile(root,args,{extensions,create=false,editor}){
  const p=writablePath(root,args.path);
  if(!extensions.includes(path.extname(p).toLowerCase()))throw new Error('Expected '+extensions.join('/')+' target');
  if(create&&fs.existsSync(p))throw new Error('target already exists; creation never overwrites files');
  const before=create?null:readBytes(p);if(before)checkHash(before,args.expectedSha256);
  const result=editor(before),bytes=result.buffer;
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_FILE_BYTES)throw new Error('Binary result must be a buffer up to 4 MiB');
  let truncations;
  const bound=(v,p='$')=>{if(typeof v==='string'){if(v.length>512){truncations.push({path:p,kind:'string',total:v.length,returned:512});return v.slice(0,512)+'…';}return v;}if(Array.isArray(v)){if(v.length>20)truncations.push({path:p,kind:'array',total:v.length,returned:20});return v.slice(0,20).map((x,i)=>bound(x,p+'['+i+']'));}if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bound(x,p+'.'+k)]));return v;};
  let count=20,plan;do{truncations=[];const changes=bound((result.changes??[]).slice(0,count),'$.changes');plan={path:p,previousSha256:before?sha256(before):null,nextSha256:sha256(bytes),bytes:bytes.length,changes,connectionCheck:result.connectionCheck?bound(result.connectionCheck,'$.connectionCheck'):undefined,totalChanges:result.changes?.length??0,changesTruncated:(result.changes?.length??0)>count,truncated:truncations.length>0||(result.changes?.length??0)>count,truncations:truncations.slice(0,20),totalTruncations:truncations.length,note:result.note,durationNs:result.durationNs,unit:result.unit};if(JSON.stringify(plan).length<=35000)break;if(count===1)throw new Error('Binary change preview exceeds result budget');count=Math.max(1,Math.floor(count/2));}while(true);
  if(args.confirm!==true)return {...plan,preview:true};
  const saved=before?backup(root,p):null;
  if(create){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes,{flag:'wx'});}else atomicWrite(p,bytes);
  return {...plan,preview:false,applied:true,backup:saved,result:fileDigest(p),next:'Inspect the new file/hash before another edit; compile/simulate the consuming design to validate behavior.'};
}

export function createProject(workspace, args) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(args.name)) throw new Error('name must be a MAX+plus II identifier');
  if (args.device && !/^[A-Za-z0-9_-]+$/.test(args.device)) throw new Error('invalid device identifier');
  const dir = writablePath(workspace, args.directory ?? args.name);
  if (fs.existsSync(dir)) throw new Error('project directory already exists; select a new directory to avoid source collisions');
  const acf = `CHIP ${args.name}\nBEGIN\n${args.device ? `    DEVICE = ${args.device};\n` : ''}END;\n\nSIMULATOR_CONFIGURATION\nBEGIN\n    END_TIME = 0.0ns;\nEND;\n`;
  const extension = args.sourceExtension ?? '.vhd';
  if (!['.vhd', '.v', '.tdf'].includes(extension)) throw new Error('sourceExtension must be .vhd, .v or .tdf');
  const source = args.source === undefined ? null : textBytes(args.source, args.encoding);
  if (args.confirm !== true) return { preview: true, directory: dir, acf, source: source?.toString(args.encoding ?? 'latin1') };
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `${args.name}.acf`), acf, { flag: 'wx' });
    if (source) fs.writeFileSync(path.join(dir, args.name + extension), source, { flag: 'wx' });
  } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
  return { preview: false, directory: dir, project: path.join(dir, `${args.name}.acf`), files: inventory(dir).files, next: 'acf_validate -> maxplus2_run compile:true -> stimulus_write -> simulate_and_verify' };
}

export function cloneProject(source, workspace, args) {
  const dir = writablePath(workspace, args.directory);
  if (fs.existsSync(dir)) throw new Error('clone directory already exists');
  const root = fs.realpathSync(path.dirname(source));
  if (inside(root, dir)) throw new Error('clone destination cannot be inside the source directory');
  const index = inventory(root, { limit: 20000 });
  const profile=args.profile??'all';
  if(!['all','sources'].includes(profile))throw new Error('clone profile must be all or sources');
  const extensions=new Set(['.acf','.gdf','.sym','.vhd','.vhdl','.v','.tdf','.inc','.mif','.hex','.edf','.edif','.asm']);
  if(args.includePaths!==undefined&&(!Array.isArray(args.includePaths)||args.includePaths.length>200||args.includePaths.some(p=>typeof p!=='string')))throw new Error('includePaths must contain up to200 explicit source-relative file paths');
  const included=new Set((args.includePaths??[]).map(p=>path.relative(root,scopedPath(root,p))));
  for(const p of included)if(!index.files.some(f=>f.path===p)||p==='.mcp-clone-manifest.json')throw new Error(`included clone file is missing or reserved: ${p}`);
  const files=index.files.filter(f=>f.path!=='.mcp-clone-manifest.json'&&(profile==='all'||extensions.has(path.extname(f.path).toLowerCase())||included.has(f.path)));
  if(!files.some(f=>pathKey(path.resolve(root,f.path))===pathKey(fs.realpathSync(source))))throw new Error('clone selection does not include the selected ACF');
  const bytes=files.reduce((sum,f)=>sum+f.bytes,0),selection={profile,fileCount:files.length,bytes,skippedFiles:index.total-files.length,includePaths:[...included]};
  if (bytes > 128 * 1024 * 1024) throw new Error('clone exceeds128MiB; use profile:sources and includePaths for required auxiliary files');
  if (args.confirm !== true) return { preview: true, source: root, directory: dir,...selection,note:profile==='sources'?'All matching source extensions in the directory are copied; this is not a complete hierarchy dependency resolver. Include required external assets explicitly.':undefined };
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  try {
    for (const f of files) {
      const from = scopedPath(root, f.path); const to = scopedPath(dir, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const before = fileDigest(from);
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      const after = fileDigest(to),fresh=fileDigest(from);
      if (before.sha256 !== after.sha256 || before.sha256!==fresh.sha256) throw new Error('source changed during clone; retry');
      manifest.push({ source: from, destination: to, sha256: after.sha256 });
    }
    fs.writeFileSync(path.join(dir, '.mcp-clone-manifest.json'), JSON.stringify(manifest, null, 2));
  } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
  return { preview: false, source: root, directory: dir, project: path.join(dir, path.basename(source)), ...selection, manifestPath: path.join(dir, '.mcp-clone-manifest.json'),next:profile==='sources'?'Inspect hierarchy dependencies and compile this isolated source copy; simulation needs fresh SCF/VEC or an explicitly included stimulus.':undefined };
}

export function buildStimulus(args) {
  const specs = args.inputs.map(s => typeof s === 'string' ? { name: s, nodes: [s] } : { name: s.name, nodes: s.nodes ?? [s.name] });
  const names = specs.flatMap(s => s.nodes);
  if (!names.length || names.length > 1024 || new Set(names.map(n => n.toUpperCase())).size !== names.length || new Set(specs.map(s=>s.name.toUpperCase())).size !== specs.length || names.some(n => !/^[A-Za-z_][A-Za-z0-9_\[\].|]*$/.test(n))) throw new Error('inputs must have unique valid node names, at most 1024');
  const interval = args.interval ?? 100;
  const start = args.start ?? 0;
  const stop = args.stop ?? start + args.rows.length * interval;
  if (!args.rows.length || args.rows.length > 10000 || interval <= 0 || start < 0 || stop < start + args.rows.length * interval || ![interval,start,stop].every(Number.isFinite)) throw new Error('invalid time range; STOP must allow a full interval for every pattern');
  const patterns = args.rows.map(row => {
    if (Object.keys(row).some(n => !specs.some(s => s.name === n))) throw new Error('row contains an undeclared input');
    return specs.flatMap(s => {
      const v = row[s.name]; const width = s.nodes.length;
      if (Number.isSafeInteger(v) && v >= 0) {
        const b = v.toString(2); if (b.length > width) throw new Error(`${s.name} value exceeds ${width} bits`);
        return b.padStart(width, '0').split('');
      }
      if (typeof v === 'string' && /^[01XZ]+$/i.test(v) && v.length === width) return v.toUpperCase().split('');
      throw new Error(`${s.name} requires an unsigned integer or ${width} binary/X/Z characters; every row must drive every input`);
    }).join(' ');
  });
  const outputs = args.outputs ?? [];
  if (outputs.some(n => !/^[A-Za-z_][A-Za-z0-9_\[\].|]*$/.test(n))) throw new Error('invalid output node');
  return ['% Generated by maxplus2-mcp; MSB-first explicit bus nodes %', `UNIT ${args.unit ?? 'ns'};`, `START ${start};`, `STOP ${stop};`, `INTERVAL ${interval};`, `INPUTS ${names.join(' ')};`, ...(outputs.length ? [`OUTPUTS ${outputs.join(' ')};`] : []), 'PATTERN', ...patterns, ';', ''].join('\n');
}

export function buildMemory(args) {
  const { width, depth, values } = args;
  if (!Number.isInteger(width) || width < 1 || width > 1024 || !Number.isInteger(depth) || depth < 1 || depth > 65536 || values.length > depth) throw new Error('invalid memory width/depth or too many values');
  const parse = v => {
    if (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0)) throw new Error('memory values must be unsigned safe integers or integer strings');
    if (!/^(?:\d+|0x[\da-f]+|0b[01]+)$/i.test(String(v))) throw new Error('invalid memory integer');
    const n = BigInt(v); if (n < 0n || n >= (1n << BigInt(width))) throw new Error('memory value exceeds WIDTH');
    return n.toString(16).toUpperCase();
  };
  const defaultValue = parse(args.defaultValue ?? 0);
  const lines = [`WIDTH=${width};`, `DEPTH=${depth};`, 'ADDRESS_RADIX=HEX;', 'DATA_RADIX=HEX;', 'CONTENT BEGIN'];
  for (let i = 0; i < values.length; i++) lines.push(`    ${i.toString(16).toUpperCase()} : ${parse(values[i])};`);
  if (values.length < depth) lines.push(`    [${values.length.toString(16).toUpperCase()}..${(depth - 1).toString(16).toUpperCase()}] : ${defaultValue};`);
  return [...lines, 'END;', ''].join('\n');
}
