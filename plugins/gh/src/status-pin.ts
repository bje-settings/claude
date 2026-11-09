// The decisions of the gh hooks module (`hooks/register.ts`, #488). They
// are here, not in the module, so that vitest measures them (ADR 007,
// rulings 1 and 2). This file imports nothing. The engine runs the hooks
// module with no Node, and this file is part of its module graph (ADR 007,
// ruling 6).

/** The time between two timed refreshes of the status row, in
 *  milliseconds. Each check fetches every repository and asks GitHub once
 *  for each five of them. The counts change slowly, and a git or gh call in
 *  the session refreshes the row at once. So five minutes is enough. */
export const REFRESH_MS = 300_000

/** The time one `status` run may take before the engine stops it. The run
 *  has its own 2.5 s deadline, so this limit is only for a node that does
 *  not end. */
export const RUN_TIMEOUT_MS = 15_000

/** The `gh: ` prefix of each log line of the module. */
const PREFIX = 'gh: '

/** A Bash command that starts with `git` or `gh` as a word of its own. */
const GIT_OR_GH = /^(?:git|gh)(?:\s|$)/

/** A Bash command that runs this plugin's `sync` or `sync-repo`: the work
 *  of `/gh:sync`, which its skill runs as `node "<root>/scripts/gh.ts" sync`. */
const GH_SYNC = /^node\s+"?[^"\s]*\/scripts\/gh\.ts"?\s+sync(?:-repo)?(?:\s|$)/

/**
 * True when a Bash command starts with `git` or `gh`, or with the sync of
 * this plugin. Any other command, such as `ls`, does not refresh the row.
 */
export const changesCounts = (command: string): boolean => {
  const trimmed = command.trim()
  return GIT_OR_GH.test(trimmed) || GH_SYNC.test(trimmed)
}

/** How one `status` run ended, when it did not give a report. */
export type RunFailure =
  | { readonly exitCode: number; readonly stderr: string }
  | { readonly error: unknown }

/**
 * The one line that `$.ui.log` writes for a failed run. It names the exit
 * code and the first line of stderr, or the reason the run did not start.
 */
export const failureText = (failure: RunFailure): string => {
  if ('error' in failure) {
    const { error } = failure
    const reason = error instanceof Error ? error.message : String(error)
    return `${PREFIX}the status check could not run: ${reason}`
  }
  const first = failure.stderr.trim().split('\n', 1).join('')
  const cause = first === '' ? '' : `: ${first}`
  return `${PREFIX}the status check failed with exit ${failure.exitCode}${cause}`
}

/** The counts of `hook-io.ts status --json`, as `StatusCounts` there. */
export interface Counts {
  readonly behind: number
  readonly prune: number
  readonly pullRequests: number
  readonly dependencies: number
  readonly alerts: number
}

/** What `hook-io.ts status --json` writes, as `StatusReport` there. */
export interface Report {
  readonly counts: Counts
  readonly repos: number
  readonly repository: string | null
  readonly problems: readonly string[]
}

const COUNT_KEYS: readonly (keyof Counts)[] = [
  'behind',
  'prune',
  'pullRequests',
  'dependencies',
  'alerts',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The report in `stdout`, or `null` when stdout is not one. Only the first
 * line is read. It is the report when it is a JSON document of the right
 * shape.
 */
export const parseReport = (stdout: string): Report | null => {
  const [first = ''] = stdout.split('\n', 1)
  let value: unknown
  try {
    value = JSON.parse(first)
  } catch {
    return null
  }
  if (!isRecord(value) || !isRecord(value.counts)) return null
  const { counts, repos, repository, problems } = value
  const shaped =
    COUNT_KEYS.every((key) => typeof counts[key] === 'number') &&
    typeof repos === 'number' &&
    (repository === null || typeof repository === 'string') &&
    Array.isArray(problems) &&
    problems.every((problem) => typeof problem === 'string')
  return shaped ? (value as unknown as Report) : null
}

/** What to do with one `status` run that ended: draw a report, or log a
 *  failure and keep the last report. */
export type RunOutcome =
  | { readonly kind: 'pin'; readonly report: Report }
  | { readonly kind: 'failed'; readonly text: string }

/**
 * The outcome of a `status --json` run that exited. A report on stdout is
 * drawn for any exit. The reason: `endOnceWritten` ends a run that a hung
 * read holds with `SIGKILL`. The engine reads a signal as exit 1. A run
 * with no report is a failure.
 */
export const outcomeOf = (ran: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}): RunOutcome => {
  const report = parseReport(ran.stdout)
  if (report !== null) return { kind: 'pin', report }
  if (ran.exitCode === 0)
    return { kind: 'failed', text: `${PREFIX}the status check wrote no report` }
  return { kind: 'failed', text: failureText({ exitCode: ran.exitCode, stderr: ran.stderr }) }
}

