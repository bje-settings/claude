// The POC's entry point (#164):
//   node spike/context-audit/cli.ts <root> [--scope context|all] [--shape per_section|per_unit]
//     [--no-jev] [--out report.json] [--max-pairs N] [--max-evidence N] [--pair-threshold X]
// It wires the pieces in tier order, prints the findings a reviewer (human or
// agent) would start from, and with --out writes the whole report as JSON.
// Nothing here decides anything the pieces do not: it only routes units
// between them. The functions are exported so tests can drive them; main runs
// only when this file is the script node was given.
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidatePairs } from './candidates.ts'
import { discoverFiles, scopeFilter } from './discover.ts'
import { createJev, type Jev, JevError } from './jev.ts'
import {
  classifyRequest,
  evidenceRequest,
  pairRequest,
  parseClassification,
  parseEvidence,
  parsePair,
  type RequestShape,
} from './questions.ts'
import {
  extractBlockRefs,
  extractRefs,
  ghIssueStates,
  type PackageJsonCache,
  resolveRefs,
} from './refs.ts'
import { splitMarkdown } from './split.ts'
import type {
  Classification,
  Coverage,
  EvidenceJudgment,
  OpaqueBlock,
  PairJudgment,
  Ref,
  Report,
  SkippedStage,
  SplitWarning,
  Stage,
  StageFailure,
  Unit,
  UnitKind,
  Usage,
} from './types.ts'

export type Options = {
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

const USAGE =
  'usage: cli.ts <root> [--scope context|all] [--shape per_section|per_unit] [--no-jev]' +
  ' [--out file] [--max-pairs N] [--max-evidence N] [--pair-threshold X]'

const oneOf = <T extends string>(flag: string, value: string, allowed: readonly T[]): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${flag} must be one of ${allowed.join(', ')}, got ${value}`)
}

const count = (flag: string, value: string): number => {
  const n = Number(value)
  // NaN would make slice() return [] and a run report zero pairs as a clean result.
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number, got ${value}`)
  return n
}

const fraction = (flag: string, value: string): number => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${flag} must be 0 to 1, got ${value}`)
  return n
}

export const parseArgs = (argv: string[]): Options => {
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
    if (arg === '--scope') options.scope = oneOf(arg, value(), ['context', 'all'])
    else if (arg === '--shape') options.shape = oneOf(arg, value(), ['per_section', 'per_unit'])
    else if (arg === '--no-jev') options.jev = false
    else if (arg === '--out') options.out = value()
    else if (arg === '--max-pairs') options.maxPairs = count(arg, value())
    else if (arg === '--max-evidence') options.maxEvidence = count(arg, value())
    else if (arg === '--pair-threshold') options.pairThreshold = fraction(arg, value())
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}\n${USAGE}`)
    else if (options.root !== '') throw new Error(`one root only\n${USAGE}`)
    else options.root = resolve(arg)
  }
  if (options.root === '') throw new Error(USAGE)
  return options
}

const issueNumbers = (refs: Ref[]): number[] =>
  refs.filter((ref) => ref.kind === 'issue').map((ref) => Number(ref.value.replace('#', '')))

/**
 * Tier 0: every unit and opaque block gets its refs, resolved against the
 * tree and one batched issue lookup. Returns why the lookup was unavailable,
 * or null.
 */
export const tierZero = (root: string, units: Unit[], opaque: OpaqueBlock[]): string | null => {
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '')
  const extracted = [
    ...units.map((block) => ({ block, refs: extractRefs(block.text) })),
    ...opaque.map((block) => ({
      block,
      refs: extractBlockRefs(block.text, block.lang, block.kind),
    })),
  ]
  const numbers = [...new Set(extracted.flatMap(({ refs }) => issueNumbers(refs)))]
  const lookup =
    numbers.length > 0
      ? ghIssueStates(root, numbers)
      : { states: new Map<number, 'OPEN' | 'CLOSED' | 'MERGED' | 'not_found'>(), unavailable: null }
  const packageJson: PackageJsonCache = new Map()
  for (const { block, refs } of extracted) {
    block.refs = resolveRefs(refs, {
      root,
      file: block.file,
      tracked,
      packageJson,
      // A number missing from the map means its chunk failed, never "no such issue".
      issueState: (n) => lookup.states.get(n) ?? 'unavailable',
    })
  }
  return lookup.unavailable
}

