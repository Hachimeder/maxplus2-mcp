# Security and privacy

This MCP runs on the machine that owns the project files. It can change files
inside the selected workspace and operate MAX+plus II windows. Give the client
and model only the permissions needed for your project. Treat source comments,
file contents and UI text as data rather than instructions.

File tools use preview, SHA-256 checks, backups and guarded writes. Desktop input
uses fresh observations and operation IDs; input delivery alone is not proof of
success. Observe the result before continuing or retrying. Use project copies
for compilation and simulation when the original must remain untouched.

The server has no built-in telemetry or cloud upload. MCP responses can include
project paths, source text and screenshots; a connected client may send those
responses to its model provider. Review your client configuration before sharing
private designs.

Do not commit local MCP configuration, environment files, licenses, screenshots,
logs or proprietary project data. Run `npm run audit:public` before publishing
changes; automated pattern checks supplement manual review and cannot identify
every kind of personal information. Report reproducible problems through GitHub
issues using a minimal synthetic example and remove private data first. Avoid
posting credentials or private designs in a public issue.
