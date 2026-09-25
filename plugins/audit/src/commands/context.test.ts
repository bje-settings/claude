// `/audit:context` against real repositories, with `gh` injected (ADR 001).
// The command function is the only seam. Tests reach `refs.ts`, `discover.ts`
// and `report.ts` only through it, never directly. This proves the report a
// caller actually gets, not an intermediate shape nobody consumes.
//
// Every fixture repository is a directory under `fixtures/repos/`.
// `harness/git.ts` `importTree` copies it in and commits it. This undoes the
// two names a fixture cannot use for its own files: `_gitignore` and
// `<name>.fixture.md`.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGhMock, type GhClient, GhError, type GhReplies } from '../../../../harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '../../../../harness/git.ts'
import {
  type ChoiceAnswer,
  type Classification,
  createJevMock,
  type EvidenceNeed,
  type EvidenceVerdict,
  JevError,
  type JevReplies,
  type JevSequences,
  type JevUnit,
  jevFails,
  type PairVerdict,
  type UnitKind,
} from '../../../../harness/jev.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import type { Report } from '../report.ts'
import type { Ref, Unit } from '../types.ts'
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
 *  `now` counts in whole milliseconds from zero. This makes `wallClockMs` a
 *  literal value a test can assert, not a duration it must tolerate.
 *  `createGh` answers from `replies`. An endpoint with no reply throws. This
 *  proves a fixture with no issue references never reaches `gh` at all. */
function audited(
  name: string,
  replies: GhReplies = {},
  jev: JevReplies = {},
  sequences: JevSequences = {},
): Audited {
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
    createJev: () => createJevMock(jev, sequences),
    now: () => {
      tick += 1
      return tick
    },
  }
  return { sandbox, git, work, edges, stdout: captured.stdout, stderr: captured.stderr }
}

/** The same repository, with a key in the environment. This makes the model
 *  stages run. `createJev` answers from `jev`, or from `sequences` where a
 *  stage's calls must differ from each other. The key is never a real one:
 *  the mock answers, and `harness/sandbox.ts` swept the real variable out
 *  first. */
function modelled(
  name: string,
  jev: JevReplies,
  replies: GhReplies = {},
  sequences: JevSequences = {},
): Audited {
  const audit = audited(name, replies, jev, sequences)
  audit.sandbox.env.TYPESAFE_API_KEY = 'test-key'
  return audit
}

/** A Choice answer that picked `choice` outright. */
const picked = <T extends string>(choice: T, confidence = 1): ChoiceAnswer<T> => ({
  choice,
  probabilities: { [choice]: 1 } as Record<T, number>,
  confidence,
})

/** The JSON report `--json` wrote, parsed. */
const reportOf = (stdout: string): Report => JSON.parse(stdout) as Report

/** A findings line that names one judgment and its confidence. Its ORDER
 *  within a section is what a ranked section means. */
const isConfLine = (line: string): boolean => line.startsWith('  conf ')

/** The opaque blocks of one file, in document order. Indexed by file, not by
 *  position in the whole report. A fixture that grows another file then does
 *  not renumber every assertion. */
const blocksIn = (report: Report, file: string) =>
  report.opaque.filter((block) => block.file === file)

it('resolves a path its CLAUDE.md names, and skips every model stage with no key', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  // The command writes the report itself. It answers with an empty payload.
  // So `scripts/audit.ts` adds nothing after it (`lib/envelope.ts` `renderText`).
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
  // Both answer "no root" through `toplevel`. But the real problem may be a
  // missing git, not a missing checkout, and a reader who looks for a
  // checkout is sent to the wrong place. Only a PATH without git can provoke
  // it, which is what `pathWithout` is for.
  const audit = audited('paths')
  audit.sandbox.env.PATH = audit.sandbox.pathWithout('git')

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'refused', error: 'missing git: spawn git ENOENT' })
})

it('refuses when git will not list the tracked files', async () => {
  // The shim fails `ls-files` alone. The checkout still resolves, so the audit
  // reaches the one question it cannot do without. The run must not treat an
  // unanswerable question as an empty tree, because that would report a clean
  // repository that is not clean.
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
  // A raw scan of the tokens, the way `plugins/mermaid` resolves it. Usage
  // wins over a bad `--scope`, and it does not lose to it. A user who asks
  // what a command does has not made a mistake.
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
  // A NaN or a fraction reaches a `slice` in layer 5. There it silently caps
  // the work at nothing. The run then reports a clean result it never looked
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
  // The default scope keeps this fixture's docs/note.md out. The first test
  // asserts that. This test checks the other half of the same rule.
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

it('reads --no-jev before the key, and builds no client at all', async () => {
  // The harness sweeps TYPESAFE_API_KEY out of every sandbox. A key is here
  // only because a test put it there. A caller who asked for tier 0 alone is
  // told that. The caller is not told about a key it did not offer. The mock
  // has no reply registered for anything, so a stage that ran would throw,
  // not pass quietly.
  const audit = modelled('paths', {})

  await runContext([audit.work, '--json', '--no-jev'], audit.edges)

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
      '## tier 0: refs not checked',
      '',
      '## classify: skipped (no_key)',
      '',
      '## pairs: skipped (no_key)',
      '',
      '## evidence: skipped (no_key)',
      '',
      '## failures (0)',
      '',
      '## usage: 0 requests (0 attempts), 0 input tokens, 0 ms summed request time, 1 ms wall clock',
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
  // The path is there, but the count is not: a directory has no lines. If the
  // run reports "the line is missing", that finding is invented. It comes
  // from a question that could not be asked.
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
  // Both refs name the same file in one unit. The second answer comes from
  // the count the first one took, not from a second read.
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
  // Neither is rot. A home-relative path is a fact about the machine that
  // runs the audit. A glob is a shape that an existence check always fails.
  // If the run reports either as absent, that finding is invented, from a
  // question that was never asked.
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
  expect(unitNaming(report, 'beside this file')).toEqual([
    {
      kind: 'path',
      value: 'own.ts',
      resolution: { status: 'found', repoPath: 'plugins/demo/own.ts' },
    },
  ])
})

it('answers tail_match for a path that ends a tracked path at a segment boundary', async () => {
  // Prose names paths relative to a context the reader supplies. This is
  // neither found nor absent. If the run reports it as absent, that is the
  // noisiest false finding the audit can produce.
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
  // for it proves nothing. Unchecked is the honest answer. It says the value
  // was not checked, not that it was checked and cleared.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    { kind: 'path', value: 'bin/', resolution: { status: 'unchecked', reason: 'pattern' } },
  ])
})

it('resolves a package script against the manifest that governs the file', async () => {
  // `pnpm install` is pnpm's own subcommand, not a script named "install". So
  // it is not a reference at all. If the run reports it as absent, that
  // finding is about pnpm, not about this repository.
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

it('walks up to the manifest that governs a nested file, and stops at one that will not parse', async () => {
  // Two rules apply in one fixture. A nested file inherits the root manifest.
  // A manifest that cannot be read counts as `unavailable`, not as a missing
  // script. The run stops there on purpose. It could not read the file that
  // governs this one, so nothing further up answers the question.
  //
  // The unreadable manifest here is a directory in the manifest's place. This
  // is the only shape of "cannot be read" this repository can commit. A
  // deliberately malformed `.json` file would make the linter reject it.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const refsIn = (file: string) => report.units.filter((unit) => unit.file === file)[0]?.refs
  expect(refsIn('nested/CLAUDE.md')).toEqual([
    { kind: 'script', value: 'pnpm test', resolution: { status: 'found', repoPath: null } },
  ])
  expect(refsIn('broken/CLAUDE.md')).toEqual([
    {
      kind: 'script',
      value: 'pnpm test',
      resolution: { status: 'unchecked', reason: 'unavailable' },
    },
  ])
})

it('says no_resolver for a script in a tree with no manifest at all', async () => {
  // Nothing to resolve against is not the same finding as a script that is
  // missing from a manifest that exists.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[3]?.refs).toEqual([
    {
      kind: 'script',
      value: 'pnpm test',
      resolution: { status: 'unchecked', reason: 'no_resolver' },
    },
  ])
})

