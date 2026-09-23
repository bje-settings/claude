// `/audit:context`: read a checkout's context files, and report the references
// in them that no longer resolve. The TypeScript port of the spike's `cli.ts`
// (#164) as a command function (RFC 001 decision 3): parsed arguments and
// injected clients in, an envelope out, with `scripts/audit.ts` the thin adapter
// over it.
//
// Tier 0 is complete on its own: everything it produces is read from the tree
// and from one batched issue lookup, with no model call anywhere. The three
// model stages (#174) run on top of it when there is a key to spend, and are
// reported as skipped with the reason when there is not, so that "skipped" can
// never be read as "nothing found". A model call that failed is the one thing
// this command calls its own failure: the findings still go to stdout, and the
// exit status says the run was incomplete.

import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { candidatePairs } from '../candidates.ts'
import { markdownFiles, scopeFilter, trackedPaths } from '../discover.ts'
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError, type GhResults } from '../lib/gh.ts'
import { runGit, toplevel } from '../lib/git.ts'
import {
  type Classification,
  type JevClient,
  JevError,
  type RequestShape,
  type UnitKind,
  type Usage,
} from '../lib/jev.ts'
import type { Output } from '../lib/streams.ts'
import {
  extractBlockRefs,
  extractRefs,
  issueNumbers,
  markIgnored,
  type PackageJsonCache,
  resolveRefs,
} from '../refs.ts'
import {
  type Coverage,
  type EvidenceJudgment,
  type PairJudgment,
  type Report,
  renderFindings,
  type SkippedStage,
  type Stage,
  type StageFailure,
} from '../report.ts'
import { splitMarkdown } from '../split.ts'
import type { OpaqueBlock, SplitWarning, Unit } from '../types.ts'

/** The process's edges, as `scripts/audit.ts` builds them. `now` is the clock, so
 *  that a report's `wallClockMs` is a value a test states rather than a
 *  duration it has to tolerate. */
export interface ContextEdges {
  /** The directory the caller started in, which is the default root. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly createGh: (cwd: string) => GhClient
  /** Built only when there is a key to spend, so a run that skips the model
   *  stages never constructs a client at all. */
  readonly createJev: (options: { apiKey: string }) => JevClient
  readonly now: () => number
}

// `as const`, never `: ArgSpec` or `satisfies ArgSpec`: either annotation
// widens `choices` to `readonly string[]` and collapses the parsed options to
// an index signature (`lib/README.md`). Every count and the threshold are
// string options with a default, checked below rather than by the parser,
// which has no numeric kind.
const ARG_SPEC = {
  scope: { type: 'string', default: 'context', choices: ['context', 'all'] },
  shape: { type: 'string', default: 'per_section', choices: ['per_section', 'per_unit'] },
  'no-jev': { type: 'boolean' },
  json: { type: 'boolean' },
  out: { type: 'string', default: '' },
  'max-pairs': { type: 'string', default: '300' },
  'max-evidence': { type: 'string', default: '200' },
  'pair-threshold': { type: 'string', default: '0.5' },
} as const

const USAGE = `usage: audit.ts context [root] [--scope context|all]
       [--shape per_section|per_unit] [--no-jev] [--json] [--out FILE]
       [--max-pairs N] [--max-evidence N] [--pair-threshold X]

Audits a checkout's context files (CLAUDE.md, README.md and anything under a
.claude/ directory; --scope all reads every tracked .md) for references that
no longer resolve. The root defaults to the working directory.

Tier 0 reads the tree and one batched issue lookup and needs no model. The
model stages need TYPESAFE_API_KEY and are reported as skipped without it, or
with --no-jev. --json writes the whole report instead of the findings text;
--out writes it to a file as well.`

/** A whole number, written out. A pattern rather than `Number.isInteger`, for
 *  the reason `sync.ts` gives its own `-j` check: the value reaches an
 *  arithmetic context, where anything this does not refuse is reinterpreted
 *  silently, and a pattern refuses `2.5`, `-1`, `1e3` and `abc` as one rule
 *  rather than as four arms a test would have to reach separately. */
const COUNT_RE = /^\d+$/

/** A fraction from 0 to 1, written out. Same argument as {@link COUNT_RE}, and
 *  the bound is part of the pattern: a threshold above 1 compares against a
 *  similarity that can never reach it, so every pair is dropped and the run
 *  reports nothing found. 1 itself is admitted and means near-exact only; two
 *  identical texts score within one float step of 1, on either side of it, so
 *  which of them it keeps is arithmetic rather than a contract. */
