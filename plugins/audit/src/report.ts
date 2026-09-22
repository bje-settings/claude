// The audit's answer, and the text a reader starts from. The port of the
// spike's `printFindings` (#164) without its write callback: a string in one
// piece, so the command decides where it goes and a test asserts it without a
// stream.
//
// Tier 0's sections only. The model stages have no findings to print in this
// layer and appear as the one line saying they never ran, which is the whole
// point of `SkippedStage`: "skipped" must never read as "nothing found".

import type { OpaqueBlock, Ref, SplitWarning, Unit } from './types.ts'

/** A stage that asks the model something. Layer 5 gives each one findings. */
export type Stage = 'classify' | 'pairs' | 'evidence'

/** Why a stage never ran.
 *
 *  `no_key` is an environment holding no `TYPESAFE_API_KEY`, which is what a
 *  machine that has never been set up reports. `no_jev` is every other reason
 *  there was no model call: the caller asked for tier 0 alone with `--no-jev`,
 *  or there is a key and no client to spend it, since `lib/jev.ts` lands at
 *  layer 4. `commands/context.ts` `skipReason` is where the two are chosen. */
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

/** One line per ref `keep` selects, naming where it was written. */
const linesFor = (report: Report, keep: (ref: Ref) => boolean): string[] =>
  blocksOf(report).flatMap((block) =>
    block.refs
      .filter(keep)
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

/** A section: its heading, its count, and one line per finding. */
const section = (heading: string, entries: string[]): string[] => [
  '',
  `## ${heading} (${entries.length})`,
  ...entries,
]

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

  lines.push(
    ...section(
      'tier 0: refs that do not resolve',
      linesFor(report, (ref) => ref.resolution.status === 'absent'),
    ),
  )
  lines.push(
    ...section(
      'tier 0: line references past the end of the file',
      linesFor(report, (ref) => ref.resolution.status === 'line_out_of_range'),
    ),
  )
  // There is deliberately no "issues cited that are not open" section here.
  // Tier 0 knows each cited issue's state, and every state is in the JSON
  // report, but the state alone is not a finding: a history line legitimately
  // cites a closed issue, and this repository's own files are almost entirely
  // that. The spike gated the finding on a model judgment instead, `volatile`
  // at or above 0.8 and a unit that is not `history` (`cli.ts` `isExpired`),
  // which makes it a model section and layer 5's to add.

  // No count in this heading: the lines are the counts, and a number of
  // distinct kinds beside them would be a second number meaning something
  // else.
  lines.push('', '## tier 0: refs not checked', ...uncheckedTally(report))

  for (const skipped of report.skipped) {
    lines.push('', `## ${skipped.stage}: skipped (${skipped.reason})`)
  }

  return `${lines.join('\n')}\n`
}
