# Apply brief (template)

Fill every `<...>` before sending. One brief per draft PR, per round. The findings list is the
brief: the review round has already run the review, read every finding against the code, and
dropped the ones that did not hold. Send only the ones that did.

---

Apply the review findings below to draft PR #<n> (`<url>`) in `<owner/repo>`. The branch is
`<branch>`, checked out in the worktree at `<absolute path>`. Work only there.

<One line saying what this pull request is: the stream id of a workstreams plan, or the round of a
field test of `<plugin:skill>` against `<target repository>`.>

Current status of the pull request:

```json
<output of ws-pr-status.py>
```

## Findings to apply

Each was produced by `/pr-review-toolkit:review-pr`, by a bot review on the PR, or by a human
reviewer, and each has been read against the code in this worktree and confirmed to hold. Apply
them in order.

1. **<one-line summary>**, `<path>:<line>`, from <review-pr's `<analyzer>` | the `<bot>` review |
   a human review comment>. <What is wrong, and what the review round confirmed when it read the
   code.> <What the fix should achieve, without prescribing the diff.>
2. ...

<If a finding must land before or after another, say so here. Otherwise delete this line.>

<If this pull request exists because a field test found behaviour no spec covered, say so here:
a change to behaviour without the fixture that would have caught it is incomplete, so where a
finding names one, add it. Otherwise delete this paragraph.>

## Procedure

1. Apply each finding as a focused commit, following the repository's commit convention.
2. A finding you find does not apply after all is reported under `rejected` with a one-line
   reason, not silently skipped, and is not a reason to stop on the rest.
3. Run `<test command>` before pushing. Never use `--no-verify`, never force-push.
4. If what you applied made the PR title or body inaccurate, update them with `gh pr edit` so the
   description says what the diff now does.
5. Do not run `/pr-review-toolkit:review-pr`, do not add findings of your own, do not mark the PR
   ready, do not merge, do not resolve review threads left by a human or a bot, and do not reply
   to them: the round that dispatched you replies with the outcome once you return.

## Return

End your reply with exactly one fenced JSON block:

```json
{
  "pr": <n>,
  "applied": [<the numbers of the findings above that you applied>],
  "rejected": [{"finding": "<one line>", "reason": "<one line>"}],
  "pushed": "<sha before your first commit>..<sha you pushed>, or null if the branch did not move>",
  "title_or_body_updated": true | false,
  "error": "<null, or what stopped you>"
}
```

`applied` is the list of numbers, not a count: the round replies on the thread each finding came
from, and it can only do that if it knows which ones landed. `pushed` is how the round measures
what the diff gained, so it must name the commit the branch was on before you touched it.
