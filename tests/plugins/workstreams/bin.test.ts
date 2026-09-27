// The one spawned contract test for `scripts/workstreams.ts`
// (`harness/README.md`): argv in, exit code and streams out. Everything
// else about these commands is exercised in process, in
// `subcommands/*.test.ts`. This is the only place the process boundary
// itself, and the floor guard in front of it, are real.
//
// Only the paths that need no `gh` and touch no real checkout: the usage,
// the refusals, and each arm's own `--help`. A spawned child cannot be
// handed the injected `gh` client (ADR 001, and the reason the command
// function is the seam at all). So a test that drove `sweep` itself here
// would reach for the real `gh`, and assert against a machine's login.
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'

import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

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
