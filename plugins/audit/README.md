# audit

Audits a repository's context files for rot.

## `/audit:context`

Reads a checkout's `CLAUDE.md`, `README.md` and anything under a `.claude/` directory (`--scope
all` reads every tracked `.md` file instead), splits them into checkable units, and reports:

- References that no longer resolve: a path, a `file:line`, an issue number, a script or a
  command a unit names, checked against the tree and one batched issue lookup.
- Volatile units whose named issue has closed.
- Duplicate or contradicting claims across units.
- Claims an excerpt of the file they cite refutes.

The audit runs to completion with no key at all. Tier 0, the reference checks, needs no model
and is always run. The three model stages, classify, pairs and evidence, need
`TYPESAFE_API_KEY` and are reported as skipped, with the reason, when there is none to spend or
`--no-jev` was passed. Repository text reaches TypeSafe only when that key is present.

### Requirements

Node 22.18 or newer. `git`; the audit reads only tracked files and refuses if git is absent or
the root is outside a checkout. `gh`, for issue states, only when a context file names an issue
number; a repository that names none never reaches it. `TYPESAFE_API_KEY`, optional, for the
three model stages.

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
| `--pair-threshold X` | Similarity floor, 0 to 1, a candidate pair must clear to be judged. Default 0.5. |
| `--help`, `-h` | Prints usage and exits 0. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every stage that ran succeeded; skipping because there was no key to spend, or `--no-jev`, counts as succeeding. |
| 1 | At least one model call failed, including a classify stage that ran and labelled no unit at all. The findings still printed; stderr says how many calls failed. |
| 2 | The request was refused: a bad flag, a second positional, a bad count or fraction, a path outside any checkout, git absent, an `--out` that cannot be opened, git refusing to list the tracked files, or a tracked file that cannot be read. Nothing on stdout. |

### Example

From an installed copy of the plugin, `<plugin>` below is the plugin's own directory:

```bash
node <plugin>/scripts/audit.ts context . --no-jev
```

### Running outside Claude Code

The command has no dependency on the plugin runtime; inside Claude Code the skill uses
`${CLAUDE_PLUGIN_ROOT}` in its place:

```bash
node <plugin>/scripts/audit.ts context /path/to/a/repo --scope all --out report.json
```

`node <plugin>/scripts/audit.ts` with no command prints the list, and `context --help` prints its
own usage.