it('reads a manifest that declares no scripts as a manifest, not as a missing one', async () => {
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const unit = report.units.filter((entry) => entry.file === 'noscripts/CLAUDE.md')[0]
  expect(unit?.refs).toEqual([
    { kind: 'script', value: 'pnpm test', resolution: { status: 'absent' } },
  ])
})

it('reads a manifest whose scripts key is null as one declaring none', async () => {
  // `typeof null` is `'object'`. So the null arm of the guard is the only
  // thing between this manifest and `Object.hasOwn(null, ...)`. That call
  // throws and takes the whole run down, over one word in one file.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const unit = report.units.filter((entry) => entry.file === 'nullscripts/CLAUDE.md')[0]
  expect(unit?.refs).toEqual([
    { kind: 'script', value: 'pnpm test', resolution: { status: 'absent' } },
  ])
})

it('reads the refs in a fenced code block, commands included', async () => {
  // A fenced block never goes to the model. Tier 0 is the only stage that
  // reads it. A command line that names a path is exactly where a stale path
  // hides.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]?.refs).toEqual([
    { kind: 'command', value: 'pnpm', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    { kind: 'script', value: 'pnpm test', resolution: { status: 'found', repoPath: null } },
    { kind: 'command', value: 'node', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
    { kind: 'command', value: 'node', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
  ])
})

it('takes no refs at all out of a mermaid diagram', async () => {
  // A diagram's `#` marks are colours, and its arrows are not paths. So every
  // ref it could yield would be false. This fixture's diagram carries both
  // shapes on purpose.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  const diagram = blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[1]
  expect(diagram?.kind).toBe('mermaid')
  expect(diagram?.refs).toEqual([])
})

it('gives each issue reference the state the lookup answered with', async () => {
  // A number the lookup left out is `unavailable`, never absent. The reason it
  // is missing may be a permissions error or a rate limit. If the run reports
  // that as "no such issue", the finding is invented, from a failure to ask.
  const audit = audited('issues', {
    issueStates: {
      states: { '170': 'OPEN', '164': 'CLOSED', '4242': 'not_found' },
      unavailable: null,
    },
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units.map((unit) => unit.refs)).toEqual([
    [{ kind: 'issue', value: '#170', resolution: { status: 'issue', state: 'OPEN' } }],
    [{ kind: 'issue', value: '#164', resolution: { status: 'issue', state: 'CLOSED' } }],
    [{ kind: 'issue', value: '#4242', resolution: { status: 'absent' } }],
    [{ kind: 'issue', value: '#999', resolution: { status: 'unchecked', reason: 'unavailable' } }],
  ])
  expect(report.issueLookup).toBe('ok')
})

it('carries the lookup’s own reason into the report and the findings text', async () => {
  const audit = audited('issues', {
    issueStates: { states: {}, unavailable: 'API rate limit exceeded' },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('  issue lookup unavailable: API rate limit exceeded')
})

it('catches a gh failure into the lookup reason, leaving every issue unchecked', async () => {
  // The real client folds its own failures into `unavailable` and never
  // throws. But a caller that trusted that, and then reached for `.states` on
  // a rejection, would take the whole audit down over one lookup.
  //
  // Built here rather than with `ghFails`, whose `detail` is only its message.
  // The two differ the way they do on a real failure: `message` carries the
  // whole argv, and `detail` is gh's own line. A report line that quoted
  // `message` would carry the `--json` fields with it. That is the defect
  // issue #159 found. With the two equal, nothing would notice.
  const audit = audited('issues', {
    issueStates: new GhError(
      'gh issue list --json number,state failed: gh: could not resolve to a Repository',
      1,
      { cause: null, detail: 'gh: could not resolve to a Repository' },
    ),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.issueLookup).toBe('gh: could not resolve to a Repository')
  expect(report.units.map((unit) => unit.refs[0]?.resolution)).toEqual([
    { status: 'unchecked', reason: 'unavailable' },
    { status: 'unchecked', reason: 'unavailable' },
    { status: 'unchecked', reason: 'unavailable' },
    { status: 'unchecked', reason: 'unavailable' },
  ])
})

it('does not read a scoped package name as a path', async () => {
  // `@scope/name` has a slash and is not a path. If the run reports it as
  // absent, that gives a reader a finding to dismiss in every repository with
  // a dependency.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[0]?.refs).toEqual([])
})

it('does not read an owner/name@ref pin as a path', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[1]?.refs).toEqual([])
})

it('treats an env-templated path as a placeholder rather than a missing file', async () => {
  // `${VAR}` is the spelling a skill writes. No existence check can ever
  // succeed on it. It is a shape, which is a different fact from an absence.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    {
      kind: 'path',
      value: `\${CLAUDE_PLUGIN_ROOT}/scripts/audit.ts`,
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('resolves a number-only record reference against the one file that starts with it', async () => {
  // Prose names a record by its number, `docs/adr/022`, while the file carries
  // a slug after it. One tracked path that starts with the value and a
  // separator is that file. If the run reports it as absent, that finding is
  // about a naming convention, not about rot.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[3]?.refs).toEqual([
    {
      kind: 'path',
      value: 'docs/adr/022',
      resolution: { status: 'found', repoPath: 'docs/adr/022-slug.md' },
    },
  ])
})

it('does not resolve a number-only reference that two files could answer to', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[4]?.refs).toEqual([
    { kind: 'path', value: 'docs/adr/099', resolution: { status: 'absent' } },
  ])
})

it('answers ignored, not absent, for a path this repository’s own rules exclude', async () => {
  // A build output is not in the tree because it is not meant to be there. If
  // the run reports it as absent, that makes every repository with a
  // `.gitignore` noisy in exactly the places its own rules already explain.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[5]?.refs).toEqual([
    { kind: 'path', value: 'build/output.js', resolution: { status: 'ignored' } },
  ])
})

it('answers ignored for a line reference into an ignored file too', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[6]?.refs).toEqual([
    { kind: 'file_line', value: 'build/output.js:12', resolution: { status: 'ignored' } },
  ])
})

it('skips a uses: value in a yaml block, which names another repository’s file', async () => {
  // GitHub Actions resolves a `uses:` value against the repository and ref it
  // names, not against this checkout. So an existence check here answers a
  // question nobody asked. The `run:` line beside it still yields its script.
  // That is what proves the block was read at all.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).opaque[0]?.refs).toEqual([
    {
      kind: 'script',
      value: 'pnpm test',
      resolution: { status: 'unchecked', reason: 'no_resolver' },
    },
  ])
})

it('takes no issue reference from a URL, a cross-repo slug, a colour or a padded number', async () => {
  // The gh double has no reply registered at all, so an endpoint reached here
  // throws. This fixture proves two things: the four shapes all yield
  // nothing, and a repository that names no issue never reaches gh.
  //
  // The colours are two. `#000` is refused by the leading zero alone. `#123`
  // is refused only by the `:` that touches it, which is the rule this test
  // exercises on its own. The URL carries no path, so the cross-repo rule
  // cannot reach it either, and the URL rule alone drops it.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const naming = (text: string) => report.units.filter((unit) => unit.text.includes(text))[0]?.refs
  expect(naming('The thread is at')).toEqual([])
  expect(naming("Another repository's")).toEqual([])
  expect(naming('classDef')).toEqual([])
  expect(naming('zero-padded')).toEqual([])
  expect(report.issueLookup).toBe('ok')
})

it('keeps a closed issue out of the findings text, and an unfindable one in', async () => {
  // A closed issue is not a finding on its own. A history line cites one
  // correctly, and on this repository nearly every such citation is history.
  // The state is in the JSON report for layer 5, whose model judgment decides
  // which of them is rot. An issue nobody can find is an absence like any
  // other. That one is a finding.
  const audit = audited('issues', {
    issueStates: {
      states: { '170': 'OPEN', '164': 'CLOSED', '4242': 'not_found' },
      unavailable: null,
    },
  })

  await runContext([audit.work], audit.edges)

  const text = audit.stdout()
  expect(text).not.toContain('issues cited')
  expect(text).not.toContain('#164')
  expect(text).toContain('  CLAUDE.md:7  issue `#4242`  absent')
})

