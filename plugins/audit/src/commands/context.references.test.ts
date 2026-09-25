// context, part of its tests: path, line, script and issue references.
// The file is one of several so that vitest can run them at the same time (#205).
// `context.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import { GhError } from '../../../../harness/gh.ts'
import { audited, blocksIn, reportOf, unitNaming } from './context.test-support.ts'
import { runContext } from './context.ts'

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
