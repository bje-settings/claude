// This file tests the runner's own claims, each one against a real child.
// There is no spawn seam here, on purpose. This is the file where the
// process boundary itself is the subject. A stand-in for `spawn` would
// prove only that the stand-in was called. ADR 001 and RFC 001 "The
// testing seam" put the one spawned contract test exactly where the
// boundary is real.
//
// The children run as `process.execPath` over a fixture. `harness/spawn.ts`
// makes the same choice, for the same reason. The interpreter that runs
// this suite is the interpreter under test. So a run on the 22.18 leg
// really exercises 22.18. `tests/harness/fixtures/` supplies the four
// fixtures that already existed.
//
// `tests/lib/fixtures/` supplies the rest. These are a child that sleeps, a
// child that starts a child, and the grandchild it starts. They also
// include a child that exits before it reads its stdin. One more prints
// its own process group. `tests/harness/fixtures/` was outside the allowed
// file set of the layer that added them, so these fixtures live here.
//
// Every time limit is generous where the test says it did NOT fire, and
// tiny where it says it did. This way a loaded CI runner can be slow and
// still pass.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree.
// The file and line references below point to what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.
// Nothing here changed with the deletion.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createSandbox } from '#harness/sandbox.ts'
import { endOnceWritten, killGroup, readPending, run } from '#lib/process.ts'

const HARNESS_FIXTURES = `${import.meta.dirname}/../harness/fixtures`
const FIXTURES = `${import.meta.dirname}/fixtures`

/** A time limit no correct run can reach on any runner. */
const GENEROUS_MS = 120_000
/** A time limit a child that sleeps for a minute always overruns. */
const TINY_MS = 250
/** The one time limit that must be long enough, not short enough. It is
 *  bounded from BOTH sides.
 *
 *  Floor: it must not fire until two nested cold node starts have written
 *  the marker. That takes about 120 ms when idle, so this value carries an
 *  order of magnitude over that.
 *
 *  Ceiling: it must fire before the grandchild's own 5 s `.survived` write
 *  (`fixtures/grandchild.ts`). A time limit that fired after that write
 *  would find the marker on disk. It would wrongly fail a correctly
 *  group-killed run. So the usable window is roughly 0.2 s to 5 s. This
 *  value cannot change alone: a larger value here needs a larger
 *  grandchild timer too, changed in the same edit. */
const GROUP_MS = 4_000
/** This is past the grandchild's own 5 s write. So "it did not survive" is
 *  a real observation, not just an early look. */
const SURVIVAL_WINDOW_MS = 6_000
/** This is comfortably past what the two time limits above cost together,
 *  about 10 s.
 *
 *  This value buys headroom on a loaded runner, and that is all it buys.
 *  It does NOT turn a missing group kill into an assertion failure. The
 *  fixture hands the grandchild the child's stdout on purpose. So a group
 *  that survives keeps the pipe open, `close` never fires, and `run` never
 *  resolves. The test then fails as a timeout, not as a failed
 *  assertion. It fails later, not differently.
 *
 *  This value is named here even though `vitest.config.ts` now sets the
 *  same number as the suite default. This test is the reason the number
 *  is what it is. A config change that moves the default should not
 *  silently move this one with it. */
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
  // This is the port of `stderr=subprocess.STDOUT` (`lib/install.py:56`).
  // It is read as one block, and the caller takes its last line.
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
  // Both sides are resolved. node reports the child's own cwd already
  // resolved. On macOS the sandbox sits under /var, which is a symlink to
  // /private/var.
  expect(cwd).toBe(realpathSync(where))
  expect(home).toBe(sandbox.join('home'))
})

it('writes what it was given to the child and closes the pipe', async () => {
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`, [], { stdin: 'piped in' })

  expect(result.stdout).toBe('piped in')
})

it('closes stdin on a child that was given none, rather than leaving it open', async () => {
  // If stdin is left open, a child that reads it waits for a writer that
  // will never arrive. In a SessionStart hook, that means a session that
  // never starts.
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`)

  expect(result.stdout).toBe('')
  expect(result.status).toBe(0)
})

