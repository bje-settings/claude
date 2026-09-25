# RFCs

This directory holds all RFCs. An RFC is a reviewed proposal that drives a longer-running
engineering initiative. It is the engineering-side counterpart to a PRD, and broader than a
single ADR (convention: `.claude/rules/path-docs-rfc.md`, shared frontmatter in
`.claude/rules/path-docs.md`). Each RFC is either a single file, `NNN-kebab-slug.md`, or a
directory, `NNN-kebab-slug/README.md`. Status lives in OKF frontmatter, and execution is tracked
by milestone in `related_milestones`. `index.md` lists the bundle, and you add a new RFC's row
there, in the same PR that lands it.