const FRACTION_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/

/** The count options, checked together: `lib/args.ts` has no numeric kind, and
 *  each of these is a bound layer 5 slices work down to. */
const COUNT_FLAGS = ['max-pairs', 'max-evidence'] as const

/**
 * True when `argv` asks for help. A raw scan of the tokens themselves, checked
 * before anything is parsed, so usage wins over a bad `--scope` rather than
 * losing to it. `plugins/mermaid/src/commands/url.ts` is where this shape was
 * settled and why.
 */
export const wantsHelp = (argv: readonly string[]): boolean =>
  argv.includes('-h') || argv.includes('--help')

/**
 * Every file's blocks, in file order, or why one of them could not be read.
 *
 * Discovery lists the index and the read comes from the working tree, and the
 * two differ in ordinary use: a staged deletion, a `git mv` in flight, a
 * sparse checkout, a symlink whose target is gone. Letting the read throw ends
 * the run with node's own `fs` stack trace, no envelope and no exit code from
 * the contract, so the reason is carried back instead and the caller refuses
 * with the file named.
 */
const splitAll = (
  root: string,
  files: string[],
): {
  units: Unit[]
  opaque: OpaqueBlock[]
  warnings: SplitWarning[]
  unreadable: string | null
} => {
  const units: Unit[] = []
  const opaque: OpaqueBlock[] = []
  const warnings: SplitWarning[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(path.join(root, file), 'utf8')
    } catch (error) {
      return {
        units,
        opaque,
        warnings,
        unreadable: `${file}, which git lists as tracked: ${(error as Error).message}`,
      }
    }
    const split = splitMarkdown(file, text)
    units.push(...split.units)
    opaque.push(...split.opaque)
    warnings.push(...split.warnings)
  }
  return { units, opaque, warnings, unreadable: null }
}

/**
 * Why git could not be run at all, or `null` when it ran.
 *
 * It asks git rather than the PATH: running the command answers the question
 * the caller has, and `lib/process.ts` already separates "never started" from
 * "ran and said no" for it. `--version` because it is git's cheapest
 * subcommand and needs no repository to answer in. node's own message is
 * passed through, since it names both the command and the code.
 */
const gitMissing = async (env: NodeJS.ProcessEnv): Promise<string | null> => {
  const probe = await runGit(['--version'], { env })
  return probe.startFailure === null ? null : probe.startFailure.message
}

/** The stages a run never got to, each carrying the same reason. */
const skippedStages = (stages: readonly Stage[], reason: SkippedStage['reason']): SkippedStage[] =>
  stages.map((stage) => ({ stage, reason }))

/**
 * Why the model stages did not run.
 *
 * Both reasons are true as written, and they are the only two that can reach
 * this decision: `--no-jev` is the caller asking for tier 0 alone, and
 * `no_key` is an environment holding no `TYPESAFE_API_KEY`, which is what a
 * machine that has never been set up reports. The flag is read first, so a
 * caller who asked for no model call is told that rather than being told about
 * a key they did not offer. `classify_failed`, the third `SkippedStage`
 * reason, is decided in {@link modelStages} after a stage has actually run.
 */
const skipReason = (noJev: boolean): SkippedStage['reason'] => (noJev ? 'no_jev' : 'no_key')

/**
 * A failed model call, as the report names it.
 *
 * `JevError`'s own account when the call was rejected, and the plain message
 * otherwise: the client rejects with a `JevError` for anything the transport
 * refused, and throws a plain `Error` when an answer arrived but would not
 * parse (`lib/README.md`). There is no third shape to account for.
 */
const failureMessage = (error: unknown): string => {
  if (error instanceof JevError)
    return `HTTP ${error.status}: ${error.message} ${error.body}`.trim()
  return (error as Error).message
}

/**
 * One stage's work, each item settled on its own: a rejected call costs only
 * itself, and the rest of the stage still answers. The spike's `settle`.
 */
const settle = async <T, R>(
  stage: Stage,
  items: readonly T[],
  id: (item: T) => string,
  work: (item: T) => Promise<R>,
  failures: StageFailure[],
): Promise<R[]> => {
  const results = await Promise.allSettled(items.map(work))
  const done: R[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') done.push(result.value)
    // `index` indexes the array the results were built from.
    else failures.push({ stage, id: id(items[index] as T), message: failureMessage(result.reason) })
  })
  return done
}

