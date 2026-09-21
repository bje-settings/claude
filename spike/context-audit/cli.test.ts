import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evidenceSource, isExpired, parseArgs, printFindings, runAudit, tierZero } from './cli.ts'
import { splitMarkdown } from './split.ts'
import type { Classification, Ref, Report, Unit } from './types.ts'

const unit = (over: Partial<Unit> = {}): Unit => ({
  id: 'a.md:1-1',
  file: 'a.md',
  startLine: 1,
  endLine: 1,
  block: 'sentence',
  headingPath: [],
  leadIn: null,
  prev: null,
  next: null,
  text: 'A claim.',
  refs: [],
  ...over,
})

const classification = (over: Partial<Classification> = {}): Classification => ({
  unitId: 'a.md:1-1',
  kind: { choice: 'repo_fact', probabilities: {} as never, confidence: 1 },
  volatile: 0.9,
  selfContained: 1,
  evidenceNeed: { choice: 'file_contents', probabilities: {} as never, confidence: 1 },
  multiAssertion: 0,
  ...over,
})

const issue = (state: 'OPEN' | 'CLOSED' | 'MERGED'): Ref => ({
  kind: 'issue',
  value: '#1',
  resolution: { status: 'issue', state },
})

test('parseArgs refuses a NaN count, a bad enum value and a second root', () => {
  assert.throws(() => parseArgs(['.', '--max-pairs', 'abc']), /whole number/)
  assert.throws(() => parseArgs(['.', '--max-pairs', '-5']), /whole number/)
  assert.throws(() => parseArgs(['.', '--pair-threshold', 'abc']), /0 to 1/)
  assert.throws(() => parseArgs(['.', '--scope', 'al']), /must be one of/)
  assert.throws(() => parseArgs(['.', '--shape', 'per-unit']), /must be one of/)
  assert.throws(() => parseArgs(['.', 'other']), /one root only/)
  assert.throws(() => parseArgs([]), /usage/)
  assert.throws(() => parseArgs(['.', '--out']), /needs a value/)
  const ok = parseArgs(['.', '--no-jev', '--max-pairs', '7', '--shape', 'per_unit'])
  assert.equal(ok.jev, false)
  assert.equal(ok.maxPairs, 7)
  assert.equal(ok.shape, 'per_unit')
})

test('isExpired needs a volatile non-history unit and an issue that is not open', () => {
  const closed = unit({ refs: [issue('CLOSED')] })
  assert.equal(isExpired(closed, classification()), true)
  assert.equal(isExpired(unit({ refs: [issue('MERGED')] }), classification()), true)
  assert.equal(isExpired(unit({ refs: [issue('OPEN')] }), classification()), false)
  assert.equal(isExpired(closed, classification({ volatile: 0.5 })), false)
  assert.equal(
    isExpired(
      closed,
      classification({ kind: { choice: 'history', probabilities: {} as never, confidence: 1 } }),
    ),
    false,
  )
  assert.equal(isExpired(closed, undefined), false)
  // An unchecked issue is not a closed one.
  const unchecked: Ref = {
    kind: 'issue',
    value: '#1',
    resolution: { status: 'unchecked', reason: 'unavailable' },
  }
  assert.equal(isExpired(unit({ refs: [unchecked] }), classification()), false)
})

test('evidenceSource takes the first found file ref in source order, skipping its own file and tail matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-'))
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'x.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'a.md'), 'doc\n')
  const found = (repoPath: string, value = repoPath, kind: Ref['kind'] = 'path'): Ref => ({
    kind,
    value,
    resolution: { status: 'found', repoPath },
  })
  const u = unit({
    refs: [
      found('a.md'),
      { kind: 'path', value: 'y.ts', resolution: { status: 'tail_match', witness: 'lib/x.ts' } },
      found('lib/x.ts', 'lib/x.ts:1', 'file_line'),
      found('lib/x.ts'),
    ],
  })
  assert.deepEqual(evidenceSource(root, u), { source: 'lib/x.ts', excerpt: 'export const x = 1\n' })
  assert.equal(evidenceSource(root, unit()), null)
})

const report = (over: Partial<Report> = {}): Report => ({
  root: '/r',
  files: ['a.md'],
  units: [unit()],
  opaque: [],
  warnings: [],
  issueLookup: 'ok',
  skipped: [],
  classifications: [],
  pairs: [],
  pairCoverage: { judged: 0, available: 0 },
  evidence: [],
  evidenceCoverage: { judged: 0, available: 0 },
  failures: [],
  usage: { requests: 0, attempts: 0, inputTokens: 0, outputTokens: 0, requestMsSum: 0 },
  wallClockMs: 0,
  ...over,
})

