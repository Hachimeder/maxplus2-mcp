import fs from 'node:fs';
import path from 'node:path';
import { inventory, readProjectFile, searchProject, changeProjectFile, restoreProjectFile, editScfFile, createProject, cloneProject, buildStimulus, buildMemory, scopedPath } from './workspace.mjs';
import { DesktopController } from './desktop.mjs';
import { detectInstall } from './runtime.mjs';
import {scfPage} from './file-parsing.mjs';

const string = description => ({ type: 'string', description });
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const boolean = description => ({ type: 'boolean', description });
const confirm = boolean('Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval.');
const encoding = { type: 'string', enum: ['latin1','utf8'], description: 'File encoding; latin1 preserves MAX+plus II legacy bytes. Select utf8 explicitly for Unicode files.' };
const common = {
  project: string('Existing .acf project path or unambiguous project name. File paths are scoped to its directory.'),
  workspace: string('Workspace directory for resolving project names, or the scope when no project is supplied.'),
};
const file = { ...common, path: string('File path relative to the project/workspace. Absolute paths must remain inside that scope.') };
function tool(name, title, description, properties, required, handler, effects = 'none') {
  return { name, title, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: effects === 'none', destructiveHint: effects === 'destructive', idempotentHint: effects === 'none', openWorldHint: name.startsWith('desktop_') },
    sideEffects: effects, reversibility: effects === 'none' ? 'not-applicable' : name.startsWith('desktop_') ? 'depends-on-application' : 'backup-or-new-directory', actsOn: name.startsWith('desktop_') ? 'MAX+plus II windows' : 'project-files', handler };
}