/** What the model stages produced, or what they did instead. */
type ModelOutcome = {
  skipped: SkippedStage[]
  classifications: Classification[]
  pairs: PairJudgment[]
  pairCoverage: Coverage
  evidence: EvidenceJudgment[]
  evidenceCoverage: Coverage
  failures: StageFailure[]
  usage: Usage
}

/** What a run that made no model call spent. */
const NO_USAGE: Usage = {
  requests: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  requestMsSum: 0,
}

/** An outcome in which neither the pair nor the evidence stage ran, so both
 *  are empty and both coverages are `0 of 0`: what one such outcome carries
 *  over another is only why it stopped and what it had spent by then. */
const noJudgments = (
  reached: Pick<ModelOutcome, 'skipped' | 'classifications' | 'failures' | 'usage'>,
): ModelOutcome => ({
  ...reached,
  pairs: [],
  pairCoverage: { judged: 0, available: 0 },
  evidence: [],
  evidenceCoverage: { judged: 0, available: 0 },
})

/** The excerpt a claim is judged against. Accuracy falls as unrelated state
 *  grows, so the head of the file is a deliberate, crude bound; choosing the
 *  relevant span is a retrieval problem this port has not solved either. */
const EXCERPT_CHARS = 6000

/** A resolved path that leaves the audited root. A `../` reference resolves
 *  against the root like any other, and the file it finds is in a tree this
 *  run was not asked about and has no business reading. */
const escapesRoot = (repoPath: string): boolean => repoPath.split('/')[0] === '..'

/**
 * The head of `repoPath`, or `null` when that file is no evidence at all.
 *
 * A directory resolves as found and has no contents to excerpt.
 *
 * Neither does a path git lists but the working tree does not hold: `refs.ts`
 * resolves a record named by its number against the TRACKED list rather than
 * by reading, so a staged deletion, a `git mv` in flight or a sparse checkout
 * leaves a `found` ref whose file is not there, and a mode the reader cannot
 * open does the same. `splitAll` above refuses rather than letting that throw,
 * and this is the same hazard one stage later, where a throw would also
 * discard the tier 0 findings and the model calls this run has already paid
 * for. A file that cannot be read is no evidence, exactly like the directory
 * and the binary beside it.
 */
const excerptOf = (root: string, repoPath: string): string | null => {
  const full = path.join(root, repoPath)
  let text: string
  try {
    if (!statSync(full).isFile()) return null
    text = readFileSync(full, 'utf8')
  } catch {
    return null
  }
  // A NUL byte marks a binary file, which is no excerpt a judgment can be made
  // against.
  if (text.includes('\0')) return null
  return text.slice(0, EXCERPT_CHARS)
}

/** The file a claim is most likely about: its first reference, in the order
 *  the writer wrote them, that resolved to a readable file of this repository
 *  other than the one the claim is written in. */
const evidenceSource = (root: string, unit: Unit): { source: string; excerpt: string } | null => {
  for (const ref of unit.refs) {
    if (ref.kind !== 'path' && ref.kind !== 'file_line') continue
    if (ref.resolution.status !== 'found' || ref.resolution.repoPath === null) continue
    const repoPath = ref.resolution.repoPath
    if (repoPath === unit.file || escapesRoot(repoPath)) continue
    const excerpt = excerptOf(root, repoPath)
    if (excerpt !== null) return { source: repoPath, excerpt }
  }
  return null
}

/**
 * The evidence stage: every repository fact, against the head of the file it
 * names. A fact naming no readable file is in neither the judgments nor the
 * failures, which is what `available` counts.
 */
const judgeEvidence = async (
  jev: JevClient,
  root: string,
  units: readonly Unit[],
  kindOf: Map<string, UnitKind>,
  maxEvidence: number,
  failures: StageFailure[],
): Promise<{ evidence: EvidenceJudgment[]; coverage: Coverage }> => {
  const facts = units.filter((unit) => kindOf.get(unit.id) === 'repo_fact')
  const checkable = facts
    .flatMap((unit) => {
      const found = evidenceSource(root, unit)
      return found === null ? [] : [{ unit, ...found }]
    })
    // Document order: there is no ranking here the way there is for pairs, so
    // a budget buys the facts a reader would reach first.
    .slice(0, maxEvidence)
  const evidence = await settle(
    'evidence',
    checkable,
    (entry) => entry.unit.id,
    async ({ unit, source, excerpt }) => ({
      unitId: unit.id,
      source,
      excerpt,
      verdict: await jev.judgeEvidence(unit, source, excerpt),
    }),
    failures,
  )
  return { evidence, coverage: { judged: evidence.length, available: facts.length } }
}

