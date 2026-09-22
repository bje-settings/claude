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

import { createGhMock, type GhClient, type GhReplies, ghFails } from '../../../../harness/gh.ts'
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

it('reads the refs in a fenced code block, commands included', async () => {
  // A fenced block never goes to the model, and tier 0 is the only thing that
  // reads it: a command line that names a path is exactly where a stale path
  // hides.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).opaque[0]?.refs).toEqual([
    { kind: 'command', value: 'pnpm', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    { kind: 'script', value: 'pnpm test', resolution: { status: 'found', repoPath: null } },
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

  const diagram = reportOf(audit.stdout()).opaque[1]
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
  const audit = audited('issues', {
    issueStates: ghFails('gh: could not resolve to a Repository'),
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
