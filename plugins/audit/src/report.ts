// The audit's answer, and the text a reader starts from. The port of the
// spike's `printFindings` (#164) without its write callback: a string in one
// piece, so the command decides where it goes and a test asserts it without a
// stream.
//
// Tier 0's sections, then one per model stage in the order the stages run, and
// then what the run failed at and what it spent. A stage that never ran prints
// the one line saying so in place of its findings, which is the whole point of
// `SkippedStage`: "skipped" must never read as "nothing found".

import type { PairCandidate } from './candidates.ts'
import type {
  ChoiceAnswer,
  Classification,
  EvidenceVerdict,
  PairVerdict,
  Usage,
} from './lib/jev.ts'
import type { OpaqueBlock, Ref, SplitWarning, Unit } from './types.ts'

/** A candidate the model has ruled on. The candidate's own ids and similarity
 *  are kept beside the verdict: a reader acting on a finding needs both. */
export type PairJudgment = PairCandidate & { verdict: ChoiceAnswer<PairVerdict> }

/** A claim ruled on against an excerpt of the file it names. */
export type EvidenceJudgment = {
  unitId: string
  /** The file the excerpt came from, relative to the audited root. */
  source: string
  excerpt: string
  verdict: ChoiceAnswer<EvidenceVerdict>
}

/** A model call that failed. The run carries on and reports it: a stage that
 *  lost one request still answers for the rest. */
export type StageFailure = { stage: Stage; id: string; message: string }

/** How much of a stage's work was done, so "0 found" can be told from "0
 *  looked at". */
export type Coverage = { judged: number; available: number }

/** A stage that asks the model something. Layer 5 gives each one findings. */
export type Stage = 'classify' | 'pairs' | 'evidence'

/** Why a stage never ran.
 *
 *  `no_key` is an environment holding no `TYPESAFE_API_KEY`, which is what a
 *  machine that has never been set up reports. `no_jev` is the caller asking
 *  for tier 0 alone with `--no-jev`. `commands/context.ts` `skipReason` is
 *  where the two are chosen. */
export type SkippedStage = { stage: Stage; reason: 'no_key' | 'no_jev' }

export type Report = {
  /** The audited checkout's root, as `git rev-parse --show-toplevel` gives it. */
  root: string
  /** The files read, relative to `root`. */
  files: string[]
  units: Unit[]
  opaque: OpaqueBlock[]
  warnings: SplitWarning[]
  /** `ok`, or why no issue state could be read. */
  issueLookup: string
  /** `ok`, or why git could not say which absent paths this repository
   *  ignores. Without it a reader cannot tell a repository that ignores
   *  nothing from one the question could not be asked about, and the refs it
   *  leaves saying `absent` are the section a reader acts on first. */
  ignoreCheck: string
  /** Stages that did not run at all, and why. */
  skipped: SkippedStage[]
  classifications: Classification[]
  pairs: PairJudgment[]
  pairCoverage: Coverage
  evidence: EvidenceJudgment[]
  /** `available` counts the repo_fact units; one with no readable source file
   *  is in neither `judged` nor a failure. */
  evidenceCoverage: Coverage
  failures: StageFailure[]
  /** What the model calls of this run cost. Zeros when no stage ran. */
  usage: Usage
  wallClockMs: number
}

/** How one resolution reads in the report, for the statuses the sections below
 *  print. Everything else is a status word of its own.
 *
 *  Only `absent` and `line_out_of_range` reach it: those are the two the
 *  sections select. The spike's `issue` arm, which prints the state, belongs
 *  with the section that prints issues, and comes back with it at layer 5
 *  rather than sitting here as a branch no input can reach. */
const describe = (ref: Ref): string => {
  const resolution = ref.resolution
  if (resolution.status === 'line_out_of_range') return `only ${resolution.lines} lines`
  return resolution.status
}

/** Every block that carries refs, units and opaque blocks alike: a path that
 *  does not resolve is the same finding wherever it was written. */
const blocksOf = (report: Report): Array<Unit | OpaqueBlock> => [...report.units, ...report.opaque]

/** One line per ref resolved to `status`, naming where it was written. */
const linesFor = (report: Report, status: Ref['resolution']['status']): string[] =>
  blocksOf(report).flatMap((block) =>
    block.refs
      .filter((ref) => ref.resolution.status === status)
      .map(
        (ref) =>
          `  ${block.file}:${block.startLine}  ${ref.kind} \`${ref.value}\`  ${describe(ref)}`,
      ),
  )

