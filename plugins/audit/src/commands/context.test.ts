// `/audit:context` against real repositories, with `gh` injected (ADR 001).
// The command function is the only seam: `refs.ts`, `discover.ts` and
// `report.ts` are reached through it and never called directly, so what is
// asserted is the report a caller actually gets rather than an intermediate
// shape nobody consumes.
//
// Every fixture repository is a directory under `fixtures/repos/`, copied in
// and committed by `harness/git.ts` `importTree`, which undoes the two names a
// fixture cannot be stored under (`_gitignore`, `<name>.fixture.md`).
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGhMock, type GhClient, type GhReplies } from '../../../../harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import type { Report } from '../report.ts'
import { type ContextEdges, runContext } from './context.ts'

const REPOS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'repos')

/** stdout and stderr as strings, the way `sync.test.ts` captures them. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })
  return {
    output: createOutput(stream(out), stream(err)),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

interface Audited {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly work: string
  readonly edges: ContextEdges
  stdout(): string
  stderr(): string
}

/** A repository holding fixture `name`, and the edges to audit it with.
 *
 *  `now` counts in whole milliseconds from zero, so `wallClockMs` is a literal
 *  a test can assert rather than a duration it has to tolerate. `createGh`
 *  answers from `replies`, and an endpoint with no reply throws, which is what
 *  proves a fixture with no issue references never reaches `gh` at all. */
function audited(name: string, replies: GhReplies = {}): Audited {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.importTree(work, path.join(REPOS, name))
  const captured = capture()
  let tick = 0
  const edges: ContextEdges = {
    cwd: sandbox.path,
    env: sandbox.env,
    output: captured.output,
    createGh: (): GhClient => createGhMock(replies),
    now: () => {
      tick += 1
      return tick
    },
  }
  return { sandbox, git, work, edges, stdout: captured.stdout, stderr: captured.stderr }
}

/** The JSON report `--json` wrote, parsed. */
const reportOf = (stdout: string): Report => JSON.parse(stdout) as Report

it('resolves a path its CLAUDE.md names, and skips every model stage with no key', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  // The command writes the report itself and answers with an empty payload, so
  // `bin/audit.ts` adds nothing after it (`lib/envelope.ts` `renderText`).
  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  const report = reportOf(audit.stdout())
  expect(report.files).toEqual(['CLAUDE.md'])
  expect(report.units[0]?.refs).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
  expect(report.skipped).toEqual([
    { stage: 'classify', reason: 'no_key' },
    { stage: 'pairs', reason: 'no_key' },
    { stage: 'evidence', reason: 'no_key' },
  ])
  expect(report.issueLookup).toBe('ok')
})

it('refuses a path that is inside no checkout, and writes nothing to stdout', async () => {
  const audit = audited('paths')
  const outside = audit.sandbox.join('outside')
  mkdirSync(outside)

  const envelope = await runContext([outside], audit.edges)

  expect(envelope).toEqual({ outcome: 'refused', error: `not a git repository: ${outside}` })
  expect(audit.stdout()).toBe('')
})

it('tells a git that is not installed apart from a directory outside any checkout', async () => {
  // Both answer "no root" through `toplevel`, and a reader sent to look for a
  // checkout when the real problem is a missing git is sent to the wrong
  // place. Only a PATH without git can provoke it, which is what
  // `pathWithout` is for.
  const audit = audited('paths')
  audit.sandbox.env.PATH = audit.sandbox.pathWithout('git')

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'refused', error: 'missing git: spawn git ENOENT' })
})

it('refuses when git will not list the tracked files', async () => {
  // The shim fails `ls-files` alone, so the checkout still resolves and the
  // audit reaches the one question it cannot do without. Reading an
  // unanswerable question as an empty tree would report a clean repository.
  const audit = audited('paths')
  const shim = audit.git.gitShim('ls-files')
  audit.sandbox.stubPath(shim.directory)
  audit.sandbox.env.GIT_STUB_FAIL = shim.failing

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: `could not list the tracked files of ${realpathSync(audit.work)}`,
  })
})

it('answers --help with its own usage, before anything is parsed or read', async () => {
  // A raw scan of the tokens, the way `plugins/mermaid` resolves it: usage
  // wins over a bad `--scope` rather than losing to it, and asking what a
  // command does is not a mistake.
  const audit = audited('paths')

  const envelope = await runContext(['--scope', 'nonsense', '--help'], audit.edges)

  expect(envelope.outcome).toBe('ok')
  expect(envelope.outcome === 'ok' && envelope.value).toMatch(/^usage: audit\.ts context \[root\]/)
  expect(audit.stdout()).toBe('')
})
