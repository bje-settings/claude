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

/** Why a stage never ran. `no_key` is no `TYPESAFE_API_KEY` in the
 *  environment; `no_jev` is `--no-jev`, the caller asking for tier 0 alone. */
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
  /** Stages that did not run at all, and why. */
  skipped: SkippedStage[]
  wallClockMs: number
}

/** How one resolution reads in the report. */
const describe = (ref: Ref): string => {
  const resolution = ref.resolution
  switch (resolution.status) {
    case 'unchecked':
      return `unchecked (${resolution.reason})`
    case 'line_out_of_range':
      return `only ${resolution.lines} lines`
    case 'found':
      return 'found'
    default:
      return resolution.status
  }
}

/** Every block that carries refs, units and opaque blocks alike: a path that
 *  does not resolve is the same finding wherever it was written. */
const blocksOf = (report: Report): Array<Unit | OpaqueBlock> => [...report.units, ...report.opaque]

const linesWithStatus = (report: Report, status: string): string[] =>
  blocksOf(report).flatMap((block) =>
    block.refs
      .filter((ref) => ref.resolution.status === status)
      .map(
        (ref) =>
          `  ${block.file}:${block.startLine}  ${ref.kind} \`${ref.value}\`  ${describe(ref)}`,
      ),
  )

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

  lines.push(...section('tier 0: refs that do not resolve', linesWithStatus(report, 'absent')))
  lines.push(
    ...section(
      'tier 0: line references past the end of the file',
      linesWithStatus(report, 'line_out_of_range'),
    ),
  )

  for (const skipped of report.skipped) {
    lines.push('', `## ${skipped.stage}: skipped (${skipped.reason})`)
  }

  return `${lines.join('\n')}\n`
}
