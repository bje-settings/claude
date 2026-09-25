---
type: ADR
description: The audit plugin's three model stages send repository text to TypeSafe only when TYPESAFE_API_KEY is set, treat every judgment as advisory input a reviewer verifies rather than a gate, and reach the model through a JevClient in the shared lib/ behind an SDK-style interface mocked at that boundary.
status: stable
created: 2026-09-22
owner: brianespinosa
related_issues: [164]
related_milestones: [6]
---

# ADR 003: The audit plugin's model boundary

Records what `plugins/audit`'s `/audit:context` does at the one boundary nothing else in this
marketplace crosses: sending a checkout's own prose to a service outside the machine so it can be
judged.

## Context

Tier 0 of `/audit:context` reads only the checkout and, for the issue numbers a unit cites, one
batched `gh` lookup. Every other capability in this marketplace stays inside that same boundary:
`gh` reaches the user's own remotes and GitHub through the same injected client, and `mermaid`
builds a link but sends nothing itself. Tier 0 alone cannot decide whether a claim still holds,
whether two units say the same thing, or whether a cited file still backs what a unit asserts;
those are judgments, and answering them means sending the unit's text, and sometimes an excerpt of
a file it cites, to something that can read prose.
Once one plugin does that, a repository running it needs a way to tell, without reading
`plugins/audit/src/commands/context.ts`, whether its own words are about to leave the machine on
a given run.

**Revised at [#205](https://github.com/bje-settings/claude/issues/205):** `src/commands/` is now
`src/subcommands/` ([ADR 004](004-plugins-ship-runtime-files-only.md)). The line numbers below are
the ones this record was written against.

The service on the other side of that boundary is not deterministic. PR #168's spike measured it
directly: identical requests to the model drift by about 0.02 on mid-range probabilities, and a
label in the 0.4 to 0.7 confidence band can flip between two runs of the same request. Anything
that reads a raw probability as pass or fail, in CI, in a required check, or in a command's own
exit status, would be red or green depending on when it ran rather than on what changed in the
checkout, which is the property this repository's other gates deliberately do not have:
`docs/adr/002-quality-gate-venues.md`'s coverage numbers and job names do not move between two
runs of the same commit, and tier 0's own findings do not either.

ADR 001's test seam asks for an injected client, one reply per operation, so a command's logic is
provable without a network call, and RFC 001's decision to mock only at system boundaries applies
to whatever answers the model stages the same way it applies to `git` and `gh`. The model this
plugin calls is reached through three distinct operations with three different request and
response shapes, one per judgment (a unit's classification, a candidate pair's verdict, a claim
against an excerpt), so where that boundary sits and what shape it presents to a test is a real
question, not a detail either seam settles on its own.

## Decision

**Repository text leaves the machine only when `TYPESAFE_API_KEY` is set, and never otherwise.**
`scripts/audit.ts` hands `commands/context.ts` a client factory rather than a constructed client, and
`modelStages` reads the key and decides whether to call that factory at all
(`plugins/audit/src/commands/context.ts:407-427`). With no key, or with `--no-jev`, the three
model stages are skipped with the reason recorded on the report, and nothing they would have sent
is ever built. Tier 0 never reads `TYPESAFE_API_KEY` and does not need to, so the audit is
complete and useful with no key present at all; the key only ever widens what the audit checks,
never narrows what it can answer without one.

**No raw model probability gates anything; every model finding is advisory, for a reviewer to
verify, never a threshold a command enforces on its own.** `runContext` exits 1 only when a model
call itself failed to answer, never because of what it answered: a `pairs: contradicts` verdict,
an `evidence: contradicts` verdict, or a unit judged volatile and expired are findings printed for
a reader, and none of them changes the exit code
(`plugins/audit/src/commands/context.ts:681-683`; the sections in `report.ts`). The `/audit:context`
skill's own triage step exists for the same reason: it orders findings by how directly tier 0
established them, absent references first because they are near-certain and needed no model call
at all, evidence contradictions last because the excerpt a claim is judged against is only the
first 6,000 characters of the cited file, so a true claim about something further down can still
read as contradicted. Nothing in this plugin treats a judgment as proof a reviewer can skip.

**The model is reached through a `JevClient` in the shared `lib/`, one method per operation, mocked
at that interface rather than at the transport underneath it.** `lib/jev.ts`'s `JevClient` declares
four members: `classify`, `judgePair` and `judgeEvidence`, the three model operations, plus
`usage()` for what a run spent. `harness/jev.ts` is the double built against exactly that
interface, the same shape ADR 001 states for `lib/gh.ts`'s injected `GhClient`: one reply
registered per model operation, an unregistered method throwing rather than answering empty, and
`usage()` answering a fixed zero rather than accumulating anything real, so a test proves a
command called the client correctly rather than passing because nothing was called. The question
and rubric wording each method sends is copied verbatim from the PR #168 spike, since it is what
every measurement the spike made, including the drift figure above, depended on staying exactly
as written. Living in `lib/` rather than inside `plugins/audit/src/` is what lets a later plugin
needing the same kind of judgment reuse the client, the way `lib/gh.ts` is already shared by
convention: `gh` and this plugin's own issue lookup (`commands/context.ts:22`) both reach it.

## Consequences

- A repository running `/audit:context` with no `TYPESAFE_API_KEY` gets the complete tier 0
  report and nothing else; the three model sections read `skipped (no_key)` rather than empty,
  which is what `SkippedStage` exists to keep a reader from misreading as "nothing found".
- Any later use of the model in this plugin inherits the same rule: the key is read at the point
  it would be spent, through the factory `scripts/audit.ts` hands over, not earlier and not twice.
- The key stays an environment variable rather than a `userConfig` entry, although the plugin
  docs recommend `userConfig` with `sensitive: true` for credentials. A sensitive value reaches
  hook processes (as `CLAUDE_PLUGIN_OPTION_<KEY>`) and MCP or LSP server configs, and never skill
  content; the skill runs `scripts/audit.ts` through the Bash tool in the user's own shell
  environment, which is not a hook process, so a key declared there would never reach it. If the
  plugin ever gains a hook or an MCP server that spends the key, `userConfig` becomes the right
  home for it and this entry is the one to revise.
- No test, CI gate, or command exit status may read a Jev probability as pass or fail. The
  mitigation is the same one ADR 002 states for coverage: a number is a fact the report carries,
  not a threshold anything enforces, unless the rubric behind it is itself pinned by a test the
  way the question wording is pinned here by staying verbatim.
- The rubric wording is an assumption inherited from PR #168's measurement rather than one this
  plugin re-verifies; changing a question or a criterion's text without re-measuring drift on the
  new wording invalidates the 0.02 figure this decision rests on.
- The mock lives at `lib/jev.ts`'s interface, so a change to how `classify`, `judgePair` or
  `judgeEvidence` are called inside the plugin needs no change to `harness/jev.ts`'s shape; a
  change to what any of the three means does.
