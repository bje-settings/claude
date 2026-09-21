// The runner's own claims, every one of them against a real child. There is
// no spawn seam here on purpose: this is the file where the process boundary
// is the subject, and a stand-in for `spawn` would prove only that the
// stand-in was called (ADR 001, RFC 001 "The testing seam", which puts the
// one spawned contract test exactly where the boundary is real).
//
// The children are `process.execPath` over a fixture, the same choice
// `harness/spawn.ts` makes and for the same reason: the interpreter running
// this suite is the interpreter under test, so a run on the 22.18 leg
// genuinely exercises 22.18. `harness/fixtures/` supplies the four that
// already exist; `lib/fixtures/` supplies the three it has no equivalent of
// (a child that sleeps, a child that starts a child, a child that exits
// before reading its stdin), because `harness/fixtures/` is outside this
// layer's allowed file set.
//
// Every bound is generous where the test says it did NOT fire and tiny where
// it says it did, so a loaded CI runner can be slow without being wrong.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createSandbox } from '../harness/sandbox.ts'
import { killGroup, run } from './process.ts'

const HARNESS_FIXTURES = `${import.meta.dirname}/../harness/fixtures`
const FIXTURES = `${import.meta.dirname}/fixtures`

/** A bound no correct run can reach on any runner. */
const GENEROUS_MS = 120_000
/** A bound a child that sleeps for a minute always overruns. */
const TINY_MS = 250

const node = (fixture: string, args: string[] = [], options = {}) =>
  run(process.execPath, [fixture, ...args], options)

it('answers with the status and both streams of a child that ran', async () => {
  const result = await node(`${HARNESS_FIXTURES}/fail.ts`)

  expect(result.status).toBe(3)
  expect(result.signal).toBeNull()
  expect(result.stdout).toBe('partial\n')
  expect(result.stderr).toBe('boom\n')
  expect(result.startFailure).toBeNull()
  expect(result.timedOut).toBe(false)
})

it('answers with both streams interleaved, for a caller that wants one transcript', async () => {
  // The port of `stderr=subprocess.STDOUT` (`lib/install.py:56`), which is
  // read as one block and taken the last line of.
  const result = await node(`${HARNESS_FIXTURES}/fail.ts`)

  expect(result.combined).toContain('partial\n')
  expect(result.combined).toContain('boom\n')
  expect(result.combined.length).toBe(result.stdout.length + result.stderr.length)
})

it('hands the child its arguments unchanged, with no shell between', async () => {
  // A shell would re-read the semicolon and the quotes as its own.
  const awkward = ['a b; rm -rf /', '"quoted"', '✓']
  const result = await node(`${HARNESS_FIXTURES}/echo-argv.ts`, awkward)

  expect(JSON.parse(result.stdout)).toEqual(awkward)
})

it('runs the child where it was told to, with the environment it was given', async () => {
  const sandbox = createSandbox()
  const where = sandbox.join('elsewhere')
  mkdirSync(where)

  const result = await node(`${HARNESS_FIXTURES}/where.ts`, [], {
    cwd: where,
    env: { ...sandbox.env, HOME: sandbox.join('home') },
  })

  const [cwd, home] = result.stdout.split('\n')
  // Resolved on both sides: node reports the child's own cwd resolved, and on
  // macOS the sandbox sits under /var, which is a symlink to /private/var.
  expect(cwd).toBe(realpathSync(where))
  expect(home).toBe(sandbox.join('home'))
})

it('writes what it was given to the child and closes the pipe', async () => {
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`, [], { stdin: 'piped in' })

  expect(result.stdout).toBe('piped in')
})

it('closes stdin on a child that was given none, rather than leaving it open', async () => {
  // Left open, a child that reads stdin waits for a writer that will never
  // arrive, which in a SessionStart hook is a session that never starts.
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`)

  expect(result.stdout).toBe('')
  expect(result.status).toBe(0)
})