it('tallies what tier 0 did not settle, by kind and reason', async () => {
  // Without this, "unchecked" reads as "fine". A reader has no way to tell a
  // repository whose refs all resolved apart from one whose refs were mostly
  // never checked.
  const audit = audited('tails')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## tier 0: refs not checked',
      '  1  path pattern',
      '  2  path tail_match',
      '  1  script no_resolver',
    ].join('\n'),
  )
})

it('names every line reference past the end of its file, with the count it has', async () => {
  const audit = audited('lines')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## tier 0: line references past the end of the file (3)',
      '  CLAUDE.md:3  file_line `docs/short.md:99`  only 3 lines',
      '  CLAUDE.md:9  file_line `docs/short.md:1-99`  only 3 lines',
      '  CLAUDE.md:11  file_line `docs/empty.txt:1`  only 0 lines',
    ].join('\n'),
  )
})

it('leads with the splitter’s warnings, so the counts beside them are not trusted', async () => {
  // A fence that never closes swallows the rest of the file. So the unit
  // count under it is not the file's own count. The warning must sit where a
  // reader sees it before the findings.
  const audit = audited('warn')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toMatch(
    /^1 files, 1 units, 1 opaque\n {2}warning: CLAUDE\.md:5 unclosed_fence\n/,
  )
})

it('reads a file:line inside a code block, and leaves a ../ example unchecked', async () => {
  // An example writes a `../` path relative to whatever directory the example
  // runs from. That directory is not the referencing file's own directory, so
  // there is nowhere to look for the path. It is a shape, not an absence. A
  // comment line carries no command, but its file:line is still a reference.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[2]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'scripts/build.ts:1',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
    { kind: 'command', value: 'node', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    {
      kind: 'path',
      value: '../other/tool.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('refuses an unknown flag, with nothing on stdout', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--nope'], audit.edges)

  // This is node's own wording, passed through rather than rewritten. It
  // names the token the caller typed, which is what a caller needs
  // (`lib/args.ts`).
  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(/^Unknown option '--nope'/)
  expect(audit.stdout()).toBe('')
})

it('audits the directory it was called in when no root is given', async () => {
  const audit = audited('absent')
  const edges = { ...audit.edges, cwd: audit.work }

  await runContext(['--json'], edges)

  expect(reportOf(audit.stdout()).files).toEqual(['CLAUDE.md'])
})

it('reads the paths in a fence with no info string, but takes no commands from it', async () => {
  // A fence with no language is not known to be a shell. So its first words
  // are not commands. But the paths written in it are still paths.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[3]?.refs).toEqual([
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
  ])
})

it('reads the refs in a file’s frontmatter, issue numbers included', async () => {
  // Frontmatter never goes to the model either. A skill's frontmatter is
  // exactly where a path to a renamed script sits unnoticed. An issue number
  // is read there, and in a fence too. Only a mermaid diagram is exempt.
  // Without this test, the diagram's own early return would be the only thing
  // that proves it.
  const audit = audited('opaque', {
    issueStates: { states: { '164': 'CLOSED' }, unavailable: null },
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const front = blocksIn(report, '.claude/notes.md')[0]
  expect(front?.file).toBe('.claude/notes.md')
  expect(front?.refs).toEqual([
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
    { kind: 'issue', value: '#164', resolution: { status: 'issue', state: 'CLOSED' } },
  ])
})

it('counts a last line with no final newline, and an empty file as no lines', async () => {
  // A trailing newline ends the last line; it does not start an empty one. So
  // a one-line file with no trailing newline still has a line 1. An empty
  // file has no line at all to point at. This is not `wc -l`, which counts
  // newlines and would answer 0 for that one-line file.
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[4]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/empty.txt:1',
      resolution: { status: 'line_out_of_range', repoPath: 'docs/empty.txt', lines: 0 },
    },
    {
      kind: 'file_line',
      value: 'docs/oneline.txt:1',
      resolution: { status: 'found', repoPath: 'docs/oneline.txt' },
    },
  ])
})

it('takes no path out of code that merely quotes one', async () => {
  // `run('scripts/build.ts')` trims to `run('scripts/build.ts`. Nobody wrote
  // that as a path: the token is code around a path, not a path itself. A
  // brace on its own trims to nothing at all.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[4]?.refs).toEqual([])
})

it('reads a backticked URL as no path and a bare well-known filename as one', async () => {
  // A URL has slashes and is no path in the tree. `CLAUDE.md` has an extension
  // too generic to qualify by suffix, so it is a path by name instead.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units.at(-1)?.refs).toEqual([
    { kind: 'path', value: 'CLAUDE.md', resolution: { status: 'found', repoPath: 'CLAUDE.md' } },
  ])
})

it('strips a shell prompt before reading the command on the line', async () => {
  // A transcript writes `$ pnpm test`. If the run reports `$` as the command,
  // that finding is about the prompt, not about this repository.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]?.refs[0]).toEqual({
    kind: 'command',
    value: 'pnpm',
    resolution: { status: 'unchecked', reason: 'no_resolver' },
  })
})

/** The refs of the one unit whose text contains `text`. A fixture that grows
 *  a paragraph then does not renumber every assertion beside it. */
const unitNaming = (report: Report, text: string): Ref[] | undefined =>
  report.units.find((unit) => unit.text.includes(text))?.refs

it('asks git about a path outside the tree without losing the answer for the rest', async () => {
  // `git check-ignore` does not skip a path it cannot place. One value outside
  // the repository aborts the whole batch with exit 128. The run shares that
  // batch across every absent ref. If the run sent one bad value, every
  // correctly ignored path in the repository would become a headline finding.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(unitNaming(report, 'bundle is written')).toEqual([
    { kind: 'path', value: 'build/out.js', resolution: { status: 'ignored' } },
  ])
  // The value that cannot be asked about is still answered, from the tree.
  expect(unitNaming(report, 'sibling checkout')).toEqual([
    { kind: 'path', value: '../other/tool.ts', resolution: { status: 'absent' } },
  ])
  // The first segment is what leaves the tree, not the first two characters. A
  // directory whose name merely starts with them is still git's to answer
  // about. A prefix test would drop it and wrongly report it as absent.
  expect(unitNaming(report, 'scratch copy')).toEqual([
    { kind: 'path', value: '..cache/out.js', resolution: { status: 'ignored' } },
  ])
})

it('answers ignored for a path written inside a fenced block too', async () => {
  // Build output is named in a command line more often than in prose. A
  // block's refs go through the same ignore pass, or they do not go through
  // it at all.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const fence = report.opaque.find((block) => block.text.includes('scripts/build.ts'))
  expect(fence?.refs.find((ref) => ref.value === 'build/nested.js')?.resolution).toEqual({
    status: 'ignored',
  })
})

it('never asks git whether a missing script is ignored', async () => {
  // A script is a name in a manifest, not a path git has an opinion about.
  // This fixture ignores `pnpm*`. So a script value that reached the batch
  // would come back ignored, and a real missing script would no longer count
  // as a finding.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'this manifest does not declare')).toEqual([
    { kind: 'script', value: 'pnpm missing', resolution: { status: 'absent' } },
  ])
})

it('says the ignore check was unavailable rather than reporting absent as settled', async () => {
  // The shim fails `check-ignore` alone, so everything else still resolves. If
  // the run reads an unanswerable question as "nothing here is ignored", it
  // publishes every ignored path as a finding, with no sign anything went
  // wrong. An exclude file git cannot read makes `check-ignore` exit 128 for
  // the whole batch. This is a real repository state, not a stubbed one.
  const audit = audited('ignored')
  const notAFile = audit.sandbox.join('excludes-dir')
  mkdirSync(notAFile)
  audit.git.git(audit.work, 'config', 'core.excludesFile', notAFile)

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('  ignore check unavailable: git check-ignore exited 128')
  expect(audit.stdout()).toContain('  CLAUDE.md:3  path `build/out.js`  absent')
})

