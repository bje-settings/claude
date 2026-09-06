# Apply brief (template)

Fill every `<...>` before sending. One brief per draft PR, per round. Same contract as the
workstreams apply pass, on purpose: it is the same `workstreams:applier` agent, and a second
dialect of the same JSON would be one more thing to keep in step. The review has already
happened in the main session; this brief carries only the findings that survived it.

---

Apply the review findings below to draft PR #<n> (`<url>`) in `<owner/repo>`. It fixes the
findings of a field test of `<plugin:skill>` run against
`<target repository, or "a repository outside the enterprise">`. The branch is `<branch>`,
checked out in the worktree at `<absolute path>`. Work only there.

Current status from the loop:

```json
<output of gh pr view <n> --repo <owner/repo> --json number,state,isDraft,mergeable,statusCheckRollup>
```

## Findings to apply

Each was produced by `/pr-review-toolkit:review-pr`, by a bot review on the PR, or by a human
reviewer, and each has been read against the code in this worktree and confirmed to hold. Apply
them in order.

1. **<one-line summary>** — `<path>:<line>`, from <review-pr's `<analyzer>` | the `<bot>` review |
   a human review comment>. <What is wrong, and what the main session confirmed when it read the
   code.> <What the fix should achieve, without prescribing the diff.>
2. ...

## Procedure

1. Apply each finding as a focused commit, following the repository's commit convention.
2. This pull request exists because a field test found behaviour no spec covered, so a change to
   behaviour without the fixture that would have caught it is incomplete. Where a finding names
   one, add it.
3. A finding you find does not apply after all is reported under `rejected` with a one-line
   reason, not silently skipped, and is not a reason to stop on the rest.
4. Run `<test command>` before pushing. Never use `--no-verify`, never force-push.
5. If what you applied made the PR title or body inaccurate, update them with `gh pr edit`.
6. Do not run `/pr-review-toolkit:review-pr`, do not add findings of your own, do not mark the PR
   ready, do not merge, do not resolve review threads left by a human or a bot.

## Return

End your reply with exactly one fenced JSON block:

```json
{
  "stream": "<plugin:skill>@<target>",
  "pr": <n>,
  "applied": <count of findings applied>,
  "rejected": [{"finding": "<one line>", "reason": "<one line>"}],
  "title_or_body_updated": true | false,
  "error": "<null, or what stopped you>"
}
```
