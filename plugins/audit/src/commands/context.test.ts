// `/audit:context` against real repositories, with `gh` injected (ADR 001).
// The command function is the only seam: `refs.ts`, `discover.ts` and
// `report.ts` are reached through it and never called directly, so what is
// asserted is the report a caller actually gets rather than an intermediate
// shape nobody consumes.
//
// Every fixture repository is a directory under `fixtures/repos/`, copied in
// and committed by `harness/git.ts` `importTree`, which undoes the two names a
// fixture cannot be stored under (`_gitignore`, `<name>.fixture.md`).
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGhMock, type GhClient, GhError, type GhReplies } from '../../../../harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import type { Report } from '../report.ts'
import type { Ref } from '../types.ts'
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

/** The opaque blocks of one file, in document order. Indexed by file rather
 *  than by position in the whole report, so a fixture that grows another file
 *  does not renumber every assertion. */
const blocksIn = (report: Report, file: string) =>
  report.opaque.filter((block) => block.file === file)

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
      '## tier 0: refs not checked',
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
  expect(unitNaming(report, 'beside this file')).toEqual([
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

it('walks up to the manifest that governs a nested file, and stops at one that will not parse', async () => {
  // Two rules in one fixture: a nested file inherits the root manifest, and a
  // manifest that cannot be read is `unavailable` rather than a missing
  // script. Stopping there is the point: the file that governs this one could
  // not be read, so what is further up does not answer the question. The
  // unreadable manifest is a directory in the manifest's place, which is the
  // one shape of "cannot be read" that can be committed here without a
  // deliberately malformed .json file for the linter to reject.
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
  // `typeof null` is `'object'`, so the null arm of the guard is the only
  // thing between this manifest and `Object.hasOwn(null, ...)`, which throws
  // and takes the whole run down over one word in one file.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const unit = report.units.filter((entry) => entry.file === 'nullscripts/CLAUDE.md')[0]
  expect(unit?.refs).toEqual([
    { kind: 'script', value: 'pnpm test', resolution: { status: 'absent' } },
  ])
})

it('reads the refs in a fenced code block, commands included', async () => {
  // A fenced block never goes to the model, and tier 0 is the only thing that
  // reads it: a command line that names a path is exactly where a stale path
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
  // A diagram's `#`s are colours and its arrows are not paths, so every ref it
  // could yield would be a false one. This fixture's diagram carries both
  // shapes deliberately.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  const diagram = blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[1]
  expect(diagram?.kind).toBe('mermaid')
  expect(diagram?.refs).toEqual([])
})

it('gives each issue reference the state the lookup answered with', async () => {
  // A number the lookup left out is `unavailable`, never absent: the reason it
  // is missing may be a permissions error or a rate limit, and reporting that
  // as "no such issue" is a finding invented out of a failure to ask.
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
  // throws, but a caller that trusted that and reached for `.states` on a
  // rejection would take the whole audit down over one lookup.
  //
  // Built here rather than with `ghFails`, whose `detail` is its message, so
  // the two differ the way they do on a real failure: `message` carries the
  // whole argv and `detail` is gh's own line. A report line that quoted
  // `message` would carry the `--json` fields with it, which is the defect
  // #159 found, and with the two equal nothing would notice.
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
  // `@scope/name` has a slash and is not a path, and reporting one absent
  // gives a reader a finding to dismiss in every repository that has a
  // dependency.
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
  // `${VAR}` is the spelling a skill writes, and no existence check can ever
  // succeed on it: it is a shape, which is a different fact from an absence.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    {
      kind: 'path',
      value: `\${CLAUDE_PLUGIN_ROOT}/bin/audit.ts`,
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('resolves a number-only record reference against the one file that starts with it', async () => {
  // Prose names a record by its number, `docs/adr/022`, while the file carries
  // a slug after it. One tracked path starting with the value and a separator
  // is that file; reporting it absent would be a finding about a naming
  // convention rather than about rot.
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
  // A build output is not in the tree because it is not meant to be. Reporting
  // it absent would make every repository with a .gitignore noisy in exactly
  // the places its own rules already explain.
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
  // A `uses:` value is resolved by GitHub Actions against the repository and
  // ref it names, not against this checkout, so an existence check here
  // answers a question nobody asked. The `run:` line beside it still yields
  // its script, which is what proves the block was read at all.
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
  // throws: this fixture proves both that the four shapes yield nothing and
  // that a repository naming no issue never reaches gh. The colours are two:
  // `#000` is refused by the leading zero alone, and `#123` only by the `:`
  // touching it, which is the rule that has to be exercised on its own. The
  // URL carries no path, so the cross-repo rule cannot reach it either and the
  // URL rule is the only thing that drops it.
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
  // A closed issue is not a finding on its own: a history line cites one
  // correctly, and on this repository every such citation is history. The
  // state is in the JSON report for layer 5, whose model judgment decides
  // which of them is rot. An issue nobody can find is an absence like any
  // other, and that one is a finding.
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
  // Without this, "unchecked" reads as "fine": a reader has no way to tell a
  // repository whose refs all resolved from one whose refs were mostly never
  // looked at.
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
  // A fence that never closes swallows the rest of the file, so the unit count
  // under it is not the file's. The warning has to be where a reader sees it
  // before the findings.
  const audit = audited('warn')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toMatch(
    /^1 files, 1 units, 1 opaque\n {2}warning: CLAUDE\.md:5 unclosed_fence\n/,
  )
})

it('reads a file:line inside a code block, and leaves a ../ example unchecked', async () => {
  // A `../` path in an example is written relative to whatever directory the
  // example runs from, which is not the referencing file's, so there is
  // nowhere to look for it: a shape, not an absence. A comment line carries no
  // command, and its file:line is still a reference.
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

  // node's own wording, passed through rather than rewritten: it names the
  // token the caller typed, which is what a caller needs (`lib/args.ts`).
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
  // A fence with no language is not known to be a shell, so its first words
  // are not commands; the paths written in it are still paths.
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
  // Frontmatter never goes to the model either, and a skill's frontmatter is
  // exactly where a path to a renamed script sits unnoticed. An issue number
  // is read there and in a fence too: only a mermaid diagram is exempt, and
  // the diagram's own early return would otherwise be the only thing proving
  // it.
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
  // A trailing newline ends the last line rather than starting an empty one,
  // so a one-line file without one still has a line 1, and an empty file has
  // no line at all to point at. Not `wc -l`, which counts newlines and would
  // answer 0 for that one-line file.
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
  // `run('scripts/build.ts')` trims to `run('scripts/build.ts`, which is not a
  // path anybody wrote: the token is code around a path rather than a path. A
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
  // A transcript writes `$ pnpm test`, and reporting `$` as the command would
  // be a finding about the prompt.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]?.refs[0]).toEqual({
    kind: 'command',
    value: 'pnpm',
    resolution: { status: 'unchecked', reason: 'no_resolver' },
  })
})

/** The refs of the one unit whose text contains `text`, so a fixture that
 *  grows a paragraph does not renumber every assertion beside it. */
const unitNaming = (report: Report, text: string): Ref[] | undefined =>
  report.units.find((unit) => unit.text.includes(text))?.refs

it('asks git about a path outside the tree without losing the answer for the rest', async () => {
  // `git check-ignore` does not skip a path it cannot place: one value outside
  // the repository aborts the whole batch with exit 128, and the batch is
  // shared by every absent ref in the run. Sending one would turn every
  // correctly ignored path in the repository into a headline finding.
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
  // The first segment is what leaves the tree, not the first two characters: a
  // directory whose name merely starts with them is still git's to answer
  // about, and a prefix test would drop it and report it absent.
  expect(unitNaming(report, 'scratch copy')).toEqual([
    { kind: 'path', value: '..cache/out.js', resolution: { status: 'ignored' } },
  ])
})

it('answers ignored for a path written inside a fenced block too', async () => {
  // Build output is named in a command line more often than in prose, and a
  // block's refs go through the same ignore pass or they do not go at all.
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
  // This fixture ignores `pnpm*`, so a script value that reached the batch
  // would come back ignored and a real missing script would stop being a
  // finding.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'this manifest does not declare')).toEqual([
    { kind: 'script', value: 'pnpm missing', resolution: { status: 'absent' } },
  ])
})

