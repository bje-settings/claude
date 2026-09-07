---
name: review
description: >
  Run one review round over a draft pull request: /pr-review-toolkit:review-pr on the PR's own
  diff, plus the bot and human review threads already on it, every finding verified against the
  code in the PR's worktree, the ones that hold applied by a subagent, and a reply on every thread
  saying what happened to it. One round, no loop and no state: it returns what it applied, what it
  rejected and why, and the range it pushed. The caller decides whether another round is due.
  Used by /workstreams:run and /field-test:harden.
allowed-tools: Bash, Read, Skill, Agent
---

Invocation: `/workstreams:review <pr> --worktree <absolute path> --base <branch> [--model <alias>]`

`<pr>` is the pull request number or url, `--worktree` the checkout its branch is in, and
`--base` the branch it is stacked on (`main` for an independent stream, the layer below for a
stack). Those three are required: a review that guesses any of them reviews something else.
`--model` is optional and names the model the applier runs on; without it the applier takes the
session's default.

This skill runs in the session that invoked it, and that is the whole point of it existing.
`/pr-review-toolkit:review-pr` dispatches analyzer agents whose completion wakes the session that
dispatched them. A subagent has no such wake to receive, so a subagent running this would fall
back to a timed wait and idle for the rest of the interval after the analyzers had finished
(issue #62). Invoke it with the `Skill` tool from the main session, never from a worker.

One round. No wake is scheduled here, no state file is written here, and nothing decides whether
a second round is due: `review_rounds`, the status writes, and the round limit belong to the
caller, which is the only thing that survives between ticks.

## Step 1: Read the pull request

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.py" <pr>
```

Keep the output: `url`, `head`, and `title` fill in the apply brief, and `url` names the
`<owner>/<repo>` every command below needs. A non-zero exit ends the round now, with `error` set
to the script's message and `error_status` set to the exit code, everything else empty. The exit
code travels because the caller decides on it: 1 is a pull request that does not exist and 4 is
gh itself failing, and those are not the same answer. Which of them means what for the stream is
the caller's decision, not this round's.

Record where the branch is before anything changes it:

```bash
git -C <worktree> rev-parse HEAD
```

## Step 2: Review the diff

Invoke `/pr-review-toolkit:review-pr` with the `Skill` tool, telling it three things:

- the pull request number and `<owner>/<repo>`,
- the worktree to read the code in, since this session's own directory is very likely another
  repository entirely,
- the range to review: `<base>...HEAD`.

Naming the range matters. Left to itself the toolkit reviews the working tree's `git diff`, which
in this session is empty, and it reports a clean review of nothing at all.

## Step 3: Read what is already on the pull request

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-comments.py" <url>
```

One JSON list of every review body, issue comment, and review thread comment, each entry saying
who wrote it, whether that author is a bot, whether its thread is resolved, and which line it sits
on. A bot review or a human comment is a finding the toolkit will not produce, and one nobody else
is going to act on. Fold them into the same list as the toolkit's findings.

A comment on a resolved thread has been dealt with already; read it, but treat it as settled
unless the code says otherwise. Keep each finding's `id`: Step 6 replies to it.

## Step 4: Verify every finding against the code

A finding is a claim, not a fact, whoever made it. Open the file it names, in the worktree, and
confirm it before it goes any further. Drop a finding that is wrong, that is out of scope for the
issue the PR closes, or that contradicts the target repository's `CLAUDE.md` or rules. Keep the
reason for each one dropped: it goes in the return block and in the reply on its thread.

A finding the diff already satisfies is not one of those. A round that crashed after applying a
change and before replying leaves exactly that shape, and telling its author the finding was
rejected is wrong twice over. Report it as `already addressed at <path>`, naming where in the
diff, and reply on its thread the same way. It is neither applied by this round nor rejected.

## Step 5: Apply what held

If nothing survived, skip to Step 6 with nothing applied and nothing pushed.

Otherwise fill in `apply-prompt.md` from this directory with the surviving findings, one numbered
entry each, and start one `workstreams:applier` with the `Agent` tool, passing `model` when the
invocation named one. It does not review; it applies the list and returns once.

When it returns, take `applied`, `rejected`, `title_or_body_updated`, and `error` from its JSON
block. If `error` is set, carry it out of this round unchanged, along with whatever it did apply
first: some of the list may be committed. Then read where the branch ended up:

```bash
git -C <worktree> rev-parse HEAD
```

`pushed` is `<the sha from Step 1>..<this sha>`, computed here rather than taken on trust, or null
if the two shas are the same. The applier reports a range of its own; use it only as a cross-check,
and if the two disagree, report this one and say so in `error`: the applier may have pushed and
then committed again, and the range the caller measures has to be the one the branch actually
moved through.

Then measure the round for the caller:

```bash
git -C <worktree> diff --stat <pushed>
```

That output is `diffstat` in the return block, and null when `pushed` is null.

## Step 6: Reply on every thread that produced a finding

Every bot and human thread that contributed a finding gets one reply saying what happened to it:
applied, already addressed at the path where the diff satisfies it, or rejected with the reason.
This is the only place the round writes to the pull request,
and it happens after the apply pass so the reply says what did happen rather than what was
planned.

```bash
gh api repos/<owner>/<repo>/pulls/<pr>/comments/<id>/replies -f body="<the outcome>"
```

`<id>` is the `id` of the thread comment the finding came from. A finding from a review body or an
issue comment, which has no thread to reply into, is reported in the return block only.

Never resolve a thread. Resolving is the reviewer's judgement that the matter is closed, and it is
theirs to make, not this round's; a reply says what was done and leaves them to decide.

## Return

End the round with exactly one fenced JSON block, and nothing decided beyond it:

```json
{
  "applied": [1, 3],
  "rejected": [{"finding": "<one line>", "reason": "<one line>"}],
  "already_addressed": [{"finding": "<one line>", "where": "<path>"}],
  "pushed": "<sha before>..<sha after>",
  "diffstat": "<the git diff --stat output, or null>",
  "title_or_body_updated": true,
  "error": null,
  "error_status": null
}
```

`applied` is the numbers of the findings in the brief that landed, so the caller can name them.
`rejected` carries every finding dropped in Step 4 and every one the applier could not apply,
each with its reason. `already_addressed` carries the findings the diff already satisfied, which
are neither. `error` is what stopped the round, and null when nothing did; `error_status` is the
exit code of the script that failed, and null when the error came from somewhere without one.

`pushed` is the range the caller measures the round by, null when the branch did not move, and
`diffstat` is `git diff --stat` over it. **Substantial or cosmetic is read off that diffstat, not
off anybody's description of the round.** Substantial is a delta a reviewer reading the PR fresh
would reach different conclusions from: a file added or removed, a changed contract, or logic
moved or introduced. Wording, a comment, a renamed test, a reflowed line, or a one-line guard is
cosmetic, however many files it touches. The round does not decide which of the two it was; it
prints the evidence and the caller decides.

## Out of scope

Deciding whether another round is due, counting rounds, writing any state file, scheduling a wake,
marking a pull request ready, merging, and resolving a review thread.
