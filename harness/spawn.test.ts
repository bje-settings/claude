// The spawn helper's own claims, against the tiny programs in fixtures/.
// Those run under node's type stripping exactly as a plugin's bin/ entry point
// will, so this file also proves the harness can run a `.ts` file as a process
// at all.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createSandbox } from './sandbox.ts'
import { runScript, startScript } from './spawn.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): string => path.join(FIXTURES, name)

it('runs a TypeScript entry point and hands back its argv', () => {
  const result = runScript(fixture('echo-argv.ts'), { args: ['--repo', 'acme/widgets'] })

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['--repo', 'acme/widgets'])
  expect(result.stderr).toBe('')
})

it('runs an entry point with no arguments at all', () => {
  const result = runScript(fixture('echo-argv.ts'))

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([])
})

it('passes text on stdin through unchanged', () => {
  const result = runScript(fixture('echo-stdin.ts'), { stdin: 'hello\n' })

  expect(result.stdout).toBe('hello\n')
})

it('passes bytes on stdin through unchanged, and decodes with replacement', () => {
  // The contract only bytes can show: 0xff is not valid UTF-8, so a helper
  // that decoded and re-encoded on the way through would lose it, and a
  // helper that decoded strictly would throw here instead of reporting.
  const invalid = Uint8Array.from([0x61, 0xff, 0x62])

  const result = runScript(fixture('echo-stdin.ts'), { stdin: invalid })

  expect(Uint8Array.from(result.stdoutBytes)).toEqual(invalid)
  expect(result.stdout).toBe('a�b')
})

it('keeps stderr and the exit status of a command that fails', () => {
  const result = runScript(fixture('fail.ts'))

  expect(result.status).toBe(3)
  expect(result.stdout).toBe('partial\n')
  expect(result.stderr).toBe('boom\n')
  expect(result.stderrBytes.toString('utf8')).toBe('boom\n')
})

it('runs the child from the directory and environment it is given', () => {
  const sandbox = createSandbox()

  const result = runScript(fixture('where.ts'), { env: sandbox.env, cwd: sandbox.path })

  // realpath because macOS puts the temp directory behind a /var symlink and
  // the child reports where it actually is.
  expect(result.stdout).toBe(`${realpathSync(sandbox.path)}\n${sandbox.env.HOME}\n`)
})

it('throws when the child could not be started', () => {
  // A result full of empty strings would read as a command that ran and said
  // nothing, which is the silent pass this harness exists to refuse.
  const sandbox = createSandbox()

  expect(() => runScript(fixture('echo-argv.ts'), { cwd: sandbox.join('gone') })).toThrow(/ENOENT/)
})

// --- startScript, the variant whose pipes are still open ----------------------
//
// `runScript` is `spawnSync` and drains both streams before it returns, so
// nothing run through it can have its reader taken away part-way: the EPIPE
// guard every entry point carries is unpinnable through it (round 5's handoff
// note from #156). These four examples are the variant's own claims; the
// guards themselves are pinned beside the entry points that carry them.

it('hands back the first line a running child writes', async () => {
  const sandbox = createSandbox()
  const running = startScript(fixture('where.ts'), { env: sandbox.env, cwd: sandbox.path })

  const first = await running.firstLine()

  expect(first).toBe(realpathSync(sandbox.path))
  expect((await running.ended()).status).toBe(0)
})

it('hands back everything a child wrote when it never wrote a newline', async () => {
  const running = startScript(fixture('echo-argv.ts'), { args: ['--repo', 'acme/widgets'] })

  const first = await running.firstLine()

  expect(JSON.parse(first)).toEqual(['--repo', 'acme/widgets'])
})

it('runs with no options at all, and reports the status and stderr', async () => {
  const running = startScript(fixture('fail.ts'))

  expect(await running.firstLine()).toBe('partial')
  expect(await running.ended()).toEqual({ status: 3, signal: null, stderr: 'boom\n' })
})

it('closes this end of the child stdout without losing the child', async () => {
  const running = startScript(fixture('fail.ts'))

  // What `| head -1` leaves behind. The child itself is still reachable, and
  // the channel a real failure has to reach is untouched.
  running.closeStdout()

  expect(running.child.pid).toBeGreaterThan(0)
  expect((await running.ended()).stderr).toContain('boom')
})