it('reports a lookup that threw something other than a GhError as unavailable', async () => {
  // `GhError` is the only failure the client declares, but the catch exists
  // because something else might throw. If the code reads `.detail` off
  // whatever was thrown, it gets `undefined`. That `undefined` folds to the
  // report's success value. So a mis-wired client would publish "the lookup
  // succeeded" while every issue ref silently said unavailable.
  const audit = audited('issues')
  const edges: ContextEdges = {
    ...audit.edges,
    createGh: () => {
      throw new TypeError('gh client is not wired')
    },
  }

  await runContext([audit.work, '--json'], edges)

  const report = reportOf(audit.stdout())
  expect(report.issueLookup).toContain('gh client is not wired')
  expect(report.issueLookup).not.toBe('ok')
})

it('refuses, naming the file, when a tracked markdown file is not on disk', async () => {
  // `git ls-files` lists the index, but the read comes from the working tree.
  // The two differ in ordinary use: a staged deletion, a `git mv` in flight, a
  // sparse checkout. If the read were to throw, the run would end with node's
  // own `fs` stack trace and no envelope. The caller would then get neither
  // findings nor a sentence it can act on.
  const audit = audited('paths')
  rmSync(path.join(audit.work, 'CLAUDE.md'))

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    /^could not read CLAUDE\.md, which git lists as tracked: ENOENT/,
  )
  expect(audit.stdout()).toBe('')
})

it('takes no command from a bare prompt, an assignment or a sudo', async () => {
  // A transcript writes a lone `$` between commands. An example writes
  // `CI=1 ...` or `sudo ...` in front of the command it means. If the run
  // reports `$`, `CI=1` or `sudo` as the command, that finding is about the
  // shell line, not about this repository.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  const commands = blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]
    ?.refs.filter((ref) => ref.kind === 'command')
    .map((ref) => ref.value)
  expect(commands).toEqual(['pnpm', 'node', 'node'])
})

it('reads each placeholder character as a template on its own', async () => {
  // `{` and `$` are separate rules, because either spelling alone makes the
  // value a template. A fixture that carries both at once satisfies either
  // rule. So neither rule is held to anything.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(unitNaming(report, 'no braces at all')).toEqual([
    {
      kind: 'path',
      value: '$CLAUDE_PLUGIN_ROOT/scripts/audit.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
  expect(unitNaming(report, 'named by a brace')).toEqual([
    {
      kind: 'path',
      value: 'dist/{name}/index.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('does not absolve a value that ends a tracked path mid-segment', async () => {
  // The tail rule compares against `/` plus the value. So `est/thing.ts` is
  // not answered by `deep/nest/thing.ts`. Without the boundary, a witness
  // could be found for almost any suffix, and `tail_match` would absolve
  // everything.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'partial segment')).toEqual([
    { kind: 'path', value: 'est/thing.ts', resolution: { status: 'absent' } },
  ])
})

it('reads a bare npm subcommand as no script at all', async () => {
  // npm is the one manager whose bare subcommands are not also script
  // shorthands. So only `npm run <name>` is a script. This is tested in the
  // negative case too, since the positive case passes whichever rule applies.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'only the explicit run form')).toEqual([])
})

it('prefers the root over the referencing file when both hold the path', async () => {
  // Prose names paths from the root far more often than from the file it is
  // written in. So the root's path is the one meant. With only one of the two
  // present anywhere, the order the two lookups run in proves nothing.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  // The ref is written in `plugins/demo/CLAUDE.md`. `lib/x.ts` exists both at
  // the root and beside that file. So the two lookups disagree, and the
  // answer shows which one ran first.
  expect(unitNaming(reportOf(audit.stdout()), 'which exists here and at the root')).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
})

it('refuses a bad value for either count, not only the first', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--max-evidence', 'abc'], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: '--max-evidence must be a whole number, not "abc"',
  })
})

it('measures the run on the clock it was given, rounded to whole milliseconds', async () => {
  // `now` is an edge case, so `wallClockMs` is a literal value, not a duration
  // a test must tolerate. The rounding exists because the real clock is
  // `performance.now()`, whose fractions are noise in a report and in a diff.
  const audit = audited('paths')
  const ticks = [0, 1.6]
  const edges: ContextEdges = { ...audit.edges, now: () => ticks.shift() as number }

  await runContext([audit.work, '--json'], edges)

  expect(reportOf(audit.stdout()).wallClockMs).toBe(2)
})

it('audits the checkout a subdirectory belongs to, and asks gh about that root', async () => {
  // The root is the toplevel, not the directory the caller named. `gh`
  // resolves the repository from the working directory it is built with. So a
  // client built with the caller's own path would ask about whatever
  // repository happened to sit there.
  const audit = audited('issues')
  const asked: string[] = []
  const edges: ContextEdges = {
    ...audit.edges,
    createGh: (cwd: string): GhClient => {
      asked.push(cwd)
      return createGhMock({ issueStates: { states: {}, unavailable: null } })
    },
  }
  const below = path.join(audit.work, 'below')
  mkdirSync(below)

  await runContext([below, '--json'], edges)

  const report = reportOf(audit.stdout())
  expect(report.root).toBe(realpathSync(audit.work))
  expect(report.files).toEqual(['CLAUDE.md'])
  expect(asked).toEqual([realpathSync(audit.work)])
})

it('trims a code span before reading it, so padding is not part of the value', async () => {
  // A writer pads a span for readability. Without the trim, the value carries
  // the spaces. `looksLikePath` refuses it because it contains whitespace, and
  // the reference is dropped rather than resolved.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'written with padding')).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
})

it('leaves an existing --out file alone when the run refuses', async () => {
  // The pre-open is a probe. A probe that truncates would destroy the
  // caller's last report before it writes anything new.
  //
  // The refusal must happen AFTER the probe runs. Otherwise the probe never
  // runs, and the assertion passes under either mode. A bad root is the first
  // such case. A bad count is not, which is why the test does not use it
  // here.
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')
  writeFileSync(out, 'previous\n')
  const outside = audit.sandbox.join('outside')
  mkdirSync(outside)

  const envelope = await runContext([outside, '--out', out], audit.edges)

  expect(envelope).toEqual({ outcome: 'refused', error: `not a git repository: ${outside}` })
  expect(readFileSync(out, 'utf8')).toBe('previous\n')
})

it('replaces the --out file rather than appending to it on a second run', async () => {
  // The probe opens for append, so it cannot truncate. The write that earns
  // the file is a separate call, and it must truncate. Otherwise a second run
  // leaves two reports in one file, and nothing can parse it.
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')

  await runContext([audit.work, '--out', out], audit.edges)
  await runContext([audit.work, '--out', out], audit.edges)

  const written = JSON.parse(readFileSync(out, 'utf8')) as Report
  expect(written.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
})

it('refuses an --out whose directory does not exist', async () => {
  // This is the other half of the claim the probe makes. A directory in the
  // file's place is one way it cannot be opened. A missing parent directory
  // is the other way. A caller reaches it when it types a path before the
  // directory exists.
  const audit = audited('paths')
  const out = audit.sandbox.join('nowhere', 'report.json')

  const envelope = await runContext([audit.work, '--out', out], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    new RegExp(`^could not open ${out} for writing: ENOENT`),
  )
  expect(audit.stdout()).toBe('')
})

/** One unit's five judgments, with only what a test is about spelled out. The
 *  defaults are the quiet answers: a repository fact, not volatile, whole on
 *  its own, and one claim. */
const classified = (unitId: string, over: Partial<Classification> = {}): Classification => ({
  unitId,
  kind: picked<UnitKind>('repo_fact'),
  volatile: 0,
  selfContained: 1,
  evidenceNeed: picked<EvidenceNeed>('file_contents'),
  multiAssertion: 0,
  ...over,
})

it('reports a pair the model says contradicts, naming both units', async () => {
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.9),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: contradicts (1; 1 of 1 judged)',
      '  conf 0.90  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on failure.',
      '    b: The retry policy backs off exponentially every time.',
    ].join('\n'),
  )
})