it('decodes output with replacement rather than failing on a stray byte', async () => {
  // `decode("utf-8", "replace")`, which every ported script does: one byte
  // costs one character, never the whole answer.
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`, [], {
    stdin: new Uint8Array([0xff, 0x41]),
  })

  expect(result.stdout).toBe('�A')
})

it('survives a child that exits before reading the stdin it was given', async () => {
  // The write fails with EPIPE, asynchronously, on a stream whose error event
  // would otherwise take this whole process down while the child's status is
  // already in hand. Larger than any pipe buffer, so the write cannot land
  // before the child is gone.
  const result = await node(`${FIXTURES}/exit-now.ts`, [], { stdin: 'x'.repeat(8 * 1024 * 1024) })

  expect(result.status).toBe(0)
  expect(result.startFailure).toBeNull()
})

it('reports a command that is not there as 127, the way a shell does', async () => {
  const result = await run('definitely-not-a-command-127')

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.status).toBe(127)
  expect(result.stdout).toBe('')
})

it('reports a command that is there and cannot be run as 126', async () => {
  // `lib/install.py:64` to `71`: "command not found" for this one sends the
  // reader looking for the wrong thing.
  const sandbox = createSandbox()
  const notExecutable = sandbox.join('tool')
  writeFileSync(notExecutable, '#!/bin/sh\necho hi\n', { mode: 0o644 })

  const result = await run(notExecutable)

  expect(result.startFailure?.code).toBe('EACCES')
  expect(result.status).toBe(126)
})

it('answers rather than rejecting when node refuses the argv outright', async () => {
  // `spawn` reports most failures on the `error` event, but it validates argv
  // synchronously and throws a TypeError for a NUL byte. Thrown inside the
  // promise executor that is a rejection, and "never rejects" is the contract
  // every caller in `gh.ts` and `git.ts` is written against: not one of them
  // has a `try`, so a rejection would surface as a node-internals stack trace
  // out of a helper whose whole documented answer is `null`.
  const result = await run('git', ['rev-parse\u0000--show-toplevel'])

  expect(result.startFailure?.code).toBe('ERR_INVALID_ARG_VALUE')
  // 126, not 127: the command is on PATH, this is not a form of it that runs.
  expect(result.status).toBe(126)
  expect(result.stdout).toBe('')
  expect(result.timedOut).toBe(false)
})

it('reports a working directory that is not there as a failure to start', async () => {
  const sandbox = createSandbox()

  const result = await node(`${HARNESS_FIXTURES}/echo-argv.ts`, [], {
    cwd: sandbox.join('never-created'),
  })

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.startFailure?.message).toContain('spawn')
})

it('leaves a child that finishes inside its bound alone', async () => {
  const result = await node(`${FIXTURES}/sleep.ts`, ['10'], { timeoutMs: GENEROUS_MS })

  expect(result.timedOut).toBe(false)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('finished\n')
})

it('kills a child that outlives its bound and says the bound fired', async () => {
  const result = await node(`${FIXTURES}/sleep.ts`, ['600000'], { timeoutMs: TINY_MS })

  expect(result.timedOut).toBe(true)
  // A killed child has no status of its own; the signal is what happened.
  expect(result.status).toBeNull()
  expect(result.signal).toBe('SIGKILL')
  expect(result.stdout).toBe('')
})

it('kills the whole process group, not only the child it holds', async () => {
  // `hook-io.py:226`: the fan-out starts a child per repository, and killing
  // the child alone leaves those running against the network long after the
  // session moved on. The grandchild here inherits the child's stdout, so a
  // group that survived would also keep this run from ever closing.
  const sandbox = createSandbox()
  const marker = sandbox.join('grandchild')

  const result = await node(`${FIXTURES}/spawn-sleeper.ts`, [marker], { timeoutMs: 1_000 })

  expect(result.timedOut).toBe(true)
  expect(result.stdout).toContain('spawned ')
  expect(existsSync(`${marker}.started`)).toBe(true)
  // Generous: the grandchild writes this 5 s after it starts, and the run
  // above returned inside 1 s.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  expect(existsSync(`${marker}.survived`)).toBe(false)
  expect(existsSync(`${marker}.started`)).toBe(true)
})

it('measures how long the child actually took', async () => {
  // Only the floor is asserted. A loaded runner makes a child slower, never
  // faster, so this cannot go red for being busy.
  const result = await node(`${FIXTURES}/sleep.ts`, ['120'])

  expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
})

it('says nothing about a process group that is already gone', async () => {
  // The arm `kill_group`'s `except OSError` covers. A pid far above any the
  // kernel hands out has no group to signal, and this must not throw: the
  // caller's next act is to signal the child directly in any case.
  expect(() => killGroup(2 ** 30)).not.toThrow()
})
