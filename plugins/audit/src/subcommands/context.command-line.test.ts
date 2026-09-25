// context, part of its tests: the command line, the flags and --out.
// The file is one of several so that vitest can run them at the same time (#205).
// `context.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { Report } from '../report.ts'
import { audited, modelled, reportOf } from './context.test-support.ts'
import { runContext } from './context.ts'

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
