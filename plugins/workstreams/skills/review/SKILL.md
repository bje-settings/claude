---
name: review
description: Take one step of the review loop on one draft pull request, from its state. Dispatch a review round, record a finished one, reopen for a missing run, do the rot check, or report.
argument-hint: [pr-number] [--round 0|1|2] [--substantial] [--round-1-head <sha>] [--rot-checked] [round return]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh pr close *) Bash(gh pr reopen *) Bash(gh pr diff *) Bash(gh pr view *) Bash(gh pr edit *) Bash(gh pr comment *) Bash(gh issue view *) Bash(git worktree list *) Bash(git -C * diff *) Read Grep Glob Agent
user-invocable: false
---

Pull request and review facts: $ARGUMENTS. The flags are the four facts `pr-state`
cannot read. The caller reads them from the markers below.

Its worktree comes from `git worktree list`, matched against the pull request's head
branch. The round's issues are the ones its body closes (`gh pr view <number>`), or
the ones the caller names. No worktree match, or more than one, is a stop. Name what is
absent. A round dispatched into a guessed worktree will guess again inside it.

The model for the round agent comes from the newest plan comment on those issues, or from
the caller. When neither names one, choose it by this rule. Do not ask, and do not stop:

- `opus` for round 2.
- `opus` for round 1 when the diff changes logic under `src/`, `lib/`, `scripts/` or
  `hooks/`, as in [Markers](#markers).
- `opus` for round 1 when the layer is new behaviour at the top of a stream.
- `sonnet` for any other round 1: prose, tests, metadata or renames.

Give the model and the reason in the return of the call that dispatches the round.

Both commands below run in that worktree. They take no repository argument, and read it
from the working directory. So, outside a checkout, they report on git rather than on
the pull request.

Do one step for each call, then return. Never wait: the caller waits.

## Markers

After each review round, and after the rot check, post one marker comment on the pull
request. The effort is the name in the plan comment's last line, or the caller's. That
line can have a `<sub>` tag or not. Take the name in both cases. The date is today's:

```bash
gh pr comment <number> --body "<marker>
Head <sha>.

<sub>_Recorded by <effort>, <date>._</sub>"
```

The marker is one of these, exactly: `Review round 1 done: substantial.`,
`Review round 1 done.`, `Review round 2 done.`, `Rot check done.`

A round 1 marker has a second line, `Head <sha>.`, with the full `head` of the round
agent's return. Line 1 stays exact. Other markers have no `Head` line.

Round 1 is substantial only when its own commits changed logic under `src/`, `lib/`,
`scripts/` or `hooks/`. Logic is a new or changed branch, state, output line or contract.
A rename, comment, type, message text or one-line guard is minor. Prose, tests and
metadata are never substantial. For the commits after the `Head` line, `pr-state` applies
the path part of this rule. Each changed file under those directories counts, except a
test file, a file under a test directory, or a Markdown file. Then the state is `review-2`.

## Process

0. Called with a round agent's JSON return: check its `substantial` against
   `git -C <worktree> diff <from> <head>`. The diff decides the marker. Post that
   round's marker, with its `Head` line for round 1, name any disagreement, then
   return. A marker that did not post is a stop. Say so.

1. Read the state once.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --round <0|1|2> --json
   ```

   Add `--substantial`, `--round-1-head <sha>` and `--rot-checked` when the caller passes
   them. `sinceRound1` says why the state is `review-2` after a round 1 that was not
   substantial.

   A non-empty `unavailable` means a fact could not be read. Say which fact. Do not act
   on a `state` of `null`: no state at all means the command declines to name one from
   facts nobody has seen.

   `contextsFrom: "head"` is different. It means the base branch is one no ruleset
   covers, which every layer of a stack is, so the command takes the verdict over what
   has reported on the head. Say so once, and say the rest of it too: that verdict
   cannot see a check nobody has created. So `green` there means everything that
   reported is satisfying, not that the pull request would pass the default branch's
   ruleset. A layer is fully checked only once it is rebased onto a branch that has one.

2. Act on the state, then return it.

   | State | What to do |
   | --- | --- |
   | `awaiting-pr` | Nothing. GitHub said this pull request number does not exist. A read gh refused for another reason gives `state: null` instead. |
   | `merged`, `closed` | Nothing. The pull request already finished. Report the state, then return. |
   | `no-run` | No workflow run for this head. `gh pr close <n> && gh pr reopen <n>`. |
   | `review-1`, `review-2` | Step 3. CI can still run, or be red, at `review-1`: the round reads it. |
   | `fixing` | Nothing. CI is not green, or a review thread from a person is unresolved. Name the contexts that failed. A bot's own thread, review bots such as Copilot included, is named under `botThreadAuthors`. It does not hold this state: say what it is. The loop can reach `done` with such a thread still open. |
   | `rot-check` | Step 4. |
   | `done` | Step 5. |

3. Dispatch one round agent: one subagent, `general-purpose`, in the pull request's
   worktree, with the model from the rule above. Build its brief from
   [round-brief.md](round-brief.md), the round agent's whole instruction, and add
   [round-2.md](round-2.md) verbatim for round 2. Round 2's brief carries round 1's
   findings and rejected list, from the round 1 return that the caller passes. Fill in
   every placeholder the template names; a brief with a placeholder left in it is a round
   that will guess.

   Reviewers by what the diff changes, from `gh pr diff <n> --name-only`:

   | The diff changes | Reviewers |
   | --- | --- |
   | prose only | `comment-analyzer`, `code-reviewer` |
   | any code | add `silent-failure-hunter` |
   | tests, or code that should have them | add `pr-test-analyzer` |
   | a new exported type | add `type-design-analyzer` |

   Return once it is dispatched. The agent returns once, with the JSON block
   [round-brief.md](round-brief.md) asks for, as a completion notification to the
   caller. Findings under `lower_layer` are never applied here: they belong to a branch
   this round does not own.

4. Rot check. Read [rot-check.md](rot-check.md) and do what it says with the rot lists the
   rounds returned. Then post the `Rot check done.` marker.

5. Report five things: the state reached, what each round applied and rejected with its
   reason, the rot check's corrections, anything returned under `lower_layer`, and any
   thread still open under `botThreadAuthors`.
