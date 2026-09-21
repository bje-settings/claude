// The smoke run (#164, spike): a handful of real calls against Jev over
// hand-written units, so the question design can be judged against answers
// instead of against intuition. Run it by hand, never in CI:
//
//   node spike/context-audit/smoke.ts                  # both shapes
//   node spike/context-audit/smoke.ts --shape per_unit
//   node spike/context-audit/smoke.ts --probe          # + determinism, + ceiling
//
// `TYPESAFE_API_KEY` comes from the environment and goes nowhere else: it is
// read once here, handed to the client, and never printed, logged or written.
//
// The fixtures are real lines from this worktree's `CLAUDE.md` and
// `plugins/gh/README.md`, with their real line numbers, except the four
// marked `synthetic` in the table below: two history lines (neither of those
// two files carries one; the shape is taken from this worktree's git log) and
// two lines fabricated to contradict a real one, which is the only way to get
// a contradiction without one existing in the tree.

import { createJev, JevError, noul } from './jev.ts'
import {
  classifyRequest,
  evidenceRequest,
  type JevRequest,
  pairRequest,
  parseClassification,
  parseEvidence,
  parsePair,
  type RequestShape,
} from './questions.ts'
import type { Classification, EvidenceNeed, Unit, UnitKind } from './types.ts'

//
// Fixtures.
//

type Expected = {
  kind: UnitKind
  volatile: boolean
  selfContained: boolean
  evidenceNeed: EvidenceNeed
  multiAssertion: boolean
}

type Fixture = { unit: Unit; expected: Expected; synthetic?: boolean }

function unit(
  file: string,
  startLine: number,
  endLine: number,
  headingPath: string[],
  text: string,
  extra: Partial<Unit> = {},
): Unit {
  return {
    id: `${file}:${startLine}-${endLine}`,
    file,
    startLine,
    endLine,
    block: 'sentence',
    headingPath,
    leadIn: null,
    prev: null,
    next: null,
    text,
    refs: [],
    ...extra,
  }
}

const CLAUDE = 'CLAUDE.md'
const README = 'plugins/gh/README.md'