it('says the ignore check was unavailable rather than reporting absent as settled', async () => {
  // The shim fails `check-ignore` alone, so everything else still resolves.
  // Reading an unanswerable question as "nothing here is ignored" would
  // publish every ignored path as a finding with no sign anything went wrong.
  // An exclude file git cannot read makes `check-ignore` exit 128 for the
  // whole batch, which is a real repository state rather than a stubbed one.
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
  // because something else might. Reading `.detail` off whatever was thrown
  // gives `undefined`, and `undefined` folds to the report's success value, so
  // a mis-wired client would publish "the lookup succeeded" while every issue
  // ref silently said unavailable.
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
  // `git ls-files` lists the index and the read comes from the working tree,
  // and the two differ in ordinary use: a staged deletion, a `git mv` in
  // flight, a sparse checkout. Letting the read throw ends the run with node's
  // own `fs` stack trace and no envelope, so the caller gets neither findings
  // nor a sentence it can act on.
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
  // A transcript writes a lone `$` between commands, and an example writes
  // `CI=1 ...` or `sudo ...` in front of the one it means. Reporting `$`,
  // `CI=1` or `sudo` as the command would be a finding about the shell line
  // rather than about this repository.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  const commands = blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]
    ?.refs.filter((ref) => ref.kind === 'command')
    .map((ref) => ref.value)
  expect(commands).toEqual(['pnpm', 'node', 'node'])
})

