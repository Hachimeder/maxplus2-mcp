# Public-source verification

Version: 0.10.3. Tool count: 68. Runtime: Node.js 24.14.0.

The public tree was tested independently of the original private workspace.
The default test runner completed **27 suites, 240 passing checks, zero failures**.
Fourteen individual tests requiring installed vendor software were explicitly
skipped; native-only suites are selected separately with `--native`.

Native verification of the 0.10.1 tool implementations used MAX+plus II 10.2,
PowerShell 7.6.6 and the locally built
Win32/UIA backend. The native run exercised 45 suites, including original
compilation/simulation, EDIF export, GDF/SYM edits, SCF edits, source identity,
library parsing and desktop backend tests. A startup relocation assumption found
during that run was corrected; all 13 startup checks passed in a targeted rerun.
All other native suites passed. Version 0.10.2 adds release packaging and bilingual
introduction pages; version 0.10.3 adds MCPB distribution and discovery metadata.
The tool implementations are unchanged. Hardware programming
was not tested.

Windows teardown was corrected to close test clients and tool children before
removing scratch directories. Its 30 reliability checks passed after the fix.
Plain stdio checks discovered all 68 tools, read both guide resources, and verified
error responses and workspace traversal rejection.

Publication review excluded private experiment files, screenshots, logs, local
configuration, archives, vendor libraries and executable images. The public audit
checks text, UTF-16 byte views and encoded JSON fixtures. The final Git index is
audited separately before the initial public commit.

These are local verification results on Windows and Node.js 24.14.0.
`ci/github-actions.yml` is an inactive template for a Windows/Linux, Node.js 18/24
matrix. The initial publication credential lacks GitHub's workflow scope, so
automatic CI was not enabled. Those additional host/runtime combinations have
not been verified by GitHub Actions at publication time.
