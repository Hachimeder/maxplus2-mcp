# MCP tools

Version 0.10.1 exposes 68 tools through tools/list.

Descriptions and parameters below are generated from the same definitions used by the server.
Inspect the live schema for complete constraints. Paths are scoped to the selected workspace or project.

## installation_status

Locate the MAX+PLUS II installation (maxplus2.exe / setacf.exe), report version info from maxplus2.ini, available device families, and additional bundled tools. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | Installation root, e.g. C:\maxplus2. Defaults to MAXPLUS2_ROOT or common paths. |

## list_projects

Recursively find .acf projects under a root directory and list the artifacts already compiled for each. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | Directory to scan. Defaults to MAXPLUS2_WORKSPACE or the server cwd. |
| maxDepth | no | integer | Recursion depth limit (default 6). |
| limit | no | integer | Maximum projects to return (default 500). |

## project_inspect

Summarize one project: .acf sections, CHIP blocks, device, pin count, compiled artifacts with timestamps, and the cleanliness of the last .rpt. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (e.g. "top") or absolute path to a .acf. |
| workspace | no | string | Directory to resolve relative project names against. |

## acf_read_sections

Read the .acf as structured sections/entries with line numbers. Use to discover which section holds a setting before writing. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name or absolute .acf path. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| section | no | string | Only return this section (case-insensitive), e.g. CHIP. |
| includeEntries | no | boolean | Set false to return section headers only (default true). |

## acf_read_pins

Extract device and pin assignments from the .acf CHIP block, and cross-check them against the compiler-generated .pin report when present. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |

## setacf_plan

Build the exact setacf.exe argument vector for a change WITHOUT executing it. Always call this first: setacf edits the .acf in place and has no dry-run mode.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| root | no | string | MAX+PLUS II install root. |
| kind | no | string | Pin assignment kind. |
| signal | no | string | Signal name, e.g. "\|CLK" or "CLK". |
| pin | no | string / integer | Pin number. |
| device | no | string | Set the DEVICE assignment, e.g. EP1K30TC144-1. |
| section | no | string | Section name (defaults to CHIP for device/pin edits). |
| sectionValue | no | string | Section value, e.g. the chip name. |
| modifyTo | no | string | Modify an existing section value (-m). |
| deleteVariable | no | string | Delete a variable (-d). |
| prependPath | no | string | Prepend a hierarchy path (-p). |
| variable | no | string | Raw variable for advanced use. |
| value | no | string | Raw value for advanced use. |
| create | no | boolean | Create the .acf if missing (-c). |

## setacf_apply

Execute a setacf change. Backs the .acf up first and returns a line diff. Requires confirm:true. Prefer calling setacf_plan first.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| root | no | string | MAX+PLUS II installation root, for example C:\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths. |
| confirm | yes | boolean | Must be true to actually write. |
| backup | no | boolean | Back up the .acf first (default true). |
| timeoutMs | no | integer | Hard timeout in milliseconds. A client timeout is wall-clock and progress does not extend it, so keep this below the client budget. |
| kind | no | string | Assignment kind. INPUT_PIN, OUTPUT_PIN or BIDIR_PIN sets a pin; omit it when setting a device or a raw variable. |
| signal | no | string | Signal name to constrain, for example "\|CLK" or "CLK". A leading pipe is added automatically if absent. |
| pin | no | string / integer | Pin number to assign. |
| device | no | string | Device to assign, for example EP1K30TC144-1. Written as the DEVICE variable in the CHIP section. |
| section | no | string | ACF section name. Device and pin edits default to CHIP; other settings live in sections such as SIMULATOR_CONFIGURATION. |
| sectionValue | no | string | Section value, for example the chip name in "CHIP top". Required when the section does not exist yet, because setacf cannot name a section it is creating. |
| modifyTo | no | string | New value for an existing section (-m). Requires section and sectionValue. |
| deleteVariable | no | string | Name of the variable to delete from its section (-d). |
| prependPath | no | string | Hierarchy path prefix to prepend to the variable (-p), for a signal inside a sub-design. |
| variable | no | string | Raw setacf variable for advanced use, for example "DEVICE" or a full "\"\|SIG\":PIN" form. |
| value | no | string | Value paired with variable for advanced use. |
| create | no | boolean | Create the .acf if it does not exist (-c). Use only when bootstrapping a new project. |
| async | no | boolean | Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status. |

## maxplus2_plan

Build the exact maxplus2.exe command line for compile / timing analysis / simulation / object conversion, WITHOUT running it.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| root | no | string | MAX+PLUS II installation root, for example C:\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths. |
| compile | no | boolean | Run the Compiler (-c). |
| rebuild | no | boolean | Back up/move matching top and numbered hierarchy CNF before compile to force source extraction (default true); false requests native incremental reuse. |
| simulate | no | boolean | Run the Simulator (-s). |
| convert | no | boolean | Convert object files (-convert). |
| taDelay | no | boolean | Timing Analyzer, Delay Matrix (-ta_delay). |
| taSetup | no | boolean | Timing Analyzer, Setup/Hold (-ta_setup). |
| taReg | no | boolean | Timing Analyzer, Registered Performance (-ta_reg). |
| ignoreErrors | no | boolean | Continue past errors (-i). |
| timingAnalyzerOutput | no | string | -tao file. |
| simScf | no | string | Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run. |
| simVec | no | string | Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run. |
| simCmd | no | string | Simulator command file (-cmd). REJECTED by this build. |
| simTbl | no | string | Where to write the simulator result table. Plain text, and what verification reads back. |
| simHst | no | string | Simulator command file (-cmd). REJECTED by this build. |
| outHex | no | string | HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex. |
| outJam | no | string | JAM STAPL output (-jam). REJECTED by this build. |
| outJ11 | no | string | HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex. |
| outJbc | no | string | JBC 2.0 output (-jbc). REJECTED by this build. |
| outJb1 | no | string | JBC 1.0 output (-jb1). REJECTED by this build. |
| outPof | no | string | POF output (-pof). REJECTED by this build, but compiling writes <project>.pof anyway. |
| outRbf | no | string | RBF output (-rbf). REJECTED by this build. |
| outSbf | no | string | SBF output (-sbf). REJECTED by this build. |
| outSvf | no | string | SVF output (-svf). REJECTED by this build, so this installation cannot derive a JTAG programming file. |
| outTtf | no | string | TTF output file (-ttf). REJECTED by this build; compiling writes <project>.ttf. |
| cwd | no | string | Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run. |

