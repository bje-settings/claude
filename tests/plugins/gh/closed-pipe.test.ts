// A reader that has had enough, end to end, once per command family.
//
// Round 5's handoff note on #156 says no test could pin this guard.
// `harness/spawn.ts` `runScript` uses `spawnSync`, which drains both streams
// before it returns. So nothing run through `runScript` can lose its reader
// part-way through. Layer 2 removed three contracts for this reason: "there
// is no final flush to fail at".
//
// `harness/spawn.ts` `startScript` is the variant that can lose a reader.
// These tests are the examples it exists for. One is
// `gh.ts <command> | head -1`, where the reader leaves and the process still
// exits clean.
//
// This test checks the outcome, not the timing. It checks the child's exit
// status. It also checks that stderr carries no node stack trace. The write
// can land before or after the pipe closes. That is the race this guard
// exists for. Either way, the answer must be the same.
import path from 'node:path'
import { expect, it } from 'vitest'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { startScript } from '#harness/spawn.ts'
import { createRig, githubRepo } from './subcommands/hook-io.test-support.ts'

const BIN = pluginFile('gh', 'scripts', 'gh.ts')
const HOOK = pluginFile('gh', 'hooks', 'hook-io.ts')

/** Neither stream may show an internal stack trace. With no `error` listener,
 *  node reports a failed write as an uncaught exception. That exception would
 *  then appear in a session's debug log. */
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
  const work = path.join(fan, 'a')
  git.createAt(fan, 'a')
  git.branchWithWork(work, 'wip')
  // Origin moves before the run starts. This gives the fan-out's fetch
  // something new to bring back. The test claims this fetch still happens
  // even when nobody reads the output. Without a value to compare, the test
  // could only claim the child exited with status 0.
  git.remoteAdvance(work)
  const before = git.sha(work, 'refs/remotes/origin/main')
  // No `gh` is available, so nothing here reaches the real GitHub. The
  // fan-out still fetches, syncs, and writes its whole report. It must do
  // this work whether or not anyone listens.
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const running = startScript(BIN, {
    args: ['sync', '--dry-run', '--no-install', fan],
    env,
  })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
  // The fetch landed after the reader left. The run continued to the end.
  // It did not die at its first write.
  expect(git.sha(work, 'refs/remotes/origin/main')).not.toBe(before)
})

it('finishes clean when the reader of shepherd-status --help leaves at once', async () => {
  const sandbox = createSandbox()
  // The shepherd family writes its own JSON document through the writers it
  // receives. It does not use the envelope renderer. So it needs its own
  // example here.
  const running = startScript(BIN, { args: ['shepherd-status', '--help'], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of the hook response leaves at once', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  // The rig's `gh` always fails, so the hook has a line to write: the
  // GitHub half fails.
  const running = startScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ cwd: work }),
    env: rig.sandbox.env,
  })

  running.closeStdout()
  const ended = await running.ended()

  // Nothing here changes state, so there is nothing left to finish. The point
  // is that the shutdown flush does not turn this into a trace on stderr. If
  // it did, the debug log would record it as a hook failure.
  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})
