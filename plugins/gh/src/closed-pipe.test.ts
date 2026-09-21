// A reader that has had enough, end to end, once per command family.
//
// Round 5's handoff note on #156 says this guard could not be pinned:
// `harness/spawn.ts` `runScript` is `spawnSync` and drains both streams
// before it returns, so nothing run through it can lose its reader part-way,
// and layer 2 retired three contracts on "there is no final flush to fail
// at". `harness/spawn.ts` `startScript` is the variant that can, and these
// are the examples it exists for: `gh.ts <command> | head -1`, where the
// reader leaves and the process still exits clean.
//
// What is asserted is the outcome, never a timing: the child's status, and
// that its stderr carries no node stack trace. Whether the write lands before
// or after the pipe closes is the race the guard exists for, and either way
// the answer has to be the same one.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { createSandbox } from '../../../harness/sandbox.ts'
import { startScript } from '../../../harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, '..', 'bin', 'gh.ts')
const HOOK = path.join(HERE, '..', 'hooks', 'hook-io.ts')

/** Neither stream may carry an internals stack trace: with no `error`
 *  listener node reports a failed write as an uncaught exception, and that is
 *  what would reach a session's debug log. */
const expectNoCrash = (stderr: string): void => {
  expect(stderr).not.toContain('Error: write EPIPE')
  expect(stderr).not.toContain('ERR_STREAM_DESTROYED')
  expect(stderr).not.toMatch(/\n {4}at /)
}

it('finishes clean when the reader of gh.ts --help leaves after one line', async () => {
  const sandbox = createSandbox()
  const running = startScript(BIN, { args: ['--help'], env: sandbox.env })

  // The reader takes its line and goes, as `| head -1` does.
  await running.firstLine()
  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of a sync report never reads at all', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const fan = sandbox.join('fan')
  git.createAt(fan, 'a')
  git.branchWithWork(path.join(fan, 'a'), 'wip')
  // No `gh`, so nothing here reaches the real GitHub; the fan-out still
  // fetches, syncs and writes its whole report, which is the work that must
  // be done whether or not anyone is listening.
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const running = startScript(BIN, {
    args: ['sync', '--dry-run', '--no-install', fan],
    env,
  })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of shepherd-status --help leaves at once', async () => {
  const sandbox = createSandbox()
  // The shepherd family writes its own JSON document through the writers it
  // is handed rather than through the envelope renderer, so it is its own
  // example.
  const running = startScript(BIN, { args: ['shepherd-status', '--help'], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of the hook response leaves at once', async () => {
  const sandbox = createSandbox()
  const running = startScript(HOOK, { args: ['branch', 'side', 'main'], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  // Nothing here changes state, so there is nothing left to finish; the point
  // is that the shutdown flush does not turn it into a trace on stderr, which
  // the debug log would then carry as a hook failure.
  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})
