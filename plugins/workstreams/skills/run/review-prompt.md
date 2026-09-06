# Review brief (template)

Fill every `<...>` before sending. One brief per draft PR.

---

Review draft PR #<n> (`<url>`) for stream `<id>` of a workstreams plan in `<owner/repo>`. The
branch is `<branch>`, checked out in the worktree at `<absolute path>`. Work only there.

Current status from the run loop:

```json
<output of ws-pr-status.py>
```

## Procedure

1. Invoke `/pr-review-toolkit:review-pr` on PR #<n>.
2. For every finding it produces, open the code it points at and decide whether it holds. A
   finding is a claim, not a fact. Reject a finding that is wrong, that is out of scope for the
   issue this PR closes, or that contradicts the repository's `CLAUDE.md` or rules.
3. Apply each finding that holds as a focused commit, following the repository's commit
   convention. Run `<test command>` before pushing. Never use `--no-verify`, never force-push.
4. If the applied changes made the PR title or body inaccurate, update them with `gh pr edit` so
   the description says what the diff now does.
5. Do not mark the PR ready, do not merge, do not resolve review threads left by humans.

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
