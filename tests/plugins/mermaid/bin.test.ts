// The one spawned contract test for `scripts/mermaid.ts` (harness/README.md):
// argv and stdin in, exit code and streams out. Everything else about this
// plugin's decisions is exercised in-process in `url.test.ts`. This is the
// only place the process boundary itself, and the floor guard in front of
// it, are real.
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'

import { runScript } from '#harness/spawn.ts'

const BIN = pluginFile('mermaid', 'scripts', 'mermaid.ts')

const DIAGRAM = 'graph TD; A-->B'

it('runs as a real process and prints a view URL on stdout', () => {
  const result = runScript(BIN, { args: ['--route', 'view'], stdin: DIAGRAM })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^https:\/\/mermaid\.live\/view#pako:.+\n$/)
  expect(result.stderr).toBe('')
})

it('exits 2 with the reason on stderr and nothing on stdout, for empty stdin', () => {
  const result = runScript(BIN, { args: ['--route', 'view'], stdin: '' })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('no diagram source on stdin\n')
})

it('exits 2 for invalid UTF-8 on stdin, read as bytes rather than decoded text', () => {
  const invalid = Uint8Array.from([0x61, 0xff, 0x62])

  const result = runScript(BIN, { args: ['--route', 'view'], stdin: invalid })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('diagram source is not valid UTF-8\n')
})

it('defaults to --route view with no --route flag at all, as a real process', () => {
  const result = runScript(BIN, { args: [], stdin: DIAGRAM })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^https:\/\/mermaid\.live\/view#pako:.+\n$/)
})

it('answers --help as a real process, exit 0, and never decodes stdin', () => {
  // Invalid UTF-8 on stdin would exit 2, if bin.ts read it and url.ts
  // decoded it. So a clean exit 0 here proves something more. The adapter
  // also skips its own stdin read for --help, not only url.ts's decode
  // step. The in-process version of this test, in url.test.ts, cannot see
  // that half. It never touches bin.ts's readFileSync(0) at all.
  const invalid = Uint8Array.from([0x61, 0xff, 0x62])

  const result = runScript(BIN, { args: ['--help'], stdin: invalid })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^mermaid\.ts \[--route /)
  expect(result.stderr).toBe('')
})

it('answers -h the same way --help does, as a real process', () => {
  const result = runScript(BIN, { args: ['-h'], stdin: '' })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^mermaid\.ts \[--route /)
})

it('answers --help over a bad --route, as a real process, not the route refusal', () => {
  // This pins the ordering at the process boundary. Without the wantsHelp
  // pre-scan in both bin.ts and url.ts, this would exit 2 with the --route
  // refusal instead. That is how it behaved before this round.
  const result = runScript(BIN, { args: ['--help', '--route', 'bogus'], stdin: '' })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^mermaid\.ts \[--route /)
  expect(result.stderr).toBe('')
})
