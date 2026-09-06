# Review brief (template)

Fill every `<...>` before sending. One brief per draft PR. Same contract as the workstreams
review pass, on purpose: it is the same reviewer agent, and a second dialect of the same JSON
would be one more thing to keep in step.

---

Review draft PR #<n> (`<url>`) in `<owner/repo>`. It fixes the findings of a field test of
`<plugin:skill>` run against `<target repository, or "a repository outside the enterprise">`. The
branch is `<branch>`, checked out in the worktree at `<absolute path>`. Work only there.

Current status from the loop:

```json
<output of gh pr view <n> --repo <owner/repo> --json number,state,isDraft,mergeable,statusCheckRollup>
```

## Procedure

1. Invoke `/pr-review-toolkit:review-pr` on PR #<n>.
2. For every finding it produces, open the code it points at and decide whether it holds. A
   finding is a claim, not a fact. Reject a finding that is wrong, that is out of scope for the
   issues this PR closes, or that contradicts the repository's `CLAUDE.md` or rules.
3. Pay particular attention to the specs. This pull request exists because a field test found
   behaviour no spec covered, so a fix that changes behaviour without adding the fixture that
   would have caught it is incomplete, whatever the review toolkit says.
4. Apply each finding that holds as a focused commit, following the repository's commit
   convention. Run `<test command>` before pushing. Never use `--no-verify`, never force-push.
5. If the applied changes made the PR title or body inaccurate, update them with `gh pr edit`.
6. Do not mark the PR ready, do not merge, do not resolve review threads left by humans.

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
