// `/audit:context` against real repositories, with `gh` injected (ADR 001).
// The command function is the only seam: `refs.ts`, `discover.ts` and
// `report.ts` are reached through it and never called directly, so what is
// asserted is the report a caller actually gets rather than an intermediate
// shape nobody consumes.
//
// Every fixture repository is a directory under `fixtures/repos/`, copied in
// and committed by `harness/git.ts` `importTree`, which undoes the two names a
// fixture cannot be stored under (`_gitignore`, `<name>.fixture.md`).
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
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
  expect(report.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
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

it('refuses a second positional, since there is only one root to audit', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, 'elsewhere'], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: `one root at most, not: ${audit.work} elsewhere`,
  })
})

it('refuses a count that is not a whole number', async () => {
  // A NaN or a fraction reaches a `slice` in layer 5, where it silently caps
  // the work at nothing and the run reports a clean result it never looked
  // for.
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--max-pairs', '2.5'], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: '--max-pairs must be a whole number, not "2.5"',
  })
})

it('refuses a pair threshold outside 0 to 1', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--pair-threshold', '1.5'], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: '--pair-threshold must be 0 to 1, not "1.5"',
  })
})

it('reads every tracked markdown file with --scope all', async () => {
  // The default scope keeps this fixture's docs/note.md out, which the first
  // test asserts; this is the other half of the same rule.
  const audit = audited('paths')

  await runContext([audit.work, '--json', '--scope', 'all'], audit.edges)

  expect(reportOf(audit.stdout()).files).toEqual([
    'CLAUDE.md',
    'docs/note.md',
    'plugins/demo/CLAUDE.md',
  ])
})

it('names --no-jev as the reason the model stages did not run', async () => {
  const audit = audited('paths')

  await runContext([audit.work, '--json', '--no-jev'], audit.edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_jev' },
    { stage: 'pairs', reason: 'no_jev' },
    { stage: 'evidence', reason: 'no_jev' },
  ])
})

it('says no_jev, not no_key, when a key is set and there is no client to spend it', async () => {
  // The harness sweeps TYPESAFE_API_KEY out of every sandbox, so a key is only
  // ever here because a test put it there. Until layer 4 lands the client, a
  // key that is present changes nothing, and reporting `no_key` beside one
  // would be a reason that is not true.
  const audit = audited('paths')
  audit.sandbox.env.TYPESAFE_API_KEY = 'set-but-unusable'

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_jev' },
    { stage: 'pairs', reason: 'no_jev' },
    { stage: 'evidence', reason: 'no_jev' },
  ])
})

it('writes the whole report to --out and still prints the findings', async () => {
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')

  const envelope = await runContext([audit.work, '--out', out], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(audit.stdout()).toContain('## tier 0: refs that do not resolve (0)')
  const written = JSON.parse(readFileSync(out, 'utf8')) as Report
  expect(written.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
})

it('refuses an --out that cannot be opened, before it reads anything', async () => {
  const audit = audited('paths')
  const out = audit.sandbox.join('a-directory')
  mkdirSync(out)

  const envelope = await runContext([audit.work, '--out', out], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    new RegExp(`^could not open ${out} for writing: EISDIR`),
  )
  expect(audit.stdout()).toBe('')
})

it('reports a path that is not there as the finding, in the findings text', async () => {
  const audit = audited('absent')

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(audit.stdout()).toBe(
    [
      '1 files, 1 units, 0 opaque',
      '',
      '## tier 0: refs that do not resolve (1)',
      '  CLAUDE.md:3  path `lib/gone.ts`  absent',
      '',
      '## tier 0: line references past the end of the file (0)',
      '',
      '## classify: skipped (no_key)',
      '',
      '## pairs: skipped (no_key)',
      '',
      '## evidence: skipped (no_key)',
      '',
    ].join('\n'),
  )
})

it('reports a line reference past the end of the file it names', async () => {
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[0]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/short.md:99',
      resolution: { status: 'line_out_of_range', repoPath: 'docs/short.md', lines: 3 },
    },
  ])
})

