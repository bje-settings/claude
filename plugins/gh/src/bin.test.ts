// The one spawned contract test for `bin/gh.ts` (`harness/README.md`): argv
// in, exit code and streams out. Everything else about these commands is
// exercised in-process in `commands/*.test.ts`; this is the only place the
// process boundary itself, and the floor guard in front of it, are real.
//
// Only the paths that need no `gh` and touch no repository: the usage, the
// refusals, `--help`, and a subcommand nobody answers to. A spawned child
// cannot be handed the injected `gh` client (ADR 001, and the reason the
// fan-out is in-process at all), so a test that drove a real sync through here
// would be reaching for the real `gh`.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createSandbox } from '../../../harness/sandbox.ts'
import { runScript } from '../../../harness/spawn.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gh.ts')

/** The sandbox's environment, so the child carries no `GIT_` or `GH_`
 *  variable this test did not choose. */
const env = (): NodeJS.ProcessEnv => createSandbox().env

it('prints the command list with no arguments at all, and exits 0', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: gh\.ts <command>/)
  expect(result.stdout).toContain('sync-repo')
  expect(result.stderr).toBe('')
})

it('answers --help the same way, because asking what this does is not a mistake', () => {
  const result = runScript(BIN, { args: ['--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: gh\.ts <command>/)
})

it('answers -h the same way --help does', () => {
  const result = runScript(BIN, { args: ['-h'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: gh\.ts <command>/)
})

it('refuses a subcommand nobody answers to, with the list on stderr', () => {
  const result = runScript(BIN, { args: ['nope'], env: env() })

  expect(result.status).toBe(2)
  // Nothing on stdout: a caller parsing it can never parse a refusal into a
  // result (`lib/envelope.ts`).
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('unknown command: nope')
  expect(result.stderr).toContain('usage: gh.ts <command>')
})

it('prints one command’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['sync', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('gh.ts sync [--dry-run]')
  expect(result.stderr).toBe('')
})

it('refuses an unknown flag on a command, exit 2, with nothing on stdout', () => {
  const result = runScript(BIN, { args: ['sync', '--nope'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('unknown flag: --nope\n')
})

it('refuses sync-repo with no repository path, and names the usage', () => {
  const result = runScript(BIN, { args: ['sync-repo'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('usage: gh.ts sync-repo [--dry-run] [--no-install] <repo-path>\n')
})

it('prints sync-repo’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['sync-repo', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('gh.ts sync-repo [--dry-run]')
})

it('refuses a -j value that is not a positive integer', () => {
  const result = runScript(BIN, { args: ['sync', '-j', '0', '.'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stderr).toBe('invalid -j value: 0\n')
})