## maxplus2_run

Execute maxplus2.exe (compile / simulate / timing / convert) with a hard timeout, then report which artifacts changed and the parsed report summary. Beware: this starts a 2002-era Win32 process that can block on modal dialogs.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| root | no | string | MAX+PLUS II installation root, for example C:\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths. |
| compile | no | boolean | Run the Compiler (-c). This also writes the .pof, .rpt and .pin artifacts. |
| rebuild | no | boolean | Back up/move matching top and numbered hierarchy CNF before compile to force source extraction (default true); false requests native incremental reuse. |
| simulate | no | boolean | Run the Simulator (-s). Requires stimulus: pass simScf, or leave a .scf or a matching .vec next to the project. |
| convert | no | boolean | Convert object files (-convert). |
| taDelay | no | boolean | Run the Timing Analyzer in Delay Matrix mode (-ta_delay). |
| taSetup | no | boolean | Run the Timing Analyzer in Setup/Hold Matrix mode (-ta_setup). |
| taReg | no | boolean | Run the Timing Analyzer in Registered Performance mode (-ta_reg). |
| ignoreErrors | no | boolean | Continue past errors (-i). Use when you want every diagnostic from one run rather than stopping at the first failure. |
| timingAnalyzerOutput | no | string | File for Timing Analyzer output. Each analysis mode is emitted with its own -tao, so multiple modes cannot overwrite one file. |
| simScf | no | string | Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run. |
| simVec | no | string | Stimulus file. A .vec is converted by the Simulator; END_TIME must be 0.0ns for that to span the run. |
| simCmd | no | string | Simulator command file (-cmd). REJECTED by this build. |
| simTbl | no | string | Where to write the simulator result table. Plain text, and what verification reads back. |
| simHst | no | string | Simulator command file (-cmd). REJECTED by this build. |
| outHex | no | string | HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex. |
| outJam | no | string | JAM STAPL output (-jam). REJECTED by this build. |
| outJ11 | no | string | HEX output (-hex). REJECTED by this build; compiling already writes <project>.hex. |
| outJbc | no | string | JBC 2.0 output (-jbc). REJECTED by this build. |
| outJb1 | no | string | JBC 1.0 output (-jb1). REJECTED by this build. |
| outPof | no | string | POF output (-pof). REJECTED by this build, but compiling writes <project>.pof anyway. |
| outRbf | no | string | RBF output (-rbf). REJECTED by this build. |
| outSbf | no | string | SBF output (-sbf). REJECTED by this build. |
| outSvf | no | string | SVF output (-svf). REJECTED by this build, so this installation cannot derive a JTAG programming file. |
| outTtf | no | string | TTF output file (-ttf). REJECTED by this build; compiling writes <project>.ttf. |
| cwd | no | string | Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run. |
| timeoutMs | no | integer | Hard timeout, default 900000 (15 min). |
| async | no | boolean | Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status. |

## acf_validate

Statically validate an .acf for defects that block compilation, notably the bare "CHIP " header that setacf itself creates when no CHIP section exists yet (MAX+PLUS II then fails with "Missing identifier after section keyword"). Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |

## acf_repair_chip_headers

Rewrite malformed CHIP headers (bare "CHIP " or shell-escaped names) into canonical "CHIP <name>" form. setacf is append-only and cannot fix these itself. Preview-first; requires confirm:true to write and backs the file up.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| chipName | no | string | Name to use for the CHIP section. Defaults to the project name. |
| confirm | no | boolean | Must be true to write. Without it this is a preview. |
| backup | no | boolean | Back up the .acf first (default true). |

## probe_executable

Run `maxplus2 -v` (or -h) to verify the 2002-era binary actually starts and returns on this host. Read-only and project-independent. Run this before trusting any headless compile loop: MAX+PLUS II can block forever on a modal dialog.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+PLUS II install root. |
| mode | no | string | Which probe to run (default version). |
| cwd | no | string | Working directory for the child process. Defaults to the project directory, which is where MAX+PLUS II expects to run. |
| timeoutMs | no | integer | Hard timeout, default 60000. |

## simulate_and_verify

Run the Simulator headless and return the parsed result table, then optionally check expected output values. This is how simulation verification is automated: MAX+PLUS II writes a plain-text .tbl containing the simulated outputs, so a design can be checked without a human reading a waveform. Note a successful simulation may exit 1 — the verdict comes from the success banner plus the table artifact.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Project name (for example "top") or an absolute path to its .acf file. A bare name is resolved against workspace, and is rejected as ambiguous if several projects share it. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| root | no | string | MAX+PLUS II installation root, for example C:\maxplus2. Defaults to MAXPLUS2_ROOT, then a scan of common paths. |
| scf | no | string | Stimulus file. Defaults to <project>.scf if present. |
| tbl | no | string | Where to write the result table. Defaults to <project>.tbl. |
| previewRows | no | integer | How many leading trace rows to return (default 12). |
| tolerance | no | number | Time tolerance in table units when matching expectations (default 0.05). |
| timeoutMs | no | integer | Hard timeout in milliseconds. A client timeout is wall-clock and progress does not extend it, so keep this below the client budget. |
| expect | no | object | Expected values, as { "<time>": { "SIGNAL": value } }. Values may be numbers or hex strings like "80". Outputs and buried nodes are both checkable. |
| async | no | boolean | Run in the background and return a jobId immediately instead of blocking. Use for any compile or simulation that may outrun the client timeout: a client timeout does NOT stop the child process, so a blocking call that is abandoned keeps running with nobody holding the result. Poll with job_status. |