/**
 * The pair stage: candidates chosen lexically, then ruled on one at a time.
 *
 * History is a record of the past and structural text asserts nothing, so
 * neither can be a duplicate worth removing or a claim worth refuting. A unit
 * the classify stage said nothing about keeps its place, since an unlabelled
 * unit is not a labelled one.
 */
const judgePairs = async (
  jev: JevClient,
  units: readonly Unit[],
  kindOf: Map<string, UnitKind>,
  options: { maxPairs: number; threshold: number },
  failures: StageFailure[],
): Promise<{ pairs: PairJudgment[]; coverage: Coverage }> => {
  const comparable = units.filter((unit) => {
    const kind = kindOf.get(unit.id)
    return kind !== 'history' && kind !== 'structural'
  })
  const byId = new Map(units.map((unit) => [unit.id, unit]))
  // Descending similarity, then capped: a budget buys the pairs most likely to
  // be a real duplicate, and `coverage` says how many it did not reach.
  const candidates = candidatePairs(comparable, { threshold: options.threshold }).sort(
    (x, y) => y.similarity - x.similarity,
  )
  const pairs = await settle(
    'pairs',
    candidates.slice(0, options.maxPairs),
    (candidate) => `${candidate.a} <> ${candidate.b}`,
    async (candidate) => {
      // Both ids came from `units` a moment ago, so the lookups answer.
      const a = byId.get(candidate.a) as Unit
      const b = byId.get(candidate.b) as Unit
      return { ...candidate, verdict: await jev.judgePair(a, b) }
    },
    failures,
  )
  return { pairs, coverage: { judged: pairs.length, available: candidates.length } }
}

/**
 * The model stages, or the reason there were none.
 *
 * The client is built here and nowhere else: `scripts/audit.ts` hands over a
 * factory rather than a client, so a run with no key to spend never constructs
 * one and never reads the environment twice.
 */
const modelStages = async (
  edges: ContextEdges,
  units: readonly Unit[],
  options: {
    root: string
    noJev: boolean
    shape: RequestShape
    maxPairs: number
    maxEvidence: number
    threshold: number
  },
): Promise<ModelOutcome> => {
  const key = edges.env.TYPESAFE_API_KEY ?? ''
  if (options.noJev || key === '') {
    return noJudgments({
      skipped: skippedStages(['classify', 'pairs', 'evidence'], skipReason(options.noJev)),
      classifications: [],
      failures: [],
      usage: NO_USAGE,
    })
  }
  const jev = edges.createJev({ apiKey: key })
  // The client folds a rejected request into its own failures rather than
  // rejecting, so there is nothing to catch here (`lib/README.md`).
  const classified = await jev.classify(units, options.shape)
  const { classifications } = classified
  const kindOf = new Map(classifications.map((entry) => [entry.unitId, entry.kind.choice]))
  const failures: StageFailure[] = classified.failures.map((failure) => ({
    stage: 'classify',
    ...failure,
  }))
  // Nothing downstream can be routed without a label. The pair stage reads
  // `kindOf` to leave history and structural units out, and the evidence stage
  // reads it to select the repository facts: against an empty map the first
  // compares everything and the second checks nothing, so a run that had
  // learned nothing would go on to spend a whole pair budget and then report
  // an evidence section that read as "nothing found". The spike's own guard
  // (`cli.ts:521-537`).
  //
  // A run with no units at all is not that case: there was nothing to
  // classify, so nothing failed and nothing was skipped, and `0 of 0 judged`
  // is the honest answer the two stages below already give for it.
  if (units.length > 0 && classifications.length === 0) {
    // Only when the stage said nothing about why, which is the spike's rule:
    // `*` stands for the whole stage, and beside a failure that names the
    // request or the unit that actually broke it would be a second entry for
    // one fault. Every failure in hand here is the classify stage's own, so
    // "none at all" is the same test the spike writes as "none of them is a
    // classify failure".
    if (failures.length === 0) {
      failures.push({ stage: 'classify', id: '*', message: 'no unit was classified' })
    }
    return noJudgments({
      skipped: skippedStages(['pairs', 'evidence'], 'classify_failed'),
      classifications,
      failures,
      usage: jev.usage(),
    })
  }
  const paired = await judgePairs(jev, units, kindOf, options, failures)
  const checked = await judgeEvidence(
    jev,
    options.root,
    units,
    kindOf,
    options.maxEvidence,
    failures,
  )
  return {
    skipped: [],
    classifications,
    pairs: paired.pairs,
    pairCoverage: paired.coverage,
    evidence: checked.evidence,
    evidenceCoverage: checked.coverage,
    failures,
    usage: jev.usage(),
  }
}

