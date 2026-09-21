// Benchmark harness (#164): the same sample, judged by Jev and by a Claude
// subagent, so time, tokens and agreement can be compared like for like.
//   node bench.ts prepare <report.json> <dir>   write the sample and the rubric
//   node bench.ts jev <dir>                     judge the sample with Jev, timed
//   node bench.ts compare <dir>                 agreement between every answer file
// The subagent reads the same state and the same rubric Jev is sent, and
// writes <dir>/<name>.json in the shape `jev` writes.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJev } from './jev.ts'
import {
  type AnswerBag,
  classifyRequest,
  EVIDENCE_QUESTION_ID,
  evidenceRequest,
  PAIR_QUESTION_ID,
  pairRequest,
  parseClassification,
  parseEvidence,
  parsePair,
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
const stride = <T>(items: T[], count: number): T[] => {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)] as T)
}

const prepare = (reportPath: string, dir: string): void => {
  const report = readJson<Report>(reportPath)
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  const units = stride(report.units, SAMPLE.units)
  const pairs = stride(report.pairs, SAMPLE.pairs).map((pair) => ({
    a: byId.get(pair.a) as Unit,
    b: byId.get(pair.b) as Unit,
  }))
  const evidence = stride(report.evidence, SAMPLE.evidence).map((e) => ({
    unit: byId.get(e.unitId) as Unit,
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

const runJev = async (dir: string): Promise<void> => {
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
    const requests = classifyRequest(sample.units, { shape: 'per_section' })
    const bags = await Promise.all(
      requests.map((r) => jev.ask(r.state, r.questions) as Promise<AnswerBag>),
    )
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
        const bag = (await jev.ask(r.state, r.questions)) as AnswerBag
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
        const bag = (await jev.ask(r.state, r.questions)) as AnswerBag
        if (bag[EVIDENCE_QUESTION_ID] === undefined) throw new Error('no evidence answer')
        answers.evidence[String(i)] = parseEvidence(unit, source, excerpt, bag).verdict.choice
      }),
    )
  })

  writeJson(join(dir, 'jev.json'), answers)
  writeJson(join(dir, 'jev-timings.json'), timings)
  process.stdout.write(`${JSON.stringify(timings, null, 2)}\n`)
}

const compare = (dir: string): void => {
  const names = readdirSync(dir)
    .filter((f) => /^(jev|sonnet|opus)[\w-]*\.json$/.test(f) && !f.includes('timings'))
    .map((f) => f.replace('.json', ''))
  const loaded = new Map(names.map((name) => [name, readJson<Answers>(join(dir, `${name}.json`))]))
  const fields = ['kind', 'volatile', 'self_contained', 'evidence', 'multi_assertion'] as const
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const x = loaded.get(names[i] as string) as Answers
      const y = loaded.get(names[j] as string) as Answers
      const rate = (pairs: [unknown, unknown][]): string => {
        const both = pairs.filter(([p, q]) => p !== undefined && q !== undefined)
        const same = both.filter(([p, q]) => p === q).length
        return `${same}/${both.length}`
      }
      const parts = fields.map(
        (field) =>
          `${field} ${rate(Object.keys(x.units).map((id) => [x.units[id]?.[field], y.units[id]?.[field]]))}`,
      )
      parts.push(`pairs ${rate(Object.keys(x.pairs).map((id) => [x.pairs[id], y.pairs[id]]))}`)
      parts.push(
        `evidence ${rate(Object.keys(x.evidence).map((id) => [x.evidence[id], y.evidence[id]]))}`,
      )
      process.stdout.write(`${names[i]} vs ${names[j]}: ${parts.join(', ')}\n`)
    }
  }
}

const [mode, first, second] = process.argv.slice(2)
if (mode === 'prepare' && first !== undefined && second !== undefined) prepare(first, second)
else if (mode === 'jev' && first !== undefined && existsSync(first)) await runJev(first)
else if (mode === 'compare' && first !== undefined) compare(first)
else {
  process.stderr.write('usage: bench.ts prepare <report.json> <dir> | jev <dir> | compare <dir>\n')
  process.exitCode = 1
}
