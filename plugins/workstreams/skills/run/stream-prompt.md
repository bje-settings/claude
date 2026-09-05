# Stream brief (template)

Fill every `<...>` before sending. One brief per independent stream; one brief per stack listing
every layer bottom-up.

---

You are working stream `<id>` of a workstreams plan for `<owner/repo>`, checked out at
`<absolute path of the root checkout>`.

## Conventions you must follow

Quoted from the repository's `CLAUDE.md` and `.claude/rules/`; read those files yourself before
starting and treat them as authoritative over this brief.

- Branch name: `<pattern, e.g. wktr-<issue>-<one-to-three-words>>`
- Worktree location: `<path pattern, e.g. .claude/worktrees/<branch>>`, created with
  `git worktree add <path> -b <branch>` from `<base branch>`. Never edit the root checkout.
- After creating the worktree: `<dependency install command, or "no install needed">`
- Commit messages: `<convention, e.g. Conventional Commits, brief>`. Never use `--no-verify`.
- Tests to run before opening the PR: `<command>`

## The work

<For an independent stream: one section. For a stack: one section per layer, bottom-up.>

### Layer 1 (bottom) — issue #<n>: <title>

Base branch: `<default branch>`.

<The issue body's substance, the files and regions the plan says it touches, and any decision
the plan already made for it. Do not widen the scope: anything the issue does not ask for is out.>

### Layer 2 — issue #<n>: <title>

Base branch: `<layer 1 branch>`. Use `gh stack` to create this branch on top of layer 1 and to
open its PR with the right base; the `gh-stack` skill describes the commands.

<...>

## Cross-repo dependency

<None, or: what has to land in `<other repo>` first, and what to do if it has not.>

## Finishing

1. Run the tests named above. Fix what you broke; do not disable a test to get green.
2. Push the branch and open a **draft** PR with `gh pr create --draft`, title in the repo's commit
   convention, body describing the change, how it was tested, and `Closes #<n>`. For a stack, one
   PR per layer, each based on the layer below.
3. Do not mark the PR ready, do not merge, do not run a review: the run loop does that.

If you reach a decision you cannot make from the issue, the code, and the conventions, stop.
Commit what you have, do not open the PR, and return `paused` with the exact question.

## Return

End your reply with exactly one fenced JSON block:

```json
{
  "stream": "<id>",
  "status": "draft | paused | failed",
  "branch": "<branch, or for a stack the top branch>",
  "worktree": "<absolute path>",
  "pr": <number, or for a stack the bottom PR number, or null>,
  "prs": [<every PR number bottom-up, for a stack>],
  "question": "<the decision you need, or the error, or null>"
}
```
