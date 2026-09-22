# fixtures

## `sweep-capture.json`

Every child process `createGhClient` started while answering the four reads the sweep makes,
recorded on 2026-09-21 against `bje-settings/claude` itself, with each call's argv, exit status
and stdout exactly as `gh` printed them. It was produced by the real client with a recording
runner wrapped around `lib/process.ts`, so the argv in it is the argv the shipped code builds and
the bodies are GitHub's own, not a hand-written approximation of either.

The four reads, in the order they appear: `listMilestones()`, `listIssues({ milestone: '4' })`,
`listIssues()` and `listOpenPullRequests()`. Each is preceded by the `gh repo view` call every
GraphQL endpoint makes to resolve the owner and name.

`sweep.test.ts` replays it by argv: a runner that answers a recorded call with its recorded
stdout, and throws on an argv that was never recorded. That is what makes the acceptance case a
test of this repository's real tracker state rather than of a fixture someone wrote to pass.

It is never edited. Its enclosing whitespace is Biome's, which reformatted the wrapper on the
commit that added it; every byte GitHub and `gh` produced is inside the `stdout` strings, where a
formatter does not reach. The sets it is asserted against are round 8's hand sweep of milestone 4:
unblocked #111 (no blockers at all), #130 and #133; next tier #18, #96, #100, #101, #131 and
#132; and #98, #102, #134 and #135 behind blockers that are not yet reachable. A tracker change
that would alter those sets is a reason to take a new capture under a new name, not to edit this
one: an edited capture proves nothing about what the API answers.