export function authoringTools({ defaultWorkspace, resolveAcf }) {
  const scope = a => a.project ? path.dirname(resolveAcf(a.project, a.workspace)) : fs.realpathSync(a.workspace ?? defaultWorkspace);
  const controllers=new Map();
  const rootProperty={root:string('MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation.')};
  const desktop=(method,a={})=>{
    const installed=detectInstall(a.root);
    if(!installed?.root)throw new Error('MAX+plus II installation not found; call installation_status or provide root.');
    const root=fs.realpathSync(installed.root);
    if(!controllers.has(root))controllers.set(root,new DesktopController(root));
    const {root:_,...args}=a;return controllers.get(root).request(method,args);
  };
  return [
    tool('project_restore_file','Restore backed-up project bytes','Restore a file from this project backup store, including binary GDF/SCF bytes. Preview by default. Requires backup SHA-256; an existing destination also requires its current SHA-256 and is backed up before restoration.',{
      ...file,backup:string('Backup path returned by an earlier mutation, inside this scope .mcp-backups directory.'),backupSha256:string('SHA-256 of the backup, equal to previousSha256 from the original change.'),expectedSha256:string('Current destination SHA-256 if it still exists.'),confirm,
    },['path','backup','backupSha256'],a=>restoreProjectFile(scope(a),a),'destructive'),
    tool('project_create', 'Create a MAX+plus II project', 'Create an isolated directory with a named CHIP .acf, optional HDL source and END_TIME=0.0ns. Preview by default, refuse existing directories; use one directory per design.', {
      workspace: common.workspace, directory: string('New directory relative to the workspace, defaulting to the project name.'), name: string('Project/HDL top identifier, for example demo.'), device: string('Optional installed device name, for example EP1K10TC100-1.'), source: string('Optional complete HDL text for the top design.'), sourceExtension: { type:'string', enum:['.vhd','.v','.tdf'], description:'Top source extension; defaults to .vhd.' }, encoding, confirm,
    }, ['name'], a => createProject(a.workspace ?? defaultWorkspace, a), 'write'),
    tool('project_clone', 'Clone a project for isolated work', 'Copy the project directory into a new directory; preserve names and verify SHA-256 for every copied file. Default all; sources selects design extensions and explicit includePaths, avoiding old SCF/TBL/reports in large projects. Preserves originals, excludes backup stores. Does not infer external hierarchy dependencies; inspect and compile the copy.', {
      ...common, directory: string('New destination directory under workspace. Must not already exist or be inside the source directory.'),profile:{type:'string',enum:['all','sources'],description:'Default all. sources copies ACF/GDF/SYM/HDL/INC/MIF/HEX/EDIF/ASM, while excluding other files unless named in includePaths.'},includePaths:{type:'array',maxItems:200,items:{type:'string',description:'Exact source-relative auxiliary file path.'},description:'Explicit files to retain, e.g. a stimulus SCF/VEC or memory asset with an unusual extension. Each must exist within the source directory.'}, confirm,
    }, ['project','directory'], a => cloneProject(resolveAcf(a.project, a.workspace), a.workspace ?? defaultWorkspace, a), 'write'),
    tool('project_files', 'List project files', 'List sources, memories, schematics, waveforms and build artifacts under the selected project/workspace. Deterministic offset pagination, byte sizes and supported text formats are returned.', {
      ...common, offset: integer('Zero-based pagination offset.',0,20000), limit: integer('Maximum number of files to return; default 200.',1,2000),
    }, [], a => inventory(scope(a), { offset:a.offset ?? 0, limit:a.limit ?? 200 })),
    tool('project_read_file', 'Read a project text file', 'Read a bounded line range and exact SHA-256 of HDL, ACF, MIF, HEX, VEC, reports or other supported text. Use nextLine to continue and expectedSha256 to avoid overwriting concurrent edits.', {
      ...file, encoding, startLine: integer('First one-based line to read; default 1.',1,10000000), lineCount: integer('Maximum lines to return; default 200.',1,2000),
    }, ['path'], a => readProjectFile(scope(a),a)),
    tool('project_search', 'Search design sources and reports', 'Search for a literal string across supported project text files with file/line evidence. Results are bounded and truncation/oversized skipped files are explicit; binary GDF/SCF content is not guessed.', {
      ...common, query: string('Nonempty literal text to find.'), caseSensitive: boolean('Case sensitive comparison when true; default false.'), limit: integer('Maximum matching lines; default 100.',1,200), encoding,
    }, ['query'], a => searchProject(scope(a),a)),
    tool('project_edit_file', 'Edit or manage a project file', 'Write, exact-patch, copy, move or delete one file. Preview by default. Existing files require expectedSha256; writes/moves/deletes preserve a recoverable backup. General binary writes are refused; use scf_edit for supported SCF scalar inputs and desktop tools for GDF drawing changes.', {
      ...file, operation: { type:'string', enum:['write','patch','copy','move','delete'], description:'Single operation to preview/apply. Defaults to write.' }, content: string('Complete new text for write.'), destination: string('New path inside the scope for copy/move. Existing destinations are refused.'), expectedSha256: string('SHA-256 from project_read_file or another verified read; mandatory for an existing source file.'), encoding, confirm,
      edits: { type:'array', minItems:1, maxItems:100, description:'Sequential exact text replacements for patch. Each replacement must match exactly occurrences times.', items:{type:'object',additionalProperties:false,properties:{find:string('Exact nonempty original text.'),replace:string('Literal replacement text.'),occurrences:integer('Expected number of matches, default 1.',1,10000)},required:['find','replace']} },
    }, ['path'], a => changeProjectFile(scope(a),a), 'destructive'),
    tool('stimulus_write', 'Write timed simulator stimulus', 'Generate a verified multi-row VEC shape using INTERVAL, bare pattern rows and one final semicolon. Explicit bus nodes are MSB-first. Preview/apply with backups. Existing SCF may take precedence; inspect/delete its backed-up copy or open/convert VEC in the GUI. Set ACF END_TIME=0.0ns.', {
      ...file, expectedSha256:string('Existing VEC SHA-256 if replacing a file.'),confirm,
      inputs:{ type:'array',minItems:1,maxItems:1024,description:'Scalar input node strings, or {name,nodes:[MSB,...,LSB]} bus declarations with explicit simulator node names.', items:{anyOf:[{type:'string'},{type:'object',additionalProperties:false,properties:{name:string('Logical row key.'),nodes:{type:'array',minItems:1,maxItems:1024,items:{type:'string'},description:'Ordered physical input node names, MSB first.'}},required:['name','nodes']}]} },
      outputs:{type:'array',maxItems:1024,items:{type:'string'},description:'Optional physical output node names to include in the result table.'},
      rows:{type:'array',minItems:1,maxItems:10000,items:{type:'object',additionalProperties:{anyOf:[{type:'integer',minimum:0},{type:'string'}]}},description:'One complete input map per interval. Integers or exact-width binary/X/Z strings; for example [{CLK:0,A:3},{CLK:1,A:5}].'},
      interval:{type:'number',exclusiveMinimum:0,description:'Duration of each input pattern, default 100.'},start:{type:'number',minimum:0,description:'Start time, default 0.'},stop:{type:'number',minimum:0,description:'Stop time; default start + rows.length * interval.'},unit:{type:'string',enum:['ns','us','ms'],description:'Simulator time unit, default ns.'},
    }, ['path','inputs','rows'], a => {
      if (path.extname(a.path).toLowerCase() !== '.vec') throw new Error('stimulus path must end in .vec');
      return changeProjectFile(scope(a),{...a,operation:'write',content:buildStimulus(a)});
    }, 'write'),
    tool('memory_write', 'Write a ROM/RAM memory image', 'Generate an Intel/Altera MIF with explicit WIDTH, DEPTH, hexadecimal addresses/data and initialized unused addresses. Arbitrary width values may use integer strings. Preview or apply to a .mif with hash checking/backups.', {
      ...file,width:integer('Word width in bits.',1,1024),depth:integer('Number of memory addresses.',1,65536),values:{type:'array',maxItems:65536,items:{anyOf:[{type:'integer',minimum:0},{type:'string'}]},description:'Address-zero-first unsigned values. Large values use decimal, 0x-prefixed hex or 0b-prefixed binary strings.'}, defaultValue:{anyOf:[{type:'integer',minimum:0},{type:'string'}],description:'Value for remaining addresses, default 0.'},expectedSha256:string('Existing MIF SHA-256 if replacing a file.'),confirm,
    }, ['path','width','depth','values'], a => {
      if (path.extname(a.path).toLowerCase() !== '.mif') throw new Error('memory path must end in .mif');
      return changeProjectFile(scope(a),{...a,operation:'write',content:buildMemory(a)});
    }, 'write'),
    tool('scf_inspect', 'Read binary waveform events directly', 'Decode verified SCF scalar and display-bus logic runs/events, including 0/1/X/Z, with times in ns. Returns input/output roles, writable input names, paging and unsupported metadata explicitly. Does not open the GUI.', {...file,signal:string('Optional exact scalar or display-bus signal name.'),startTime:{type:'number',minimum:0,description:'Range start in ns, default 0.'},endTime:{type:'number',minimum:0,description:'Range end in ns, default full duration.'},offset:integer('Event/segment page offset, default 0.',0,1000000),limit:integer('Events/segments per signal, default 20; may reduce to fit output budget.',1,500),signalOffset:integer('Signal page offset, default 0.',0,65535),signalLimit:integer('Signals per page, default 5.',1,20)},['path'],a=>{
      const p=scopedPath(scope(a),a.path);if(fs.statSync(p).size>16*1024*1024)throw new Error('SCF parser limit is 16 MiB');return scfPage(fs.readFileSync(p),a);
    }),
    tool('scf_edit', 'Edit binary SCF input stimulus directly', 'Preview/apply event changes to existing scalar inputs in vendor version-4 SCF. Fixed existing end time, exact 0.1ns ticks, 0/1/X/Z. Preserve groups, other signal records and opaque editor bytes. Requires current SHA-256; backs up before atomic write. Output/internal traces become stale and must be re-simulated. For a bus, edit its scalar members returned by scf_inspect.',{
      ...file,expectedSha256:string('Current SCF SHA-256 from project_parse_file.'),confirm,
      edits:{type:'array',minItems:1,maxItems:100,description:'One replacement event sequence per existing scalar input. Each starts at time zero and uses increasing times below the current file end.',items:{type:'object',additionalProperties:false,required:['signal','events'],properties:{signal:string('Exact existing scalar input name.'),events:{type:'array',minItems:1,maxItems:100000,description:'Ordered transitions; unchanged values are coalesced.',items:{type:'object',additionalProperties:false,required:['time','value'],properties:{time:{type:'number',minimum:0,description:'Time in ns, an exact multiple of 0.1.'},value:{anyOf:[{type:'integer',minimum:0,maximum:1},{type:'string',enum:['X','Z','x','z']}],description:'Scalar logic 0, 1, X or Z.'}}}}}}},
    },['path','expectedSha256','edits'],a=>editScfFile(scope(a),a),'destructive'),
    tool('desktop_status', 'Check independent Windows desktop backend', 'Check the MCP-owned Windows UI Automation/Win32 backend. Builds the bundled helper locally if needed and reports interactive desktop availability. Runs locally using standard Windows components. Does not launch or manipulate a MAX+plus II window.', rootProperty,[],async a=>{
      try { return await desktop('status',a); } catch (err) { return {connected:false,backend:'standalone-win32-uia',agentIndependent:true,requiresHostTools:false,reason:err.message,setup:'docs/DESKTOP.md'}; }
    }),
    tool('desktop_result', 'Read a recent desktop operation result', 'Retrieve a cached completed desktop result and its MCP image blocks without executing input again. Results last up to ten minutes, twelve entries, or server restart. No separate host execution step exists.', {
      ...rootProperty,requestId:string('ID returned directly by desktop_windows/launch/observe/action, or the supplied operationId.'),
    }, ['requestId'],a=>desktop('result',a)),
    tool('desktop_windows', 'List MAX+plus II windows', 'Directly discover real windows/dialogs of installed MAX+plus II executables, including HWND, PID, bounds and title. Select exactly one returned windowId before observing/input. All agents call this standard MCP tool.', rootProperty,[],a=>desktop('windows',a)),
    tool('desktop_launch', 'Launch a MAX+plus II GUI program', 'Launch an existing allowlisted MAX+plus II GUI through the independent Windows backend and return its real windows. No shell or arbitrary executable. Launch does not prove readiness; observe the returned window.', {
      ...rootProperty,
      program:{type:'string',enum:['max2win.exe','megawiz.exe','genmem.exe','wlarithm.exe','wlsum.exe','wlcount.exe','wlmux.exe','wlram.exe','wlclshif.exe','wdivide.exe'],description:'Installed MAX+plus II GUI executable, default max2win.exe.'},
    }, [],a=>desktop('launch',a),'write'),
    tool('desktop_observe', 'Observe a MAX+plus II window', 'Return a fresh native screenshot as standard MCP image content, UI Automation tree, focus, window bounds and observationId directly. Inspect before acting; each input consumes its observation. Capture diagnostics report limitations honestly.', {
      ...rootProperty,
      windowId:integer('Opaque ID from desktop_windows; never invent one.',1,Number.MAX_SAFE_INTEGER),includeScreenshot:boolean('Capture screenshot, default true. Required for coordinate input.'),includeText:boolean('Capture accessibility tree and focus, default true. Required for indexed input and typing.'),
      textOffset:integer('Control pagination offset, default 0. Use nextTextOffset from the previous observation; every page creates a new observationId.',0,1500),textLimit:integer('Maximum controls in one observation page, default 60; the response budget may reduce this. Global element indices are preserved.',1,100),
      menuOffset:integer('Native menu pagination offset. Use menus.nextOffset and inspect actual enabled leaf commands.',0,2000),menuLimit:integer('Maximum native menu records; default60.',1,100),
    }, ['windowId'],a=>desktop('observe',a)),
    tool('desktop_action', 'Perform one observed MAX+plus II action', 'Directly execute ONE click, hover, key chord, Unicode text entry, value change, drag, scroll, secondary UI action or activation, then return a fresh screenshot/tree. Uses MCP-owned Win32/UIA. Requires latest observationId/windowId. Inspect after every input; no host-specific calls.', {
      ...rootProperty,windowId:integer('Window ID from the latest observation.',1,Number.MAX_SAFE_INTEGER),observationId:string('Unconsumed ID from desktop_observe or the previous action result.'), action:{type:'string',enum:['click','move','press_key','type_text','set_value','drag','scroll','perform_secondary_action','activate_window','invoke_menu'],description:'One native Windows action; invoke_menu requires an observed enabled leaf menu_index.'},
      operationId:string('Optional unique 1..100 character letters/digits/_/- ID. Retrying identical arguments with this ID reads the cached result and never repeats input; reuse with different arguments is rejected.'),
      parameters:{type:'object',description:'invoke_menu:menu_index from menus.items; click: element_index OR window-relative physical x/y+screenshotId, optional mouse_button/click_count; move:x/y/screenshotId; press_key:key; type_text:text; set_value:element_index/value; drag:from_x/from_y/to_x/to_y/screenshotId, optional mouse_button/durationMs(100..5000); scroll:x/y/scrollX/scrollY/screenshotId (integer wheel units,120 per notch); secondary:element_index/action. Mouse actions may use modifiers:["Ctrl","Shift","Alt"]. Observe actual focus before typing.',additionalProperties:true},
    }, ['windowId','observationId','action'],a=>desktop('action',a),'destructive'),
  ];
}
