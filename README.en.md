# maxplus2-mcp

[简体中文](README.md) | [English](README.en.md)

An MCP server that lets AI agents work with MAX+plus II: read and edit projects,
GDF schematics, SYM symbols and SCF waveforms, run the original compiler and
simulator, and operate the native Windows interface.

Version **0.10.2** exposes **68 tools** over local **stdio MCP**. The runtime uses
only Node.js built-in modules and requires no npm dependencies. The Windows
backend belongs to this project and uses Win32 and UI Automation. Any client
that supports local stdio MCP can connect; no Codex Computer Use or agent SDK is
required.

The server combines file parsing, the original command-line tools and desktop
interaction. An agent can inspect the actual circuit and waveform, make guarded
file edits, then verify behavior with the original software. Wizards and editor
properties that have not been decoded remain accessible through the standalone
desktop backend.

**Download:** The [latest Release](https://github.com/Hachimeder/maxplus2-mcp/releases/latest)
provides a compact runtime package, a complete source package and SHA-256 checksums.

## Capabilities

| Area | Features |
| --- | --- |
| Projects and source | Create, clone, search, read, edit, back up and restore; ACF settings, HDL, MIF and VEC |
| GDF schematics | Original geometry, symbol placement, rotation/mirroring, world pin positions, wires, annotations, parameters and declarations |
| GDF connectivity | Source instances and pins, explicit per-bit bus topology, checked scalar movement/routing and anonymous wire-tail cleanup |
| SYM symbols | Create, edit, inspect and selectively refresh embedded definitions while preserving unselected instances |
| Text and colors | Fonts, explicit Windows-936 Chinese text and saved color roles; detect and remove duplicate DOC text covering native pin labels |
| SCF waveforms | Input events, X/Z, signal creation/removal, names, groups, radix, ordering and duration; clock/counter/repeat stimuli |
| Compilation and analysis | Original compilation, simulation, timing analysis and synthesized netlist export; background jobs, cancellation, reports and result checks |
| Windows interface | Windows, screenshots, UIA controls, menus, keyboard, mouse, dragging and scrolling; expiring observations and duplicate-input protection |

Use MCP `tools/list` for the full parameter schemas, or read the
[tool reference](docs/TOOLS.md). Prefer file tools for decoded formats and desktop
tools for wizards, menus and other editor operations.

## Installation and connection

File tools require **Node.js 18+**. Original compilation, simulation and desktop
operations require **Windows** and a separately installed, appropriately licensed
copy of **MAX+plus II**. The original toolchain has been verified with version 10.2.
Desktop operations also require .NET Framework 4.8 and an unlocked, interactive
Windows session. This repository does not distribute the MAX+plus II installer,
executables, device libraries or license files.

### Use the Release package

1. Download `maxplus2-mcp-v0.10.2.zip` from the
   [v0.10.2 Release](https://github.com/Hachimeder/maxplus2-mcp/releases/tag/v0.10.2)
   and extract it to a stable directory.
2. Install Node.js separately if necessary and check it with `node --version`.
3. Connect your MCP client using the configuration below, replacing the paths
   with your actual software installation and project directories.

The runtime package includes runtime source, Windows backend source, both README
pages and operating guides. Git and npm install are not required to run it. The
Windows helper compiles automatically on first use.
`maxplus2-mcp-v0.10.2-source.zip` additionally includes development scripts, public
tests and the CI template for development and contributions.

### Install from source

```powershell
git clone https://github.com/Hachimeder/maxplus2-mcp.git
cd maxplus2-mcp
node --version
```

Copy the service definition from [mcp-config.example.json](mcp-config.example.json)
into your client's MCP configuration. The directories below are placeholders:

```json
{
  "mcpServers": {
    "maxplus2": {
      "command": "node",
      "args": ["C:\\tools\\maxplus2-mcp\\server.mjs"],
      "env": {
        "MAXPLUS2_ROOT": "C:\\maxplus2",
        "MAXPLUS2_WORKSPACE": "C:\\fpga-projects"
      }
    }
  }
}
```

If the client cannot find Node on PATH, set `command` to the absolute path of your
Node executable. Client-specific configuration formats may differ; the command,
arguments and environment above define how to launch the stdio server.

You can validate the directories and original compiler, then generate a local
configuration file that Git ignores:

```powershell
node scripts/configure-local.mjs --root "C:\maxplus2" --workspace "C:\fpga-projects"
node scripts/configure-local.mjs --root "C:\maxplus2" --workspace "C:\fpga-projects" --apply
```

You can also launch through `start-local.ps1`, or check the installation with:

```powershell
node scripts/local-startup.mjs --check --root "C:\maxplus2" --workspace "C:\fpga-projects"
```

A stdio server expects JSON-RPC requests from the MCP client. Diagnostic messages
use stderr. The desktop helper builds from `native/MaxplusDesktop.cs` into the
ignored `bin/` directory. To build it manually, run
`pwsh -NoProfile -File scripts/build-desktop.ps1 -SelfTest`.

## Recommended workflow

1. Check the environment with `installation_status` and create a working copy
   with `project_clone`.
2. Read the actual contents and SHA-256 with `project_parse_file` or a dedicated
   inspection tool.
3. Preview edits and inspect changes, connectivity and limitations. Apply an
   authorized change with `confirm:true` and the fresh `expectedSha256`; these
   fields implement the tool's transaction controls.
4. Compile and simulate, then check newly generated reports, connections and
   actual outputs. Use `job_status` / `job_cancel` for asynchronous jobs.
5. For desktop interaction, use `desktop_windows` → `desktop_observe` →
   `desktop_action`. Supply the latest observationId and inspect the new
   observation returned after each action before continuing.

Detailed guides: [file workflow](docs/FILE-FIRST.md),
[desktop operations](docs/DESKTOP.md), and [formats and limits](docs/FORMATS.md).
These detailed workflow guides are currently in Chinese; the
[tool reference](docs/TOOLS.md) and live tool schemas are in English.

## Verification and development

Run development commands in a Git clone or the complete source package:

```powershell
npm run audit:public
npm test
```

Default tests use independent examples and mocked backends. They do not require
MAX+plus II, private experiments or vendor libraries. To run native integration
checks, select your installation:

```powershell
$env:MAXPLUS2_ROOT = "C:\maxplus2"
npm run test:native
```

Native tests create self-authored circuits in temporary directories and verify
compilation, simulation and netlists. Desktop tests additionally need an
interactive Windows session. Public checks do not require vendor installation.
An inactive [GitHub Actions template](ci/github-actions.yml) is included;
see the [CI instructions](ci/README.md) to enable it.

Pagination tests generate their GDF from custom symbols; SCF fixtures come from a
self-authored XOR circuit. They contain no private coursework or machine paths.
Run checks before contributing and provide a minimal public reproducer.
Verification evidence is documented in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Known limits

File editing primarily supports verified **GDF v6 / SCF v4** records. Unknown
records are preserved or edits are refused. Parameterized macro bus widths,
complete internal hierarchy connectivity, automatic bus routing and some private
SCF editor display fields remain limited. Source connectivity and synthesized
netlists answer different questions; verify logic changes with original
compilation and simulation.

Generic desktop tools provide an interaction route, but do not prove every menu
feature has been tested individually. Clients must forward screenshots to a
vision-capable model for complex canvas interaction. Hardware programming
requires supported physical hardware and is not verified by repository tests.

## License and privacy

Project code uses the [MIT License](LICENSE). Third-party software and fixture
provenance are described in [NOTICE.md](NOTICE.md). Local configuration, logs,
screenshots, backups, private experiments and vendor software are excluded from
the release. An MCP client may send returned data to its model provider;
see [SECURITY.md](SECURITY.md).