const render = (r: Report): string => {
  const lines: string[] = []
  printFindings(r, (line) => lines.push(line))
  return lines.join('\n')
}

test('printFindings says what was skipped, unavailable, unchecked, truncated and failed', () => {
  const out = render(
    report({
      skipped: ['classify', 'pairs', 'evidence'],
      issueLookup: 'gh repo view failed',
      warnings: [{ file: 'a.md', line: 3, kind: 'unclosed_fence' }],
      units: [
        unit({
          refs: [
            { kind: 'path', value: 'gone.ts', resolution: { status: 'absent' } },
            {
              kind: 'path',
              value: '~/x',
              resolution: { status: 'unchecked', reason: 'machine_specific' },
            },
            {
              kind: 'path',
              value: 'y.ts',
              resolution: { status: 'tail_match', witness: 'lib/y.ts' },
            },
            {
              kind: 'file_line',
              value: 'a.md:9',
              resolution: { status: 'line_out_of_range', repoPath: 'a.md', lines: 2 },
            },
          ],
        }),
      ],
      pairCoverage: { judged: 3, available: 10 },
      failures: [{ stage: 'pairs', id: 'x <> y', message: 'HTTP 500' }],
    }),
  )
  assert.match(out, /warning: a\.md:3 unclosed_fence/)
  assert.match(out, /issue lookup unavailable: gh repo view failed/)
  assert.match(out, /do not resolve \(1\)\n {2}a\.md:1 {2}path `gone\.ts` {2}absent/)
  assert.match(
    out,
    /past the end of the file \(1\)\n {2}a\.md:1 {2}file_line `a\.md:9` {2}only 2 lines/,
  )
  assert.match(out, /refs not checked\n {2}1 {2}path machine_specific\n {2}1 {2}path tail_match/)
  assert.match(out, /volatile and the issue it names is closed\n {2}skipped \(--no-jev\)/)
  assert.match(out, /pairs: contradicts \(0; 3 of 10 judged\)\n {2}skipped/)
  assert.match(out, /failures \(1\)\n {2}pairs x <> y: HTTP 500/)
})

test('printFindings lists an expired unit only when the issue lookup worked', () => {
  const base = {
    units: [unit({ refs: [issue('CLOSED')] })],
    classifications: [classification()],
  }
  assert.match(render(report(base)), /closed\n {2}a\.md:1-1 {2}A claim\./)
  assert.match(
    render(report({ ...base, issueLookup: 'gh failed' })),
    /closed\n {2}not checked: issue lookup unavailable/,
  )
})

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'cli-repo-'))
  execFileSync('git', ['init', '-q', root])
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'x.ts'), 'export const x = 1\n')
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# T\n\nSee `lib/x.ts`. Gone is `lib/gone.ts`. Runs `pnpm test`.\n\n```mermaid\nclassDef a color:#000\n```\n\n```bash\nls lib/x.ts\n```\n',
  )
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}\n')
  execFileSync('git', ['-C', root, 'add', '.'])
  return root
}

test('tierZero resolves against the tree, reads code blocks without a fence re-wrap and skips mermaid', () => {
  const root = repo()
  const split = splitMarkdown('CLAUDE.md', readFileSync(join(root, 'CLAUDE.md'), 'utf8'))
  tierZero(root, split.units, split.opaque)
  const byValue = new Map(
    [...split.units, ...split.opaque].flatMap((b) =>
      b.refs.map((r) => [r.value, r.resolution] as const),
    ),
  )
  assert.deepEqual(byValue.get('lib/x.ts'), { status: 'found', repoPath: 'lib/x.ts' })
  assert.deepEqual(byValue.get('lib/gone.ts'), { status: 'absent' })
  assert.deepEqual(byValue.get('pnpm test'), { status: 'found', repoPath: null })
  assert.deepEqual(byValue.get('ls'), { status: 'unchecked', reason: 'no_resolver' })
  // The mermaid colour is no issue, so no issue lookup ran at all.
  assert.equal(
    [...byValue.keys()].some((v) => v.startsWith('#')),
    false,
  )
})

test('runAudit with --no-jev writes a full report with every model stage marked skipped', async () => {
  const root = repo()
  const r = await runAudit(parseArgs([root, '--no-jev']))
  assert.equal(r.files.length, 1)
  assert.ok(r.units.length >= 3)
  assert.deepEqual(r.skipped, ['classify', 'pairs', 'evidence'])
  assert.equal(r.issueLookup, 'ok')
  assert.deepEqual(r.failures, [])
  assert.equal(new Set(r.units.map((u) => u.id)).size, r.units.length)
  assert.ok(r.wallClockMs >= 0)
})