it('compares no history or structural unit, whatever they look like', async () => {
  // A record of the past and a heading assert nothing about the repository as
  // it stands. So neither can be the duplicate or the contradiction a pair
  // finding is about. `judgePair` has no reply registered, so a candidate
  // that reached the model would throw rather than pass quietly.
  const audit = modelled('pairs', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('history') }),
        classified('CLAUDE.md:5-5'),
      ],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('reports a volatile unit whose cited issue has closed', async () => {
  // The unit names its own expiry. The issue it hangs that expiry on is no
  // longer open. That pairing is the finding; neither half is one alone.
  const audit = modelled(
    'expired',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## volatile and the issue it names is closed (1)',
      '  CLAUDE.md:3-3  The Python layer is retiring and stays only until `#164` lands.',
    ].join('\n'),
  )
})

it('never calls a history unit expired, whatever the issue it cites says', async () => {
  // A line about a past round cites a closed issue correctly. This
  // repository's own files are almost entirely that kind of line. Without the
  // `kind` field, the section would report every one of them.
  const audit = modelled(
    'history',
    {
      classify: {
        classifications: [
          classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('history'), volatile: 0.9 }),
        ],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('leaves a unit the model does not call volatile out of the section', async () => {
  // 0.8 is the spike's bar, tuned against the live model. The unit below it
  // says nothing about its own expiry. So the closed issue it cites is a
  // citation, not a deadline that has passed.
  const audit = modelled(
    'expired',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3', { volatile: 0.79 })],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('does not judge a volatile unit whose issue could not be looked up, and says how many', async () => {
  // The issue that closed may be the one the expiry hangs on, or it may not.
  // So the unit is neither reported nor quietly dropped. The count in the
  // heading stops a reader from taking "0 found" to mean "nothing is stale".
  const audit = modelled(
    'expired',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })],
        failures: [],
      },
    },
    { issueStates: { states: {}, unavailable: 'API rate limit exceeded' } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## volatile and the issue it names is closed (0; 1 volatile units not judged, issue lookup unavailable)',
  )
})

it('reports a classify request that failed, and fails the run while still printing', async () => {
  // A model call that failed is the one thing this command calls its own
  // failure. The findings are still what a reader acts on, so they go to
  // stdout. The status alone says the run was incomplete. Nothing was
  // classified, so no unit is expired, and none counts as unjudged either. An
  // unlabelled unit is not a volatile one.
  const audit = modelled(
    'stale',
    {
      classify: {
        classifications: [],
        failures: [{ id: 'request 0', message: 'HTTP 500: boom' }],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const text = audit.stdout()
  expect(text).toContain('1 files, 2 units, 0 opaque')
  // A heading of 0 with nothing under it would read as "no unit expired". The
  // spike's line instead says the stage never judged one.
  expect(text).toContain(
    '## volatile and the issue it names is closed (0)\n  not judged: classify failed\n',
  )
  // This is not "0 of 0 judged". No label came back, so the two stages below
  // classify were never in a position to judge anything. A coverage line that
  // says they looked at nothing would read as a repository with no
  // candidates in it. `judgePair` would throw if the run reached it.
  expect(text).toContain('## pairs: skipped (classify_failed)')
  expect(text).toContain('## evidence: skipped (classify_failed)')
  // This is one entry, not two. The stage already said what went wrong. A `*`
  // beside it would count as a second failure for one fault, and as a second
  // model call in the envelope's count, for a call that was never made.
  expect(text).toContain(['## failures (1)', '  classify request 0: HTTP 500: boom'].join('\n'))
})

it('skips the stages below classify when no unit was classified at all', async () => {
  // The classify stage answered and labelled nothing; it did not say why. The
  // two stages below it read the labels to decide what to ask about. Without
  // any labels, the pair stage would compare history and structural units it
  // should leave out. The evidence stage would find no repository fact and
  // check nothing. Neither answer is worth what it costs, so neither stage
  // runs. `*` is the failure that says the whole stage came back empty.
  const audit = modelled(
    'ranked',
    { classify: { classifications: [], failures: [] } },
    {},
    // This is a sequence whose only entry throws. If the run reaches
    // `judgePair` at all, that is the defect this test exists to catch. An
    // unregistered method would say the same thing, but less deliberately.
    { judgePair: [new Error('judgePair must not be reached')] },
  )

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const report = reportOf(audit.stdout())
  expect(report.skipped).toEqual([
    { stage: 'pairs', reason: 'classify_failed' },
    { stage: 'evidence', reason: 'classify_failed' },
  ])
  expect(report.failures).toEqual([
    { stage: 'classify', id: '*', message: 'no unit was classified' },
  ])
  expect(report.pairCoverage).toEqual({ judged: 0, available: 0 })
  expect(report.evidenceCoverage).toEqual({ judged: 0, available: 0 })
})

it('prints a unit of exactly the line limit whole, and truncates the next character', async () => {
  // A limit is only pinned by the value that sits on it. The first two units
  // are findings of the same section: one of exactly 110 characters, one of
  // 111. If the comparison were relaxed by one, the first would be cut
  // although it fits. If it were tightened by one, the second would print
  // whole.
  //
  // The third unit puts an emoji across the cut itself. The emoji is two
  // UTF-16 code units, and the cut lands between them. So a slice by code
  // unit keeps the high half alone, which is not a character.
  const audit = modelled(
    'boundary',
    {
      classify: {
        classifications: [
          classified('CLAUDE.md:3-3', { volatile: 0.9 }),
          classified('CLAUDE.md:5-5', { volatile: 0.9 }),
          classified('CLAUDE.md:7-7', { volatile: 0.9 }),
        ],
        failures: [],
      },
      // The two sentences are near-identical by construction, so they are a
      // candidate pair as well; this test is about neither verdict.
      judgePair: picked<PairVerdict>('unrelated'),
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## volatile and the issue it names is closed (3)',
      '  CLAUDE.md:3-3  The retry note in this file stays here until #164 has closed, and this whole sentence runs to one hundred ten.',
      '  CLAUDE.md:5-5  The deploy note in this file stays here until #164 closes, and this whole sentence runs to one hundred elev...',
      '  CLAUDE.md:7-7  The rollout note in this file stays here until #164 closes, and this sentence carries an emoji right here:...',
    ].join('\n'),
  )
  // This is checked separately because the assertion above cannot check it. A
  // lone high half is invisible in a source literal, and an editor draws it
  // the same way as the whole emoji. `[...text]` walks code points, so a
  // surviving half comes out as itself.
  expect([...audit.stdout()].some((character) => character.codePointAt(0) === 0xd83d)).toBe(false)
})

it('calls a repository with nothing to classify neither failed nor skipped', async () => {
  // This is the other side of the guard, and the one a real checkout can
  // reach. A repository that holds no markdown at all has nothing to label.
  // That is not the same as a stage that was asked and came back empty.
  // Nothing failed, nothing was skipped, and `0 of 0 judged` is the honest
  // answer. Neither `judgePair` nor `judgeEvidence` has a reply registered, so
  // a stage that asked anything would throw.
  const audit = modelled('nounits', { classify: { classifications: [], failures: [] } })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  const text = audit.stdout()
  expect(text).toContain('0 files, 0 units, 0 opaque')
  expect(text).toContain('## pairs: contradicts (0; 0 of 0 judged)')
  expect(text).toContain('## evidence: contradicts (0; 0 of 0 judged)')
  expect(text).toContain('## failures (0)')
})

it('reports a pair the model says makes one claim twice, under its own heading', async () => {
  // Two verdicts are findings, and they are different findings. One is a line
  // to delete; the other is a disagreement to settle. A reader acts on them
  // separately.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.75),
  })

  await runContext([audit.work], audit.edges)

  const text = audit.stdout()
  expect(text).toContain('## pairs: contradicts (0; 1 of 1 judged)')
  expect(text).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.75  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
    ].join('\n'),
  )
})