/** What the issue lookup answered, with the numbers as `gh` reports them.
 *
 *  `gh` is not reached at all when nothing names an issue: the client resolves
 *  the repository on its first call, so asking it for an empty list would be a
 *  network round trip to answer a question nobody asked.
 */
const issueStates = async (
  root: string,
  edges: ContextEdges,
  numbers: readonly number[],
): Promise<GhResults['issueStates']> => {
  if (numbers.length === 0) return { states: {}, unavailable: null }
  try {
    return await edges.createGh(root).issueStates({ numbers })
  } catch (error) {
    // The real client folds its own failures into `unavailable` and never
    // throws (`lib/README.md`), so this is the belt to that braces: a client
    // that did throw would otherwise take the whole audit down over one
    // lookup. `GhError` is the only failure it declares, and `detail` is gh's
    // own account of it without the argv prefix the message carries.
    //
    // Tested rather than cast, the way every other command here reads one
    // (`plugins/gh/src/commands/shepherd-pr.ts:248`). A cast reads `detail`
    // off whatever was thrown, and `undefined` is folded into `ok` by the
    // caller, so a client that failed some other way would report a lookup
    // that succeeded while every issue ref said unavailable.
    if (error instanceof GhError) return { states: {}, unavailable: error.detail }
    return { states: {}, unavailable: `issue lookup threw: ${String(error)}` }
  }
}

/** A block tier 0 fills in: a unit or an opaque block, both of which carry
 *  `file` and `refs` and are read the same way here. */
type Blocks = {
  readonly units: Unit[]
  readonly opaque: OpaqueBlock[]
  readonly tracked: readonly string[]
}

/**
 * Tier 0: every unit and opaque block gets its refs, resolved against the tree
 * and against one batched issue lookup. Answers why that lookup was
 * unavailable, or `null`.
 *
 * Extraction runs first for everything, so every issue number in the whole run
 * goes to `gh` in one call rather than one call per unit. A repository whose
 * files name no issue at all never reaches `gh`, which is what the injected
 * mock proves: an endpoint with no registered reply throws.
 */
const tierZero = async (
  root: string,
  edges: ContextEdges,
  blocks: Blocks,
): Promise<{ issueLookup: string | null; ignoreCheck: string | null }> => {
  const extracted = [
    ...blocks.units.map((block) => ({ block, refs: extractRefs(block.text) })),
    ...blocks.opaque.map((block) => ({
      block,
      refs: extractBlockRefs(block.text, block.lang, block.kind),
    })),
  ]
  const numbers = [...new Set(extracted.flatMap((entry) => issueNumbers(entry.refs)))]
  const lookup = await issueStates(root, edges, numbers)
  // One cache for the whole run: a `package.json` governs every file under it,
  // so reading it once per unit would read the same file dozens of times.
  const packageJson: PackageJsonCache = new Map()
  for (const { block, refs } of extracted) {
    block.refs = resolveRefs(refs, {
      root,
      file: block.file,
      tracked: blocks.tracked,
      packageJson,
      // A number the lookup left out is one it gave no usable answer for,
      // never "no such issue".
      issueState: (n) => lookup.states[String(n)] ?? 'unavailable',
    })
  }
  const ignoreCheck = await markIgnored([...blocks.units, ...blocks.opaque], root, edges.env)
  return { issueLookup: lookup.unavailable, ignoreCheck }
}

/**
 * The command function.
 *
 * The report goes to `output` as it is built, and the envelope carries only
 * the status: a payload here would be written a second time by the adapter.
 */
