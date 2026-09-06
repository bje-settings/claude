# Fix brief (template)

Fill every `<...>` before sending. One brief per field-test round: all of that round's issues, one
pull request.

---

You are fixing the findings of one field test of `<plugin:skill>`, run against
`<target repository path>`. The plugin's own repository is `<owner/repo>`, checked out at
`<absolute path of the root checkout>`.

## Conventions you must follow

Quoted from the plugin repository's `CLAUDE.md` and `.claude/rules/`; read those files yourself
before starting and treat them as authoritative over this brief.

- Branch name: `<pattern; for example wktr-N-two-words>`
- Worktree location: `<path pattern>`, created with `git worktree add PATH -b BRANCH` from
  `<base branch>`. Never edit the root checkout.
- After creating the worktree: `<dependency install command, or "no install needed">`
- Commit messages: `<convention>`. Never use `--no-verify`.
- Tests to run before opening the PR: `<command>`

## The findings

<One section per issue: its number, its title, and the reproduction it carries. The issues were
written by the field test from recorded events, so the command, the exit code, and the sequence
leading to it are already in them; do not re-derive them.>

## What a fix has to include

Each finding needs both halves:

1. The change that makes the behaviour right.
2. A fixture and a spec that would have caught it, built from the shape the issue describes.
   `<the repository's rule for this; for example: assert against real repositories built by the
   fixtures rather than mocking, and where the logic is in jq, add the branch's own fixture and
   verify it by mutation.>`

A finding you conclude is not a bug is a finding to say so about, in the pull request body, with
the reason. Do not close the issue yourself.

<If this is a retry after a mechanical CI failure: quote the failing job and its output here, say
that the previous attempt's commits are already on the branch, and ask for a fix on top rather
than a rewrite.>

## Finishing

1. Run the tests named above. Fix what you broke; do not disable a test to get green.
2. Push the branch and open a **draft** PR with `gh pr create --draft`, title in the repository's
   commit convention, body describing the change, how it was tested, and `Closes #<n>` for every
   issue of the round.
3. Do not mark the PR ready, do not merge, do not run a review: the loop does that.

If you reach a decision you cannot make from the issues, the code, and the conventions, stop.
Commit what you have, do not open the PR, and return `paused` with the exact question. If the
findings plainly do not fit one pull request, that is one of those decisions.

## Return

End your reply with exactly one fenced JSON block:

```json
{
  "stream": "<plugin:skill>@<target>",
  "status": "draft | paused | failed",
  "branch": "<branch>",
  "worktree": "<absolute path>",
  "pr": <number, or null if none opened>,
  "question": "<the decision you need, or the error, or null>"
}
```