/** How a ref tier 0 did not settle is tallied, or `null` for one it did.
 *  `unchecked` carries its own reason; `tail_match` and `ignored` are answers
 *  that are neither "there" nor "missing", and a reader counting findings has
 *  to be able to see how many of them there were. */
const uncheckedKey = (ref: Ref): string | null => {
  const resolution = ref.resolution
  if (resolution.status === 'unchecked') return `${ref.kind} ${resolution.reason}`
  if (resolution.status === 'tail_match' || resolution.status === 'ignored') {
    return `${ref.kind} ${resolution.status}`
  }
  return null
}

/** The tally, one line per kind and reason, in key order. */
const uncheckedTally = (report: Report): string[] => {
  const counts = new Map<string, number>()
  for (const block of blocksOf(report)) {
    for (const ref of block.refs) {
      const key = uncheckedKey(ref)
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts].sort().map(([key, n]) => `  ${n}  ${key}`)
}

/** The resolutions tier 0 reports as findings, each under its own heading and
 *  in this order. These are the two statuses {@link describe} prints. */
const FINDING_SECTIONS = [
  ['absent', 'tier 0: refs that do not resolve'],
  ['line_out_of_range', 'tier 0: line references past the end of the file'],
] as const satisfies ReadonlyArray<readonly [Ref['resolution']['status'], string]>

/** A section: its heading, its count, and one line per finding. */
const section = (heading: string, entries: string[]): string[] => [
  '',
  `## ${heading} (${entries.length})`,
  ...entries,
]

/** The longest a unit's text may be in a findings list. The text is there to
 *  recognise a unit by rather than to read in full, and one finding is one
 *  line: a table row carries a newline between its cells, and a paragraph runs
 *  for as long as its writer wanted. */
const LINE_CHARS = 110

const short = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 3)}...` : flat
}

const cov = (coverage: Coverage): string => `${coverage.judged} of ${coverage.available} judged`

/** The two verdicts that are findings, each its own: one is a line to delete,
 *  the other a disagreement to settle. `unrelated` is the answer that is not a
 *  finding, which is why it has no section. */
const PAIR_FINDINGS = ['contradicts', 'same_claim'] as const

/** The pairs the model ruled on, under the verdict that is a finding. */
const pairSections = (report: Report): string[] => {
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  return PAIR_FINDINGS.flatMap((verdict) => {
    const matching = report.pairs.filter((pair) => pair.verdict.choice === verdict)
    return [
      '',
      `## pairs: ${verdict} (${matching.length}; ${cov(report.pairCoverage)})`,
      // Every pair names two units of this same run, so the lookups answer.
      ...matching.flatMap((pair) => [
        `  conf ${pair.verdict.confidence.toFixed(2)}  ${pair.a}  <>  ${pair.b}`,
        `    a: ${(byId.get(pair.a) as Unit).text}`,
        `    b: ${(byId.get(pair.b) as Unit).text}`,
      ]),
    ]
  })
}

/** The probability at which the model is taken to have said a unit names its
 *  own expiry. */
const VOLATILE_BAR = 0.8

/** The claims an excerpt refutes. A claim the excerpt supports, or says
 *  nothing about, is not a finding: only the contradiction is something to
 *  act on. */
const evidenceSections = (report: Report): string[] => {
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  const refuted = report.evidence.filter((entry) => entry.verdict.choice === 'contradicts')
  return [
    '',
    `## evidence: contradicts (${refuted.length}; ${cov(report.evidenceCoverage)})`,
    // Every judgment names a unit of this same run.
    ...refuted.flatMap((entry) => [
      `  conf ${entry.verdict.confidence.toFixed(2)}  ${entry.unitId}  against ${entry.source}`,
      `    ${short((byId.get(entry.unitId) as Unit).text)}`,
    ]),
  ]
}

/** A unit that names an expiry, where an issue it cites is no longer open.
 *
 *  0.8 is the spike's own bar, tuned against the live model.
 *  A record of the past cites a closed issue correctly, so `history` is never
 *  a finding here however the issue resolved. The model is not asked WHICH
 *  issue the expiry refers to, so a unit citing several is reported when any
 *  of them has closed. */