it('says unavailable, not absent, for a line reference whose file cannot be read', async () => {
  // The path is there and the count is not: a directory has no lines, and
  // reporting "the line is missing" would be a finding invented out of a
  // question that could not be asked.
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[1]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/dir:2',
      resolution: { status: 'unchecked', reason: 'unavailable' },
    },
  ])
})

it('resolves a line reference the file is long enough for, reading the file once', async () => {
  // Both refs name the same file in one unit, so the second answer comes from
  // the count the first one took rather than from a second read.
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/short.md:1',
      resolution: { status: 'found', repoPath: 'docs/short.md' },
    },
    {
      kind: 'file_line',
      value: 'docs/short.md:3',
      resolution: { status: 'found', repoPath: 'docs/short.md' },
    },
  ])
})

it('reads a line range by its end, which is the line that has to exist', async () => {
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[3]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/short.md:1-99',
      resolution: { status: 'line_out_of_range', repoPath: 'docs/short.md', lines: 3 },
    },
  ])
})

it('marks a path outside the tree and a glob unchecked, each with its own reason', async () => {
  // Neither is rot. A home-relative path is a fact about the machine running
  // the audit, and a glob is a shape an existence check would always fail, so
  // reporting either absent would be a finding invented out of a question that
  // was never asked.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units[1]?.refs).toEqual([
    {
      kind: 'path',
      value: '~/.claude/settings.json',
      resolution: { status: 'unchecked', reason: 'machine_specific' },
    },
  ])
  expect(report.units[2]?.refs).toEqual([
    {
      kind: 'path',
      value: 'plugins/*/skills/',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('falls back to the referencing file’s own directory when the root has no such path', async () => {
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
  expect(report.units[3]?.refs).toEqual([
    {
      kind: 'path',
      value: 'own.ts',
      resolution: { status: 'found', repoPath: 'plugins/demo/own.ts' },
    },
  ])
})

it('answers tail_match for a path that ends a tracked path at a segment boundary', async () => {
  // Prose names paths relative to a context the reader supplies, so this is
  // neither found nor absent, and reporting it absent would be the noisiest
  // false finding the audit can produce.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[0]?.refs).toEqual([
    {
      kind: 'path',
      value: 'nest/thing.ts',
      resolution: { status: 'tail_match', witness: 'deep/nest/thing.ts' },
    },
  ])
})

it('answers tail_match for a directory reference contained in a tracked path', async () => {
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[1]?.refs).toEqual([
    {
      kind: 'path',
      value: 'two/three/',
      resolution: { status: 'tail_match', witness: 'one/two/three/leaf.ts' },
    },
  ])
})

it('leaves a one-segment directory reference unchecked rather than absolving it', async () => {
  // `bin/` would match a tracked path in almost any repository, so a witness
  // for it proves nothing. Unchecked is the honest answer: it was not looked
  // for, rather than looked for and absolved.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    { kind: 'path', value: 'bin/', resolution: { status: 'unchecked', reason: 'pattern' } },
  ])
})

it('resolves a package script against the manifest that governs the file', async () => {
  // `pnpm install` is pnpm's own subcommand, not a script called "install", so
  // it is not a reference at all: reporting it absent would be a finding about
  // pnpm rather than about this repository.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units[0]?.refs).toEqual([
    { kind: 'script', value: 'pnpm test', resolution: { status: 'found', repoPath: null } },
  ])
  expect(report.units[1]?.refs).toEqual([
    { kind: 'script', value: 'pnpm build', resolution: { status: 'absent' } },
  ])
  expect(report.units[2]?.refs).toEqual([])
})

it('reads npm only in its explicit run form, and yarn the way it reads pnpm', async () => {
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units[3]?.refs).toEqual([
    { kind: 'script', value: 'npm run test', resolution: { status: 'found', repoPath: null } },
  ])
  expect(report.units[4]?.refs).toEqual([
    { kind: 'script', value: 'yarn test', resolution: { status: 'found', repoPath: null } },
  ])
  expect(report.units[5]?.refs).toEqual([
    { kind: 'script', value: 'pnpm run test', resolution: { status: 'found', repoPath: null } },
  ])
})
