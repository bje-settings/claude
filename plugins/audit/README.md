# audit

Audits a repository's context files for rot.

## `/audit:context`

`/audit:context` reads a checkout's `CLAUDE.md`, `README.md`, and every tracked `.md` file under
`.claude/`. With `--scope all`, it reads every tracked `.md` file instead. It splits the files
into checkable units and reports:

- A reference that no longer resolves. This is a path, a `file:line`, an issue number, or a
  script or command a unit names. The audit checks each one against the tree and one batched
  issue lookup.
- Volatile units whose named issue has closed.
- Duplicate claims, or claims that conflict across units.
- Claims an excerpt of the file they cite refutes.

The audit runs to completion with no key at all. Tier 0, the reference checks, needs no model
and is always run. The three model stages, classify, pairs, and evidence, each need
`TYPESAFE_API_KEY`. When there is no key to spend, or `--no-jev` was passed, the report marks
the stage as skipped. It gives the reason. Repository text reaches TypeSafe only when that key
is present.

### Requirements

Node 22.18 or newer.

`git`. The audit reads only tracked files. It refuses to run when git is absent, or when the
root is outside a checkout.

`gh`, for issue states. The audit needs `gh` only when a context file names an issue number. A
repository that names no issue number never reaches this check.

`TYPESAFE_API_KEY`, optional, for the three model stages.

### Flags

| Flag | Effect |
| --- | --- |
| `--scope context\|all` | `context` (default) reads `CLAUDE.md`, `README.md` anywhere, and any tracked `.md` file under `.claude/`. `all` reads every tracked `.md` file instead. |
| `--shape per_section\|per_unit` | The classify request shape sent to the model. Default `per_section`. |
| `--no-jev` | Skip the three model stages even with a key present. |
| `--json` | Write the whole report as JSON to stdout instead of the findings text. |
| `--out FILE` | Also write the JSON report to `FILE`. |
| `--max-pairs N` | Cap on how many candidate duplicate pairs the pairs stage judges, highest similarity first. Default 300. |
| `--max-evidence N` | Cap on how many repository facts the evidence stage judges. Default 200. |
| `--pair-threshold X` | Similarity floor, 0 to 1. A candidate pair must clear this floor before the audit judges it. Default 0.5. |
| `--help`, `-h` | Prints usage and exits 0. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every stage that ran succeeded. A stage that the audit skips, because there was no key to spend or because of `--no-jev`, counts as success. |
| 1 | At least one model call failed, such as a classify stage that ran and labelled no unit at all. The findings still print. Stderr states how many calls failed. |
| 2 | The audit refused the request. Reasons: a bad flag, a second positional argument, a bad count or fraction, or a path outside any checkout. Other reasons: git is absent, `--out` cannot open, or git refuses to list the tracked files. A tracked file that cannot be read is also a reason. Nothing appears on stdout. |

### Example

From an installed copy of the plugin, `<plugin>` below is the plugin's own directory:

```bash
node <plugin>/scripts/audit.ts context . --no-jev
```

### Running outside Claude Code

The command has no dependency on the plugin runtime. Inside Claude Code, the skill uses
`${CLAUDE_PLUGIN_ROOT}` instead:

```bash
node <plugin>/scripts/audit.ts context /path/to/a/repo --scope all --out report.json
```

`node <plugin>/scripts/audit.ts` with no command prints the list, and `context --help` prints its
own usage.
