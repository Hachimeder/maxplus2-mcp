/** Workflows derived from actual schematic and CPU waveform use. */
import fs from 'node:fs';
import path from 'node:path';
import {scopedPath,authorBinaryFile,sha256} from './workspace.mjs';
import {pageResult} from './extended-file-tools.mjs';
import {cleanupGdfWires} from './gdf-wire-cleanup.mjs';
import {analyseWaveformResults,inspectWaveformSignals} from './waveform-results.mjs';
import {inspectDisplayPalette} from './display-palette.mjs';
const string=(description,maxLength=2047)=>({type:'string',maxLength,description});
const integer=(description,minimum,maximum)=>({type:'integer',minimum,maximum,description});
const ns=description=>({type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER,description});
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const pages={offset:integer('Root collection offset, default0.',0,1000000),limit:integer('Root collection items, default20; may reduce to fit response budget.',1,100),childOffset:integer('Independent nested detail offset, default0.',0,1000000),childLimit:integer('Nested collection item limit, default root limit.',1,100)};
const budgets={maxRows:integer('TBL row parsing budget, default200000.',1,1000000),maxComparisons:integer('TBL analysis comparison budget, default2000000.',1,10000000)};
function entry(name,title,description,properties,required,handler,write=false,actsOn='project-files'){
 return {name,title,description,inputSchema:object(properties,required),annotations:{readOnlyHint:!write,destructiveHint:write,idempotentHint:!write,openWorldHint:false},sideEffects:write?'write':'none',reversibility:write?'reversible-by-backup':'not-applicable',actsOn,handler};
}
export function practiceFileTools({defaultWorkspace,resolveAcf}){
 const scope=a=>a.project?path.dirname(resolveAcf(a.project,a.workspace)):fs.realpathSync(a.workspace??defaultWorkspace);
 const file={project:string('Existing ACF whose directory scopes files.'),workspace:string('Workspace scope when no project is selected.'),path:string('File path within the selected scope.')};
 const readTable=a=>{
  const p=scopedPath(scope(a),a.path),stat=fs.statSync(p);
  if(path.extname(p).toLowerCase()!=='.tbl')throw new Error('Waveform result analysis requires an original .tbl result file');
  if(!stat.isFile()||stat.size>32*1024*1024)throw new Error('TBL must be an ordinary file up to32MiB');
  const bytes=fs.readFileSync(p);return {path:p,sha256:sha256(bytes),text:bytes.toString('latin1')};
 };
 return [
  entry('gdf_wire_cleanup','Prune checked anonymous wire tails','Remove only unannotated electrical leaf segments in GDF6 pin-bearing physical nets. Preserve surviving token bytes, named wires, pins, isolated unconnected nets and overlapping conductors. Every round checks source scalar pin partitions and complete bus bit/alias partitions. Refuse unknown topology or exceeded budgets; compile and simulate the result independently. Fresh hash, preview and backup transaction.',{...file,expectedSha256:{...string('Current full GDF SHA-256 from a fresh inspection.',64),minLength:64},maxComparisons:integer('Fixed-cap cleanup comparison budget, default4000000; caller may lower it.',1,4000000),maxPasses:integer('Maximum leaf-peeling rounds, default1000.',1,1000),confirm:{type:'boolean',description:'Apply when true; default preview without writing.'}},['path','expectedSha256'],a=>authorBinaryFile(scope(a),a,{extensions:['.gdf'],editor:b=>cleanupGdfWires(b,{maxComparisons:a.maxComparisons,maxPasses:a.maxPasses})}),true),
  entry('waveform_signals','Inspect actual simulation table columns','Read an original TBL and return real declared input/output/buried signals, bit widths, native units and available time span. Detect malformed tables, ambiguous names and exceeded budgets. Hidden SCF signals absent from TBL remain absent; this does not prove saved editor layout.',{...file,...pages,...budgets},['path'],a=>{const s=readTable(a);return {path:s.path,sha256:s.sha256,...pageResult(inspectWaveformSignals(s.text,a),a)};}),
  entry('waveform_results','Extract valid output events and viewing interval','Extract result events gated by an actual scalar valid signal. Default proven rising edges, with initial-high rows separately marked; optional samples means native rows while valid=1. Optional settling samples point-in-time data inside the valid window. Retains raw numeric/X/Z tokens, missing columns and unknowns; held data while valid is low creates no result. Return paginated events and a recommended ns window; does not alter SCF zoom, row visibility, clock or design logic.',{...file,validSignal:string('Real scalar valid column, e.g. OUT_VALID.',256),dataSignals:{type:'array',minItems:1,maxItems:64,description:'Actual result columns, e.g. OUTBUS[7..0].',items:string('Real TBL column name.',256)},kindSignal:string('Optional type discriminator column, e.g. OUT_KIND; no semantics inferred.',256),edge:{type:'string',enum:['rising','samples'],description:'Default rising. samples selects native valid-high rows, not uniform sampling.'},settleNs:ns('Sampling delay after valid entry, default0; must remain in the same valid window.'),paddingNs:ns('Recommended view padding, default1000ns.'),startTimeNs:ns('Inclusive event-range start in ns, default first native time.'),endTimeNs:ns('Inclusive event-range end in ns, default last native time.'),offset:integer('Result event offset, default0.',0,1000000),limit:integer('Event count, default20; may reduce to fit output budget.',1,100),maxEvents:integer('Total event budget before pagination, default100000.',1,200000),...budgets},['path','validSignal','dataSignals'],a=>{
   const s=readTable(a),analysed=analyseWaveformResults(s.text,{...a,limit:a.limit??20});
   const selected=new Set([analysed.validSignal,analysed.kindSignal,...analysed.dataSignals].filter(Boolean).map(n=>n.toUpperCase()));
   const result={...analysed,totalDeclaredSignals:analysed.signals.length,signals:analysed.signals.filter(n=>selected.has(n.name.toUpperCase())),signalCatalogTool:'waveform_signals'};
   let count=result.events.items.length;
   for(;;){const items=result.events.items.slice(0,count),next=result.events.offset+items.length<result.events.total?result.events.offset+items.length:null,out={path:s.path,sha256:s.sha256,...result,events:{...result.events,items,returned:items.length,limit:count||result.events.limit,nextOffset:next,truncated:result.events.offset>0||next!==null},responseLimitReduced:count<result.events.items.length};
    if(JSON.stringify(out).length<=36000)return out;
    if(count<=1)throw new Error('Waveform event exceeds response budget; select fewer dataSignals or narrow the time interval');
    count=Math.max(1,Math.floor(count/2));
   }
  }),
  entry('display_palette_inspect','Inspect stored original application colors','Read only the [Colors] section of installed maxplus2.ini. Separate ordinary DOC Text, native Symbol Pinstub Names, and Nodes & Connection Dots roles. Reports stored preferences, not live unsaved colors; GDF color bits and custom previews cannot prove native display. Verify visible colors using original Color Palette Preview and desktop_observe.',{root:string('Optional explicit MAX+plus II installation root; invalid explicit roots are refused.')},[],a=>inspectDisplayPalette(a.root),false,'installed-application-preferences')
 ];
}
