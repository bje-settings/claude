// The spawn helper's own claims, against the tiny programs in
// fixtures/. Those run under node's type stripping exactly as a plugin's
// scripts/ entry point will. So this file also proves the harness can run
// a `.ts` file as a process at all.
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
  // This is the contract only bytes can show. 0xff is not valid UTF-8. A
  // helper that decoded and re-encoded on the way through would lose it.
  // A helper that decoded strictly would throw here, instead of a report.
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
// `runScript` uses `spawnSync` and drains both streams before it returns.
// So nothing run through it can lose its reader part-way through. This
// means the EPIPE guard every entry point carries cannot be tested
// through it (round 5's handoff note from #156). These four examples are
// the variant's own claims. The guards themselves are pinned beside the
// entry points that carry them.

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

it('reports a child that could not be started, when it is waited on', async () => {
  const sandbox = createSandbox()
  const running = startScript(fixture('echo-argv.ts'), { cwd: sandbox.join('gone') })

  // `spawn` reports this as an event, not a throw. So without a
  // listener, it is an uncaught exception that vitest attributes to
  // whichever example is in flight. This function rejects here, instead
  // of answering with the status of -2 that follows a failed spawn. That
  // is the same refusal `runScript` makes: a result full of empty strings
  // would read as a command that ran and said nothing.
  await expect(running.ended()).rejects.toThrow(/ENOENT/)
})

it('answers the same thing however late, and however often, it is asked', async () => {
  const running = startScript(fixture('fail.ts'))

  const first = await running.ended()

  expect(first).toEqual({ status: 3, signal: null, stderr: 'boom\n' })
  // `close` has already fired by now. A wait that subscribed to it at
  // this point would never settle. It would present as a bare suite
  // timeout, with nothing that points at the helper.
  expect(await running.ended()).toEqual(first)
})

it('survives a child that exits before it reads its stdin', async () => {
  // The write goes past the pipe buffer, so it is still in flight when
  // the child exits, and this end takes an EPIPE. Without a listener, that
  // is an uncaught exception, though all it means is that the reader
  // left.
  const running = startScript(fixture('fail.ts'), { stdin: 'x'.repeat(1 << 20) })

  expect((await running.ended()).status).toBe(3)
})

it('closes this end of the child stdout without losing the child', async () => {
  const running = startScript(fixture('fail.ts'))

  // What `| head -1` leaves behind. The child itself is still reachable, and
  // the channel a real failure has to reach is untouched.
  running.closeStdout()

  expect(running.child.pid).toBeGreaterThan(0)
  expect((await running.ended()).stderr).toContain('boom')
})

it('answers a line asked for after this end of stdout was closed', async () => {
  const running = startScript(fixture('fail.ts'))

  running.closeStdout()

  // A destroyed stream never emits `end`. So a wait that listened only
  // for that event would sit here until the suite timed out. It would
  // never report that the reader had already gone.
  expect(await running.firstLine()).toBe('')
  expect((await running.ended()).status).toBe(3)
})
