// The audit's answer, and the text a reader starts from. This is the port
// of the spike's `printFindings` (#164), without its write callback. It
// returns a string in one piece. So the command decides where the string
// goes. A test can assert it without a stream.
//
// Tier 0's sections come first. Then one section per model stage, in the
// order the stages run. Then what the run failed at, and what it spent. A
// stage that never ran prints one line that says so, in place of its
// findings. This is the whole point of `SkippedStage`: "skipped" must never
// read as "nothing found".

import type { PairCandidate } from './candidates.ts'
import type {
  ChoiceAnswer,
  Classification,
  EvidenceVerdict,
  PairVerdict,
  Usage,
} from './lib/jev.ts'
import type { OpaqueBlock, Ref, SplitWarning, Unit } from './types.ts'

/** A candidate the model has ruled on. The candidate's own ids and
 *  similarity are kept beside the verdict. A reader who acts on a finding
 *  needs both. */
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

/** A stage that asks the model something. Each one has its own findings
 *  section, in {@link STAGE_SECTIONS}. */
export type Stage = 'classify' | 'pairs' | 'evidence'

/** Why a stage never ran.
 *
 *  `no_key` is an environment that holds no `TYPESAFE_API_KEY`. This is what
 *  a machine that has never been set up reports. `no_jev` is when the
 *  caller asks for tier 0 alone, with `--no-jev`. `subcommands/context.ts`
 *  `skipReason` is where the code chooses those two. They are the only two
 *  that can reach the classify stage.
 *
 *  `classify_failed` is the third. It reaches only `pairs` and `evidence`.
 *  The classify stage ran and came back with no label at all. So there is
 *  nothing to route the two stages below it by. `subcommands/context.ts`
 *  `modelStages` is where the code chooses it. */
export type SkippedStage = { stage: Stage; reason: 'no_key' | 'no_jev' | 'classify_failed' }

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
   *  ignores. Without it, a reader cannot tell a repository that ignores
   *  nothing from one where the question could not be asked. The refs it
   *  leaves marked `absent` are the section a reader acts on first. */
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
 *  Only `absent` and `line_out_of_range` reach it. Those are the two the
 *  sections select. The spike's `issue` arm, which printed the state, was
 *  already dead there for the same reason. No section prints a ref's issue
 *  state here either. A cited issue's state is a finding only once a model
 *  judgment gates it. That gate is {@link isExpired}'s section, not this
 *  one. */
const describe = (ref: Ref): string => {
  const resolution = ref.resolution
  if (resolution.status === 'line_out_of_range') return `only ${resolution.lines} lines`
  return resolution.status
}

/** Every block that carries refs, units and opaque blocks alike. A path
 *  that does not resolve is the same finding, wherever it was written. */
const blocksOf = (report: Report): Array<Unit | OpaqueBlock> => [...report.units, ...report.opaque]

/** One line per ref resolved to `status`. It names where it was written. */
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
 *  `unchecked` carries its own reason. `tail_match` and `ignored` are
 *  answers that are neither "there" nor "missing". A reader who counts
 *  findings has to be able to see how many of them there were. */
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

/** A section: a blank line, the heading, and one line per finding. Every
 *  section of the report is built here. So the code writes the blank line
 *  that separates them only once. A heading counts its own findings, in the
 *  form that section needs. No other code counts them for it. */
const section = (heading: string, entries: string[] = []): string[] => [
  '',
  `## ${heading}`,
  ...entries,
]

/** The longest a unit's text may be, in a findings list. The text is there
 *  to recognise a unit by, not to read in full. One finding is one line. A
 *  table row carries a newline between its cells. A paragraph runs for as
 *  long as its writer wanted. */
const LINE_CHARS = 110

/** `text` cut to at most `chars`, never through a character.
 *
 *  `slice` counts UTF-16 code units. Everything outside the basic plane is
 *  two of them. An emoji or a rarer CJK codepoint that straddles the cut
 *  would leave its high half behind. That leftover is not a character. It
 *  reaches the reader as a replacement mark, in the middle of the text the
 *  finding is recognised by.
 *
 *  The code drops that half instead. The result is one code unit shorter.
 *  It is still the source's own words. That is the property every unit
 *  text in this report has. */