## parse_tbl

Parse an existing MAX+PLUS II Simulator result table (.tbl) into a time-indexed trace of inputs, outputs and buried nodes, with optional expected-value checking. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Project name; uses its <project>.tbl. Optional if path is given. |
| path | no | string | Explicit .tbl path. |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| limit | no | integer | Max trace rows to return (default 40). |
| full | no | boolean | Return every row. |
| tolerance | no | number | Time tolerance, in the table's own unit, when matching an expectation to a simulation row. Default 0.05. |
| expect | no | object | Expected values as { "<time>": { "<SIGNAL>": value } }. Values may be numbers or hex strings. A mismatch is reported, not thrown. |

## parse_report

Parse a MAX+PLUS II .rpt / .summary / .pin file into structured severity counts, statuses, device, and diagnostics. Read-only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Project name; uses its .rpt. Optional if path is given. |
| path | no | string | Explicit report path (absolute, or relative to workspace). |
| workspace | no | string | Directory that a relative project name is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| maxDiagnostics | no | integer | Cap on returned diagnostics (default 200). |

## gdf_inspect

Read a strictly validated GDF/SYM schematic summary: labels, fonts, title fields and geometry counts. gdf_geometry provides paginated original coordinates, definitions, instances and world pin positions; gdf_edit supports existing v6 geometry. Electrical connectivity requires netlist_export. Optionally compare labels with another drawing.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| path | yes | string | Schematic to read: absolute, or relative to workspace. A missing .gdf extension is added automatically. |
| workspace | no | string | Directory that a relative path is resolved against. Defaults to MAXPLUS2_WORKSPACE, then the server working directory. |
| compareWith | no | string | Optional second schematic to compare against, reporting labels present in one but not the other. |

## job_status

Poll a background job started with async:true. Returns running/done/failed/cancelled, how long it has been going, how many child processes are live, and the full result once it settles. This exists because a client timeout is wall-clock and does NOT stop the work: polling is the only way to keep a long compile without losing it. Results are held for 30 minutes after they settle.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| jobId | yes | string | The jobId returned when the job was started with async:true. |

## job_cancel

Terminate a running background job by killing its child process. Use this rather than abandoning a job: an abandoned job keeps running and keeps holding the project directory. Build artifacts already written are left in place — this stops work, it does not undo it.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| jobId | yes | string | The jobId to terminate. |

## project_restore_file

Restore a file from this project backup store, including binary GDF/SCF bytes. Preview by default. Requires backup SHA-256; an existing destination also requires its current SHA-256 and is backed up before restoration.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| backup | yes | string | Backup path returned by an earlier mutation, inside this scope .mcp-backups directory. |
| backupSha256 | yes | string | SHA-256 of the backup, equal to previousSha256 from the original change. |
| expectedSha256 | no | string | Current destination SHA-256 if it still exists. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |

## project_create

Create an isolated directory with a named CHIP .acf, optional HDL source and END_TIME=0.0ns. Preview by default, refuse existing directories; use one directory per design.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| directory | no | string | New directory relative to the workspace, defaulting to the project name. |
| name | yes | string | Project/HDL top identifier, for example demo. |
| device | no | string | Optional installed device name, for example EP1K10TC100-1. |
| source | no | string | Optional complete HDL text for the top design. |
| sourceExtension | no | string | Top source extension; defaults to .vhd. |
| encoding | no | string | File encoding; latin1 preserves MAX+plus II legacy bytes. Select utf8 explicitly for Unicode files. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |

## project_clone

Copy the project directory into a new directory; preserve names and verify SHA-256 for every copied file. Default all; sources selects design extensions and explicit includePaths, avoiding old SCF/TBL/reports in large projects. Preserves originals, excludes backup stores. Does not infer external hierarchy dependencies; inspect and compile the copy.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | yes | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| directory | yes | string | New destination directory under workspace. Must not already exist or be inside the source directory. |
| profile | no | string | Default all. sources copies ACF/GDF/SYM/HDL/INC/MIF/HEX/EDIF/ASM, while excluding other files unless named in includePaths. |
| includePaths | no | array | Explicit files to retain, e.g. a stimulus SCF/VEC or memory asset with an unusual extension. Each must exist within the source directory. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |

## project_files

List sources, memories, schematics, waveforms and build artifacts under the selected project/workspace. Deterministic offset pagination, byte sizes and supported text formats are returned.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| offset | no | integer | Zero-based pagination offset. |
| limit | no | integer | Maximum number of files to return; default 200. |

## project_read_file

Read a bounded line range and exact SHA-256 of HDL, ACF, MIF, HEX, VEC, reports or other supported text. Use nextLine to continue and expectedSha256 to avoid overwriting concurrent edits.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| encoding | no | string | File encoding; latin1 preserves MAX+plus II legacy bytes. Select utf8 explicitly for Unicode files. |
| startLine | no | integer | First one-based line to read; default 1. |
| lineCount | no | integer | Maximum lines to return; default 200. |

## project_search

Search for a literal string across supported project text files with file/line evidence. Results are bounded and truncation/oversized skipped files are explicit; binary GDF/SCF content is not guessed.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| query | yes | string | Nonempty literal text to find. |
| caseSensitive | no | boolean | Case sensitive comparison when true; default false. |
| limit | no | integer | Maximum matching lines; default 100. |
| encoding | no | string | File encoding; latin1 preserves MAX+plus II legacy bytes. Select utf8 explicitly for Unicode files. |

## project_edit_file

