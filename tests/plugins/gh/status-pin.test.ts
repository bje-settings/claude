// The decisions of the gh hooks module, in process (#488). The module itself
// runs under `claude plugin test` (`register.test.tsx`). These functions are
// in `src/`, so vitest measures them.
import { expect, it } from 'vitest'
import {
  changesCounts,
  failureText,
  outcomeOf,
  parseReport,
  plainText,
  REFRESH_MS,
  type Report,
  RUN_TIMEOUT_MS,
  SEGMENT_COLOUR,
  segmentsOf,
} from '#gh/status-pin.ts'

const ZERO = { behind: 0, prune: 0, pullRequests: 0, dependencies: 0, alerts: 0 }

/** A report of one repository, `acme/widgets`, with `counts` over zero. */
const report = (counts: Partial<Report['counts']> = {}, more: Partial<Report> = {}): Report => ({
  counts: { ...ZERO, ...counts },
  repos: 1,
  repository: 'acme/widgets',
  problems: [],
  ...more,
})

/** `value` as `status --json` writes it. */
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

it('refreshes after a git or gh command, and after the sync of this plugin', () => {
  for (const command of [
    'git pull',
    '  git fetch --prune',
    'git',
    'gh pr merge 12',
    'gh\tissue list',
    'node "/home/me/.claude/plugins/gh/scripts/gh.ts" sync',
    'node /home/me/plugins/gh/scripts/gh.ts sync --dry-run',
    'node "/p/scripts/gh.ts" sync-repo /a/repo',
  ]) {
    expect([command, changesCounts(command)]).toEqual([command, true])
  }
})

it('does not refresh after any other command', () => {
  for (const command of [
    'ls -la',
    'echo git pull',
    'gitk',
    'ghq list',
    'cd repo && git pull',
    'node scripts/other.ts sync',
    'node "/p/scripts/gh.ts" issues',
    'node "/p/scripts/gh.ts" syncer',
    '',
  ]) {
    expect([command, changesCounts(command)]).toEqual([command, false])
  }
})

it('names the exit code and the first line of stderr for a failed exit', () => {
  expect(failureText({ exitCode: 2, stderr: 'usage: hook-io.ts\nmore\n' })).toBe(
    'gh: the status check failed with exit 2: usage: hook-io.ts',
  )
  expect(failureText({ exitCode: 1, stderr: '  \n' })).toBe(
    'gh: the status check failed with exit 1',
  )
})

it('names the reason a run did not start', () => {
  expect(failureText({ error: new Error('spawn node ENOENT') })).toBe(
    'gh: the status check could not run: spawn node ENOENT',
  )
  expect(failureText({ error: 'timed out' })).toBe('gh: the status check could not run: timed out')
})

it('refreshes every five minutes, and gives a run 15 seconds', () => {
  expect(REFRESH_MS).toBe(300_000)
  expect(RUN_TIMEOUT_MS).toBe(15_000)
})

// --- parseReport ---------------------------------------------------------------

it('reads the report on the first line of stdout', () => {
  const value = report({ behind: 1, alerts: 2 }, { problems: ['timed out'] })
  expect(parseReport(line(value))).toEqual(value)
  expect(parseReport(`${line(value)}more text\n`)).toEqual(value)
  expect(parseReport(JSON.stringify(report({}, { repository: null })))).toEqual(
    report({}, { repository: null }),
  )
})

it('reads no report from text that is not JSON, or JSON that is not a report', () => {
  const good = report()
  for (const stdout of [
    '',
    '\n',
    'gh: [behind]\n',
    `\n${line(good)}`,
    line(null),
    line(3),
    line('text'),
    line({ ...good, counts: null }),
    line({ ...good, counts: 'none' }),
    line({ ...good, counts: { ...ZERO, pullRequests: '1' } }),
    line({ ...good, counts: { behind: 0, prune: 0, dependencies: 0, alerts: 0 } }),
    line({ ...good, repos: '1' }),
    line({ ...good, repository: 7 }),
    line({ counts: ZERO, repos: 1, problems: [] }),
    line({ ...good, problems: 'timed out' }),
    line({ ...good, problems: ['timed out', 2] }),
  ]) {
    expect([stdout, parseReport(stdout)]).toEqual([stdout, null])
  }
})

// --- outcomeOf -----------------------------------------------------------------