/** The file a repo_fact's claim is most likely about: its first ref, in source order, that resolved to a real file. */
export const evidenceSource = (
  root: string,
  unit: Unit,
): { source: string; excerpt: string } | null => {
  for (const ref of unit.refs) {
    if (ref.kind !== 'path' && ref.kind !== 'file_line') continue
    if (ref.resolution.status !== 'found' || ref.resolution.repoPath === null) continue
    const repoPath = ref.resolution.repoPath
    if (repoPath === unit.file) continue
    const absolute = join(root, repoPath)
    if (!statSync(absolute).isFile()) continue
    const text = readFileSync(absolute, 'utf8')
    // A NUL byte marks a binary file, which is no excerpt a judgment can be made against.
    if (text.includes('\0')) continue
    return { source: repoPath, excerpt: text.slice(0, EXCERPT_CHARS) }
  }
  return null
}

/**
 * A unit Jev says names its own expiry, where an issue it cites is no longer
 * open. Jev is not asked which issue the expiry refers to, so a unit citing
 * several issues is flagged when any of them has closed.
 */
export const isExpired = (unit: Unit, c: Classification | undefined): boolean =>
  c !== undefined &&
  c.volatile >= 0.8 &&
  c.kind.choice !== 'history' &&
  unit.refs.some((ref) => ref.resolution.status === 'issue' && ref.resolution.state !== 'OPEN')

const describe = (ref: Ref): string => {
  const r = ref.resolution
  switch (r.status) {
    case 'unchecked':
      return `unchecked (${r.reason})`
    case 'tail_match':
      return `tail of ${r.witness}`
    case 'line_out_of_range':
      return `only ${r.lines} lines`
    case 'issue':
      return r.state
    case 'found':
      return 'found'
    case 'absent':
      return 'absent'
  }
}

const short = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 110 ? `${flat.slice(0, 107)}...` : flat
}

const failureMessage = (e: unknown): string => {
  if (e instanceof JevError) return `HTTP ${e.status}: ${e.message} ${e.body}`.trim()
  if (e instanceof Error) return e.message
  return String(e)
}

const settle = async <T, R>(
  stage: Stage,
  items: T[],
  id: (item: T) => string,
  work: (item: T) => Promise<R>,
  failures: StageFailure[],
): Promise<R[]> => {
  const results = await Promise.allSettled(items.map(work))
  const out: R[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') out.push(result.value)
    else failures.push({ stage, id: id(items[i] as T), message: failureMessage(result.reason) })
  })
  return out
}

type Write = (line: string) => void

/** The one line a stage that never ran prints in place of its findings, or null. */
const skippedLine = (report: Report, stage: Stage): string | null => {
  const found = report.skipped.find((s) => s.stage === stage)
  if (found === undefined) return null
  return found.reason === 'no_jev' ? '  skipped (--no-jev)' : '  skipped: classify failed'
}

const cov = (c: Coverage): string => `${c.judged} of ${c.available} judged`

/** How a ref tier 0 did not settle is tallied, or null for one it did. */
const uncheckedKey = (ref: Ref): string | null => {
  switch (ref.resolution.status) {
    case 'unchecked':
      return `${ref.kind} ${ref.resolution.reason}`
    case 'tail_match':
      return `${ref.kind} tail_match`
    default:
      return null
  }
}