Write, exact-patch, copy, move or delete one file. Preview by default. Existing files require expectedSha256; writes/moves/deletes preserve a recoverable backup. General binary writes are refused; use scf_edit for supported SCF scalar inputs and desktop tools for GDF drawing changes.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| operation | no | string | Single operation to preview/apply. Defaults to write. |
| content | no | string | Complete new text for write. |
| destination | no | string | New path inside the scope for copy/move. Existing destinations are refused. |
| expectedSha256 | no | string | SHA-256 from project_read_file or another verified read; mandatory for an existing source file. |
| encoding | no | string | File encoding; latin1 preserves MAX+plus II legacy bytes. Select utf8 explicitly for Unicode files. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |
| edits | no | array | Sequential exact text replacements for patch. Each replacement must match exactly occurrences times. |

## stimulus_write

Generate a verified multi-row VEC shape using INTERVAL, bare pattern rows and one final semicolon. Explicit bus nodes are MSB-first. Preview/apply with backups. Existing SCF may take precedence; inspect/delete its backed-up copy or open/convert VEC in the GUI. Set ACF END_TIME=0.0ns.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| expectedSha256 | no | string | Existing VEC SHA-256 if replacing a file. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |
| inputs | yes | array | Scalar input node strings, or {name,nodes:[MSB,...,LSB]} bus declarations with explicit simulator node names. |
| outputs | no | array | Optional physical output node names to include in the result table. |
| rows | yes | array | One complete input map per interval. Integers or exact-width binary/X/Z strings; for example [{CLK:0,A:3},{CLK:1,A:5}]. |
| interval | no | number | Duration of each input pattern, default 100. |
| start | no | number | Start time, default 0. |
| stop | no | number | Stop time; default start + rows.length * interval. |
| unit | no | string | Simulator time unit, default ns. |

## memory_write

Generate an Intel/Altera MIF with explicit WIDTH, DEPTH, hexadecimal addresses/data and initialized unused addresses. Arbitrary width values may use integer strings. Preview or apply to a .mif with hash checking/backups.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| width | yes | integer | Word width in bits. |
| depth | yes | integer | Number of memory addresses. |
| values | yes | array | Address-zero-first unsigned values. Large values use decimal, 0x-prefixed hex or 0b-prefixed binary strings. |
| defaultValue | no | schema | Value for remaining addresses, default 0. |
| expectedSha256 | no | string | Existing MIF SHA-256 if replacing a file. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |

## scf_inspect

Decode verified SCF scalar and display-bus logic runs/events, including 0/1/X/Z, with times in ns. Returns input/output roles, writable input names, paging and unsupported metadata explicitly. Does not open the GUI.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| signal | no | string | Optional exact scalar or display-bus signal name. |
| startTime | no | number | Range start in ns, default 0. |
| endTime | no | number | Range end in ns, default full duration. |
| offset | no | integer | Event/segment page offset, default 0. |
| limit | no | integer | Events/segments per signal, default 20; may reduce to fit output budget. |
| signalOffset | no | integer | Signal page offset, default 0. |
| signalLimit | no | integer | Signals per page, default 5. |

## scf_edit

Preview/apply event changes to existing scalar inputs in vendor version-4 SCF. Fixed existing end time, exact 0.1ns ticks, 0/1/X/Z. Preserve groups, other signal records and opaque editor bytes. Requires current SHA-256; backs up before atomic write. Output/internal traces become stale and must be re-simulated. For a bus, edit its scalar members returned by scf_inspect.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing .acf project path or unambiguous project name. File paths are scoped to its directory. |
| workspace | no | string | Workspace directory for resolving project names, or the scope when no project is supplied. |
| path | yes | string | File path relative to the project/workspace. Absolute paths must remain inside that scope. |
| expectedSha256 | yes | string | Current SCF SHA-256 from project_parse_file. |
| confirm | no | boolean | Apply the described file change when true; otherwise return a preview. This is a tool argument, not a request for another user approval. |
| edits | yes | array | One replacement event sequence per existing scalar input. Each starts at time zero and uses increasing times below the current file end. |

## desktop_status

Check the MCP-owned Windows UI Automation/Win32 backend. Builds the bundled helper locally if needed and reports interactive desktop availability. Runs locally using standard Windows components. Does not launch or manipulate a MAX+plus II window.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |

## desktop_result

Retrieve a cached completed desktop result and its MCP image blocks without executing input again. Results last up to ten minutes, twelve entries, or server restart. No separate host execution step exists.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |
| requestId | yes | string | ID returned directly by desktop_windows/launch/observe/action, or the supplied operationId. |

## desktop_windows

Directly discover real windows/dialogs of installed MAX+plus II executables, including HWND, PID, bounds and title. Select exactly one returned windowId before observing/input. All agents call this standard MCP tool.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |

## desktop_launch

Launch an existing allowlisted MAX+plus II GUI through the independent Windows backend and return its real windows. No shell or arbitrary executable. Launch does not prove readiness; observe the returned window.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |
| program | no | string | Installed MAX+plus II GUI executable, default max2win.exe. |

## desktop_observe

Return a fresh native screenshot as standard MCP image content, UI Automation tree, focus, window bounds and observationId directly. Inspect before acting; each input consumes its observation. Capture diagnostics report limitations honestly.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |
| windowId | yes | integer | Opaque ID from desktop_windows; never invent one. |
| includeScreenshot | no | boolean | Capture screenshot, default true. Required for coordinate input. |
| includeText | no | boolean | Capture accessibility tree and focus, default true. Required for indexed input and typing. |
| textOffset | no | integer | Control pagination offset, default 0. Use nextTextOffset from the previous observation; every page creates a new observationId. |
| textLimit | no | integer | Maximum controls in one observation page, default 60; the response budget may reduce this. Global element indices are preserved. |
| menuOffset | no | integer | Native menu pagination offset. Use menus.nextOffset and inspect actual enabled leaf commands. |
| menuLimit | no | integer | Maximum native menu records; default60. |

## desktop_action

