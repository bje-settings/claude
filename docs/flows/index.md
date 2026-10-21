---
okf_version: "0.2"
---

# Flow index

One directory per skill, `<plugin>/<skill>/`. `_skill-flow.md` is the flow of the skill. Each
`<subcommand>-flow.md` is the flow of one dispatcher subcommand that the skill runs.

| Doc | Description |
|-----|-------------|
| [audit/context/_skill-flow.md](audit/context/_skill-flow.md) | What the /audit:context skill does, and every way it declines to act. |
| [audit/context/context-flow.md](audit/context/context-flow.md) | How `audit.ts context` checks its arguments and checkout, runs tier 0 and the model stages, and which outcome sets its exit status. |
| [gh/issues/_skill-flow.md](gh/issues/_skill-flow.md) | What the gh:issues skill does for each operation, and every way it declines to act. |
| [gh/shepherd/_skill-flow.md](gh/shepherd/_skill-flow.md) | What the /gh:shepherd skill does for auto-merge pull requests and stacks, and every way it declines to act, given an optional label. |
| [gh/shepherd/discover-flow.md](gh/shepherd/discover-flow.md) | How `gh.ts discover` finds the checkout roots in scope for a directory, and each way it stops. |
| [gh/shepherd/shepherd-pr-flow.md](gh/shepherd/shepherd-pr-flow.md) | How `gh.ts shepherd-pr` checks its arguments, then runs one of six steps on one pull request. It reports every result. |
| [gh/shepherd/shepherd-status-flow.md](gh/shepherd/shepherd-status-flow.md) | How `gh.ts shepherd-status` reads one repository's open, auto-merge pull requests and its stacks into targets and a not-ready list, one label at most. It also shows each way it stops. |
| [gh/shepherd/shepherd-stack-flow.md](gh/shepherd/shepherd-stack-flow.md) | How `gh.ts shepherd-stack` checks its arguments, then runs one of four steps on one GitHub stack, layer by layer, bottom first. It reports every result. |
| [gh/sync/_skill-flow.md](gh/sync/_skill-flow.md) | What the /gh:sync skill does, and every way it declines to act. |
| [gh/sync/sync-flow.md](gh/sync/sync-flow.md) | How `gh.ts sync` finds its checkouts, syncs each one in process, and which outcome sets its exit status. |
| [mermaid/view/_skill-flow.md](mermaid/view/_skill-flow.md) | What the /mermaid:view skill does, and every way it declines to act. |
| [workstreams/question/_skill-flow.md](workstreams/question/_skill-flow.md) | What the /workstreams:question skill does, and every way it declines to act. |
| [workstreams/question/rounds-flow.md](workstreams/question/rounds-flow.md) | How `workstreams.ts rounds` finds the rounds in flight from their plan comments, scopes them, and when its answer is short. |
| [workstreams/review/_skill-flow.md](workstreams/review/_skill-flow.md) | What the /workstreams:review skill does in one step, and every way it declines to act. |
| [workstreams/review/mark-flow.md](workstreams/review/mark-flow.md) | How `workstreams.ts mark` checks its arguments, finds the head, and writes one `workstreams/<name>` commit status, and each way it stops. |
| [workstreams/review/pr-state-flow.md](workstreams/review/pr-state-flow.md) | How `workstreams.ts pr-state` reads one pull request and its checks into a verdict and a review-loop state, and each way it stops. |
| [workstreams/start/_skill-flow.md](workstreams/start/_skill-flow.md) | What the /workstreams:start skill does on each call and each wake, and every way it stops. |
| [workstreams/start/intersect-flow.md](workstreams/start/intersect-flow.md) | How `workstreams.ts intersect` reads each open pull request's head against the default branch and against the other heads, and each way it stops or reports a fact as unread. |
| [workstreams/start/mark-flow.md](workstreams/start/mark-flow.md) | How `workstreams.ts mark` checks its arguments, finds the head, and writes one `workstreams/<name>` commit status, and each way it stops. |
| [workstreams/start/pr-state-flow.md](workstreams/start/pr-state-flow.md) | How `workstreams.ts pr-state` reads one pull request and its checks into a verdict and a review-loop state, and each way it stops. |
| [workstreams/start/rounds-flow.md](workstreams/start/rounds-flow.md) | How `workstreams.ts rounds` finds the rounds in flight from their plan comments, scopes them, and when its answer is short. |
| [workstreams/start/watch-flow.md](workstreams/start/watch-flow.md) | How `workstreams.ts watch` polls each open pull request and writes one line for each event, and each way it stops or goes quiet. |
| [workstreams/stream/_skill-flow.md](workstreams/stream/_skill-flow.md) | What the /workstreams:stream skill does in one step, and every way it declines to act. |
| [workstreams/stream/mark-flow.md](workstreams/stream/mark-flow.md) | How `workstreams.ts mark` checks its arguments, finds the head, and writes one `workstreams/<name>` commit status, and each way it stops. |
| [workstreams/sweep/_skill-flow.md](workstreams/sweep/_skill-flow.md) | What the /workstreams:sweep skill does, and every way it declines to act. |
| [workstreams/sweep/sweep-flow.md](workstreams/sweep/sweep-flow.md) | How `workstreams.ts sweep` reads the tracker, puts each open issue in a tier, and when its report is short or empty. |