const printRefFindings = (report: Report, write: Write): void => {
  write(
    `${report.files.length} files, ${report.units.length} units, ${report.opaque.length} opaque`,
  )
  for (const w of report.warnings) write(`  warning: ${w.file}:${w.line} ${w.kind}`)
  if (report.issueLookup !== 'ok') write(`  issue lookup unavailable: ${report.issueLookup}`)

  const blocks = [...report.units, ...report.opaque]
  const withStatus = (status: string): string[] =>
    blocks.flatMap((block) =>
      block.refs
        .filter((ref) => ref.resolution.status === status)
        .map(
          (ref) =>
            `  ${block.file}:${block.startLine}  ${ref.kind} \`${ref.value}\`  ${describe(ref)}`,
        ),
    )
  const absent = withStatus('absent')
  write(`\n## tier 0: refs that do not resolve (${absent.length})`)
  for (const entry of absent) write(entry)
  const outOfRange = withStatus('line_out_of_range')
  write(`\n## tier 0: line references past the end of the file (${outOfRange.length})`)
  for (const entry of outOfRange) write(entry)

  // What tier 0 could not decide, by kind and reason, so "unchecked" never
  // reads as "fine".
  const unchecked = new Map<string, number>()
  for (const block of blocks) {
    for (const ref of block.refs) {
      const key = uncheckedKey(ref)
      if (key !== null) unchecked.set(key, (unchecked.get(key) ?? 0) + 1)
    }
  }
  write('\n## tier 0: refs not checked')
  for (const [key, n] of [...unchecked].sort()) write(`  ${n}  ${key}`)
}

const printExpiredFindings = (report: Report, write: Write): void => {
  const classOf = new Map(report.classifications.map((c) => [c.unitId, c]))
  // A unit with any unavailable issue ref is not judged either way, since the
  // closed one may be the wrong one; the rest are judged on what did resolve.
  const unavailableIssue = (u: Unit): boolean =>
    u.refs.some(
      (r) =>
        r.kind === 'issue' &&
        r.resolution.status === 'unchecked' &&
        r.resolution.reason === 'unavailable',
    )
  const expired = report.units.filter(
    (u) => !unavailableIssue(u) && isExpired(u, classOf.get(u.id)),
  )
  const notJudged = report.units.filter(
    (u) => unavailableIssue(u) && (classOf.get(u.id)?.volatile ?? 0) >= 0.8,
  ).length
  write(
    `\n## volatile and the issue it names is closed (${expired.length}${notJudged > 0 ? `; ${notJudged} volatile units not judged, issue lookup unavailable` : ''})`,
  )
  const skipped = skippedLine(report, 'classify')
  if (skipped !== null) write(skipped)
  else if (report.failures.some((f) => f.stage === 'classify' && f.id === '*'))
    write('  not judged: classify failed')
  else for (const unit of expired) write(`  ${unit.id}  ${short(unit.text)}`)
}

const printPairFindings = (report: Report, byId: Map<string, Unit>, write: Write): void => {
  const pairs = (verdict: string): PairJudgment[] =>
    report.pairs
      .filter((pair) => pair.verdict.choice === verdict)
      .sort((x, y) => y.verdict.confidence - x.verdict.confidence)
  for (const verdict of ['contradicts', 'same_claim']) {
    write(`\n## pairs: ${verdict} (${pairs(verdict).length}; ${cov(report.pairCoverage)})`)
    const skipped = skippedLine(report, 'pairs')
    if (skipped !== null) write(skipped)
    for (const pair of pairs(verdict)) {
      write(`  conf ${pair.verdict.confidence.toFixed(2)}  ${pair.a}  <>  ${pair.b}`)
      write(`    a: ${short(byId.get(pair.a)?.text ?? '')}`)
      write(`    b: ${short(byId.get(pair.b)?.text ?? '')}`)
    }
  }
}

const printEvidenceFindings = (report: Report, byId: Map<string, Unit>, write: Write): void => {
  const refuted = report.evidence
    .filter((e) => e.verdict.choice === 'contradicts')
    .sort((x, y) => y.verdict.confidence - x.verdict.confidence)
  write(`\n## evidence: contradicts (${refuted.length}; ${cov(report.evidenceCoverage)})`)
  const skipped = skippedLine(report, 'evidence')
  if (skipped !== null) write(skipped)
  for (const e of refuted) {
    write(`  conf ${e.verdict.confidence.toFixed(2)}  ${e.unitId}  against ${e.source}`)
    write(`    ${short(byId.get(e.unitId)?.text ?? '')}`)
  }
}