Directly execute ONE click, hover, key chord, Unicode text entry, value change, drag, scroll, secondary UI action or activation, then return a fresh screenshot/tree. Uses MCP-owned Win32/UIA. Requires latest observationId/windowId. Inspect after every input; no host-specific calls.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+plus II installation root; defaults to MAXPLUS2_ROOT or discovered installation. |
| windowId | yes | integer | Window ID from the latest observation. |
| observationId | yes | string | Unconsumed ID from desktop_observe or the previous action result. |
| action | yes | string | One native Windows action; invoke_menu requires an observed enabled leaf menu_index. |
| operationId | no | string | Optional unique 1..100 character letters/digits/_/- ID. Retrying identical arguments with this ID reads the cached result and never repeats input; reuse with different arguments is rejected. |
| parameters | no | object | invoke_menu:menu_index from menus.items; click: element_index OR window-relative physical x/y+screenshotId, optional mouse_button/click_count; move:x/y/screenshotId; press_key:key; type_text:text; set_value:element_index/value; drag:from_x/from_y/to_x/to_y/screenshotId, optional mouse_button/durationMs(100..5000); scroll:x/y/scrollX/scrollY/screenshotId (integer wheel units,120 per notch); secondary:element_index/action. Mouse actions may use modifiers:["Ctrl","Shift","Alt"]. Observe actual focus before typing. |

## project_parse_file

File-first structured parsing of strict GDF text/geometry, SCF scalar/bus logic events in ns, ACF assignments, TBL traces, reports and EDIF connections. Returns original path/bytes/SHA-256 and explicit limitations. Use gdf_geometry for paginated symbol definitions/placements and netlist_export for GDF circuit connections.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project to scope file paths to its directory. |
| workspace | no | string | Workspace scope when project is omitted; defaults to MAXPLUS2_WORKSPACE. |
| path | yes | string | Source file relative to the project/workspace; absolute paths must remain within that scope. |
| format | no | string | Default auto detects the file extension; explicit formats still validate their content. |
| signal | no | string | Optional exact SCF signal or display bus name. |
| startTime | no | number | SCF time-range start in ns, default 0. |
| endTime | no | number | SCF time-range end in ns; default entire duration. |
| offset | no | integer | Zero-based item/event page offset, default 0. |
| limit | no | integer | Maximum text records/trace rows/diagnostics or SCF events per signal; default 100, SCF defaults to 20 and may reduce to fit the result budget. |
| signalOffset | no | integer | Zero-based SCF signal page offset; default 0. |
| signalLimit | no | integer | Maximum SCF signals per page; default 5. Use nextSignalOffset to continue. |
| cell | no | string | Optional EDIF library/cell identifier for inspecting a hierarchical cell; defaults to the top design. |
| net | no | string | Optional exact EDIF net identifier/name to inspect its connections. |
| endpointOffset | no | integer | Zero-based endpoint offset within each EDIF net. |
| endpointLimit | no | integer | Maximum endpoints per EDIF net, default 20; use nextEndpointOffset to continue. |

## netlist_export

Copy a GDF/HDL/ACF/EDIF design and local dependencies to a fresh temporary directory; enable original MAX+plus II EDIF/VHDL/Verilog/AHDL writers and compile there. Return source hashes, actual compiler evidence, exported files and structured port/instance/net connectivity. Original files remain untouched. The netlist is synthesized logic; original drawing placement and source component identities can change. Supports async jobs and cancellation.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project to scope file paths to its directory. |
| workspace | no | string | Workspace scope when project is omitted; defaults to MAXPLUS2_WORKSPACE. |
| path | yes | string | Source file relative to the project/workspace; absolute paths must remain within that scope. |
| root | no | string | MAX+plus II installation root, default MAXPLUS2_ROOT/discovery. |
| timeoutMs | no | integer | Compiler timeout; default 60000 milliseconds. |
| async | no | boolean | Return jobId immediately; poll job_status or stop with job_cancel. |

## gdf_geometry

Strictly decode GDF/SYM v2..6 coordinates, wires/buses, symbol definitions, original instances, rotations/mirrors, stretched world pin positions and local text anchors. No compiler or GUI needed. Paginated root records and nested collections preserve offsets/counts. Geometry does not prove connectivity; use netlist_export for circuit connections.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project; file paths stay inside its directory. |
| workspace | no | string | Workspace scope when no project is given. |
| path | yes | string | GDF/SYM file inside the chosen project/workspace. |
| view | no | string | Collection to inspect; default sheet. |
| offset | no | integer | Root collection offset; default zero. |
| limit | no | integer | Root records per page; default 20, reduced to fit budget. |
| childOffset | no | integer | Offset in each nested pins/attributes/primitives collection. |
| childLimit | no | integer | Items per nested collection; default 10, reduced to fit budget. |

## gdf_edit

Preview/apply lossless GDF v6 root line coordinates, translations, symbol orientation or free annotation text. Existing records only. Requires fresh file SHA-256, rejects unsupported targets/overflow, preserves unrelated bytes and backs up before atomic replacement. Moving a symbol does not move its wires; recompile/export to verify circuit behavior.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project; file paths stay inside its directory. |
| workspace | no | string | Workspace scope when no project is given. |
| path | yes | string | GDF/SYM file inside the chosen project/workspace. |
| expectedSha256 | yes | string | SHA-256 returned by the latest GDF read. |
| confirm | no | boolean | Apply when true; otherwise preview. Session authorization suffices, no new user approval is implied. |
| edits | yes | array | One operation per original record offset. Observe again after text edits. |

## gdf_symbol_library

List installed max2lib SYM files with SHA-256 and names, or inspect one prototype with local pins, extent and preserved default instance/parameter attributes. Read-only. Symbol insertion uses these hashes and original bytes, independently of any agent SDK.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | MAX+PLUS II installation root; defaults to environment/detection. |
| path | no | string | Optional .sym path relative to max2lib, or absolute inside that library. |
| query | no | string | Literal case-insensitive substring of library-relative filenames. |
| offset | no | integer | File or pin/default-attribute page offset; default zero. |
| limit | no | integer | Items per page; default 20, maximum 100. |