const FIXTURES: Fixture[] = [
  {
    unit: unit(
      CLAUDE,
      49,
      49,
      ['claude', 'Plugin marketplace', 'Plugin domains'],
      '- When adding a skill, name the domain it belongs to before writing it.',
      { block: 'list_item' },
    ),
    expected: {
      kind: 'instruction',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'nothing_local',
      multiAssertion: false,
    },
  },
  {
    unit: unit(
      CLAUDE,
      95,
      95,
      ['claude', 'Plugin marketplace', 'Plugin design'],
      '- New plugins use `skills/`, not `commands/`.',
      { block: 'list_item' },
    ),
    expected: {
      kind: 'instruction',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'nothing_local',
      multiAssertion: false,
    },
  },
  {
    unit: unit(
      CLAUDE,
      172,
      173,
      ['claude', 'Tests', 'Coverage'],
      "- TypeScript: `vitest.config.ts`'s thresholds are the gate, 100 on lines, branches, functions and statements over a named source set, with `cobertura` feeding the enterprise Code Coverage ruleset.",
      {
        block: 'list_item',
        refs: [
          {
            kind: 'path',
            value: 'vitest.config.ts',
            resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
          },
        ],
      },
    ),
    expected: {
      kind: 'repo_fact',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'config_value',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      CLAUDE,
      199,
      199,
      ['claude', 'Tests', 'Git hooks'],
      '- `lefthook.yml` holds the steps; `CONTRIBUTING.md` says how they install.',
      { block: 'list_item' },
    ),
    expected: {
      kind: 'repo_fact',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'file_contents',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      CLAUDE,
      24,
      24,
      ['claude', 'Plugin marketplace', 'Plugins'],
      'New plugin code is TypeScript, run directly by node on a 22.18 floor.',
    ),
    expected: {
      kind: 'repo_fact',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'config_value',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      README,
      309,
      310,
      ['gh', 'Requirements'],
      'Everything in this plugin is TypeScript, run directly by node with no build step, and it needs **node 22.18 or newer**.',
    ),
    expected: {
      kind: 'repo_fact',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'file_contents',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      CLAUDE,
      105,
      106,
      ['claude', 'Plugin marketplace', 'Skills'],
      'Enforced across the plugins **and** `.claude/skills/` by `tests/skills.test.ts`, with `tests/test_skills.py` its Python original until #138.',
    ),
    expected: {
      kind: 'repo_fact',
      volatile: true,
      selfContained: false,
      evidenceNeed: 'file_contents',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      CLAUDE,
      110,
      111,
      ['claude', 'Repo tooling: root `scripts/` and `.claude/skills/`'],
      "Root `scripts/` is this repo's own tooling, Python until #128, and `.claude/skills/` holds the skills that drive it.",
    ),
    expected: {
      kind: 'repo_fact',
      volatile: true,
      selfContained: true,
      evidenceNeed: 'file_contents',
      multiAssertion: true,
    },
  },
  {
    unit: unit(
      CLAUDE,
      107,
      107,
      ['claude', 'Plugin marketplace', 'Skills'],
      'See `.claude/rules/file-skill-md.md`.',
    ),
    expected: {
      kind: 'pointer',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'file_exists',
      multiAssertion: false,
    },
  },
  {
    unit: unit(
      README,
      270,
      271,
      ['gh', 'The session-start hook'],
      'A node below the floor is the same silence: the hook checks the running version first and exits 0 without writing anything, because a hook that explains itself on stderr writes into the session.',
    ),
    expected: {
      kind: 'rationale',
      volatile: false,
      selfContained: false,
      evidenceNeed: 'file_contents',
      multiAssertion: false,
    },
  },
  {
    unit: unit(
      README,
      87,
      88,
      ['gh', 'How a branch is proven merged'],
      'Deletion uses `git branch -D`, which is required because a squash-merged branch is not an ancestor of anything.',
    ),
    expected: {
      kind: 'rationale',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'nothing_local',
      multiAssertion: false,
    },
  },
  {
    unit: unit(CLAUDE, 145, 145, ['claude', 'Tests'], '### Tests', { block: 'sentence' }),
    expected: {
      kind: 'structural',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'nothing_local',
      multiAssertion: false,
    },
  },
  // Synthetic: the two audited files carry no history line. These two are
  // written from this worktree's git log, in the voice a round record uses.
  {
    synthetic: true,
    unit: unit(
      CLAUDE,
      1,
      1,
      ['claude', 'Records'],
      "PR #162 merged as 7fbd778 and retired the `gh` plugin's Python.",
    ),
    expected: {
      kind: 'history',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'github_state',
      multiAssertion: true,
    },
  },
  {
    synthetic: true,
    unit: unit(
      CLAUDE,
      2,
      2,
      ['claude', 'Records'],
      'Round 6 landed the `gh` port as four stacked pull requests on 2026-09-21.',
    ),
    expected: {
      kind: 'history',
      volatile: false,
      selfContained: true,
      evidenceNeed: 'github_state',
      multiAssertion: false,
    },
  },
]

/** Synthetic: fabricated to contradict fixture 2, since nothing in the tree contradicts it. */
const CONTRADICTING = unit(
  'docs/adr/002-quality-gate-venues.md',
  40,
  40,
  ['ADR 002', 'Coverage'],
  'The TypeScript coverage gate is 80 on lines and branches.',
)

const UNITS = FIXTURES.map((fixture) => fixture.unit)

//
// The three cases beyond classification.
//

/** `vitest.config.ts:86-91`, verbatim. */
const VITEST_EXCERPT = [
  '      thresholds: {',
  '        lines: 100,',
  '        functions: 100,',
  '        branches: 100,',
  '        statements: 100,',
  '      },',
].join('\n')

