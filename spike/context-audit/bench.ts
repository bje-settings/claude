// Benchmark harness (#164): the same sample, judged by Jev and by a Claude
// subagent, so time, tokens and agreement can be compared like for like.
//   node bench.ts prepare <report.json> <dir>   write the sample and the rubric
//   node bench.ts jev <dir> [per_unit]          judge the sample with Jev, timed
//   node bench.ts compare <dir>                 agreement between every answer file
// The subagent reads the same state and the same rubric Jev is sent, and
// writes <dir>/<name>.json in the shape `jev` writes. `compare` reads every
// answer file whose name starts with jev, sonnet or opus. Only the per_unit
// run of `jev` sends Jev what the subagent read; the default per_section run
// batches units and drops prev and next, so it is a different comparison.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJev } from './jev.ts'
import {
  classifyRequest,
  EVIDENCE_QUESTION_ID,
  evidenceRequest,
  PAIR_QUESTION_ID,
  pairRequest,
  parseClassification,
  parseEvidence,
  parsePair,
  type RequestShape,
} from './questions.ts'
import type { Report, Unit } from './types.ts'

const SAMPLE = { units: 100, pairs: 30, evidence: 10 }

type UnitAnswer = {
  kind: string
  volatile: boolean
  self_contained: boolean
  evidence: string
  multi_assertion: boolean
}
type Answers = {
  units: Record<string, UnitAnswer>
  pairs: Record<string, string>
  evidence: Record<string, string>
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

/** Every nth item, so the sample spans the files instead of taking the first one. */
export const stride = <T>(items: T[], count: number): T[] => {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)] as T)
}

const prepare = (reportPath: string, dir: string): void => {
  const report = readJson<Report>(reportPath)
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  const unit = (id: string): Unit => {
    const found = byId.get(id)
    // A stale report names units its own units array no longer has.
    if (found === undefined) throw new Error(`report names unknown unit ${id}`)
    return found
  }
  const units = stride(report.units, SAMPLE.units)
  const pairs = stride(report.pairs, SAMPLE.pairs).map((pair) => ({
    a: unit(pair.a),
    b: unit(pair.b),
  }))
  const evidence = stride(report.evidence, SAMPLE.evidence).map((e) => ({
    unit: unit(e.unitId),
    source: e.source,
    excerpt: e.excerpt,
  }))

  // What the subagent reads is exactly what Jev is sent: the state of a
  // per_unit request, and the question objects as the rubric.
  const requests = classifyRequest(units, { shape: 'per_unit' })
  writeJson(join(dir, 'sample.json'), { units, pairs, evidence })
  writeJson(
    join(dir, 'units.json'),
    units.map((unit, i) => ({ id: unit.id, state: requests[i]?.state })),
  )
  writeJson(
    join(dir, 'pairs.json'),
    pairs.map(({ a, b }, i) => ({ id: String(i), state: pairRequest(a, b).state })),
  )
  writeJson(
    join(dir, 'evidence.json'),
    evidence.map(({ unit, source, excerpt }, i) => ({
      id: String(i),
      state: evidenceRequest(unit, source, excerpt).state,
    })),
  )
  const first = pairs[0]
  const firstEvidence = evidence[0]
  writeJson(join(dir, 'rubric.json'), {
    unit_questions: requests[0]?.questions,
    pair_question: first === undefined ? null : pairRequest(first.a, first.b).questions,
    evidence_question:
      firstEvidence === undefined
        ? null
        : evidenceRequest(firstEvidence.unit, firstEvidence.source, firstEvidence.excerpt)
            .questions,
  })
  process.stdout.write(
    `${units.length} units, ${pairs.length} pairs, ${evidence.length} evidence\n`,
  )
}