it('asks about the units that share a vocabulary, and about no others', async () => {
  // Three rules apply in one fixture, and each would cost model calls to get
  // wrong. Two units that say nearly the same thing are worth a comparison. A
  // unit about something else is not. A unit of three tokens is never
  // compared at all, however much vocabulary it shares, because there is not
  // enough of it for a shared word to mean anything.
  const audit = modelled('similar', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3'),
        classified('CLAUDE.md:5-5'),
        classified('CLAUDE.md:7-7'),
        classified('CLAUDE.md:9-9'),
      ],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.6),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: contradicts (1; 1 of 1 judged)',
      '  conf 0.60  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
    ].join('\n'),
  )
})

it('does not compare a cell value repeated down one table', async () => {
  // Two rows of one table that say the same thing are one value written twice
  // in a column, not a claim made twice. There is nothing to delete and
  // nothing to settle, so a model call on them buys nothing. `judgePair` has
  // no reply registered, so a candidate that reached it would throw.
  const audit = modelled('tables', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:8-8')],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('still compares the same cell written under two different headings', async () => {
  // This is the other half of the repeated-cell rule. One table that says
  // something twice is a column. Two tables that say the same thing show the
  // duplication the audit exists to find. If the run dropped every identical
  // row, it would hide that duplication.
  const audit = modelled('retables', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:13-13')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.81),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.81  CLAUDE.md:13-13  <>  CLAUDE.md:7-7',
    ].join('\n'),
  )
})

it('lets no unit be compared more than five times, whichever side it is on', async () => {
  // Seven units that all say nearly the same thing would need twenty-one
  // calls. The twenty-first buys nothing a reader did not already have from
  // the first few. The cap binds on both sides of a pair. A unit that sorts
  // last is never the query side, so without the second check, its own cap
  // would never bind at all.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('hub', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const pairs = reportOf(audit.stdout()).pairs
  const appearances = new Map<string, number>()
  for (const pair of pairs) {
    for (const id of [pair.a, pair.b]) appearances.set(id, (appearances.get(id) ?? 0) + 1)
  }
  expect(Math.max(...appearances.values())).toBe(5)
  expect(pairs.length).toBeLessThan(21)
})

it('spends a --max-pairs budget on the most similar candidates first', async () => {
  // The cap is a budget, and what it buys depends entirely on the order. The
  // run should spend its last call on the pair most likely to be a real
  // duplicate. The coverage line tells a reader the other two were never
  // asked about.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('same_claim', 0.7),
  })

  await runContext([audit.work, '--json', '--max-pairs', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.pairCoverage).toEqual({ judged: 1, available: 3 })
  expect(report.pairs.map((pair) => [pair.a, pair.b])).toEqual([['CLAUDE.md:3-3', 'CLAUDE.md:5-5']])
})

it('asks nothing when --pair-threshold is set above what any pair scores', async () => {
  // The threshold is how a caller trades false pairs against missed ones. It
  // must reach the scoring stage to do either. `judgePair` has no reply
  // registered, so a candidate that survived would throw.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0.9'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes 1 as a threshold too, which is the top of the range the flag names', async () => {
  // This is the other endpoint, and the parser is the whole of what this test
  // pins down. A pattern that admitted 0 up to just under 1 would refuse this
  // value with exit 2. A caller who asked for near-exact duplicates only would
  // be told their value was not a fraction. What the run then finds is the
  // existing 0.9 case.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  const envelope = await runContext([audit.work, '--json', '--pair-threshold', '1'], audit.edges)

  expect(envelope.outcome).toBe('ok')
  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes --pair-threshold 0 as a threshold, not as no threshold at all', async () => {
  // Zero is the other end of the range, and it is the value a falsy guard
  // loses. A run asked to keep every candidate its index finds must not
  // quietly fall back to the default. These six units score from 0.12 to
  // 0.18, all under the default of 0.5. So a fallback would report nothing at
  // all, instead of the five pairs the per-unit cap leaves room for.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('graded', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 5, available: 5 })
})

it('writes one JSON document and one newline, with the stages that ran unskipped', async () => {
  // This is what a caller who pipes `--json` parses. A second document, a
  // stray line of findings text, or a lost newline all reach a reader as a
  // broken stream. `skipped` must be empty on a run where every stage ran. A
  // reader who looks for the reason a section is thin must be able to tell
  // "none" from "not recorded".
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.9),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const stdout = audit.stdout()
  expect(stdout.endsWith('}\n')).toBe(true)
  expect(stdout.split('\n')).toHaveLength(2)
  const report = reportOf(stdout)
  expect(report.skipped).toEqual([])
  expect(report.pairs).toHaveLength(1)
})

it('records every pair call that failed and keeps going, rather than ending the run', async () => {
  // One rejected call must not cost the other two, and each one must be
  // named. A stage that stopped at the first failure would report a clean
  // pair section it never earned. This is built as a real `JevError`, so
  // `message` and `body` differ the way they do on a live failure. A report
  // line that quoted only one of them would still read as complete.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: new JevError(529, 'the model is overloaded', 'request failed'),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '3 model calls failed' })
  const text = audit.stdout()
  expect(text).toContain('## pairs: contradicts (0; 0 of 3 judged)')
  expect(text).toContain(
    [
      '## failures (3)',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:5-5: HTTP 529: request failed the model is overloaded',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:7-7: HTTP 529: request failed the model is overloaded',
      '  pairs CLAUDE.md:5-5 <> CLAUDE.md:7-7: HTTP 529: request failed the model is overloaded',
    ].join('\n'),
  )
})

it('reports an answer that would not parse in its own words', async () => {
  // A rejected request and an answer that arrived but is not one this code
  // can read are different failures. Only the first has an HTTP status. A
  // report that prefixed both with one would send a reader to the transport,
  // to look for a parser's complaint.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: new Error('answer pair chose banana, which is not one of the options'),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  expect(audit.stdout()).toContain(
    [
      '## failures (1)',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:5-5: answer pair chose banana, which is not one of the options',
    ].join('\n'),
  )
})

it('judges a repository fact against the head of the file it names', async () => {
  // The claim and the file it points at are the cheapest evidence the audit
  // has. The excerpt is bounded on purpose. Accuracy falls as unrelated state
  // grows, so the head of the file is a crude bound, not a retrieval
  // strategy.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.88),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.evidenceCoverage).toEqual({ judged: 1, available: 1 })
  expect(
    report.evidence.map((entry) => [entry.unitId, entry.source, entry.excerpt.length]),
  ).toEqual([['CLAUDE.md:3-3', 'docs/retry.md', 6000]])
})

it('picks the first reference that is a readable file of this repository', async () => {
  // Four refs are no evidence, and the fifth is. The unit's own file would
  // judge a claim against itself. A `../` path resolves outside the audited
  // root, a tree this run has no business to read. A directory has no
  // contents to excerpt. A path that does not resolve at all names no file to
  // read. Each of these would otherwise be picked before the file the writer
  // actually pointed at.
  const audit = modelled('sources', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('says_nothing'),
  })
  // This file sits beside the audited root, not beside the sandbox.
  // `harness/git.ts` puts the checkout at `<root>/work`. So
  // `../outside/tool.ts`, written from the repository, resolves here and
  // nowhere else. Anywhere else, the ref is simply `absent`, and the skip
  // this test is named for is never reached.
  const outside = path.join(audit.work, '..', 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'tool.ts'), 'export const wait = 1000\n')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  // This is the premise, asserted so the test cannot pass for the wrong
  // reason. The `../` ref really does resolve to a file. That is what makes
  // the skip a decision, not an absence.
  expect(report.units[0]?.refs[1]).toEqual({
    kind: 'path',
    value: '../outside/tool.ts',
    resolution: { status: 'found', repoPath: '../outside/tool.ts' },
  })
  expect(report.evidence.map((entry) => entry.source)).toEqual(['docs/note.md'])
})

it('is not fooled into excerpting a binary file', async () => {
  // A NUL byte marks a file no judgment can be made against, and it is the
  // first ref the unit names. Without the check, the model would be asked to
  // compare a claim with six thousand characters of an image. This fixture is
  // written here rather than committed, because a fixture that holds a NUL
  // byte is a file no tool in this repository can read either.
  const audit = modelled('binary', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('says_nothing'),
  })
  mkdirSync(path.join(audit.work, 'assets'))
  writeFileSync(path.join(audit.work, 'assets', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0d]))

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidence.map((entry) => entry.source)).toEqual(['docs/note.md'])
})