const PAIRS = [
  {
    label: 'same claim across two files (node floor)',
    a: UNITS[4] as Unit,
    b: UNITS[5] as Unit,
    expected: 'same_claim' as const,
  },
  {
    label: 'fabricated contradiction (coverage gate)',
    a: UNITS[2] as Unit,
    b: CONTRADICTING,
    expected: 'contradicts' as const,
  },
  {
    label: 'same subject, compatible detail (hooks)',
    a: UNITS[3] as Unit,
    b: UNITS[0] as Unit,
    expected: 'unrelated' as const,
  },
]

const EVIDENCE = [
  {
    label: 'real claim against the file it is about',
    unit: UNITS[2] as Unit,
    source: 'vitest.config.ts',
    excerpt: VITEST_EXCERPT,
    expected: 'supports' as const,
  },
  {
    label: 'fabricated claim against the same excerpt',
    unit: CONTRADICTING,
    source: 'vitest.config.ts',
    excerpt: VITEST_EXCERPT,
    expected: 'contradicts' as const,
  },
]

//
// Reporting.
//

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat.padEnd(width) : `${flat.slice(0, width - 1)}…`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width)
}

function pct(value: number): string {
  return value.toFixed(2).replace(/^0/, ' ')
}

type Tally = { hits: number; total: number }

function mark(hit: boolean, tally: Tally): string {
  tally.total += 1
  if (hit) tally.hits += 1
  return hit ? '  ' : ' X'
}

const JUDGMENT_NAMES = ['kind', 'volatile', 'self', 'evidence', 'multi'] as const

function reportClassifications(
  shape: RequestShape,
  parsed: Classification[],
  tallies: Record<string, Tally>,
): void {
  console.log(`\n## classification, ${shape}`)
  console.log(
    [
      pad('id', 4),
      pad('kind', 14),
      pad('p', 5),
      '  ',
      pad('vol', 5),
      '  ',
      pad('self', 5),
      '  ',
      pad('evidence', 14),
      pad('p', 5),
      '  ',
      pad('multi', 5),
      '  ',
      'text',
    ].join(' '),
  )
  for (const [index, classification] of parsed.entries()) {
    const fixture = FIXTURES[index]
    if (fixture === undefined) continue
    const want = fixture.expected
    const kindHit = classification.kind.choice === want.kind
    const evidenceHit = classification.evidenceNeed.choice === want.evidenceNeed
    const volHit = classification.volatile >= 0.5 === want.volatile
    const selfHit = classification.selfContained >= 0.5 === want.selfContained
    const multiHit = classification.multiAssertion >= 0.5 === want.multiAssertion
    console.log(
      [
        pad(`u${index}`, 4),
        pad(classification.kind.choice, 14),
        pct(classification.kind.probabilities[classification.kind.choice]),
        mark(kindHit, tallies.kind as Tally),
        pct(classification.volatile),
        mark(volHit, tallies.volatile as Tally),
        pct(classification.selfContained),
        mark(selfHit, tallies.self as Tally),
        pad(classification.evidenceNeed.choice, 14),
        pct(classification.evidenceNeed.probabilities[classification.evidenceNeed.choice]),
        mark(evidenceHit, tallies.evidence as Tally),
        pct(classification.multiAssertion),
        mark(multiHit, tallies.multi as Tally),
        truncate(fixture.unit.text, 54),
      ].join(' '),
    )
    const misses: string[] = []
    if (!kindHit) misses.push(`kind wanted ${want.kind}`)
    if (!evidenceHit) misses.push(`evidence wanted ${want.evidenceNeed}`)
    if (!volHit) misses.push(`volatile wanted ${want.volatile}`)
    if (!selfHit) misses.push(`self_contained wanted ${want.selfContained}`)
    if (!multiHit) misses.push(`multi_assertion wanted ${want.multiAssertion}`)
    if (misses.length > 0) console.log(`${' '.repeat(5)}-> ${misses.join('; ')}`)
  }
}

//
// The run.
//

