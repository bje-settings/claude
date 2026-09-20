// The one spawned contract test for `bin/mermaid.ts` (harness/README.md):
// argv and stdin in, exit code and streams out. Everything else about this
// plugin's decisions is exercised in-process in `url.test.ts`; this is the
// only place the process boundary itself, and the floor guard placed in
// front of it, are real.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { runScript } from '../../../harness/spawn.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mermaid.ts')

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