## gdf_create

Create a version-6 GDF sheet with the recovered original-editor blank header/extent. Preview by default; never overwrite an existing file. Use gdf_construct for symbols/wires, then original compiler/simulator for circuit verification.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project used as file scope. |
| workspace | no | string | Workspace directory when no project is given. |
| path | yes | string | Target GDF path inside the chosen scope. |
| width | no | integer | Sheet width on the 8-unit grid, default 1904. |
| height | no | integer | Sheet height on the 8-unit grid, default 1232. |
| confirm | no | boolean | Apply when true; otherwise return a preview. Existing session authorization suffices. |

## gdf_construct

Transactional GDF v6 construction: insert hashed SYM instances, name I/O and electrical wires/buses, replace/clear modern parameter assignment maps, normalize invalid/duplicate native NET_IDs, add/delete orthogonal wires, symbols and free annotations. Existing offsets/current SHA-256 required; preview/backup/atomic apply. Deleted symbols leave wires. Same wire names can connect remote geometry; actual parameters and connections require original compiler/simulator verification. Legacy/ambiguous parameter records are preserved and refused for edits.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF project used as file scope. |
| workspace | no | string | Workspace directory when no project is given. |
| path | yes | string | Target GDF path inside the chosen scope. |
| root | no | string | Installed symbol-library root; not required for local custom SYM sources. |
| expectedSha256 | yes | string | Current target GDF SHA-256 from fresh geometry read. |
| confirm | no | boolean | Apply when true; otherwise return a preview. Existing session authorization suffices. |
| operations | yes | array | Explicit source-offset operations, or complete positions/names for new objects. All validated before writing. |

## gdf_pin_labels

File-only GDF/SYM diagnostics. Omit expectedSha256 to inspect exact pin/DOC duplicates and fixed-font same-row pin collisions. Supply a fresh hash to preview cleanup; confirm=true applies with backup. Removes only exact visible duplicate free DOC, preserving native pin labels. Optional right-label alignment moves label anchors only. Does not infer arbitrary glyph/layout collisions.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| offset | no | integer | Offset in each root collection; default zero. |
| limit | no | integer | Root items per collection; default 20, reduced to fit the result budget. |
| childOffset | no | integer | Independent offset in each nested collection; default zero. |
| childLimit | no | integer | Items per nested collection; defaults to the requested root limit, reduced to fit the result budget. |
| expectedSha256 | no | string | Current full file SHA-256 from a fresh inspection. |
| alignOverlappingRightPins | no | boolean | Also align colliding right-edge fixed-font pin labels inside the existing symbol; refuse if insufficient space. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## gdf_declarations

Read existing native CONSTANT h/51/52 and PARAM h/53/54 declaration pairs. Reports writable and ambiguous/unsupported legacy forms. These are source declarations or defaults, not generic instance parameter assignments.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| offset | no | integer | Offset in each root collection; default zero. |
| limit | no | integer | Root items per collection; default 20, reduced to fit the result budget. |
| childOffset | no | integer | Independent offset in each nested collection; default zero. |
| childLimit | no | integer | Items per nested collection; defaults to the requested root limit, reduced to fit the result budget. |

## gdf_declarations_edit

Edit only an existing unambiguous native CONSTANT/PARAM name/value pair. Retains native IDs, aliases, geometry, fonts and other properties. Requires both name and value, fresh hash, preview and recoverable backup. Compiler/simulator must validate expression, scope and effect.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| edits | yes | array | Ordered collection of explicit entries validated by this tool. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## gdf_text_edit

Create, reposition, restyle or delete root free DOC annotations. Preserves font, metrics, alternative text and opaque bits; refuses electrical labels or instance/pin text. Sequential operations use original offsets and return resulting offsets. Printable Latin-1 only.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| operations | yes | array | Ordered changes; record offsets refer to the original input. Inspect again after applying. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## gdf_symbol_refresh

Preview or apply a hashed same-name/same-type SYM to explicitly selected GDF instances. Shared definitions split so unselected instances retain original bytes. Instances/NET_ID/parameters/placement/rotation remain. Reports pin/interface and geometric contact changes; these require explicit allow flags. Compile/export/simulate to prove actual connectivity.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| template | yes | string | Workspace SYM or absolute installed max2lib SYM. |
| templateSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| root | no | string | Optional installed library root. |
| offset | no | integer | Offset in each root collection; default zero. |
| limit | no | integer | Root items per collection; default 20, reduced to fit the result budget. |
| childOffset | no | integer | Independent offset in each nested collection; default zero. |
| childLimit | no | integer | Items per nested collection; defaults to the requested root limit, reduced to fit the result budget. |
| selectors | yes | array | Explicit selectors: exactly one original offset, definition index or instance name per entry. |
| allowInterfaceChanges | no | boolean | Explicitly permit reported pin name/direction/add/delete changes. |
| allowDisconnected | no | boolean | Explicitly permit reported geometric contact changes; this does not prove electrical safety. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## gdf_graphics_edit

Add/delete or resize/restyle root drawing lines, circles and arcs. Original unknown flags/shared symbol definitions retained; drawing lines are not electrical wires. Use gdf_construct for connections. Original offsets/current hash, preview and backup required.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| operations | yes | array | Ordered changes; record offsets refer to the original input. Inspect again after applying. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## sym_inspect

Inspect standalone SYM graphics, pin names/positions/native interface directions, text display flags and preserved instance defaults. No compiler needed. Paginated collections; direction provenance does not prove circuit wiring.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| offset | no | integer | Offset in each root collection; default zero. |
| limit | no | integer | Root items per collection; default 20, reduced to fit the result budget. |
| childOffset | no | integer | Independent offset in each nested collection; default zero. |
| childLimit | no | integer | Items per nested collection; defaults to the requested root limit, reduced to fit the result budget. |

## sym_edit