type Options = { shapes: RequestShape[]; probe: boolean }

function parseArgv(argv: string[]): Options {
  const asked = argv.includes('--shape') ? argv[argv.indexOf('--shape') + 1] : 'both'
  const shapes: RequestShape[] =
    asked === 'per_unit' || asked === 'per_section' ? [asked] : ['per_unit', 'per_section']
  return { shapes, probe: argv.includes('--probe') }
}

async function main(): Promise<number> {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (apiKey === undefined || apiKey === '') {
    console.error('TYPESAFE_API_KEY is not set')
    return 1
  }
  const options = parseArgv(process.argv.slice(2))
  const jev = createJev({ apiKey, concurrency: 6 })

  const latencies: number[] = []
  async function ask(request: JevRequest): Promise<Record<string, unknown>> {
    const started = Date.now()
    const answers = await jev.ask(request.state, request.questions)
    latencies.push(Date.now() - started)
    return answers as Record<string, unknown>
  }

  const tallies: Record<string, Tally> = {}
  for (const name of JUDGMENT_NAMES) tallies[name] = { hits: 0, total: 0 }
  const perShape: Record<string, Tally> = {}

  for (const shape of options.shapes) {
    const before = Object.fromEntries(
      JUDGMENT_NAMES.map((name) => [name, { ...(tallies[name] as Tally) }]),
    )
    const spentBefore = jev.usage()
    const requests = classifyRequest(UNITS, { shape })
    const bags = await Promise.all(requests.map((request) => ask(request)))
    const answers = Object.assign({}, ...bags) as Record<string, unknown>
    reportClassifications(shape, parseClassification(UNITS, answers), tallies)
    const hits = JUDGMENT_NAMES.reduce(
      (sum, name) => sum + (tallies[name] as Tally).hits - (before[name] as Tally).hits,
      0,
    )
    const total = JUDGMENT_NAMES.reduce(
      (sum, name) => sum + (tallies[name] as Tally).total - (before[name] as Tally).total,
      0,
    )
    perShape[shape] = { hits, total }
    const spent = jev.usage()
    console.log(
      `     ${shape}: ${requests.length} requests, ${hits}/${total} judgments matched, ` +
        `${spent.inputTokens - spentBefore.inputTokens} input tokens`,
    )
  }

  console.log('\n## pairs')
  const pairTally: Tally = { hits: 0, total: 0 }
  for (const pair of PAIRS) {
    const answers = await ask(pairRequest(pair.a, pair.b))
    const judgment = parsePair({ a: pair.a.id, b: pair.b.id, similarity: 1 }, answers)
    const hit = judgment.verdict.choice === pair.expected
    console.log(
      [
        pad(judgment.verdict.choice, 12),
        pct(judgment.verdict.probabilities[judgment.verdict.choice]),
        `conf ${pct(judgment.verdict.confidence)}`,
        mark(hit, pairTally),
        `want ${pad(pair.expected, 12)}`,
        pair.label,
      ].join(' '),
    )
  }

  console.log('\n## evidence')
  const evidenceTally: Tally = { hits: 0, total: 0 }
  for (const check of EVIDENCE) {
    const answers = await ask(evidenceRequest(check.unit, check.source, check.excerpt))
    const judgment = parseEvidence(check.unit, check.source, check.excerpt, answers)
    const hit = judgment.verdict.choice === check.expected
    console.log(
      [
        pad(judgment.verdict.choice, 13),
        pct(judgment.verdict.probabilities[judgment.verdict.choice]),
        `conf ${pct(judgment.verdict.confidence)}`,
        mark(hit, evidenceTally),
        `want ${pad(check.expected, 13)}`,
        check.label,
      ].join(' '),
    )
  }

  if (options.probe) {
    await determinism(ask)
    await ceiling(jev)
  }

  console.log('\n## totals')
  for (const name of JUDGMENT_NAMES) {
    const tally = tallies[name] as Tally
    console.log(`  ${pad(name, 9)} ${tally.hits}/${tally.total}`)
  }
  for (const [shape, tally] of Object.entries(perShape)) {
    console.log(`  ${pad(shape, 12)} ${tally.hits}/${tally.total}`)
  }
  console.log(`  pairs     ${pairTally.hits}/${pairTally.total}`)
  console.log(`  evidence  ${evidenceTally.hits}/${evidenceTally.total}`)

  const usage = jev.usage()
  const sorted = [...latencies].sort((a, b) => a - b)
  console.log(
    `\n## usage\n  ${usage.requests} requests, ${usage.inputTokens} input tokens, ` +
      `${usage.outputTokens} output tokens, ${usage.requestMsSum} ms of request time`,
  )
  if (sorted.length > 0) {
    const median = sorted[Math.floor(sorted.length / 2)] as number
    console.log(
      `  latency per request: min ${sorted[0]} ms, median ${median} ms, max ${sorted[sorted.length - 1]} ms`,
    )
  }
  return 0
}

