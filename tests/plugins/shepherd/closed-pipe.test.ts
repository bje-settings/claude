// A reader that has had enough, end to end, once per entry point of the
// shepherd plugin.
//
// `harness/spawn.ts` `startScript` is the variant of `runScript` that can
// lose a reader part-way through. These tests check the outcome, not the
// timing: the child's exit status, and no node stack trace on stderr. The
// write can land before or after the pipe closes. Either way, the answer
// must be the same.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { startScript } from '#harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = pluginFile('shepherd', 'scripts', 'shepherd.ts')
const HOOK = pluginFile('shepherd', 'hooks', 'session-start.ts')
/** The floor fixture names nothing of the gh plugin, so this file reuses it
 *  by path, as `tests/plugins/workstreams/session-start.test.ts` does. */
const OLD_NODE_VERSION = path.join(HERE, '..', 'gh', 'fixtures', 'old-node-version.ts')

/** Neither stream may show an internal stack trace. With no `error` listener,
 *  node reports a failed write as an uncaught exception. */
const expectNoCrash = (stderr: string): void => {
  expect(stderr).not.toContain('Error: write EPIPE')
  expect(stderr).not.toContain('ERR_STREAM_DESTROYED')
  expect(stderr).not.toMatch(/\n {4}at /)
}

it('finishes clean when the reader of shepherd.ts --help leaves after one line', async () => {
  const sandbox = createSandbox()
  const running = startScript(BIN, { args: ['--help'], env: sandbox.env })

  // The reader takes its line and goes, as `| head -1` does.
  await running.firstLine()
  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of shepherd-status --help leaves at once', async () => {
  const sandbox = createSandbox()
  // The shepherd family writes its own document through the writers it
  // receives. It does not use the envelope renderer. So it needs its own
  // example here.
  const running = startScript(BIN, { args: ['shepherd-status', '--help'], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of the hook response leaves at once', async () => {
  const sandbox = createSandbox()
  // With no gh on PATH, the hook has a line to write.
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const running = startScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})

it('finishes clean when the reader of the below-floor alert leaves at once', async () => {
  const sandbox = createSandbox()
  const running = startScript(OLD_NODE_VERSION, { args: [HOOK], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expectNoCrash(ended.stderr)
})
