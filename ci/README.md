# GitHub Actions template

`github-actions.yml` runs the public audit and portable test suite on Windows and
Linux with Node.js 18 and 24. It is a template; files in this directory do not
start an Actions workflow.

To enable CI, use a GitHub credential authorized to write workflow files, copy the
template to `.github/workflows/test.yml`, and commit/push that file. With GitHub
CLI OAuth authentication, writing workflow files requires the `workflow` scope.
Do not put credentials into the YAML, source code or remote URL.

Until enabled, use `npm run audit:public` and `npm test` locally. Vendor integration
checks additionally require the separately installed MAX+plus II software and
`MAXPLUS2_ROOT`; they are not part of the hosted template.