export const printFindings = (report: Report, write: Write): void => {
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  printRefFindings(report, write)
  printExpiredFindings(report, write)
  printPairFindings(report, byId, write)
  printEvidenceFindings(report, byId, write)

  write(`\n## failures (${report.failures.length})`)
  for (const f of report.failures) write(`  ${f.stage} ${f.id}: ${f.message}`)

  const u = report.usage
  write(
    `\n## usage: ${u.requests} requests (${u.attempts} attempts), ${u.inputTokens} input tokens,` +
      ` ${u.requestMsSum} ms summed request time, ${report.wallClockMs} ms wall clock`,
  )
}

/** Every file's blocks, in file order. */
const splitAll = (
  root: string,
  files: string[],
): { units: Unit[]; opaque: OpaqueBlock[]; warnings: SplitWarning[] } => {
  const units: Unit[] = []
  const opaque: OpaqueBlock[] = []
  const warnings: SplitWarning[] = []
  for (const file of files) {
    const split = splitMarkdown(file, readFileSync(join(root, file), 'utf8'))
    units.push(...split.units)
    opaque.push(...split.opaque)
    warnings.push(...split.warnings)
  }
  // Every later stage looks units up by id, so a collision would silently
  // merge two of them.
  if (new Set(units.map((u) => u.id)).size !== units.length) {
    throw new Error('splitter produced duplicate unit ids')
  }
  return { units, opaque, warnings }
}

/**
 * Tier 1's per-unit judgments. Each request classifies a run of units; a
 * failed request loses only its own run, and the units it covered are left
 * unclassified rather than the whole stage being discarded.
 */
const classifyUnits = async (
  jev: Jev,
  units: Unit[],
  shape: RequestShape,
  failures: StageFailure[],
): Promise<Classification[]> => {
  const requests = classifyRequest(units, { shape })
  const results = await Promise.allSettled(requests.map((r) => jev.ask(r.state, r.questions)))
  const bag: Record<string, unknown> = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') Object.assign(bag, result.value)
    else
      failures.push({
        stage: 'classify',
        id: `request ${i}`,
        message: failureMessage(result.reason),
      })
  })
  // parseClassification reads every unit by its global index, so a unit whose
  // request failed is parsed alone with its answers moved under u0.
  const classifications: Classification[] = []
  units.forEach((unit, i) => {
    if (!(`kind__u${i}` in bag)) return
    const own: Record<string, unknown> = {}
    for (const j of ['kind', 'volatile', 'self_contained', 'evidence', 'multi_assertion']) {
      own[`${j}__u0`] = bag[`${j}__u${i}`]
    }
    try {
      classifications.push(...parseClassification([unit], own))
    } catch (e) {
      failures.push({ stage: 'classify', id: unit.id, message: failureMessage(e) })
    }
  })
  return classifications
}

const judgePairs = async (
  jev: Jev,
  units: Unit[],
  kindOf: Map<string, UnitKind>,
  options: Options,
  failures: StageFailure[],
): Promise<{ pairs: PairJudgment[]; coverage: Coverage }> => {
  // History is a record of the past and structural text asserts nothing, so
  // neither can be a duplicate worth removing or a claim worth refuting.
  const comparable = units.filter((unit) => {
    const kind = kindOf.get(unit.id)
    return kind !== 'history' && kind !== 'structural'
  })
  const byId = new Map(units.map((unit) => [unit.id, unit]))
  const allCandidates = candidatePairs(comparable, { threshold: options.pairThreshold }).sort(
    (x, y) => y.similarity - x.similarity,
  )
  const pairs = await settle(
    'pairs',
    allCandidates.slice(0, options.maxPairs),
    (c) => `${c.a} <> ${c.b}`,
    async (candidate) => {
      const a = byId.get(candidate.a)
      const b = byId.get(candidate.b)
      if (a === undefined || b === undefined) throw new Error('candidate names an unknown unit')
      const r = pairRequest(a, b)
      // jev.ask throws when a question asked has no answer.
      return parsePair(candidate, await jev.ask(r.state, r.questions))
    },
    failures,
  )
  return { pairs, coverage: { judged: pairs.length, available: allCandidates.length } }
}

