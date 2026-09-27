// The one spawned contract test for `scripts/workstreams.ts`
// (`harness/README.md`): argv in, exit code and streams out. Everything
// else about these commands is exercised in process, in
// `subcommands/*.test.ts`. This is the only place the process boundary
// itself, and the floor guard in front of it, are real.
//
// Only the paths that reach no GitHub are here. These are the usage, the
// refusals, each arm's own `--help`, and the process edges of the watch. A spawned child cannot
// be handed the injected `gh` client (ADR 001, and the reason the command
// function is the seam at all). So a test that drove `sweep` itself here
// would reach for the real `gh`, and assert against a machine's login. The
// watch examples run in a sandbox checkout. A `gh` that always fails is
// first on PATH, as in the hook tests.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'

import { createSandbox } from '#harness/sandbox.ts'
import { runScript, startScript } from '#harness/spawn.ts'

const BIN = pluginFile('workstreams', 'scripts', 'workstreams.ts')

/** The sandbox's environment, so the child carries no `GIT_` or `GH_`
 *  variable this test did not choose. */
const env = (): NodeJS.ProcessEnv => createSandbox().env

it('prints the command list with no arguments at all, and exits 0', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: workstreams\.ts <command>/)
  expect(result.stdout).toContain('sweep [--milestone 4,5] [--json]')
  expect(result.stdout).toContain('pr-state <number> [--round 0|1|2]')
  expect(result.stdout).toContain('intersect [--json]')
  expect(result.stdout).toContain('watch [--interval 60] [--ticks 0]')
  expect(result.stderr).toBe('')
})

for (const flag of ['--help', '-h']) {
  it(`answers ${flag} the same way, because asking what this does is not a mistake`, () => {
    const result = runScript(BIN, { args: [flag], env: env() })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^usage: workstreams\.ts <command>/)
    expect(result.stderr).toBe('')
  })
}

it('refuses a subcommand nobody answers to, with the list on stderr', () => {
  const result = runScript(BIN, { args: ['nope'], env: env() })

  expect(result.status).toBe(2)
  // Nothing on stdout: a caller parsing it can never parse a refusal into a
  // result (`lib/envelope.ts`).
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('unknown command: nope')
  expect(result.stderr).toContain('usage: workstreams.ts <command>')
})

it('prints sweep’s own usage for its --help, without asking gh anything', () => {
  const result = runScript(BIN, { args: ['sweep', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^What a round could start on/)
  expect(result.stdout).toContain('--milestone takes one number or a comma-separated list')
  expect(result.stderr).toBe('')
})

it('refuses an unknown flag on sweep, exit 2, with nothing on stdout', () => {
  const result = runScript(BIN, { args: ['sweep', '--nope'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('--nope')
})

it('refuses a --milestone that is not a milestone number, before reaching gh', () => {
  const result = runScript(BIN, { args: ['sweep', '--milestone', 'main'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('--milestone takes milestone numbers, not "main"\n')
})

it('refuses a repeated --milestone at the process boundary too', () => {
  const result = runScript(BIN, {
    args: ['sweep', '--milestone', '4', '--milestone', '5'],
    env: env(),
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toBe('--milestone is not repeatable; pass one comma-separated list\n')
})

it('prints pr-state’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['pr-state', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^One pull request's review-loop state/)
  expect(result.stderr).toBe('')
})

it('refuses pr-state with no pull request number, before reaching gh', () => {
  const result = runScript(BIN, { args: ['pr-state'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('pr-state takes a pull request number\n')
})

it('refuses a pr-state positional that is not a number', () => {
  const result = runScript(BIN, { args: ['pr-state', 'main'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stderr).toBe('pr-state takes a pull request number, not "main"\n')
})

it('refuses a pr-state round outside the three the loop has', () => {
  const result = runScript(BIN, { args: ['pr-state', '178', '--round', '3'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('--round must be one of 0, 1, 2')
})

it('prints intersect’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['intersect', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^Every open pull request's head against the default branch/)
  expect(result.stderr).toBe('')
})

it('fails intersect outside a git checkout, exit 1, with nothing on stdout', () => {
  const sandbox = createSandbox()

  const result = runScript(BIN, { args: ['intersect'], env: sandbox.env, cwd: sandbox.path })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^intersect runs inside a git checkout, and .* is not in one\n$/)
})

// --- watch -------------------------------------------------------------------
//
// The watch is the one arm that runs until it is stopped. A SIGTERM ends it
// with exit 0, and so does a reader that closed the pipe. Neither run
// reaches GitHub. The `gh` first on PATH always fails. So each poll writes
// one "poll failed" line, and the watch polls again.

/** A sandbox and a checkout in it, with a `gh` that always fails first on
 *  PATH. */
const watchRig = (): { env: NodeJS.ProcessEnv; work: string } => {
  const sandbox = createSandbox()
  const stubs = sandbox.join('stub-bin')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(path.join(stubs, 'gh'), '#!/bin/sh\necho "gh stub: offline" >&2\nexit 1\n', {
    mode: 0o755,
  })
  sandbox.stubPath(stubs)
  const work = createGitFixtures(sandbox).create(sandbox.join('repo'))
  return { env: sandbox.env, work }
}

it('prints watch’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['watch', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^Every open pull request's head/)
  expect(result.stderr).toBe('')
})

it('refuses a watch --interval that is not a whole number of seconds', () => {
  const result = runScript(BIN, { args: ['watch', '--interval', 'soon'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('--interval takes a whole number of seconds, not "soon"\n')
})

it('writes one line and exits 0 outside a git checkout', () => {
  const sandbox = createSandbox()

  const result = runScript(BIN, { args: ['watch'], env: sandbox.env, cwd: sandbox.path })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/is not inside a git checkout, so there is nothing to watch\n$/)
  expect(result.stderr).toBe('')
})

it('writes one line and exits 0 when gh is not on PATH', () => {
  const sandbox = createSandbox()
  const work = createGitFixtures(sandbox).create(sandbox.join('repo'))
  sandbox.env.PATH = sandbox.pathWithout('gh')

  const result = runScript(BIN, { args: ['watch'], env: sandbox.env, cwd: work })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^watch: cannot run gh: .*, so there is nothing to watch\n$/)
})

it('keeps polling after a poll that failed, and ends with exit 0 on SIGTERM', async () => {
  const { env: rigEnv, work } = watchRig()
  const watch = startScript(BIN, { args: ['watch'], env: rigEnv, cwd: work })

  await expect(watch.firstLine()).resolves.toBe('poll failed: gh stub: offline')
  // The watch now sleeps for 60 seconds. The signal must end that sleep,
  // or the suite timeout ends this example first.
  watch.child.kill('SIGTERM')

  await expect(watch.ended()).resolves.toEqual({ status: 0, signal: null, stderr: '' })
})

it('ends with exit 0 when the reader closes the pipe', async () => {
  const { env: rigEnv, work } = watchRig()
  const watch = startScript(BIN, { args: ['watch', '--interval', '1'], env: rigEnv, cwd: work })

  await expect(watch.firstLine()).resolves.toBe('poll failed: gh stub: offline')
  watch.closeStdout()

  await expect(watch.ended()).resolves.toEqual({ status: 0, signal: null, stderr: '' })
})
