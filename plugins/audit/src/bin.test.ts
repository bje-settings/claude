// The one spawned contract test for `scripts/audit.ts` (`harness/README.md`):
// argv in, exit code and streams out. Everything else about this command is
// exercised in-process in `commands/context.test.ts`. This is the only place
// where the process boundary itself, and the floor guard in front of it, are
// real.
//
// The real run at the end uses a fixture with no issue reference in it. So
// the child needs no `gh`. A spawned child cannot be handed the injected
// client (ADR 001). A fixture that named an issue would reach for the real
// `gh`.
//
// The same is true for Jev, one step further. The sandbox sweeps
// `TYPESAFE_API_KEY`. This adapter builds the REAL client from whatever key
// exists. So the only model path a spawned test can take has no key and no
// client at all. A fake key here would not make a fake call. It would make
// a real one.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { createSandbox } from '../../../harness/sandbox.ts'
import { runScript } from '../../../harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, '..', 'scripts', 'audit.ts')
const REPOS = path.join(HERE, 'fixtures', 'repos')

/** The sandbox's environment, so the child carries no `GIT_`, `GH_` or
 *  `TYPESAFE_API_KEY` this test did not choose. */
const env = (): NodeJS.ProcessEnv => createSandbox().env

it('prints the command list with no arguments at all, and exits 0', () => {
  const result = runScript(BIN, { args: [], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: audit\.ts <command>/)
  expect(result.stdout).toContain('context')
  expect(result.stderr).toBe('')
})

it('answers --help the same way, because asking what this does is not a mistake', () => {
  const result = runScript(BIN, { args: ['--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: audit\.ts <command>/)
})

it('prints the context command’s own usage for its --help', () => {
  const result = runScript(BIN, { args: ['context', '--help'], env: env() })

  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^usage: audit\.ts context \[root\]/)
  expect(result.stderr).toBe('')
})

it('refuses a subcommand nobody answers to, with the list on stderr', () => {
  const result = runScript(BIN, { args: ['nope'], env: env() })

  expect(result.status).toBe(2)
  // Nothing on stdout: a caller that parses it can never parse a refusal
  // into a result (`lib/envelope.ts`).
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('unknown command: nope')
  expect(result.stderr).toContain('usage: audit.ts <command>')
})

it('refuses an unknown flag on the command, exit 2, with nothing on stdout', () => {
  const result = runScript(BIN, { args: ['context', '--nope'], env: env() })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^Unknown option '--nope'/)
})

it('refuses a root that is inside no checkout', () => {
  const sandbox = createSandbox()

  const result = runScript(BIN, { args: ['context', sandbox.path], env: sandbox.env })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`not a git repository: ${sandbox.path}\n`)
})

it('audits a real checkout end to end, with no key and no gh to reach', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.importTree(work, path.join(REPOS, 'absent'))

  const result = runScript(BIN, { args: ['context', work], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('  CLAUDE.md:3  path `lib/gone.ts`  absent')
  expect(result.stdout).toContain('## classify: skipped (no_key)')
  // Nothing was spent. This is the other half of "no client was built".
  expect(result.stdout).toContain('## failures (0)')
  expect(result.stdout).toMatch(/## usage: 0 requests \(0 attempts\), 0 input tokens,/)
})
