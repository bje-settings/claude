# workstreams

The round primitives: the pieces a round of issue-tracker work is run out of, each usable
on its own. The issue tracker is the source of truth, blockers are recorded as issue
dependency relationships rather than as prose, and a round is the unblocked set swept from
the milestones being worked.

One skill per primitive, so a repository installs the plugin and reaches for whichever
piece it wants. This is the first of the five in
[#111](https://github.com/bje-settings/claude/issues/111); the review loop
([#133](https://github.com/bje-settings/claude/issues/133)), the stream
([#132](https://github.com/bje-settings/claude/issues/132)), the question phase
([#131](https://github.com/bje-settings/claude/issues/131)) and the orchestrator
([#134](https://github.com/bje-settings/claude/issues/134)) land after it.

## Requirements

`/workstreams:sweep` runs `preflight` first and stops with a hint per finding. It checks:

| Requirement | Why |
| --- | --- |
| [`gh`](https://cli.github.com) on `PATH` | Every read the sweep makes goes through it. |
| `gh auth status` | Issue dependencies are a GraphQL query, which needs a login. |
| The [`gh stack`](https://github.com/github/gh-stack) extension | A sequenced round opens a stack of pull requests. |
| The `gh` plugin, from any marketplace | The sweep sequences a round that `/gh:sync` prunes between. |

Nothing is vendored: a dependency is declared here and checked before a round starts,
never bundled. The plugin registry is read at
`$HOME/.claude/plugins/installed_plugins.json`, and a plugin counts as present under any
marketplace, because a fork under another name is still that plugin to the skill that
runs its commands.

## `/workstreams:sweep`

Finds what a round could start on, and says how it should be sequenced.

The command answers the deterministic half and the skill does the reading. What the
command answers:

| Set | Rule |
| --- | --- |
| unblocked | Every `blockedBy` entry is closed or merged, or there are none at all. |
| next tier | Exactly one open blocker, and that blocker is itself unblocked. |
| blocked | Everything else, with its open blockers named. |

"No blockers at all" and "every blocker closed" are both unblocked and are reported
separately: the first is work nothing was waiting for, the second is work a round just
released.

What the skill does with that: reads every body and every comment, reads the Decisions
lists in `docs/rfc/` and `docs/adr/` against what has merged, maps the files each issue
touches, classifies and sizes each one, chooses between parallel streams, a stack and one
pull request, and posts the sequencing comment on every affected issue. `skills/sweep/`
carries the rules, with `file-map.md` holding the mapping rules a file map has to apply.

It is a read of the tracker until the last step, which posts comments, so it is not
model-invocable: a person runs it.

## Commands

The skills run these; they also run by hand, from any repository, on any machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" --help
```

### `sweep`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" sweep [--milestone 4,5] [--json]
```

Reports the open milestones with their issue counts, every open pull request including
ones no round opened, and the three sets for each milestone asked for plus the issues on
no milestone at all. `--milestone` takes one number or a comma-separated list and is
refused if given twice, because `parseArgs` would otherwise keep only the last one
silently. Left out, the report covers every open milestone and any other milestone the
issues name, so an open issue left on a closed milestone is still reported. `--json`
prints one object for a skill to read.

Exit 2 on a usage error, 1 only when nothing at all could be read. A read that partly
failed is still an answer: the rows that arrived are reported and every reason the answer
is short is listed under `unavailable`, which a caller reads before acting on the sets.

The repository is whatever `gh` resolves from the working directory.

### `preflight`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight [--json]
```

Prints `{"ok": ..., "missing": [{"id": ..., "hint": ..., "detail": ...}]}` with `--json`
and the same findings as lines without it. Each hint is a command to run, except for an
unreadable registry, whose hint names the file it could not read. Exit 0 when everything
is present, 1 when anything is missing.

A registry that cannot be read is reported as itself and never as missing plugins: the fix
is a different one, and telling someone to install what they already have sends them the
wrong way.

## Tests

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run plugins/workstreams         # this plugin alone
```

`src/fixtures/sweep-capture.json` is every child process the real `gh` client started
while answering the sweep's four reads against `bje-settings/claude` on 2026-09-21. The
acceptance case replays it through the real client and asserts the sets a person swept by
hand that day, so "the report matches a hand sweep" is held by a test rather than by a
memory of one.
