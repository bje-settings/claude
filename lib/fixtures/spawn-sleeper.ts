// Starts a grandchild and then waits: the shape `gh-sync.py` and
// `gh pr checks --watch` have, where killing the one child this process holds
// would leave its own children running (hook-io.py:236, the comment on
// `kill_group`).
//
// The grandchild inherits this child's stdout, so if the process group is not
// killed the pipe stays open and the run never closes. It writes
// `<marker>.started` at once and `<marker>.survived` after a delay, so a test
// can prove the group signal reached it: the first file must appear, the
// second must not.
//
// `harness/fixtures/` has no child that starts a child, and it is outside
// this layer's allowed file set, so the fixtures here live beside the suite
// that runs them (lib/process.test.ts).
import { spawn } from 'node:child_process'

const marker = process.argv[2] ?? ''
const child = spawn(process.execPath, [`${import.meta.dirname}/grandchild.ts`, marker], {
  stdio: 'inherit',
})
process.stdout.write(`spawned ${child.pid}\n`)
// Far past any bound a test sets: the kill is what ends this process.
setTimeout(() => {
  process.stdout.write('outlived the bound\n')
}, 60_000)
