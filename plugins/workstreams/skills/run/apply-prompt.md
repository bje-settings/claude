# Apply brief (template)

Fill every `<...>` before sending. One brief per draft PR, per round. The findings list is the
brief: the main session has already run the review, read every finding against the code, and
dropped the ones that did not hold. Send only the ones that did.

---

Apply the review findings below to draft PR #<n> (`<url>`) for stream `<id>` of a workstreams
plan in `<owner/repo>`. The branch is `<branch>`, checked out in the worktree at
`<absolute path>`. Work only there.

Current status from the run loop:

```json
<output of ws-pr-status.py>
```

## Findings to apply

Each was produced by `/pr-review-toolkit:review-pr`, by a bot review on the PR, or by a human
reviewer, and each has been read against the code in this worktree and confirmed to hold. Apply
them in order.

1. **<one-line summary>** — `<path>:<line>`, from <review-pr's `<analyzer>` | the `<bot>` review |
   a human review comment>. <What is wrong, and what the main session confirmed when it read the
   code.> <What the fix should achieve, without prescribing the diff.>
2. ...

<If a finding must land before or after another, say so here. Otherwise delete this line.>

## Procedure

1. Apply each finding as a focused commit, following the repository's commit convention.
2. A finding you find does not apply after all is reported under `rejected` with a one-line
   reason, not silently skipped, and is not a reason to stop on the rest.
3. Run `<test command>` before pushing. Never use `--no-verify`, never force-push.
4. If what you applied made the PR title or body inaccurate, update them with `gh pr edit` so the
   description says what the diff now does.
5. Do not run `/pr-review-toolkit:review-pr`, do not add findings of your own, do not mark the PR
   ready, do not merge, do not resolve review threads left by a human or a bot.

## Return

End your reply with exactly one fenced JSON block:

```json
{
  "stream": "<id>",
  "pr": <n>,
  "applied": <count of findings applied>,
  "rejected": [{"finding": "<one line>", "reason": "<one line>"}],
  "title_or_body_updated": true | false,
  "error": "<null, or what stopped you>"
}
```
