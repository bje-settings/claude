// The one spawned contract test for `scripts/mermaid.ts` (harness/README.md):
// argv and stdin in, exit code and streams out. Everything else about this
// plugin's decisions is exercised in-process in `url.test.ts`; this is the
// only place the process boundary itself, and the floor guard placed in
// front of it, are real.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { runScript } from '../../../harness/spawn.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mermaid.ts')

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
  // Invalid UTF-8 on stdin would exit 2 if bin.ts read and url.ts decoded
  // it, so a clean exit 0 here also proves the adapter's own stdin read is
  // skipped for --help, not only url.ts's decode step (the in-process
  // version of this test in url.test.ts cannot see that half, since it
  // never touches bin.ts's readFileSync(0) at all).
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
  // Pins the ordering at the process boundary: without the wantsHelp
  // pre-scan in both bin.ts and url.ts, this would exit 2 with the --route
  // refusal instead, the way it did before this round.
  const result = runScript(BIN, { args: ['--help', '--route', 'bogus'], stdin: '' })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^mermaid\.ts \[--route /)
  expect(result.stderr).toBe('')
})