/** What one bracket of the row counts. Each kind has its own colour. */
export type SegmentKind = 'repos' | 'behind' | 'prune' | 'pullRequests' | 'dependencies' | 'alerts'

/** One bracket of the row: its label (an emoji or a word), its count, if
 *  any, and the GitHub page it opens, if any. */
export interface Segment {
  readonly kind: SegmentKind
  readonly label: string
  readonly count?: number
  readonly href?: string
}

/** The theme colour of each kind. Theme keys follow the person's theme. */
export const SEGMENT_COLOUR: Readonly<Record<SegmentKind, string>> = {
  repos: 'success',
  behind: 'warning',
  prune: 'suggestion',
  pullRequests: 'planMode',
  dependencies: 'merged',
  alerts: 'error',
}

/**
 * The brackets of the row, in the order `statusLine` in `hook-io.ts`
 * writes them. A zero count is left out, and `repos` shows only with more
 * than one repository and never alone. With one repository, the 🔀, 🤖
 * and 🛡️ brackets open a GitHub page. With more than one, the counts are
 * sums, so no bracket has a page.
 */
export const segmentsOf = (report: Report): Segment[] => {
  const { counts, repository } = report
  const page = (path: string): { href?: string } =>
    repository === null ? {} : { href: `https://github.com/${repository}/${path}` }
  const segments: Segment[] = []
  if (counts.behind > 0) segments.push({ kind: 'behind', label: 'behind' })
  if (counts.prune > 0) segments.push({ kind: 'prune', label: '✂️', count: counts.prune })
  if (counts.pullRequests > 0)
    segments.push({
      kind: 'pullRequests',
      label: '🔀',
      count: counts.pullRequests,
      ...page('pulls?q=is%3Apr+is%3Aopen+draft%3Afalse+-author%3Aapp%2Fdependabot'),
    })
  if (counts.dependencies > 0)
    segments.push({
      kind: 'dependencies',
      label: '🤖',
      count: counts.dependencies,
      ...page('pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot'),
    })
  if (counts.alerts > 0)
    segments.push({
      kind: 'alerts',
      label: '🛡️',
      count: counts.alerts,
      ...page('security/dependabot'),
    })
  if (segments.length > 0 && report.repos > 1)
    segments.unshift({ kind: 'repos', label: 'repos:', count: report.repos })
  return segments
}

/** The text of `segment`, as the status line writes it: `[🛡️ 9]`. */
const bracketText = (segment: Segment): string =>
  segment.count === undefined ? `[${segment.label}]` : `[${segment.label} ${segment.count}]`

/**
 * The plain text for a surface that does not draw the prompt hint, where
 * the module pins it with `$.ui.status`. The engine puts the plugin name
 * before it, so it has no `gh: `. `undefined` when there is nothing to
 * show, which clears the pin.
 */
export const plainText = (report: Report): string | undefined => {
  const parts = [...segmentsOf(report).map(bracketText), ...report.problems.map((p) => `⚠️ ${p}`)]
  return parts.length === 0 ? undefined : parts.join(' ')
}