it('decodes output with replacement rather than failing on a stray byte', async () => {
  // This is `decode("utf-8", "replace")`, which every ported script does.
  // One bad byte costs one character, never the whole answer.
  const result = await node(`${HARNESS_FIXTURES}/echo-stdin.ts`, [], {
    stdin: new Uint8Array([0xff, 0x41]),
  })

  expect(result.stdout).toBe('�A')
})

it('survives a child that exits before reading the stdin it was given', async () => {
  // The write fails with EPIPE, asynchronously, on a stream. Without a
  // listener, that error event would take this whole process down. This
  // holds even though the child's status is already in hand. The stdin
  // here is larger than any pipe buffer, so the write cannot land before
  // the child is gone.
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
  // `lib/install.py:64` to `71`: "command not found" for this case sends
  // the reader to check the wrong thing.
  const sandbox = createSandbox()
  const notExecutable = sandbox.join('tool')
  writeFileSync(notExecutable, '#!/bin/sh\necho hi\n', { mode: 0o644 })

  const result = await run(notExecutable)

  expect(result.startFailure?.code).toBe('EACCES')
  expect(result.status).toBe(126)
})

it('answers rather than rejecting when node refuses the argv outright', async () => {
  // `spawn` reports most failures on the `error` event. But it checks argv
  // synchronously, and throws a TypeError for a NUL byte. A throw inside
  // the promise executor is a rejection. "Never rejects" is the contract
  // every caller in `gh.ts` and `git.ts` relies on: none of them has a
  // `try`. A rejection would then surface as a stack trace from inside
  // node. It would come out of a helper whose whole documented answer is
  // `null`.
  const result = await run('git', ['rev-parse\u0000--show-toplevel'])

  expect(result.startFailure?.code).toBe('ERR_INVALID_ARG_VALUE')
  // This is 126, not 127. The code is not `ENOENT`, and `startStatus` maps
  // everything else to the shell's "cannot execute". Nothing here shows
  // that `git` is on PATH: node checks the argv before any lookup. So the
  // same code and the same 126 come back, even for a command that does not
  // exist at all.
  //
  // What separates this case from a missing tool is the `ERR_` prefix on
  // the code. A caller that prints "git is not on PATH" faces "git is on
  // PATH and still would not run" too. It must read that prefix to tell
  // the two apart.
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
  // A killed child has no status of its own. The signal is what happened.
  expect(result.status).toBeNull()
  expect(result.signal).toBe('SIGKILL')
  expect(result.stdout).toBe('')
})

it(
  'kills the whole process group, not only the child it holds',
  async () => {
    // `hook-io.py:236`: the fan-out starts a child per repository. If this
    // code killed the child alone, those children would stay active on the
    // network. That would hold long after the session moved on. The
    // grandchild here inherits the child's stdout. So a group that survived
    // would also keep this run open forever.
    //
    // This is the one time limit in the file that must be long ENOUGH,
    // rather than short enough. It must not fire until two nested cold
    // node starts, with type stripping, have written the marker. That
    // takes about 120 ms on an idle machine. GROUP_MS gives that an order
    // of magnitude of headroom. The survival window outlasts the
    // grandchild's own 5 s write. So the assertion proves something; it
    // does not just arrive early.
    //
    // Both of these cost wall clock time. That is why this one test names
    // its own time budget, rather than use whatever the suite default is.
    const sandbox = createSandbox()
    const marker = sandbox.join('grandchild')

    const result = await node(`${FIXTURES}/spawn-sleeper.ts`, [marker], { timeoutMs: GROUP_MS })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain('spawned ')
    expect(existsSync(`${marker}.started`)).toBe(true)
    // The wait starts here, after the time limit has already fired at 4 s.
    // By the time it ends, the grandchild's own 5 s deadline is long past.
    // A grandchild that outlived the group kill has then had its real
    // chance to say so.
    await new Promise((resolve) => setTimeout(resolve, SURVIVAL_WINDOW_MS))
    expect(existsSync(`${marker}.survived`)).toBe(false)
    expect(existsSync(`${marker}.started`)).toBe(true)
  },
  GROUP_TEST_BUDGET_MS,
)

it('measures how long the child actually took', async () => {
  // Only the floor is asserted. A loaded runner makes a child slower, never
  // faster, so a busy machine cannot turn this test red.
  const result = await node(`${FIXTURES}/sleep.ts`, ['120'])

  expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
})