it('draws the report of an exit 0', () => {
  const value = report({ behind: 1 })
  expect(outcomeOf({ exitCode: 0, stdout: line(value), stderr: 'a cause\n' })).toEqual({
    kind: 'pin',
    report: value,
  })
})

it('draws a report that a run wrote before a signal ended it, as exit 1', () => {
  const value = report({ prune: 2 })
  expect(outcomeOf({ exitCode: 1, stdout: line(value), stderr: '' })).toEqual({
    kind: 'pin',
    report: value,
  })
})

it('fails an exit 0 that wrote no report', () => {
  for (const stdout of ['', 'gh: [behind]\n']) {
    expect(outcomeOf({ exitCode: 0, stdout, stderr: 'ignored\n' })).toEqual({
      kind: 'failed',
      text: 'gh: the status check wrote no report',
    })
  }
})

it('fails a run that exits non-zero with no report', () => {
  expect(outcomeOf({ exitCode: 1, stdout: '\n', stderr: 'Error: ENOENT\n    at x\n' })).toEqual({
    kind: 'failed',
    text: 'gh: the status check failed with exit 1: Error: ENOENT',
  })
})

// --- segmentsOf ----------------------------------------------------------------

const PULLS = 'https://github.com/acme/widgets/pulls?q=is%3Apr+is%3Aopen'

it('gives every bracket in the order of the status line, with pages for one repository', () => {
  expect(
    segmentsOf(report({ behind: 3, prune: 1, pullRequests: 2, dependencies: 4, alerts: 5 })),
  ).toEqual([
    { kind: 'behind', label: 'behind' },
    { kind: 'prune', label: '✂️', count: 1 },
    {
      kind: 'pullRequests',
      label: '🔀',
      count: 2,
      href: `${PULLS}+draft%3Afalse+-author%3Aapp%2Fdependabot`,
    },
    { kind: 'dependencies', label: '🤖', count: 4, href: `${PULLS}+author%3Aapp%2Fdependabot` },
    {
      kind: 'alerts',
      label: '🛡️',
      count: 5,
      href: 'https://github.com/acme/widgets/security/dependabot',
    },
  ])
})

it('leaves out each zero count', () => {
  expect(segmentsOf(report())).toEqual([])
  expect(segmentsOf(report({ alerts: 1 })).map((segment) => segment.kind)).toEqual(['alerts'])
  expect(segmentsOf(report({ prune: 1, dependencies: 1 })).map((s) => s.kind)).toEqual([
    'prune',
    'dependencies',
  ])
})

it('puts the repository count first in a folder, and gives no bracket a page', () => {
  const folder = report(
    { behind: 1, pullRequests: 1, dependencies: 2, alerts: 3 },
    { repos: 3, repository: null },
  )
  expect(segmentsOf(folder)).toEqual([
    { kind: 'repos', label: 'repos:', count: 3 },
    { kind: 'behind', label: 'behind' },
    { kind: 'pullRequests', label: '🔀', count: 1 },
    { kind: 'dependencies', label: '🤖', count: 2 },
    { kind: 'alerts', label: '🛡️', count: 3 },
  ])
})

it('never shows the repository count alone', () => {
  expect(segmentsOf(report({}, { repos: 4, repository: null }))).toEqual([])
})

it('gives each kind a theme colour', () => {
  expect(SEGMENT_COLOUR).toEqual({
    repos: 'success',
    behind: 'warning',
    prune: 'suggestion',
    pullRequests: 'planMode',
    dependencies: 'merged',
    alerts: 'error',
  })
})

// --- plainText -----------------------------------------------------------------

it('writes the brackets, then each problem, with no gh: prefix', () => {
  expect(
    plainText(
      report(
        { behind: 1, prune: 2, alerts: 3 },
        { repos: 2, repository: null, problems: ['timed out', 'GitHub request failed'] },
      ),
    ),
  ).toBe('[repos: 2] [behind] [✂️ 2] [🛡️ 3] ⚠️ timed out ⚠️ GitHub request failed')
})

it('writes a problem alone when there is no count', () => {
  expect(plainText(report({}, { problems: ['git not found on PATH'] }))).toBe(
    '⚠️ git not found on PATH',
  )
})

it('clears the pin when there is nothing to show', () => {
  expect(plainText(report())).toBeUndefined()
})