const isExpired = (unit: Unit, judged: Classification | undefined): boolean =>
  judged !== undefined &&
  judged.volatile >= VOLATILE_BAR &&
  judged.kind.choice !== 'history' &&
  unit.refs.some((ref) => ref.resolution.status === 'issue' && ref.resolution.state !== 'OPEN')

/** The model's answer to "does this name its own expiry". */
const namesExpiry = (judged: Classification | undefined): boolean =>
  judged !== undefined && judged.volatile >= VOLATILE_BAR

/** A unit citing an issue the lookup could not answer about. The closed issue
 *  may be exactly the one the expiry hangs on, so such a unit is judged
 *  neither way and is counted in the heading instead. */
const hasUnreachableIssue = (unit: Unit): boolean =>
  unit.refs.some(
    (ref) =>
      ref.kind === 'issue' &&
      ref.resolution.status === 'unchecked' &&
      ref.resolution.reason === 'unavailable',
  )

/** The units the classify stage makes findings of. */
const expiredSections = (report: Report): string[] => {
  const judged = new Map(report.classifications.map((entry) => [entry.unitId, entry]))
  const expired = report.units.filter(
    (unit) => !hasUnreachableIssue(unit) && isExpired(unit, judged.get(unit.id)),
  )
  const notJudged = report.units.filter(
    (unit) => hasUnreachableIssue(unit) && namesExpiry(judged.get(unit.id)),
  ).length
  const unjudged =
    notJudged > 0 ? `; ${notJudged} volatile units not judged, issue lookup unavailable` : ''
  return [
    '',
    `## volatile and the issue it names is closed (${expired.length}${unjudged})`,
    ...expired.map((unit) => `  ${unit.id}  ${short(unit.text)}`),
  ]
}

/** What each model stage prints when it ran, in the order the stages run. */
const STAGE_SECTIONS: Record<Stage, (report: Report) => string[]> = {
  classify: expiredSections,
  pairs: pairSections,
  evidence: evidenceSections,
}

/** Each model stage's own findings, or the one line saying it never ran. */
const modelSections = (report: Report): string[] =>
  (Object.keys(STAGE_SECTIONS) as Stage[]).flatMap((stage) => {
    const skipped = report.skipped.find((entry) => entry.stage === stage)
    if (skipped === undefined) return STAGE_SECTIONS[stage](report)
    return ['', `## ${stage}: skipped (${skipped.reason})`]
  })

/** The findings a reviewer, human or agent, starts from. */
export const renderFindings = (report: Report): string => {
  const lines: string[] = [
    `${report.files.length} files, ${report.units.length} units, ${report.opaque.length} opaque`,
  ]
  for (const warning of report.warnings) {
    lines.push(`  warning: ${warning.file}:${warning.line} ${warning.kind}`)
  }
  if (report.issueLookup !== 'ok') lines.push(`  issue lookup unavailable: ${report.issueLookup}`)
  if (report.ignoreCheck !== 'ok') lines.push(`  ignore check unavailable: ${report.ignoreCheck}`)

  for (const [status, heading] of FINDING_SECTIONS) {
    lines.push(...section(heading, linesFor(report, status)))
  }
  // There is deliberately no "issues cited that are not open" section here.
  // Tier 0 knows each cited issue's state, and every state is in the JSON
  // report, but the state alone is not a finding: a history line legitimately
  // cites a closed issue, and this repository's own files are almost entirely
  // that. The finding is gated on a model judgment instead, and it is the
  // classify stage's own section ({@link isExpired}).

  // No count in this heading: the lines are the counts, and a number of
  // distinct kinds beside them would be a second number meaning something
  // else.
  lines.push('', '## tier 0: refs not checked', ...uncheckedTally(report))
  lines.push(...modelSections(report))
  // Always, and with its count, whether or not a stage ran: a report with no
  // failures section would leave a reader guessing whether there were none or
  // whether nobody looked.
  lines.push(
    '',
    `## failures (${report.failures.length})`,
    ...report.failures.map((failure) => `  ${failure.stage} ${failure.id}: ${failure.message}`),
  )

  const usage = report.usage
  lines.push(
    '',
    `## usage: ${usage.requests} requests (${usage.attempts} attempts), ` +
      `${usage.inputTokens} input tokens, ${usage.requestMsSum} ms summed request time, ` +
      `${report.wallClockMs} ms wall clock`,
  )

  return `${lines.join('\n')}\n`
}
