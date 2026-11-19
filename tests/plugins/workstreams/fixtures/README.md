# fixtures

## `sweep-capture-2026-11.json`

Every child process `createGhClient` started while it answered the sweep's reads,
recorded on 2026-11-18 against `bje-settings/claude` itself. Each call's argv, exit
status, and stdout are exactly as `gh` printed them. The real client produced it, with a
recording runner wrapped around `lib/process.ts`. So the argv in it is the argv the
shipped code builds, and the bodies are GitHub's own, not a hand-written approximation of
either.

The reads sit in the file in this order: `listMilestones()`,
`listIssues({ milestone: '4' })`, `listIssues({ milestone: '7' })`, `listIssues()`, and
`listOpenPullRequests()`. A `gh repo view` call comes before each one; every GraphQL
endpoint makes that call to resolve the owner and name. That is the order the client was
driven in when it recorded them, not the order `sweep.ts` asks in. The replay matches a
call by its argv, so neither the order nor the number of calls has to agree.

`listOpenPullRequests()` asks for each pull request's files (#526). The one open pull
request was #527, the draft of that change, with one changed file at that time.

`sweep.test.ts` replays it by argv, with a runner that answers a recorded call with its
recorded stdout, and throws on an argv that was never recorded. That is what makes the
acceptance case a test of this repository's real tracker state, rather than of a fixture
someone wrote to pass.

It is never edited. Its enclosing whitespace is Biome's: Biome reformatted the wrapper
before the commit that added it. Every byte GitHub and `gh` produced sits inside the
`stdout` strings, where a formatter does not reach.

The sets it is checked against come from the capture's own `blockedBy` edges (#195). No
test writes them by hand. Milestone 7 holds the chain #402, #403, #404: #404 is behind
#403 alone, and #403 is behind #402. So #404 is blocked, and #402 unlocks #403 only.

A tracker change that would alter those sets is a reason to take a new capture under a
new name, not to edit this one. An edited capture proves nothing about what the API
answers.

## `sweep-capture.json` (removed)

The first capture, recorded on 2026-09-21. #526 removed it. Its `listOpenPullRequests`
argv has no `files` connection, so no replay of the current query can match it.
