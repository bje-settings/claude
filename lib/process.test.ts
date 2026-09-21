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
// already exist; `lib/fixtures/` supplies the ones it has no equivalent of
// (a child that sleeps, a child that starts a child, the grandchild it
// starts, a child that exits before reading its stdin, and a child that
// prints its own process group), because `harness/fixtures/` is outside this
// layer's allowed file set.
//
// Every bound is generous where the test says it did NOT fire and tiny where
// it says it did, so a loaded CI runner can be slow without being wrong.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree; every
// file and line reference below is to what they held at `cd0d515`, kept
// because each says where a rule came from. Nothing here changed with the
// deletion.
import { execFileSync } from 'node:child_process'
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
/** The one bound that has to be long enough rather than short enough, and it
 *  is bounded from BOTH sides.
 *
 *  Floor: it must not fire until two nested cold node starts have written the
 *  marker, about 120 ms idle, so this carries an order of magnitude over that.
 *  Ceiling: it must fire before the grandchild's own 5 s `.survived` write
 *  (`fixtures/grandchild.ts`), because a bound that fired after it would find
 *  the marker on disk and fail a correctly group-killed run. So the usable
 *  window is roughly 0.2 s to 5 s and this cannot simply be raised: raising it
 *  means raising the grandchild's timer in the same change. */
const GROUP_MS = 4_000
/** Past the grandchild's own 5 s write, so "it did not survive" is an
 *  observation and not just an early look. */
const SURVIVAL_WINDOW_MS = 6_000
/** Comfortably past what the two above cost together, which is about 10 s.
 *
 *  It buys headroom on a loaded runner, and that is all it buys. It does NOT
 *  turn a missing group kill into an assertion failure: the fixture hands the
 *  grandchild the child's stdout on purpose, so a surviving group keeps the
 *  pipe open, `close` never fires and `run` never resolves, and the test fails
 *  as a timeout rather than as the assertion. Later, not different.
 *
 *  Named here even though `vitest.config.ts` now sets the same number as the
 *  suite default, because this test is the reason the number is what it is and
 *  a config that moved should not silently take this one with it. */
const GROUP_TEST_BUDGET_MS = 30_000

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
  // 126, not 127, because the code is not `ENOENT` and `startStatus` maps
  // everything else to the shell's "cannot execute". Nothing here established
  // that `git` is on PATH: node validates the argv BEFORE any lookup, so the
  // same code and the same 126 come back for a command that does not exist at
  // all. What separates this case from a missing tool is the `ERR_` prefix on
  // the code, which is what a caller printing "git is not on PATH" against
  // "git is on PATH and still would not run" has to read.
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

it(
  'kills the whole process group, not only the child it holds',
  async () => {
    // `hook-io.py:236`: the fan-out starts a child per repository, and
    // killing the child alone leaves those running against the network long
    // after the session moved on. The grandchild here inherits the child's
    // stdout, so a group that survived would also keep this run from ever
    // closing.
    //
    // This is the one bound in the file that has to be long ENOUGH rather
    // than short enough: it must not fire until two nested cold node starts
    // with type stripping have written the marker, which is about 120 ms on
    // an idle machine. GROUP_MS gives that an order of magnitude, and the
    // survival window outlasts the grandchild's own 5 s write, so the
    // assertion says something rather than merely arriving early. Both cost
    // wall clock, which is why this one test names its own budget rather than
    // inheriting whatever the suite default happens to be.
    const sandbox = createSandbox()
    const marker = sandbox.join('grandchild')

    const result = await node(`${FIXTURES}/spawn-sleeper.ts`, [marker], { timeoutMs: GROUP_MS })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain('spawned ')
    expect(existsSync(`${marker}.started`)).toBe(true)
    // The wait starts here, after the bound has already fired at 4 s, so by
    // the time it ends the grandchild's own 5 s deadline is long past and a
    // grandchild that outlived the group kill has actually had its chance to
    // say so.
    await new Promise((resolve) => setTimeout(resolve, SURVIVAL_WINDOW_MS))
    expect(existsSync(`${marker}.survived`)).toBe(false)
    expect(existsSync(`${marker}.started`)).toBe(true)
  },
  GROUP_TEST_BUDGET_MS,
)

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

it("detaches a bounded child and leaves an unbounded one in this process's group", async () => {
  // The claim the whole group kill rests on, and it is not a branch, so 100%
  // coverage never touches it: `detached: true` on every child would pass
  // every other test in this file. A bounded child is detached so its group
  // can be signalled without reaching this process or the session that started
  // it, which is what `start_new_session=True` buys the two bounded Python
  // calls; an unbounded one stays here so a Ctrl-C in the terminal reaches it,
  // which is what the unbounded `subprocess.run` calls get.
  const mine = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    .toString()
    .trim()

  const unbounded = await node(`${FIXTURES}/pgid.ts`)
  const bounded = await node(`${FIXTURES}/pgid.ts`, [], { timeoutMs: GENEROUS_MS })

  expect(unbounded.stdout).toBe(mine)
  expect(bounded.stdout).not.toBe(mine)
})

it('reports a bounded command that is not there as a start failure, not as a timeout', async () => {
  // Every production `watchChecks` call is bounded, so on a machine with no
  // `gh` this is the shape the shepherd meets first. `timedOut` is the
  // assertion that matters: true beside a `startFailure` would have
  // `lib/gh.ts` read `problem` from an empty stderr and report a missing gh as
  // silence.
  const result = await run('definitely-not-a-command-127', [], { timeoutMs: TINY_MS })

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.status).toBe(127)
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
})
