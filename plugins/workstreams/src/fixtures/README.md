# fixtures

## `sweep-capture.json`

Every child process `createGhClient` started while it answered the sweep's four reads,
recorded on 2026-09-21 against `bje-settings/claude` itself. Each call's argv, exit
status, and stdout are exactly as `gh` printed them. The real client produced it, with a
recording runner wrapped around `lib/process.ts`. So the argv in it is the argv the
shipped code builds, and the bodies are GitHub's own, not a hand-written approximation of
either.

The four reads sit in the file in this order: `listMilestones()`,
`listIssues({ milestone: '4' })`, `listIssues()`, and `listOpenPullRequests()`. A
`gh repo view` call comes before each one; every GraphQL endpoint makes that call to
resolve the owner and name. That is the order the client was driven in when it recorded
them, not the order `sweep.ts` asks in. The replay matches a call by its argv, so neither
the order nor the number of calls has to agree.

`sweep.test.ts` replays it by argv, with a runner that answers a recorded call with its
recorded stdout, and throws on an argv that was never recorded. That is what makes the
acceptance case a test of this repository's real tracker state, rather than of a fixture
someone wrote to pass.

It is never edited. Its enclosing whitespace is Biome's: Biome reformatted the wrapper on
the commit that added it. Every byte GitHub and `gh` produced sits inside the `stdout`
strings, where a formatter does not reach. The sets it is checked against are round 8's
hand sweep of milestone 4: unblocked #111 (no blockers at all), #130, and #133; next tier
#18, #96, #100, #101, #131, and #132; and #98, #102, #134, and #135, behind blockers that
are not yet reachable. A tracker change that would alter those sets is a reason to take a
new capture under a new name, not to edit this one. An edited capture proves nothing about
what the API answers.