/**
 * The docs do not say whether two identical requests return identical
 * numbers, and nothing can gate CI on a value that moves. Three sends of one
 * request, compared field by field.
 */
async function determinism(
  ask: (request: JevRequest) => Promise<Record<string, unknown>>,
): Promise<void> {
  console.log('\n## determinism: the same request, three times')
  const [request] = classifyRequest([UNITS[2] as Unit], { shape: 'per_unit' })
  if (request === undefined) return
  const runs: Classification[] = []
  for (let i = 0; i < 3; i += 1) {
    runs.push(parseClassification([UNITS[2] as Unit], await ask(request))[0] as Classification)
  }
  const line = (c: Classification) =>
    [
      `${c.kind.choice} ${c.kind.probabilities[c.kind.choice].toFixed(6)}`,
      `conf ${c.kind.confidence.toFixed(6)}`,
      `vol ${c.volatile.toFixed(6)}`,
      `self ${c.selfContained.toFixed(6)}`,
      `${c.evidenceNeed.choice} ${c.evidenceNeed.probabilities[c.evidenceNeed.choice].toFixed(6)}`,
      `multi ${c.multiAssertion.toFixed(6)}`,
    ].join('  ')
  for (const [index, run] of runs.entries()) console.log(`  run ${index + 1}  ${line(run)}`)
  const identical = new Set(runs.map((run) => JSON.stringify(run))).size === 1
  console.log(`  identical across all three: ${identical}`)
}

/**
 * The docs give a token budget but no question count. This finds the ceiling
 * by sending a section-shaped request with a growing number of trivial
 * questions over a tiny state, and reports the first failure with its body.
 */
async function ceiling(jev: ReturnType<typeof createJev>): Promise<void> {
  console.log('\n## question-count ceiling')
  // The state stays at one unit so this measures the question count alone.
  // Growing both at once only finds the token budget again, which the docs
  // already state.
  const state = { units: { u0: { text: 'The coverage gate is 100 on four buckets.' } } }
  for (const count of [50, 100, 200, 400, 800, 1600, 3200]) {
    const questions = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `q${i}`,
        noul(`Reading ${i}: does \`units.u0.text\` tell the reader to do something?`),
      ]),
    )
    const started = Date.now()
    try {
      await jev.ask(state, questions)
      console.log(`  ${pad(String(count), 4)} questions: accepted in ${Date.now() - started} ms`)
    } catch (error) {
      if (error instanceof JevError) {
        console.log(
          `  ${pad(String(count), 4)} questions: HTTP ${error.status} ${truncate(error.body, 200).trim()}`,
        )
      } else {
        console.log(`  ${pad(String(count), 4)} questions: ${String(error)}`)
      }
      return
    }
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof JevError && (error.status === 401 || error.status === 403)) {
    console.error(`stopping: the API refused the key with HTTP ${error.status}. ${error.body}`)
    process.exitCode = 1
  } else {
    throw error
  }
}