Rename/resize standalone SYM, edit/create/delete internal lines/circles/arcs/text and interface pins. Uses original attributes and preserves unrelated/default records. Changes do not update embedded GDF symbol copies. Inspect fresh offsets/hash; verify consuming circuit with original compiler.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| operations | yes | array | Ordered changes; record offsets refer to the original input. Inspect again after applying. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## sym_create

Create a new original-format SYM or clone a hashed workspace/installed-library prototype under a new name. Never overwrite. Optional operations add internal graphics/text/pins. Matching HDL source interface must be supplied separately and compiler/export used to prove connectivity.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| name | yes | string | New HDL symbol name. |
| nameAttributeName | no | string | Primitive or hierarchy name attribute; custom clone/create defaults MACRO_NAME. |
| width | no | integer | Extent width on grid8. |
| height | no | integer | Extent height on grid8. |
| template | no | string | Optional custom scope SYM or absolute installed max2lib SYM. |
| templateSha256 | no | string | Current full file SHA-256 from a fresh inspection. |
| root | no | string | Optional installed library root. |
| operations | no | array | Ordered changes; record offsets refer to the original input. Inspect again after applying. |
| pins | no | array | Ordered collection of explicit entries validated by this tool. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## scf_structure

Decode version4 SCF scalar names, display ordering, groups/radix, duration and native record locations. Exposes unknown/reference limits. Use scf_inspect for paginated logic events.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| offset | no | integer | Offset in each root collection; default zero. |
| limit | no | integer | Root items per collection; default 20, reduced to fit the result budget. |
| childOffset | no | integer | Independent offset in each nested collection; default zero. |
| childLimit | no | integer | Items per nested collection; defaults to the requested root limit, reduced to fit the result budget. |

## scf_structure_edit

Transactional SCF signal rename/reorder, group/ungroup/radix, duration extension/truncation and input add/delete. Unknown fields preserved; unsafe opaque reference changes refused. Names must match compiled nodes; resimulate after edits.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| expectedSha256 | yes | string | Current full file SHA-256 from a fresh inspection. |
| operations | yes | array | Ordered scalar/group structure changes; names must match compiled nodes. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## scf_create

Create a new version4 SCF directly without VEC or GUI. Explicit input names and optional 0/1/X/Z events; events in ns on 0.1ns grid. Never overwrite. Use matching compiled netlist and original simulator for verification.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes these files. |
| workspace | no | string | Workspace scope when project is absent. |
| path | yes | string | File path within that scope. |
| durationNs | yes | number | Total waveform duration in ns on a 0.1ns grid. |
| inputs | yes | array | Ordered collection of explicit entries validated by this tool. |
| confirm | no | boolean | Apply when true; default preview. Current session authorization suffices. |

## gdf_connections

Build source nets preserving unsynthesized instances/pins. Original endpoint/overlap, pin-on-wire, transparent WIRE and remote-name rules; crossings, driver and dangling diagnostics. Separate bitTopology expands explicit bus ranges, scalar member aliases and WIRE ordered/reversed mappings; unresolved widths remain explicit. Paginated; original compilation proves electrical legality.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| offset | no | integer | Offset in each root collection; default0. |
| limit | no | integer | Items per root collection; default20, reduced to fit the response budget. |
| childOffset | no | integer | Independent offset in each nested detail collection; default0. |
| childLimit | no | integer | Items per nested detail collection; defaults to root limit. |

## gdf_move_connected

Move selected GDF6 placements on grid8 and/or choose orientation0..7. Route scalar pin extensions around other source nets and symbol interiors; split existing wires at departed interior pins. Refuse any changed source terminal partition or named-net membership. Original compilation/export/simulation required. Bus bundles/unknown topology refused. Hash/preview/backup transaction.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| expectedSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| edits | yes | array | Explicit selected placements; offsets refer to current input. One entry per placement. |
| maxRouteSteps | no | integer | Total bounded grid search expansions; default100000. |
| confirm | no | boolean | Apply when true; default preview with no write. |

## gdf_text_format_inspect

Inspect all GDF/SYM q records, original font strings, built-in font codes, stored metrics and raw text bytes. Explicit latin1/windows-936 decoding; no guessed encoding. Pagination and malformed-encoding diagnostics.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| encoding | no | string | Explicit original byte encoding. The GDF/SYM has no encoding marker; default latin1. |
| offset | no | integer | Offset in each root collection; default0. |
| limit | no | integer | Items per root collection; default20, reduced to fit the response budget. |
| childOffset | no | integer | Independent offset in each nested detail collection; default0. |
| childLimit | no | integer | Items per nested detail collection; defaults to root limit. |

## gdf_text_format_edit

Create/change only free root DOC text in GDF6 or standalone SYM2..6. Choose built-in font0..3 or Windows font face,size with explicit width/height. Exact reversible Windows-936 encoding supports Chinese bytes; Chinese requires Windows font. Preserves electrical labels, shared definitions and opaque tails. Verify glyphs with original editor.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| expectedSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| operations | yes | array | Ordered changes use original offsets. Only free root DOC text is writable. |
| confirm | no | boolean | Apply when true; default preview with no write. |

## scf_editor_metadata

Expose known display/time fields and bounded raw metadata, clearly identifying unresolved cursor/grid/zoom/private references. Preserves opaque bytes; do not infer their meaning from a round trip.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| offset | no | integer | Offset in each root collection; default0. |
| limit | no | integer | Items per root collection; default20, reduced to fit the response budget. |
| childOffset | no | integer | Independent offset in each nested detail collection; default0. |
| childLimit | no | integer | Items per nested detail collection; defaults to root limit. |

## scf_stimulus_edit

Native SCF clock, repeated 0/1/X/Z segments, wide MSB-first counters, shift, invert, fill and snapshot copy. Exact 0.1ns grid, bounded200000 total events; preserves waveforms outside edited half-open ranges and all opaque records. Fresh original simulation computes outputs.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| expectedSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| operations | yes | array | Ordered stimulus edits; windows are half-open and measured in ns on grid0.1. |
| confirm | no | boolean | Apply when true; default preview with no write. |