const cutTo = (text: string, chars: number): string => {
  const head = text.slice(0, chars)
  // D800 to DBFF is the high half of a pair; its low half was just cut off.
  const last = head.charCodeAt(chars - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

const short = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > LINE_CHARS ? `${cutTo(flat, LINE_CHARS - 3)}...` : flat
}

const cov = (coverage: Coverage): string => `${coverage.judged} of ${coverage.available} judged`

/** The two verdicts that are findings, each its own. One is a line to
 *  delete, the other a disagreement to settle. `unrelated` is the answer
 *  that is not a finding, which is why it has no section. */
const PAIR_FINDINGS = ['contradicts', 'same_claim'] as const

/** Most confident first, which is what turns a verdict's findings into a
 *  review queue rather than a list. Both callers sort the array `filter`
 *  has already copied for them. So `report.pairs` and `report.evidence`
 *  keep the order the stages judged them in. The JSON report is a record,
 *  not a queue. The order a run made its calls in is part of what it
 *  records. */
const byConfidence = <T extends { verdict: { confidence: number } }>(x: T, y: T): number =>
  y.verdict.confidence - x.verdict.confidence

/** A reader for one unit's text, shortened, by id. Every judgment in a report
 *  names a unit of the same run, so the lookup answers. */
const shortTextById = (report: Report): ((unitId: string) => string) => {
  const byId = new Map(report.units.map((unit) => [unit.id, unit]))
  return (unitId) => short((byId.get(unitId) as Unit).text)
}

/** The pairs the model ruled on, under the verdict that is a finding. */
const pairSections = (report: Report): string[] => {
  const textOf = shortTextById(report)
  return PAIR_FINDINGS.flatMap((verdict) => {
    const matching = report.pairs
      .filter((pair) => pair.verdict.choice === verdict)
      .sort(byConfidence)
    return section(
      `pairs: ${verdict} (${matching.length}; ${cov(report.pairCoverage)})`,
      matching.flatMap((pair) => [
        `  conf ${pair.verdict.confidence.toFixed(2)}  ${pair.a}  <>  ${pair.b}`,
        `    a: ${textOf(pair.a)}`,
        `    b: ${textOf(pair.b)}`,
      ]),
    )
  })
}

/** The probability at which the audit accepts the model's answer that a
 *  unit names its own expiry. */
const VOLATILE_BAR = 0.8

/** The claims an excerpt refutes. A claim the excerpt supports, or says
 *  nothing about, is not a finding. Only the contradiction is something to
 *  act on. */
const evidenceSections = (report: Report): string[] => {
  const textOf = shortTextById(report)
  const refuted = report.evidence
    .filter((entry) => entry.verdict.choice === 'contradicts')
    .sort(byConfidence)
  return section(
    `evidence: contradicts (${refuted.length}; ${cov(report.evidenceCoverage)})`,
    refuted.flatMap((entry) => [
      `  conf ${entry.verdict.confidence.toFixed(2)}  ${entry.unitId}  against ${entry.source}`,
      `    ${textOf(entry.unitId)}`,
    ]),
  )
}

/** A unit that names an expiry, where an issue it cites is no longer open.
 *
 *  0.8 is the spike's own bar, tuned against the live model. A record of
 *  the past cites a closed issue correctly. So `history` is never a
 *  finding here, however the issue resolved. The model is not asked WHICH
 *  issue the expiry refers to. So a unit that cites several is reported
 *  when any of them has closed. */
const isExpired = (unit: Unit, judged: Classification | undefined): boolean =>
  judged !== undefined &&
  judged.volatile >= VOLATILE_BAR &&
  judged.kind.choice !== 'history' &&
  unit.refs.some((ref) => ref.resolution.status === 'issue' && ref.resolution.state !== 'OPEN')

/** The model's answer to "does this name its own expiry". */
const namesExpiry = (judged: Classification | undefined): boolean =>
  judged !== undefined && judged.volatile >= VOLATILE_BAR

/** A unit that cites an issue the lookup could not answer about. The closed
 *  issue may be exactly the one the expiry hangs on. So such a unit is
 *  judged neither way. It is counted in the heading instead. */
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
  // When classify labelled nothing, a heading of 0 would read as "no unit
  // expired." But no unit was ever judged. The stages below say the same
  // with their skipped line. This section has no skipped entry of its own.
  const classifyFailed = report.skipped.some((entry) => entry.reason === 'classify_failed')
  const entries = classifyFailed
    ? ['  not judged: classify failed']
    : expired.map((unit) => `  ${unit.id}  ${short(unit.text)}`)
  return section(
    `volatile and the issue it names is closed (${expired.length}${unjudged})`,
    entries,
  )
}

/** What each model stage prints when it ran, in the order the stages run. A
 *  list, rather than a record keyed by {@link Stage}. So the order is the
 *  array's own, not something read back out of the keys. */
const STAGE_SECTIONS = [
  ['classify', expiredSections],
  ['pairs', pairSections],
  ['evidence', evidenceSections],
] as const satisfies ReadonlyArray<readonly [Stage, (report: Report) => string[]]>

/** Each model stage's own findings, or the one line that says it never ran. */
const modelSections = (report: Report): string[] =>
  STAGE_SECTIONS.flatMap(([stage, sectionsFor]) => {
    const skipped = report.skipped.find((entry) => entry.stage === stage)
    if (skipped === undefined) return sectionsFor(report)
    return section(`${stage}: skipped (${skipped.reason})`)
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
    const entries = linesFor(report, status)
    lines.push(...section(`${heading} (${entries.length})`, entries))
  }
  // There is deliberately no "issues cited that are not open" section here.
  // Tier 0 knows each cited issue's state. Every state is in the JSON
  // report. But the state alone is not a finding. A history line
  // legitimately cites a closed issue. This repository's own files are
  // almost entirely that.
  //
  // The finding is gated on a model judgment instead, and it is the
  // classify stage's own section ({@link isExpired}).

  // No count in this heading. The lines are the counts. A number of
  // distinct kinds beside them would be a second number, and it would mean
  // something else.
  lines.push(...section('tier 0: refs not checked', uncheckedTally(report)))
  lines.push(...modelSections(report))
  // Always, and with its count, whether or not a stage ran. Without a
  // failures section, a reader could not tell whether there were none, or
  // whether nobody looked.
  lines.push(
    ...section(
      `failures (${report.failures.length})`,
      report.failures.map((failure) => `  ${failure.stage} ${failure.id}: ${failure.message}`),
    ),
  )

  const usage = report.usage
  lines.push(
    ...section(
      `usage: ${usage.requests} requests (${usage.attempts} attempts), ` +
        `${usage.inputTokens} input tokens, ${usage.requestMsSum} ms summed request time, ` +
        `${report.wallClockMs} ms wall clock`,
    ),
  )

  return `${lines.join('\n')}\n`
}
