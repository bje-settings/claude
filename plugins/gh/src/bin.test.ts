// The one spawned contract test for `bin/gh.ts` (`harness/README.md`): argv
// in, exit code and streams out. Everything else about these commands is
// exercised in-process in `commands/*.test.ts`; this is the only place the
// process boundary itself, and the floor guard in front of it, are real.
//
// Only the paths that need no `gh` and touch no real checkout: the usage, the
// refusals, `--help`, a subcommand nobody answers to, and one case for #81's
// exit-1 contract. A spawned child cannot be handed the injected `gh` client
// (ADR 001, and the reason the fan-out is in-process at all), so a test that
// drove `bin/gh.ts sync` itself through a real fan-out or a real merge-proof
// lookup would be reaching for the real `gh`; the #81 case instead spawns
// `fixtures/throwing-sync-entry.ts`, which imports the real `createSyncCommand`
// with a throwing stand-in in place of the job, because the real job cannot be
// made to throw at all (that fixture's own header says why). It MIRRORS, not
// calls, `bin/gh.ts`'s own `write` helper and `sync` dispatch arm (neither is
// importable, `fixtures/README.md` has the gap that leaves): the exit-0 and
// exit-2 cases below spawn `bin/gh.ts` itself and so do exercise the real
// `write`, but a future break confined to the exit-1 case in `bin/gh.ts`'s
// own wiring would not be caught by this file.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { createSandbox } from '../../../harness/sandbox.ts'
import { runScript } from '../../../harness/spawn.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gh.ts')
const THROWING_SYNC_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'throwing-sync-entry.ts',
)

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

it('lists the shepherd commands in the command list', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.stdout).toContain('shepherd-status')
  expect(result.stdout).toContain('shepherd-pr <path> <number> <action>')
})

it('prints shepherd-status’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['shepherd-status', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('gh.ts shepherd-status [path]')
  expect(result.stderr).toBe('')
})

it('prints shepherd-pr’s own usage for its --help, naming every action', () => {
  const result = runScript(BIN, { args: ['shepherd-pr', '--help'], env: env() })

  expect(result.status).toBe(0)
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'skip', 'merged']) {
    expect(result.stdout).toContain(`gh.ts shepherd-pr <path> <number> ${action}`)
  }
})

it('refuses shepherd-pr with too few arguments, exit 2, usage on stderr', () => {
  // The process boundary itself: a command that answers with a status rather
  // than an envelope still reaches `process.exitCode` through the same
  // adapter.
  const result = runScript(BIN, { args: ['shepherd-pr', '.', '1'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('gh.ts shepherd-pr <path> <number> state')
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

it('exits 1 with the report on stdout when a job fails, at the real process boundary', () => {
  // #81: `syncRepo` cannot be driven into this state through the real `gh.ts`
  // binary (see `fixtures/throwing-sync-entry.ts` and `fixtures/README.md`),
  // so this proves the envelope-to-exit-code wiring the same way `bin/gh.ts`
  // wires it, in a real spawned process rather than in-process.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))

  const result = runScript(THROWING_SYNC_ENTRY, { args: [repo], env: sandbox.env })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe('  ✗ the sync failed: boom\n')
  expect(result.stderr).toBe(`the sync to ${path.basename(repo)} failed\n`)
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