const judgeEvidence = async (
  jev: Jev,
  units: Unit[],
  kindOf: Map<string, UnitKind>,
  options: Options,
  failures: StageFailure[],
): Promise<{ evidence: EvidenceJudgment[]; coverage: Coverage }> => {
  const repoFacts = units.filter((unit) => kindOf.get(unit.id) === 'repo_fact')
  const checkable = repoFacts
    .flatMap((unit) => {
      const found = evidenceSource(options.root, unit)
      return found === null ? [] : [{ unit, ...found }]
    })
    .slice(0, options.maxEvidence)
  const evidence = await settle(
    'evidence',
    checkable,
    (c) => c.unit.id,
    async ({ unit, source, excerpt }) => {
      const r = evidenceRequest(unit, source, excerpt)
      return parseEvidence(unit, source, excerpt, await jev.ask(r.state, r.questions))
    },
    failures,
  )
  return { evidence, coverage: { judged: evidence.length, available: repoFacts.length } }
}

const jevFromEnv = (): Jev => {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (apiKey === undefined || apiKey === '') throw new Error('TYPESAFE_API_KEY is not set')
  return createJev({ apiKey })
}

/** `deps.jev` lets a test inject a client; the CLI builds a real one from the environment. */
export const runAudit = async (options: Options, deps: { jev?: Jev } = {}): Promise<Report> => {
  const started = Date.now()
  const files = discoverFiles(options.root, options.scope === 'context' ? scopeFilter : undefined)
  const { units, opaque, warnings } = splitAll(options.root, files)
  const unavailable = tierZero(options.root, units, opaque)

  const failures: StageFailure[] = []
  const skipped: SkippedStage[] = []
  let classifications: Classification[] = []
  let pairs: PairJudgment[] = []
  let evidence: EvidenceJudgment[] = []
  let pairCoverage: Coverage = { judged: 0, available: 0 }
  let evidenceCoverage: Coverage = { judged: 0, available: 0 }
  let usage: Usage = { requests: 0, attempts: 0, inputTokens: 0, outputTokens: 0, requestMsSum: 0 }

  if (!options.jev) {
    for (const stage of ['classify', 'pairs', 'evidence'] as const)
      skipped.push({ stage, reason: 'no_jev' })
  } else {
    const jev = deps.jev ?? jevFromEnv()
    classifications = await classifyUnits(jev, units, options.shape, failures)
    if (classifications.length === 0) {
      // Without any label nothing downstream can be routed.
      if (failures.every((f) => f.stage !== 'classify'))
        failures.push({ stage: 'classify', id: '*', message: 'no unit was classified' })
      skipped.push(
        { stage: 'pairs', reason: 'classify_failed' },
        { stage: 'evidence', reason: 'classify_failed' },
      )
    } else {
      const kindOf = new Map(classifications.map((c) => [c.unitId, c.kind.choice]))
      const paired = await judgePairs(jev, units, kindOf, options, failures)
      pairs = paired.pairs
      pairCoverage = paired.coverage
      const checked = await judgeEvidence(jev, units, kindOf, options, failures)
      evidence = checked.evidence
      evidenceCoverage = checked.coverage
    }
    usage = jev.usage()
  }

  return {
    root: options.root,
    files,
    units,
    opaque,
    warnings,
    issueLookup: unavailable ?? 'ok',
    skipped,
    classifications,
    pairs,
    pairCoverage,
    evidence,
    evidenceCoverage,
    failures,
    usage,
    wallClockMs: Date.now() - started,
  }
}

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2))
  // Paid stages run before the write, so the file must be writable before
  // them: opening it catches a missing directory, a directory in its place
  // and a read-only file alike.
  if (options.out !== null) closeSync(openSync(options.out, 'w'))
  const report = await runAudit(options)
  printFindings(report, (line) => process.stdout.write(`${line}\n`))
  if (options.out !== null) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
  if (report.failures.length > 0) process.exitCode = 1
}

// import.meta.url is the real path; argv[1] is whatever the user typed, which
// may reach this file through a symlink.
const invokedDirectly = (): boolean => {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}
if (invokedDirectly()) {
  // A reader piping the findings into `head` closes stdout early; that is not
  // an error in the audit.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
