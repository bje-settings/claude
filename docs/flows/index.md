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
| [gh/shepherd/_skill-flow.md](gh/shepherd/_skill-flow.md) | What the /gh:shepherd skill does, and every way it declines to act. |
| [gh/shepherd/discover-flow.md](gh/shepherd/discover-flow.md) | How `gh.ts discover` finds the checkout roots in scope for a directory, and each way it stops. |
| [gh/shepherd/shepherd-pr-flow.md](gh/shepherd/shepherd-pr-flow.md) | How `gh.ts shepherd-pr` checks its arguments, then runs one of seven steps on one pull request, with every result it can report. |
| [gh/shepherd/shepherd-status-flow.md](gh/shepherd/shepherd-status-flow.md) | How `gh.ts shepherd-status` reads one repository's dependencies pull requests into targets and skipped rows, and each way it stops. |
| [gh/sync/_skill-flow.md](gh/sync/_skill-flow.md) | What the /gh:sync skill does, and every way it declines to act. |
| [gh/sync/sync-flow.md](gh/sync/sync-flow.md) | How `gh.ts sync` finds its checkouts, syncs each one in process, and which outcome sets its exit status. |
| [mermaid/view/_skill-flow.md](mermaid/view/_skill-flow.md) | What the /mermaid:view skill does, and every way it declines to act. |
| [workstreams/question/_skill-flow.md](workstreams/question/_skill-flow.md) | What the /workstreams:question skill does, and every way it declines to act. |
| [workstreams/question/preflight-flow.md](workstreams/question/preflight-flow.md) | What `workstreams.ts preflight` checks, which finding each gap gives, and how the findings set the exit status. |
| [workstreams/review/_skill-flow.md](workstreams/review/_skill-flow.md) | What the /workstreams:review skill does, and every way it declines to act. |
| [workstreams/review/pr-state-flow.md](workstreams/review/pr-state-flow.md) | How `workstreams.ts pr-state` reads one pull request and its checks into a verdict and a review-loop state, and each way it stops. |
| [workstreams/review/preflight-flow.md](workstreams/review/preflight-flow.md) | What `workstreams.ts preflight` checks, which finding each gap gives, and how the findings set the exit status. |
| [workstreams/stream/_skill-flow.md](workstreams/stream/_skill-flow.md) | What the /workstreams:stream skill does, and every way it declines to act. |
| [workstreams/stream/pr-state-flow.md](workstreams/stream/pr-state-flow.md) | How `workstreams.ts pr-state` reads one pull request and its checks into a verdict and a review-loop state, and each way it stops. |
| [workstreams/stream/preflight-flow.md](workstreams/stream/preflight-flow.md) | What `workstreams.ts preflight` checks, which finding each gap gives, and how the findings set the exit status. |
| [workstreams/sweep/_skill-flow.md](workstreams/sweep/_skill-flow.md) | What the /workstreams:sweep skill does, and every way it declines to act. |
| [workstreams/sweep/preflight-flow.md](workstreams/sweep/preflight-flow.md) | What `workstreams.ts preflight` checks, which finding each gap gives, and how the findings set the exit status. |
| [workstreams/sweep/sweep-flow.md](workstreams/sweep/sweep-flow.md) | How `workstreams.ts sweep` reads the tracker, puts each open issue in a tier, and when its report is short or empty. |
