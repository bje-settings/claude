// The POC's entry point (#164): node spike/context-audit/cli.ts <root> [flags].
// It wires the pieces in tier order and writes one JSON report, then prints
// the findings a reviewer (human or agent) would start from. Nothing here
// decides anything the pieces do not: it only routes units between them.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { candidatePairs } from './candidates.ts'
import { discoverFiles, scopeFilter } from './discover.ts'
import { createJev, type Jev } from './jev.ts'
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
  type RequestShape,
} from './questions.ts'
import { extractRefs, ghIssueStates, resolveRefs } from './refs.ts'
import { splitMarkdown } from './split.ts'
import type {
  Classification,
  EvidenceJudgment,
  OpaqueBlock,
  PairJudgment,
  Ref,
  Report,
  Unit,
} from './types.ts'

type Options = {
  root: string
  scope: 'context' | 'all'
  shape: RequestShape
  jev: boolean
  out: string | null
  maxPairs: number
  maxEvidence: number
  pairThreshold: number
}

// The excerpt a claim is judged against. Jev's accuracy falls as unrelated
// state grows, so the head of the file is a deliberate, crude bound; choosing
// the relevant span is the retrieval problem the spike has not solved.
const EXCERPT_CHARS = 6000

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    root: '',
    scope: 'context',
    shape: 'per_section',
    jev: true,
    out: null,
    maxPairs: 300,
    maxEvidence: 200,
    pairThreshold: 0.5,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--scope') options.scope = value() === 'all' ? 'all' : 'context'
    else if (arg === '--shape') options.shape = value() === 'per_unit' ? 'per_unit' : 'per_section'
    else if (arg === '--no-jev') options.jev = false
    else if (arg === '--out') options.out = value()
    else if (arg === '--max-pairs') options.maxPairs = Number(value())
    else if (arg === '--max-evidence') options.maxEvidence = Number(value())
    else if (arg === '--pair-threshold') options.pairThreshold = Number(value())
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
    else options.root = resolve(arg)
  }
  if (options.root === '') throw new Error('usage: cli.ts <root> [--scope context|all] [--no-jev]')
  return options
}

const issueNumbers = (refs: Ref[]): number[] =>
  refs.filter((ref) => ref.kind === 'issue').map((ref) => Number(ref.value.replace('#', '')))

/** Tier 0: every unit and opaque block gets its refs, resolved against the tree and one gh call. */
const tierZero = (root: string, units: Unit[], opaque: OpaqueBlock[]): void => {
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '')
  const extracted = [...units, ...opaque].map((block) => ({
    block,
    // A table row's text is JSON, which escapes nothing the extractor reads.
    refs: extractRefs(
      'kind' in block && block.kind !== 'frontmatter'
        ? `\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\``
        : block.text,
    ),
  }))
  const numbers = [...new Set(extracted.flatMap(({ refs }) => issueNumbers(refs)))]
  const states =
    numbers.length > 0 ? ghIssueStates(root, numbers) : new Map<number, string | null>()
  for (const { block, refs } of extracted) {
    block.refs = resolveRefs(refs, {
      root,
      file: block.file,
      tracked,
      issueState: (n) => (states.size === 0 ? undefined : states.get(n)),
    })
  }
}

const ask = async (jev: Jev, request: { state: unknown; questions: unknown }): Promise<AnswerBag> =>
  (await jev.ask(request.state, request.questions as never)) as AnswerBag

const classify = async (
  jev: Jev,
  units: Unit[],
  shape: RequestShape,
): Promise<Classification[]> => {
  const bags = await Promise.all(classifyRequest(units, { shape }).map((r) => ask(jev, r)))
  return parseClassification(units, Object.assign({}, ...bags))
}

/** The file a repo_fact's claim is most likely about: its first ref that resolved to a real file. */
const evidenceSource = (root: string, unit: Unit): { source: string; excerpt: string } | null => {
  for (const ref of unit.refs) {
    if ((ref.kind !== 'path' && ref.kind !== 'file_line') || ref.resolved !== true) continue
    if (ref.detail === null || ref.detail === unit.file) continue
    const absolute = join(root, ref.detail)
    if (!statSync(absolute).isFile()) continue
    const text = readFileSync(absolute, 'utf8')
    // A binary or minified file is no excerpt a judgment can be made against.
    if (text.includes('\0')) continue
    return { source: ref.detail, excerpt: text.slice(0, EXCERPT_CHARS) }
  }
  return null
}

const short = (text: string): string => (text.length > 110 ? `${text.slice(0, 107)}...` : text)

const printFindings = (report: Report): void => {
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  const kindOf = new Map(report.classifications.map((c) => [c.unitId, c]))
  const line = (s: string): void => void process.stdout.write(`${s}\n`)

  line(
    `\n${report.files.length} files, ${report.units.length} units, ${report.opaque.length} opaque`,
  )

  const absent = [...report.units, ...report.opaque].flatMap((block) =>
    block.refs
      .filter((ref) => ref.resolved === false)
      .map((ref) => `  ${block.file}:${block.startLine}  ${ref.kind} \`${ref.value}\``),
  )
  line(`\n## tier 0: refs that do not resolve (${absent.length})`)
  for (const entry of absent) line(entry)

  // Deterministic once Jev has said the unit names its own expiry: the issue
  // it waits on has closed, so the condition has ended.
  const expired = report.units.filter((unit) => {
    const c = kindOf.get(unit.id)
    const closed = unit.refs.some(
      (ref) => ref.kind === 'issue' && ref.detail !== 'OPEN' && ref.resolved,
    )
    return c !== undefined && c.volatile >= 0.8 && c.kind.choice !== 'history' && closed
  })
  line(`\n## volatile and the issue it names is closed (${expired.length})`)
  for (const unit of expired) line(`  ${unit.id}  ${short(unit.text)}`)

  const pairs = (verdict: string): PairJudgment[] =>
    report.pairs
      .filter((pair) => pair.verdict.choice === verdict)
      .sort((x, y) => y.verdict.confidence - x.verdict.confidence)
  for (const verdict of ['contradicts', 'same_claim']) {
    line(`\n## pairs: ${verdict} (${pairs(verdict).length})`)
    for (const pair of pairs(verdict)) {
      line(`  conf ${pair.verdict.confidence.toFixed(2)}  ${pair.a}  <>  ${pair.b}`)
      line(`    a: ${short(byId.get(pair.a)?.text ?? '')}`)
      line(`    b: ${short(byId.get(pair.b)?.text ?? '')}`)
    }
  }

  const refuted = report.evidence.filter((e) => e.verdict.choice === 'contradicts')
  line(`\n## evidence: contradicts (${refuted.length} of ${report.evidence.length} checked)`)
  for (const e of refuted) {
    line(`  conf ${e.verdict.confidence.toFixed(2)}  ${e.unitId}  against ${e.source}`)
    line(`    ${short(byId.get(e.unitId)?.text ?? '')}`)
  }

  const u = report.usage
  line(
    `\n## usage: ${u.requests} requests, ${u.inputTokens} input tokens, ${u.ms} ms of request time`,
  )
}

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2))
  const started = Date.now()
  const files = discoverFiles(options.root, options.scope === 'context' ? scopeFilter : undefined)

  const units: Unit[] = []
  const opaque: OpaqueBlock[] = []
  for (const file of files) {
    const split = splitMarkdown(file, readFileSync(join(options.root, file), 'utf8'))
    units.push(...split.units)
    opaque.push(...split.opaque)
  }
  tierZero(options.root, units, opaque)

  let classifications: Classification[] = []
  let pairs: PairJudgment[] = []
  let evidence: EvidenceJudgment[] = []
  let usage = { requests: 0, inputTokens: 0, outputTokens: 0, ms: 0 }

  if (options.jev) {
    const apiKey = process.env.TYPESAFE_API_KEY
    if (apiKey === undefined || apiKey === '') throw new Error('TYPESAFE_API_KEY is not set')
    const jev = createJev({ apiKey })
    const byId = new Map(units.map((unit) => [unit.id, unit]))

    classifications = await classify(jev, units, options.shape)
    const kindOf = new Map(classifications.map((c) => [c.unitId, c.kind.choice]))

    // History is a record of the past and structural text asserts nothing, so
    // neither can be a duplicate worth removing or a claim worth refuting.
    const comparable = units.filter((unit) => {
      const kind = kindOf.get(unit.id)
      return kind !== 'history' && kind !== 'structural'
    })
    const candidates = candidatePairs(comparable, { threshold: options.pairThreshold })
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, options.maxPairs)
    pairs = await Promise.all(
      candidates.map(async (candidate) => {
        const a = byId.get(candidate.a) as Unit
        const b = byId.get(candidate.b) as Unit
        const bag = await ask(jev, pairRequest(a, b))
        if (bag[PAIR_QUESTION_ID] === undefined) throw new Error(`no pair answer for ${a.id}`)
        return parsePair(candidate, bag)
      }),
    )

    const checkable = units
      .filter((unit) => kindOf.get(unit.id) === 'repo_fact')
      .flatMap((unit) => {
        const found = evidenceSource(options.root, unit)
        return found === null ? [] : [{ unit, ...found }]
      })
      .slice(0, options.maxEvidence)
    evidence = await Promise.all(
      checkable.map(async ({ unit, source, excerpt }) => {
        const bag = await ask(jev, evidenceRequest(unit, source, excerpt))
        if (bag[EVIDENCE_QUESTION_ID] === undefined) throw new Error(`no answer for ${unit.id}`)
        return parseEvidence(unit, source, excerpt, bag)
      }),
    )
    usage = jev.usage()
  }

  const report: Report = {
    root: options.root,
    files,
    units,
    opaque,
    classifications,
    pairs,
    evidence,
    usage,
  }
  if (options.out !== null) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
  printFindings(report)
  process.stdout.write(`wall clock ${Date.now() - started} ms\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