## scf_compiled_ports

Read an exported .edo file up to32MiB and map top-level input/output ports to MAX+plus II Simulator names, including explicit vector ranges and native flattening. Internal EDIF nets, ambiguous arrays and INOUT are marked unsupported. Use netlist_export then inspect this fresh file.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| offset | no | integer | Offset in each root collection; default0. |
| limit | no | integer | Items per root collection; default20, reduced to fit the response budget. |
| childOffset | no | integer | Independent offset in each nested detail collection; default0. |
| childLimit | no | integer | Items per nested detail collection; defaults to root limit. |

## scf_ports_import

Append selected top-level input/output nodes from a fresh hashed .edo to an existing hashed SCF. Retains existing waveforms; inputs begin0, outputsX until simulated. Refuses role mismatches/unsafe opaque references. Both files must be inside the same scope.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| expectedSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| edifPath | yes | string | Exported .edo in the same scope. |
| edifSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| signals | no | array | Explicit existing scalar names in MSB-first order where used as counter bits. |
| confirm | no | boolean | Apply when true; default preview with no write. |

## scf_from_compiled_create

Create a new SCF from selected or all supported top-level ports in a hashed .edo. Direct original SCF records, no VEC. Inputs0 and output observationsX; use scf_stimulus_edit then the original Simulator. Never overwrites; unresolved nodes require explicit supported selection.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes the files. |
| workspace | no | string | Workspace when no project is supplied. |
| path | yes | string | File path within the scope. |
| edifPath | yes | string | Exported .edo in the same scope. |
| edifSha256 | yes | string | Current full SHA-256 from fresh file inspection. |
| signals | no | array | Explicit existing scalar names in MSB-first order where used as counter bits. |
| durationNs | yes | number | Positive total time in ns on grid0.1. |
| confirm | no | boolean | Apply when true; default preview with no write. |

## gdf_wire_cleanup

Remove only unannotated electrical leaf segments in GDF6 pin-bearing physical nets. Preserve surviving token bytes, named wires, pins, isolated unconnected nets and overlapping conductors. Every round checks source scalar pin partitions and complete bus bit/alias partitions. Refuse unknown topology or exceeded budgets; compile and simulate the result independently. Fresh hash, preview and backup transaction.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes files. |
| workspace | no | string | Workspace scope when no project is selected. |
| path | yes | string | File path within the selected scope. |
| expectedSha256 | yes | string | Current full GDF SHA-256 from a fresh inspection. |
| maxComparisons | no | integer | Fixed-cap cleanup comparison budget, default4000000; caller may lower it. |
| maxPasses | no | integer | Maximum leaf-peeling rounds, default1000. |
| confirm | no | boolean | Apply when true; default preview without writing. |

## waveform_signals

Read an original TBL and return real declared input/output/buried signals, bit widths, native units and available time span. Detect malformed tables, ambiguous names and exceeded budgets. Hidden SCF signals absent from TBL remain absent; this does not prove saved editor layout.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes files. |
| workspace | no | string | Workspace scope when no project is selected. |
| path | yes | string | File path within the selected scope. |
| offset | no | integer | Root collection offset, default0. |
| limit | no | integer | Root collection items, default20; may reduce to fit response budget. |
| childOffset | no | integer | Independent nested detail offset, default0. |
| childLimit | no | integer | Nested collection item limit, default root limit. |
| maxRows | no | integer | TBL row parsing budget, default200000. |
| maxComparisons | no | integer | TBL analysis comparison budget, default2000000. |

## waveform_results

Extract result events gated by an actual scalar valid signal. Default proven rising edges, with initial-high rows separately marked; optional samples means native rows while valid=1. Optional settling samples point-in-time data inside the valid window. Retains raw numeric/X/Z tokens, missing columns and unknowns; held data while valid is low creates no result. Return paginated events and a recommended ns window; does not alter SCF zoom, row visibility, clock or design logic.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| project | no | string | Existing ACF whose directory scopes files. |
| workspace | no | string | Workspace scope when no project is selected. |
| path | yes | string | File path within the selected scope. |
| validSignal | yes | string | Real scalar valid column, e.g. OUT_VALID. |
| dataSignals | yes | array | Actual result columns, e.g. OUTBUS[7..0]. |
| kindSignal | no | string | Optional type discriminator column, e.g. OUT_KIND; no semantics inferred. |
| edge | no | string | Default rising. samples selects native valid-high rows, not uniform sampling. |
| settleNs | no | number | Sampling delay after valid entry, default0; must remain in the same valid window. |
| paddingNs | no | number | Recommended view padding, default1000ns. |
| startTimeNs | no | number | Inclusive event-range start in ns, default first native time. |
| endTimeNs | no | number | Inclusive event-range end in ns, default last native time. |
| offset | no | integer | Result event offset, default0. |
| limit | no | integer | Event count, default20; may reduce to fit output budget. |
| maxEvents | no | integer | Total event budget before pagination, default100000. |
| maxRows | no | integer | TBL row parsing budget, default200000. |
| maxComparisons | no | integer | TBL analysis comparison budget, default2000000. |

## display_palette_inspect

Read only the [Colors] section of installed maxplus2.ini. Separate ordinary DOC Text, native Symbol Pinstub Names, and Nodes & Connection Dots roles. Reports stored preferences, not live unsaved colors; GDF color bits and custom previews cannot prove native display. Verify visible colors using original Color Palette Preview and desktop_observe.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| root | no | string | Optional explicit MAX+plus II installation root; invalid explicit roots are refused. |

## capability_matrix

Return precise routes and runtime requirements for authoring, compilation, simulation and native GUI-only workflows. Distinguishes implemented entry points from operations verified on this machine and physical programming requirements.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |

