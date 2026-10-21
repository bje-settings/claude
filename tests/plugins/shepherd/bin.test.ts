// This file is the one spawned contract test for `scripts/shepherd.ts`
// (`harness/README.md`). Argv goes in. Exit code and streams come out. Every
// other check on these commands runs in-process, in `subcommands/*.test.ts`.
// Only this file makes the process boundary itself real.
//
// This file covers only the paths that need no `gh` and touch no real
// checkout: the usage, the refusals, `--help`, and an unknown command. A
// spawned child cannot receive the injected `gh` client (ADR 001).
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const BIN = pluginFile('shepherd', 'scripts', 'shepherd.ts')

/** The sandbox's environment, so the child carries no `GIT_` or `GH_`
 *  variable this test did not choose. */
const env = (): NodeJS.ProcessEnv => createSandbox().env

it('prints the command list with no arguments at all, and exits 0', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: shepherd\.ts <command>/)
  expect(result.stderr).toBe('')
})

it('answers --help and -h the same way, because asking what this does is not a mistake', () => {
  for (const flag of ['--help', '-h']) {
    const result = runScript(BIN, { args: [flag], env: env() })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^usage: shepherd\.ts <command>/)
  }
})

it('refuses a command nobody answers to, with the list on stderr', () => {
  const result = runScript(BIN, { args: ['nope'], env: env() })

  expect(result.status).toBe(2)
  // Nothing appears on stdout. A caller that parses it can never turn a
  // refusal into a result (`lib/envelope.ts`).
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('unknown command: nope')
  expect(result.stderr).toContain('usage: shepherd.ts <command>')
})

it('lists every command in the command list', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.stdout).toContain('discover [path]')
  expect(result.stdout).toContain('shepherd-status')
  expect(result.stdout).toContain('shepherd-pr <path> <number> <action>')
  expect(result.stdout).toContain('shepherd-stack <path> <stack> <action>')
})

it('prints shepherd-stack’s own usage for its --help, naming every action', () => {
  const result = runScript(BIN, { args: ['shepherd-stack', '--help'], env: env() })

  expect(result.status).toBe(0)
  for (const action of ['state', 'update', 'wait', 'merge']) {
    expect(result.stdout).toContain(`shepherd.ts shepherd-stack <path> <stack> ${action}`)
  }
})

it('prints shepherd-status’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['shepherd-status', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('shepherd.ts shepherd-status [path]')
  expect(result.stderr).toBe('')
})

it('prints shepherd-pr’s own usage for its --help, naming every action', () => {
  const result = runScript(BIN, { args: ['shepherd-pr', '--help'], env: env() })

  expect(result.status).toBe(0)
  for (const action of ['state', 'rebase', 'wait', 'settle', 'merged']) {
    expect(result.stdout).toContain(`shepherd.ts shepherd-pr <path> <number> ${action}`)
  }
})

it('refuses shepherd-pr with too few arguments, exit 2, usage on stderr', () => {
  // This tests the process boundary itself. A command that answers with a
  // status rather than an envelope still reaches `process.exitCode` through
  // the same adapter.
  const result = runScript(BIN, { args: ['shepherd-pr', '.', '1'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('shepherd.ts shepherd-pr <path> <number> state')
})

it('refuses a shepherd-pr path that is not a directory, without reaching gh', () => {
  const result = runScript(BIN, {
    args: ['shepherd-pr', 'no-such-directory', '1', 'state'],
    env: env(),
  })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('not a directory: no-such-directory\n')
})

it('refuses a shepherd-status path that is not a directory', () => {
  const result = runScript(BIN, { args: ['shepherd-status', 'no-such-directory'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stderr).toBe('not a directory: no-such-directory\n')
})

it('refuses a pull request number that is not one', () => {
  const sandbox = createSandbox()

  const result = runScript(BIN, {
    args: ['shepherd-pr', sandbox.path, 'abc', 'state'],
    env: sandbox.env,
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toBe('not a pull request number: abc\n')
})