const runJev = async (dir: string, shape: RequestShape): Promise<void> => {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (apiKey === undefined || apiKey === '') throw new Error('TYPESAFE_API_KEY is not set')
  const sample = readJson<{
    units: Unit[]
    pairs: { a: Unit; b: Unit }[]
    evidence: { unit: Unit; source: string; excerpt: string }[]
  }>(join(dir, 'sample.json'))
  const answers: Answers = { units: {}, pairs: {}, evidence: {} }
  const timings: Record<string, unknown> = {}

  // One client per stage so each stage's usage and wall clock stand alone.
  const stage = async (
    name: string,
    work: (jev: ReturnType<typeof createJev>) => Promise<void>,
  ) => {
    const jev = createJev({ apiKey })
    const started = Date.now()
    await work(jev)
    timings[name] = { wallClockMs: Date.now() - started, ...jev.usage() }
  }

  await stage('classify', async (jev) => {
    const requests = classifyRequest(sample.units, { shape })
    const bags = await Promise.all(requests.map((r) => jev.ask(r.state, r.questions)))
    for (const c of parseClassification(sample.units, Object.assign({}, ...bags))) {
      answers.units[c.unitId] = {
        kind: c.kind.choice,
        volatile: c.volatile >= 0.5,
        self_contained: c.selfContained >= 0.5,
        evidence: c.evidenceNeed.choice,
        multi_assertion: c.multiAssertion >= 0.5,
      }
    }
  })
  await stage('pairs', async (jev) => {
    await Promise.all(
      sample.pairs.map(async ({ a, b }, i) => {
        const r = pairRequest(a, b)
        const bag = await jev.ask(r.state, r.questions)
        if (bag[PAIR_QUESTION_ID] === undefined) throw new Error('no pair answer')
        answers.pairs[String(i)] = parsePair(
          { a: a.id, b: b.id, similarity: 0 },
          bag,
        ).verdict.choice
      }),
    )
  })
  await stage('evidence', async (jev) => {
    await Promise.all(
      sample.evidence.map(async ({ unit, source, excerpt }, i) => {
        const r = evidenceRequest(unit, source, excerpt)
        const bag = await jev.ask(r.state, r.questions)
        if (bag[EVIDENCE_QUESTION_ID] === undefined) throw new Error('no evidence answer')
        answers.evidence[String(i)] = parseEvidence(unit, source, excerpt, bag).verdict.choice
      }),
    )
  })

  // per_unit is the shape the subagents are given, so it is the like for like run.
  const name = shape === 'per_unit' ? 'jev-per-unit' : 'jev'
  writeJson(join(dir, `${name}.json`), answers)
  writeJson(join(dir, `${name}-timings.json`), timings)
  process.stdout.write(`${JSON.stringify(timings, null, 2)}\n`)
}

/** Agreement over the ids BOTH files answered, with the ids either side lacks counted, never hidden. */
export const agreement = (
  x: Record<string, unknown>,
  y: Record<string, unknown>,
  pick: (v: unknown) => unknown = (v) => v,
): { same: number; both: number; onlyX: number; onlyY: number } => {
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  let same = 0
  let both = 0
  let onlyX = 0
  let onlyY = 0
  for (const key of keys) {
    const inX = key in x
    const inY = key in y
    // A field absent from an answer counts as missing on that side, so two
    // files that both omit it cannot score as agreeing on it.
    const vx = inX ? pick(x[key]) : undefined
    const vy = inY ? pick(y[key]) : undefined
    if (vx !== undefined && vy !== undefined) {
      both++
      if (vx === vy) same++
    } else if (vx !== undefined) onlyX++
    else if (vy !== undefined) onlyY++
  }
  return { same, both, onlyX, onlyY }
}

const compare = (dir: string): void => {
  const names = readdirSync(dir)
    .filter((f) => /^(jev|sonnet|opus)[\w-]*\.json$/.test(f) && !f.includes('timings'))
    .map((f) => f.replace('.json', ''))
  if (names.length < 2) {
    throw new Error(
      `compare needs two or more answer files named jev*.json, sonnet*.json or opus*.json in ${dir}; found: ${names.join(', ') || 'none'}`,
    )
  }
  const loaded = new Map(names.map((name) => [name, readJson<Answers>(join(dir, `${name}.json`))]))
  const fields = ['kind', 'volatile', 'self_contained', 'evidence', 'multi_assertion'] as const
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const x = loaded.get(names[i] as string) as Answers
      const y = loaded.get(names[j] as string) as Answers
      const show = (a: ReturnType<typeof agreement>): string =>
        a.onlyX + a.onlyY === 0
          ? `${a.same}/${a.both}`
          : `${a.same}/${a.both} (missing ${a.onlyX}|${a.onlyY})`
      const parts = fields.map(
        (field) =>
          `${field} ${show(agreement(x.units, y.units, (v) => (v as UnitAnswer | undefined)?.[field]))}`,
      )
      parts.push(`pairs ${show(agreement(x.pairs, y.pairs))}`)
      parts.push(`evidence ${show(agreement(x.evidence, y.evidence))}`)
      process.stdout.write(`${names[i]} vs ${names[j]}: ${parts.join(', ')}\n`)
    }
  }
}

// import.meta.url is the real path; argv[1] may reach this file through a symlink.
const invokedDirectly = ((): boolean => {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()
const [mode, first, second] = invokedDirectly ? process.argv.slice(2) : []
if (!invokedDirectly) {
  // imported by a test
} else if (mode === 'prepare' && first !== undefined && second !== undefined) prepare(first, second)
else if (mode === 'jev' && first !== undefined) {
  if (!existsSync(first)) throw new Error(`no such directory ${first}`)

  await runJev(first, second === 'per_unit' ? 'per_unit' : 'per_section')
} else if (mode === 'compare' && first !== undefined) compare(first)
else {
  process.stderr.write('usage: bench.ts prepare <report.json> <dir> | jev <dir> | compare <dir>\n')
  process.exitCode = 1
}