it('spends a --max-evidence budget in document order, and says what it left', async () => {
  // The bound is what keeps a large repository's run finite. The coverage
  // line is the only thing between "one contradiction found" and a reader who
  // believes the other fact was checked and cleared.
  const audit = modelled('facts', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgeEvidence: picked<EvidenceVerdict>('supports'),
  })

  await runContext([audit.work, '--json', '--max-evidence', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.evidenceCoverage).toEqual({ judged: 1, available: 2 })
  expect(report.evidence.map((entry) => entry.source)).toEqual(['docs/one.md'])
})

it('names the unit when an evidence call fails, not the file it was reading', async () => {
  // The unit is what a reader would have to check by hand. So it is what the
  // failure is filed under. `jevFails` stands for "this call did not work",
  // and it carries its message as the body too, which is why it reads twice.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: jevFails('the model is overloaded', 503),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const text = audit.stdout()
  expect(text).toContain('## evidence: contradicts (0; 0 of 1 judged)')
  expect(text).toContain(
    [
      '## failures (1)',
      '  evidence CLAUDE.md:3-3: HTTP 503: the model is overloaded the model is overloaded',
    ].join('\n'),
  )
})

it('ends with what the run spent, including the wall clock it was given', async () => {
  // These are four numbers a caller uses to decide whether to run this again.
  // A call retried twice is one request and three attempts. The summed
  // request time exceeds the wall clock whenever calls ran side by side. The
  // mock answers zeros, and the clock is the one the test handed over.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## usage: 0 requests (0 attempts), 0 input tokens, 0 ms summed request time, 1 ms wall clock',
  )
})

it('shortens a long finding to one readable line', async () => {
  // The findings are a list a reader scans. A unit's text is there to
  // recognise it by, not to read in full. A table row carries a newline
  // between its cells, and a paragraph can run for hundreds of characters.
  // Either would break the one-finding-per-line shape the list depends on.
  const audit = modelled(
    'long',
    {
      classify: {
        classifications: [classified('CLAUDE.md:7-7', { volatile: 0.9 })],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '  CLAUDE.md:7-7  Rule: The retry policy backs off exponentially on every network failure, and keeps doing so until `#164` la...',
  )
})

it('hands the client the plugin’s own unit, with no shape in between', async () => {
  // `lib/` cannot import a plugin. So the client takes the minimal structural
  // shape it reads off a unit, and the plugin's richer `Unit` satisfies it,
  // with no cast and no copy. The assignment below is the whole test. A field
  // renamed or narrowed on either side fails `tsc` here. It does not become a
  // wrong question at the API.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  const unit = reportOf(audit.stdout()).units[0] as Unit
  const asJevUnit: JevUnit = unit
  expect(asJevUnit.refs.map((ref) => ref.value)).toEqual(['lib/x.ts'])
})

it('finds the one distinctive pair in a large repository without comparing every pair', async () => {
  // Ten thousand units make a repository this audit is meant for. To compare
  // every pair of them would need fifty million dot products. The index
  // finds this pair by construction, from the shared tokens almost nothing
  // else carries. It never scans the postings list of the token everything
  // carries.
  //
  // Every unit is labelled, the way a real run's units would be. A classify
  // stage that came back empty is a stage that failed, and the pair stage
  // below it no longer runs at all. The units sit on every second line from
  // the third.
  const ids = Array.from({ length: 10_002 }, (_, n) => `CLAUDE.md:${3 + 2 * n}-${3 + 2 * n}`)
  const audit = modelled('absent', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })
  const lines = ['# Scale', '']
  for (let i = 0; i < 10_000; i++) lines.push(`commontoken bg${i}x bg${i}y bg${i}z`, '')
  for (const n of [0, 1]) {
    lines.push(
      `commontoken distinctivematch1 distinctivematch2 distinctivematch3 specialown${n}`,
      '',
    )
  }
  writeFileSync(path.join(audit.work, 'CLAUDE.md'), lines.join('\n'))

  const startedAt = Date.now()
  await runContext([audit.work, '--json'], audit.edges)
  const elapsedMs = Date.now() - startedAt

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 1, available: 1 })
  expect(elapsedMs).toBeLessThan(6000)
})

it('still compares two identical sentences, which are not table cells', async () => {
  // The repeated-cell rule is about table rows and nothing else. The same
  // sentence written twice in prose is the plainest duplicate there is. A
  // rule that dropped every identical text would drop exactly it.
  const audit = modelled('twins', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.95),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.95  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on failure.',
      '    b: The retry policy backs off exponentially on failure.',
    ].join('\n'),
  )
})

it('prints a refuted claim beside the file that refutes it', async () => {
  // The finding is only actionable with all three: which claim, which file,
  // and how sure the model was. The excerpt itself stays in the JSON report,
  // where a reader who wants it can look it up.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.88),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## evidence: contradicts (1; 1 of 1 judged)',
      '  conf 0.88  CLAUDE.md:3-3  against docs/retry.md',
      '    The retry helper described in `docs/retry.md` waits one second between attempts.',
    ].join('\n'),
  )
})

it('shortens both halves of a pair finding, which a table row would otherwise break', async () => {
  // The pair section is a list a reader scans, one finding per line. A
  // two-column table row carries a newline between its cells. Printed raw,
  // one finding becomes four lines, and anything that reads the text
  // line-wise mis-counts it. The other two sections use the same bound.
  const audit = modelled('longpair', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:13-13')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.90  CLAUDE.md:13-13  <>  CLAUDE.md:7-7',
      '    a: Rule: The retry policy backs off exponentially on every network failure Why: A fixed delay hammers a servic...',
      '    b: Rule: The retry policy backs off exponentially on every network failure Why: A fixed delay hammers a servic...',
    ].join('\n'),
  )
})

it('lists the pairs of one verdict most confident first, not in the order they were judged', async () => {
  // The section is a review queue. The finding the model was surest of is the
  // one a reader should act on first. The stage judges in descending
  // SIMILARITY, which is a different order. So the two pairs below come back
  // in the opposite order to the one they must print in.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.41), picked<PairVerdict>('same_claim', 0.97)],
    },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (2; 2 of 2 judged)',
      '  conf 0.97  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on every network failure.',
      '    b: The retry policy backs off on every network failure, without any delay.',
      '  conf 0.41  CLAUDE.md:7-7  <>  CLAUDE.md:9-9',
      '    a: Deploy previews expire after fourteen quiet days and are then removed.',
      '    b: Deploy previews expire after fourteen quiet days and are then removed.',
    ].join('\n'),
  )
})

it('leaves the JSON report in the order the stage judged, and ties in it too', async () => {
  // The findings text is a review queue, and the JSON report is a record. The
  // order a run made its calls in is part of what it records. So the text's
  // sort must not reach back into `report.pairs`. The two verdicts carry the
  // SAME confidence, which is the case an unstable or id-breaking sort gets
  // wrong. The pair judged first is the one with the lower id-sorted name. If
  // the run reorders by anything but the sort's own stability, that shows up
  // here.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.6), picked<PairVerdict>('same_claim', 0.6)],
    },
  )

  await runContext([audit.work, '--json'], audit.edges)

  const judged: Array<[string, string]> = [
    ['CLAUDE.md:7-7', 'CLAUDE.md:9-9'],
    ['CLAUDE.md:3-3', 'CLAUDE.md:5-5'],
  ]
  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual(judged)

  const second = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.6), picked<PairVerdict>('same_claim', 0.6)],
    },
  )
  await runContext([second.work], second.edges)

  expect(second.stdout().split('\n').filter(isConfLine)).toEqual([
    '  conf 0.60  CLAUDE.md:7-7  <>  CLAUDE.md:9-9',
    '  conf 0.60  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
  ])
})

