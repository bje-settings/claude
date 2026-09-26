// The spawned contract for the `org-scope` arm of `scripts/gh.ts` (#233).
// `bin.test.ts` is the contract test for the other arms. This file is
// separate from it, so the new arm's tests do not collide with other open
// changes to that file.
//
// Only paths that need no `gh` run here: `--help` and a refusal. A spawned
// child cannot receive the injected `gh` client, so every verdict is tested
// in process, in `subcommands/org-scope.test.ts`.
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const BIN = pluginFile('gh', 'scripts', 'gh.ts')

/** The sandbox's environment, so the child carries no `GIT_` or `GH_`
 *  variable this test did not choose. */
const env = (): NodeJS.ProcessEnv => createSandbox().env

it('prints the org-scope help for --help, and exits 0', () => {
  const result = runScript(BIN, { args: ['org-scope', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^Whether each source owner shares an enterprise/)
  expect(result.stderr).toBe('')
})

it('refuses org-scope with no --target, with exit 2 and nothing on stdout', () => {
  const result = runScript(BIN, { args: ['org-scope', 'acme-one'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('org-scope: --target is required')
})

it('lists org-scope in the command list', () => {
  const result = runScript(BIN, { args: ['--help'], env: env() })

  expect(result.stdout).toContain('org-scope --target <owner> <source-owner>...')
})
