// This file starts a grandchild, then waits. This is the shape that
// `gh-sync.py` and `gh pr checks --watch` have. In that shape, if only the
// one child this process holds is killed, its own children stay alive
// (hook-io.py:236, the comment on `kill_group`).
//
// The grandchild inherits this child's stdout. If the process group is not
// killed, the pipe stays open and the run never closes. The grandchild
// writes `<marker>.started` at once, and `<marker>.survived` after a delay.
// A test can then prove the group signal reached it: the first file must
// appear, and the second file must not.
//
// `harness/fixtures/` has no child that starts a child. It is also outside
// this layer's allowed file set. So the fixtures here live beside the suite
// that runs them (lib/process.test.ts).
import { spawn } from 'node:child_process'

const marker = process.argv[2] ?? ''
const child = spawn(process.execPath, [`${import.meta.dirname}/grandchild.ts`, marker], {
  stdio: 'inherit',
})
process.stdout.write(`spawned ${child.pid}\n`)
// This time is far past any bound a test sets. The kill is what ends this process.
setTimeout(() => {
  process.stdout.write('outlived the bound\n')
}, 60_000)
