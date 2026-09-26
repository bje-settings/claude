// This file is the one spawned contract test for `scripts/gh.ts`
// (`harness/README.md`). Argv goes in. Exit code and streams come out. Every
// other check on these commands runs in-process, in `subcommands/*.test.ts`.
// Only this file makes the process boundary itself, and the floor guard in
// front of it, real.
//
// This file covers only the paths that need no `gh` and touch no real
// checkout. These are the usage, the refusals, `--help`, an unknown
// subcommand, and one case for #81's exit-1 contract. A spawned child cannot
// receive the injected `gh` client (ADR 001). This is also why the fan-out
// runs in-process at all. So a test could drive `scripts/gh.ts sync` through
// a real fan-out or a real merge-proof lookup. Either way, it would need the
// real `gh`.
//
// The #81 case instead spawns `fixtures/throwing-sync-entry.ts`. That fixture
// imports the real `createSyncCommand`, with a stand-in that throws instead
// of the job. Nothing can make the real job throw at all. That fixture's own
// header explains why. This test file mirrors, but does not call,
// `scripts/gh.ts`'s own `write` helper and its `sync` dispatch arm.
//
// Neither is importable. `fixtures/README.md` describes the gap that leaves.
// The exit-0 and exit-2 cases below spawn `scripts/gh.ts` itself. So they do
// exercise the real `write`. But a future defect confined to the exit-1 case
// in `scripts/gh.ts`'s own wiring would escape this file.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const BIN = pluginFile('gh', 'scripts', 'gh.ts')
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const THROWING_SYNC_ENTRY = path.join(FIXTURES, 'throwing-sync-entry.ts')
const THROWING_COMMAND_ENTRY = path.join(FIXTURES, 'throwing-command-entry.ts')

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
  // Nothing appears on stdout. A caller that parses it can never turn a
  // refusal into a result (`lib/envelope.ts`).
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
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'merged']) {
    expect(result.stdout).toContain(`gh.ts shepherd-pr <path> <number> ${action}`)
  }
})

it('refuses shepherd-pr with too few arguments, exit 2, usage on stderr', () => {
  // This tests the process boundary itself. A command that answers with a
  // status rather than an envelope still reaches `process.exitCode` through
  // the same adapter.
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
  // Issue #81: nothing can drive `syncRepo` into this state through the real
  // `gh.ts` binary (see `fixtures/throwing-sync-entry.ts` and
  // `fixtures/README.md`). So this test proves the envelope-to-exit-code
  // wiring that `createSyncCommand` and `renderText` share with
  // `scripts/gh.ts`, at a real process boundary. This test mirrors the
  // dispatch and `write` themselves. It does not call them. This matches a
  // review round 2 finding, the same one named in this file's own header
  // above.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))

  const result = runScript(THROWING_SYNC_ENTRY, { args: [repo], env: sandbox.env })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe('  ✗ the sync failed: boom\n')
  expect(result.stderr).toBe(`the sync to ${path.basename(repo)} failed\n`)
})

it('reports a command that throws as one stderr line, with no stack trace, and exits 1', () => {
  // #218 finding 7. This mirrors `scripts/gh.ts`'s own dispatch, the same
  // way `THROWING_SYNC_ENTRY` mirrors its `sync` arm and `write`, for the
  // same reason: nothing externally reachable can make a real command
  // throw through a spawned process with no `gh` (see that fixture's own
  // header, and `fixtures/README.md`).
  const result = runScript(THROWING_COMMAND_ENTRY, { args: [], env: env() })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('gh: boom\n')
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
