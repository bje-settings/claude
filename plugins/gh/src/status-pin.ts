// The decisions of the gh hooks module (`hooks/register.ts`, #488). They
// are here, not in the module, so that vitest measures them (ADR 007,
// rulings 1 and 2). This file imports nothing. The engine runs the hooks
// module with no Node, and this file is part of its module graph (ADR 007,
// ruling 6).

/** The time between two timed refreshes of the pinned line, in
 *  milliseconds. Each check fetches every repository and asks GitHub once
 *  for each five of them. The counts change slowly, and a git or gh call in
 *  the session refreshes the line at once. So five minutes is enough. */
export const REFRESH_MS = 300_000

/** The time one `status` run may take before the engine stops it. The run
 *  has its own 2.5 s deadline, so this limit is only for a node that does
 *  not end. */
export const RUN_TIMEOUT_MS = 15_000

/** The `gh: ` prefix of each line that `hook-io.ts status` writes, and of
 *  each log line of the module. */
const PREFIX = 'gh: '

/**
 * The text to pin for the stdout of `hook-io.ts status`, or `undefined` to
 * clear the line. The lines join into one. The first line keeps its `gh: `.
 * Each later line loses it, so the pinned line has one prefix.
 */
export const pinnedText = (stdout: string): string | undefined => {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const [first, ...rest] = lines
  if (first === undefined) return undefined
  const more = rest.map((line) => (line.startsWith(PREFIX) ? line.slice(PREFIX.length) : line))
  return [first, ...more].join(' ')
}

/** A Bash command that starts with `git` or `gh` as a word of its own. */
const GIT_OR_GH = /^(?:git|gh)(?:\s|$)/

/** A Bash command that runs this plugin's `sync` or `sync-repo`: the work
 *  of `/gh:sync`, which its skill runs as `node "<root>/scripts/gh.ts" sync`. */
const GH_SYNC = /^node\s+"?[^"\s]*\/scripts\/gh\.ts"?\s+sync(?:-repo)?(?:\s|$)/

/**
 * True when a Bash command starts with `git` or `gh`, or with the sync of
 * this plugin. Any other command, such as `ls`, does not refresh the line.
 */
export const changesCounts = (command: string): boolean => {
  const trimmed = command.trim()
  return GIT_OR_GH.test(trimmed) || GH_SYNC.test(trimmed)
}

/** How one `status` run ended, when it did not give a line. */
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

/** What to do with one `status` run that ended: pin a text (`undefined`
 *  clears the line), or log a failure and keep the last line. */
export type RunOutcome =
  | { readonly kind: 'pin'; readonly text: string | undefined }
  | { readonly kind: 'failed'; readonly text: string }

/**
 * The outcome of a `status` run that exited. An exit 0 pins its stdout, or
 * clears the line when stdout is empty. A run can also write its line and
 * then exit 1: `endOnceWritten` ends a run that a hung read holds with
 * `SIGKILL`, and the engine reads a signal as exit 1. So a line on stdout
 * is pinned for any exit. A failed exit with no line is a failure.
 */
export const outcomeOf = (ran: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}): RunOutcome => {
  const text = pinnedText(ran.stdout)
  if (ran.exitCode === 0 || text !== undefined) return { kind: 'pin', text }
  return { kind: 'failed', text: failureText({ exitCode: ran.exitCode, stderr: ran.stderr }) }
}
