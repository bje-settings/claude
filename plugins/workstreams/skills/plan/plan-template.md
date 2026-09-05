# Workstreams plan: <owner/repo>

## Context

<Two or three sentences: where the issues came from, what the session before this one found,
and what landing them changes.>

## Streams

| Stream | Kind | Issues | Touches | Model / effort | Why this size |
| --- | --- | --- | --- | --- | --- |
| s1 | independent | #N | `path/one.sh` | sonnet / medium | known cause, single module |
| s2a | stack, layer 1 | #N | `path/two.sh` (read side) | opus / high | foundational; s2b builds on it |
| s2b | stack, layer 2 | #N | `path/two.sh` (emit side) | opus / high | inherits the stack's top |

Stacks are listed bottom-up. Each layer is its own draft PR based on the layer below; the bottom
layer is based on the default branch.

## Cross-repo dependencies

<None, or one line per dependency: which stream, which other repository, what has to land
there and in which order. These are never absorbed into a stream silently.>

## Deferred

| Issue | Reason |
| --- | --- |
| #N | needs hardware; collect a week of data first |
| #N | already closed |

## Open questions already asked

<The questions put to the user before plan mode and their answers, so the run skill and a later
reader see what was decided and by whom.>

## Loop

Streams run in parallel as subagents, one per independent stream and one per stack. Progress is
checked every <N> seconds (<reason: longest stream, CI duration>). A stream that hits a decision
it cannot make pauses with its question; the others continue. The run ends when every stream is
done, paused, or failed, with a report of every PR, every deferred issue, and every open question.

## Out of scope

<Anything in the issue set the user chose not to work in this plan, with the reason.>