export const runContext = async (
  argv: readonly string[],
  edges: ContextEdges,
): Promise<Envelope<string>> => {
  if (wantsHelp(argv)) return ok(USAGE)

  const parsed = parseCommandLine(argv, ARG_SPEC)
  if (parsed.outcome !== 'ok') return parsed
  // `parseCommandLine` admits positionals so that this command can take its
  // root as one; how many it takes is this command's own rule. A second word
  // is far more often a quoting mistake than a request, and auditing the first
  // and ignoring the rest would hide it.
  const { options, positionals } = parsed.value
  if (positionals.length > 1) return refused(`one root at most, not: ${positionals.join(' ')}`)
  for (const flag of COUNT_FLAGS) {
    if (!COUNT_RE.test(options[flag])) {
      return refused(`--${flag} must be a whole number, not "${options[flag]}"`)
    }
  }
  const threshold = options['pair-threshold']
  if (!FRACTION_RE.test(threshold)) {
    return refused(`--pair-threshold must be 0 to 1, not "${threshold}"`)
  }
  // Opened before anything is read, and closed again: the model stages layer 5
  // adds are paid for, so a run must not spend them and only then find that
  // the file it was told to write cannot be opened. It catches a missing
  // directory, a directory in the file's place and a read-only file alike.
  //
  // `a` rather than `w`, because this is a probe: both modes create the file
  // and both fail on those three cases, but `w` would also empty the caller's
  // previous report on the way to a run that still refuses below. The write
  // that earns it is a separate call, at `writeFileSync`'s own default of `w`,
  // so the report replaces the file rather than being appended to it.
  const out = options.out
  if (out !== '') {
    try {
      closeSync(openSync(out, 'a'))
    } catch (error) {
      return refused(`could not open ${out} for writing: ${(error as Error).message}`)
    }
  }
  const started = edges.now()

  const target = positionals[0] ?? edges.cwd
  const root = await toplevel({ cwd: target, env: edges.env })
  if (root === null) {
    // `toplevel` answers `null` for a directory outside any checkout and for a
    // git that could not be run at all, and a reader sent to look for a
    // checkout when git is simply missing is sent to the wrong place. Asked
    // only here, on the failing path, because a machine with git has nothing
    // to learn from the probe.
    const missing = await gitMissing(edges.env)
    if (missing !== null) return refused(`missing git: ${missing}`)
    return refused(`not a git repository: ${target}`)
  }

  // `all` passes a predicate that keeps everything rather than no predicate at
  // all, so discovery has one shape and the scope is decided here, where the
  // flag is read.
  const filter = options.scope === 'context' ? scopeFilter : () => true
  const tracked = await trackedPaths(root, edges.env)
  if (tracked === null) return refused(`could not list the tracked files of ${root}`)
  const files = markdownFiles(tracked, filter)
  const { units, opaque, warnings, unreadable } = splitAll(root, files)
  if (unreadable !== null) return refused(`could not read ${unreadable}`)
  const tier0 = await tierZero(root, edges, { units, opaque, tracked })
  const models = await modelStages(edges, units, {
    root,
    noJev: options['no-jev'],
    // The parser held the value to the two the client declares.
    shape: options.shape as RequestShape,
    // Checked against COUNT_RE above, so this is a whole number.
    maxPairs: Number(options['max-pairs']),
    maxEvidence: Number(options['max-evidence']),
    // Checked against FRACTION_RE above, so this is 0 to 1.
    threshold: Number(threshold),
  })

  const report: Report = {
    root,
    files,
    units,
    opaque,
    warnings,
    issueLookup: tier0.issueLookup ?? 'ok',
    ignoreCheck: tier0.ignoreCheck ?? 'ok',
    skipped: models.skipped,
    classifications: models.classifications,
    pairs: models.pairs,
    pairCoverage: models.pairCoverage,
    evidence: models.evidence,
    evidenceCoverage: models.evidenceCoverage,
    failures: models.failures,
    usage: models.usage,
    // Rounded: the clock a caller passes is `performance.now()`, whose
    // fractional milliseconds are noise in a report and noise in a diff.
    wallClockMs: Math.round(edges.now() - started),
  }

  edges.output.out.write(options.json ? `${JSON.stringify(report)}\n` : renderFindings(report))
  // The text as well as the file: `--out` is what a caller keeps, and the
  // findings are what the caller reads now.
  if (out !== '') writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  // A model call that failed is this code going wrong rather than the caller's
  // request being impossible, so it is `failed` and not `refused`, and the
  // findings are already on stdout: the status says the run was incomplete,
  // and the report says which part of it.
  const count = report.failures.length
  if (count > 0) return failed(`${count} model call${count === 1 ? '' : 's'} failed`)
  return ok('')
}