it('reads each placeholder character as a template on its own', async () => {
  // `{` and `$` are separate rules because either spelling alone makes the
  // value a template. A fixture carrying both at once is satisfied by either
  // rule, so neither is held to anything.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(unitNaming(report, 'no braces at all')).toEqual([
    {
      kind: 'path',
      value: '$CLAUDE_PLUGIN_ROOT/bin/audit.ts',
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
  // The tail rule compares against `/` plus the value, so `est/thing.ts` is
  // not answered by `deep/nest/thing.ts`. Without the boundary a witness could
  // be found for almost any suffix, and `tail_match` would absolve everything.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'partial segment')).toEqual([
    { kind: 'path', value: 'est/thing.ts', resolution: { status: 'absent' } },
  ])
})

it('reads a bare npm subcommand as no script at all', async () => {
  // npm is the one manager whose bare subcommands are not also script
  // shorthands, so only `npm run <name>` is a script. Tested in the negative
  // as well, since the positive case passes whichever rule is applied.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'only the explicit run form')).toEqual([])
})

it('prefers the root over the referencing file when both hold the path', async () => {
  // Prose names paths from the root far more often than from the file it is
  // written in, so the root's is the one meant. With only one of the two
  // present anywhere, the order the two lookups run in proves nothing.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  // The ref is written in `plugins/demo/CLAUDE.md`, and `lib/x.ts` exists
  // both at the root and beside that file, so the two lookups disagree and
  // the answer says which one ran first.
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
  // `now` is an edge so that `wallClockMs` is a literal rather than a duration
  // a test has to tolerate, and the rounding is there because the real clock
  // is `performance.now()`, whose fractions are noise in a report and in a
  // diff.
  const audit = audited('paths')
  const ticks = [0, 1.6]
  const edges: ContextEdges = { ...audit.edges, now: () => ticks.shift() as number }

  await runContext([audit.work, '--json'], edges)

  expect(reportOf(audit.stdout()).wallClockMs).toBe(2)
})

it('audits the checkout a subdirectory belongs to, and asks gh about that root', async () => {
  // The root is the toplevel rather than the directory the caller named, and
  // `gh` resolves the repository from the working directory it is built with,
  // so a client built with the caller's own path would ask about whatever
  // repository that happened to sit in.
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
  // A writer pads a span for readability. Without the trim the value carries
  // the spaces, `looksLikePath` refuses it for containing whitespace, and the
  // reference is dropped rather than resolved.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'written with padding')).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
})

it('leaves an existing --out file alone when the run refuses', async () => {
  // The pre-open is a probe, and a probe that truncates destroys the caller's
  // last report on the way to writing nothing.
  //
  // The refusal has to be one that happens AFTER the probe, or the probe never
  // runs and the assertion passes under either mode. A bad root is the first
  // of them; a bad count is not, which is why it is not used here.
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
  // The probe opens for append so that it cannot truncate; the write that
  // earns the file is a separate call and has to truncate, or a second run
  // leaves two reports in one file and nothing can parse it.
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')

  await runContext([audit.work, '--out', out], audit.edges)
  await runContext([audit.work, '--out', out], audit.edges)

  const written = JSON.parse(readFileSync(out, 'utf8')) as Report
  expect(written.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
})

it('refuses an --out whose directory does not exist', async () => {
  // The other half of the claim the probe makes: a directory in the file's
  // place is one way it cannot be opened, and a parent that is not there is
  // the one a caller reaches by typing a path before creating the directory.
  const audit = audited('paths')
  const out = audit.sandbox.join('nowhere', 'report.json')

  const envelope = await runContext([audit.work, '--out', out], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    new RegExp(`^could not open ${out} for writing: ENOENT`),
  )
  expect(audit.stdout()).toBe('')
})