it('lists refuted claims most confident first as well', async () => {
  // The same rule in the evidence section. The stage judges in document order,
  // so the second fact is the one that must print first.
  const audit = modelled(
    'facts',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
        failures: [],
      },
    },
    {},
    {
      judgeEvidence: [
        picked<EvidenceVerdict>('contradicts', 0.32),
        picked<EvidenceVerdict>('contradicts', 0.88),
      ],
    },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## evidence: contradicts (2; 2 of 2 judged)',
      '  conf 0.88  CLAUDE.md:5-5  against docs/two.md',
      '    The guide in `docs/two.md` explains when a caller should give up.',
      '  conf 0.32  CLAUDE.md:3-3  against docs/one.md',
      '    The note in `docs/one.md` records how long the helper waits.',
    ].join('\n'),
  )
})

it('leaves a volatile unit alone while the issue it names is still open', async () => {
  // This is the other half of the expired rule. A unit that is volatile and
  // not history is not a finding on its own. The deadline has to pass, and an
  // OPEN issue says it has not. Without this rule, the section reports every
  // volatile unit that cites any issue at all.
  const audit = modelled(
    'expired',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'OPEN' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('does not report a volatile unit when one of the issues it cites is unanswerable', async () => {
  // One issue has closed, and the other could not be looked up. The model is
  // not asked WHICH issue the expiry hangs on. If the run published the
  // finding, it would guess that the closed issue was the one that mattered.
  // So the unit is counted in the heading instead.
  const audit = modelled(
    'partial',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## volatile and the issue it names is closed (0; 1 volatile units not judged, issue lookup unavailable)',
  )
})

it('spends the pair budget across query units, not on the first unit that has a candidate', async () => {
  // `candidatePairs` ranks each unit's own candidates and emits them in id
  // order. So the strongest pair in a repository can come out last. The
  // budget is worth nothing unless the whole list is ranked before it is cut.
  // Here the weaker pair is emitted first, and the stronger one must be the
  // one call that is made.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked2', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work, '--json', '--max-pairs', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.pairCoverage).toEqual({ judged: 1, available: 2 })
  expect(report.pairs.map((pair) => [pair.a, pair.b])).toEqual([['CLAUDE.md:7-7', 'CLAUDE.md:9-9']])
})

it('keeps a unit’s most similar candidates when its cap binds, and drops the weakest', async () => {
  // There are six candidates and room for five, so one is dropped. Which one
  // is dropped is the whole question: the cap must spend its places on the
  // strongest. The weakest candidate here is not the last one the index
  // reaches. So an unranked cap would keep it and drop a stronger pair
  // instead.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('graded', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0.1'], audit.edges)

  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual([
    ['CLAUDE.md:11-11', 'CLAUDE.md:15-15'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:3-3'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:5-5'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:7-7'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:9-9'],
  ])
})

it('compares a unit of exactly four tokens, the shortest length that pairs at all', async () => {
  // The floor is four, and a floor is only pinned by the value that sits on
  // it. Three tokens is refused elsewhere; this test checks the other side.
  const audit = modelled('fourtokens', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 1, available: 1 })
})

it('compares no structural unit, which asserts nothing that could be contradicted', async () => {
  // A heading or a table header names things; it does not claim anything
  // about them. So it can be neither the duplicate nor the contradiction a
  // pair finding is about. `judgePair` has no reply registered, so a
  // candidate that reached the model would throw rather than pass quietly.
  const audit = modelled('pairs', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('structural') }),
        classified('CLAUDE.md:5-5'),
      ],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('asks for evidence about a repository fact and about nothing else', async () => {
  // Only a claim about this repository can be checked against this
  // repository's files. An instruction or a rule is not that kind of claim.
  // `judgeEvidence` has no reply registered, so a unit that reached the model
  // would throw. `available` is the other half of the test: a kind counted
  // but never judged would read as a budget that ran out.
  const audit = modelled('evidence', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('instruction') })],
      failures: [],
    },
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidenceCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes the excerpt from a file a line reference names, not only a bare path', async () => {
  // `docs/retry.md:3` names a file as surely as `docs/retry.md` does, and a
  // writer who cited a line meant that file to be the evidence.
  const audit = modelled('fileline', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.75),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidence.map((entry) => entry.source)).toEqual(['docs/retry.md'])
})

it('carries on when the file a claim names is tracked but not on disk', async () => {
  // `docs/adr/022` resolves against the TRACKED list; it does not read the
  // file itself. So git can name a file the working tree does not hold: a
  // staged deletion, a `git mv` in flight, a sparse checkout. The read must not
  // throw out of the command. That would discard the tier 0 findings and
  // every model call this run has already paid for. `judgeEvidence` has no
  // reply registered, so a unit that still reached the model would throw.
  const audit = modelled('missing', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
  })
  rmSync(path.join(audit.work, 'docs', 'adr', '022-retry.md'))

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  const report = reportOf(audit.stdout())
  expect(report.evidence).toEqual([])
  expect(report.evidenceCoverage).toEqual({ judged: 0, available: 1 })
  expect(report.failures).toEqual([])
})

it('builds no Jev client at all when --no-jev is given and there is a key to spend', async () => {
  // The factory is the assertion. A client that is never constructed marks
  // the difference between a run that spends nothing and one that merely
  // happens to make no call. `scripts/audit.ts` builds the REAL client from
  // whatever key is in the environment. So this is the only place the rule
  // can be held.
  const audit = modelled('paths', {})
  const edges: ContextEdges = {
    ...audit.edges,
    createJev: () => {
      throw new Error('the Jev client was constructed')
    },
  }

  await runContext([audit.work, '--json', '--no-jev'], edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_jev' },
    { stage: 'pairs', reason: 'no_jev' },
    { stage: 'evidence', reason: 'no_jev' },
  ])
})

it('reads an empty TYPESAFE_API_KEY as no key, and builds no client for it either', async () => {
  // An exported variable with nothing in it is what a half-finished setup
  // leaves behind. It is no more a key to spend than an absent one.
  const audit = audited('paths')
  audit.sandbox.env.TYPESAFE_API_KEY = ''
  const edges: ContextEdges = {
    ...audit.edges,
    createJev: () => {
      throw new Error('the Jev client was constructed')
    },
  }

  await runContext([audit.work, '--json'], edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_key' },
    { stage: 'pairs', reason: 'no_key' },
    { stage: 'evidence', reason: 'no_key' },
  ])
})

it('judges no pair at all when --max-pairs is zero, and says how many it passed over', async () => {
  // A budget of nothing is a caller who asks for tier 0 plus the labels. It
  // still has to report what it did not reach. `judgePair` has no reply
  // registered, so a call that happened would throw.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  const envelope = await runContext([audit.work, '--json', '--max-pairs', '0'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 3 })
})

it('judges no claim at all when --max-evidence is zero, and says how many it passed over', async () => {
  const audit = modelled('facts', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
  })

  const envelope = await runContext([audit.work, '--json', '--max-evidence', '0'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(reportOf(audit.stdout()).evidenceCoverage).toEqual({ judged: 0, available: 2 })
})

it('breaks a tie between two equally similar candidates by id, not by position in the file', async () => {
  // Two candidates score EXACTLY the same against one unit, because their
  // text is the same. Which of them is judged first is then decided by the
  // order the index was built in. A budget that stops between them buys
  // whichever came first. If the index is built in document order, the same
  // repository answers differently once a unit moves up the file. If it is
  // built in id order, as the spike builds it, the answer belongs to the
  // repository, not to the layout.
  //
  // Both halves of the expected list are load-bearing, and they pin different
  // things. `12-12 <> 3-3` is the identical pair, which the index emits LAST
  // but which stands first here. That is the descending-similarity sort; if
  // the test deleted this pair, this line would move to the end. The two
  // equally scoring pairs behind it are in id order. If the index were built
  // in document order, they would swap.
  const ids = ['3-3', '5-5', '7-7', '10-10', '12-12'].map((line) => `CLAUDE.md:${line}`)
  const audit = modelled('ties', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual([
    ['CLAUDE.md:12-12', 'CLAUDE.md:3-3'],
    ['CLAUDE.md:10-10', 'CLAUDE.md:12-12'],
    ['CLAUDE.md:10-10', 'CLAUDE.md:3-3'],
  ])
})
