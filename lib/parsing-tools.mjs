import fs from 'node:fs';
import path from 'node:path';
import {scopedPath} from './workspace.mjs';
import {parseProjectFile,netlistPage} from './file-parsing.mjs';
const str=description=>({type:'string',description});
const int=(description,maximum)=>({type:'integer',minimum:0,maximum,description});
export function parsingTools({defaultWorkspace,resolveAcf}){
  const scope=a=>a.project?path.dirname(resolveAcf(a.project,a.workspace)):fs.realpathSync(a.workspace??defaultWorkspace);
  const file={project:str('Existing ACF project to scope file paths to its directory.'),workspace:str('Workspace scope when project is omitted; defaults to MAXPLUS2_WORKSPACE.'),path:str('Source file relative to the project/workspace; absolute paths must remain within that scope.')};
  return [{
    name:'project_parse_file',title:'Parse design and waveform files directly',
    description:'File-first structured parsing of strict GDF text/geometry, SCF scalar/bus logic events in ns, ACF assignments, TBL traces, reports and EDIF connections. Returns original path/bytes/SHA-256 and explicit limitations. Use gdf_geometry for paginated symbol definitions/placements and netlist_export for GDF circuit connections.',
    inputSchema:{type:'object',additionalProperties:false,required:['path'],properties:{...file,
      format:{type:'string',enum:['auto','gdf','scf','acf','tbl','report','edif'],description:'Default auto detects the file extension; explicit formats still validate their content.'},
      signal:str('Optional exact SCF signal or display bus name.'),startTime:{type:'number',minimum:0,description:'SCF time-range start in ns, default 0.'},endTime:{type:'number',minimum:0,description:'SCF time-range end in ns; default entire duration.'},
      offset:int('Zero-based item/event page offset, default 0.',1000000),limit:{type:'integer',minimum:1,maximum:500,description:'Maximum text records/trace rows/diagnostics or SCF events per signal; default 100, SCF defaults to 20 and may reduce to fit the result budget.'},
      signalOffset:int('Zero-based SCF signal page offset; default 0.',65535),signalLimit:{type:'integer',minimum:1,maximum:20,description:'Maximum SCF signals per page; default 5. Use nextSignalOffset to continue.'},
      cell:str('Optional EDIF library/cell identifier for inspecting a hierarchical cell; defaults to the top design.'),net:str('Optional exact EDIF net identifier/name to inspect its connections.'),endpointOffset:int('Zero-based endpoint offset within each EDIF net.',1000000),endpointLimit:{type:'integer',minimum:1,maximum:200,description:'Maximum endpoints per EDIF net, default 20; use nextEndpointOffset to continue.'},
    }},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},sideEffects:'none',reversibility:'not-applicable',actsOn:'project-files',
    handler:a=>parseProjectFile(scopedPath(scope(a),a.path),a),
  },{
    name:'netlist_export',title:'Export circuit connectivity with the original compiler',
    description:'Copy a GDF/HDL/ACF/EDIF design and local dependencies to a fresh temporary directory; enable original MAX+plus II EDIF/VHDL/Verilog/AHDL writers and compile there. Return source hashes, actual compiler evidence, exported files and structured port/instance/net connectivity. Original files remain untouched. The netlist is synthesized logic; original drawing placement and source component identities can change. Supports async jobs and cancellation.',
    inputSchema:{type:'object',additionalProperties:false,required:['path'],properties:{...file,root:str('MAX+plus II installation root, default MAXPLUS2_ROOT/discovery.'),timeoutMs:{type:'integer',minimum:1,maximum:300000,description:'Compiler timeout; default 60000 milliseconds.'},async:{type:'boolean',description:'Return jobId immediately; poll job_status or stop with job_cancel.'}}},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},sideEffects:'write',reversibility:'temporary-copy',actsOn:'isolated-design-copy',
    handler:async a=>{
      const {exportNetlist}=await import('./netlist.mjs');
      const result=await exportNetlist({source:scopedPath(scope(a),a.path),root:a.root,timeoutMs:a.timeoutMs,signal:a.__job?.controller.signal,onSpawn:a.__job?child=>a.__job.track(child):undefined});
      return {...result,sourceManifest:result.sourceManifest.slice(0,30),sourceManifestCount:result.sourceManifest.length,sourceManifestTruncated:result.sourceManifest.length>30,
        netlistJson:result.netlistJson.map(n=>({path:n.path,sha256:n.sha256,...netlistPage(n,{limit:10})})),
        next:'project_parse_file workspace:projectDir path:<exported .edo filename> with net/cell/offset filters; project_read_file reads original-vendor .vho/.vo/.tdo exports'};
    },
  }];
}
