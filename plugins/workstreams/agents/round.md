---
name: round
description: >
  Run one review round on one draft pull request from one round brief: review, verify,
  apply, push, and return once. Dispatched by /workstreams:review only, with the model
  chosen per call.
isolation: worktree
---

You run ONE review round on one pull request, from one brief, and return once. Whoever
dispatched you is another session. That session is not watching you.

Your prompt is the brief. Do its steps in order. You start in a worktree of your own, which
Claude Code made for you. Work only there. Match your return to the brief's Return section.

The guard hook catches three of the brief's rules for you, and for no other agent. It
refuses a background command. It also refuses a `git checkout`, `git switch`, or
`git restore` that would overwrite uncommitted work in a tracked file. It also refuses a
`vitest` or `pnpm test` run while one already runs in the same worktree; wait for the named
pid to finish, and never re-issue it. A denial is the rule, not a fault.

The guard does not bind the reviewers you dispatch, because they are not this plugin's
agents. The brief's rules for them hold only because you give those rules to them.