it('says nothing about a process group that is already gone', async () => {
  // This covers the case `kill_group`'s `except OSError` covers. A pid far
  // above any the kernel hands out has no group to signal. This must not
  // throw: the caller's next act is to signal the child directly either
  // way.
  expect(() => killGroup(2 ** 30)).not.toThrow()
})

it("detaches a bounded child and leaves an unbounded one in this process's group", async () => {
  // This is the claim the whole group kill rests on. It is not a branch,
  // so 100% coverage never touches it. `detached: true` on every child
  // would pass every other test in this file.
  //
  // A bounded child is detached so its group can be signalled. The signal
  // never reaches this process, or the session that started it. That is
  // what `start_new_session=True` buys the two bounded Python calls. An
  // unbounded child stays here, so a Ctrl-C in the terminal reaches it.
  // That is what the unbounded `subprocess.run` calls get.
  const mine = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    .toString()
    .trim()

  const unbounded = await node(`${FIXTURES}/pgid.ts`)
  const bounded = await node(`${FIXTURES}/pgid.ts`, [], { timeoutMs: GENEROUS_MS })

  expect(unbounded.stdout).toBe(mine)
  expect(bounded.stdout).not.toBe(mine)
})

it('reports a bounded command that is not there as a start failure, not as a timeout', async () => {
  // A bounded call, such as `repositoryStatus`, meets this shape on a
  // machine with no `gh`. `timedOut` is the assertion that matters. If it
  // were true beside a `startFailure`, `readStatusBatch` would check it
  // first. It would then report a missing `gh` as a timeout.
  const result = await run('definitely-not-a-command-127', [], { timeoutMs: TINY_MS })

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.status).toBe(127)
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
})

// --- endOnceWritten: a hook that a hung read still holds (#267) -------------

it('ends a process that a read still holds, once its output has left', async () => {
  const sandbox = createSandbox()
  const fifo = sandbox.join('fifo')
  execFileSync('mkfifo', [fifo])

  const result = await node(`${FIXTURES}/end-once-written.ts`, ['50', 'read', fifo], {
    timeoutMs: GENEROUS_MS,
  })

  expect(result.stdout).toBe('written\nended\n')
  expect(result.signal).toBe('SIGKILL')
  expect(result.timedOut).toBe(false)
})

it('leaves a process that only a timer holds to end by itself', async () => {
  const result = await node(`${FIXTURES}/end-once-written.ts`, ['50', 'timer'], {
    timeoutMs: GENEROUS_MS,
  })

  expect(result.stdout).toBe('written\n')
  expect(result.status).toBe(0)
})

it('leaves a process that nothing holds to end by itself, with no wait for the grace', async () => {
  // The grace is far longer than the bound. So a timer that held the
  // process open would make the bound fire.
  const result = await node(`${FIXTURES}/end-once-written.ts`, ['60000'], { timeoutMs: 20_000 })

  expect(result.stdout).toBe('written\n')
  expect(result.status).toBe(0)
  expect(result.timedOut).toBe(false)
})

it('waits for every stream, then ends only for a pending filesystem request', async () => {
  const ended: string[] = []
  const flushed = {
    write: (_text: string, done: () => void) => {
      done()
      return true
    },
  }
  const stuck = { write: () => true }
  const reading = () => ['PipeWrap', 'FSReqPromise']

  endOnceWritten([flushed, stuck], 0, () => ended.push('stuck'), reading)
  endOnceWritten([flushed, flushed], 0, () => ended.push('reading'), reading)
  endOnceWritten(
    [flushed, flushed],
    0,
    () => ended.push('closing'),
    () => ['ProcessWrap'],
  )
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(ended).toEqual(['reading'])
})

it('reads FSReqPromise and FSReqCallback as a pending read, and nothing else', () => {
  expect(readPending(['FSReqPromise'])).toBe(true)
  expect(readPending(['Timeout', 'FSReqCallback'])).toBe(true)
  expect(readPending(['PipeWrap', 'ProcessWrap', 'Timeout'])).toBe(false)
  expect(readPending([])).toBe(false)
})
