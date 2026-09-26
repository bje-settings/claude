// This file is the gh plugin's SessionStart hook. It is the port of
// `plugins/gh/hooks/hook-io.py` (deleted at #127). That file's docstring
// gave the argument for everything below. This comment keeps that argument
// in full, rather than a summary.
//
// This hook runs a report-only sync check at session start. It never
// changes a branch, a worktree, or a working tree. The fan-out branch runs
// `gh.ts sync --dry-run --no-install`. The in-repo branch does not touch
// the network at all. The fan-out branch does fetch, which updates
// remote-tracking refs.
//
// The hook stays silent unless it has something worth a report. A hook
// that speaks every time is a hook nobody reads. It always exits 0 on the
// `session-start` path. Nothing here can stop a session from starting. The
// `; exit 0` in `hooks.json` gives the same guarantee for the cases where
// this file never runs at all. This covers two cases: no node on PATH,
// and a hooks directory where nobody installed this file.
//
// Anything else answers with a usage message and exit 2. This includes no
// subcommand, a subcommand this hook does not know, or `branch` without
// exactly two branch names. A typo in `hooks.json` is a configuration
// mistake. A hook that swallowed that mistake would stay silent about the
// check it should run. It would stay silent for the life of the install.
//
// `hooks.json`'s `; exit 0` absorbs the exit status. The diagnostic that
// survives is the usage line on stderr, which Claude Code's debug log
// keeps. Nothing goes to stdout there, so the hook still adds no context.
// stderr is where the other degraded runs leave their trace too, for the
// same reason. A missing entry point or a missing git is worth one line in
// the debug log. It is worth nothing at all in the session.
//
// **The acceptance test for #127 is this. This file's stdout must be
// BYTE-IDENTICAL to the Python's, on the same repository state.** Its
// stdout is a JSON document that Claude Code parses. The contract covers
// the key order, the `", "` and `": "` separators that Python's
// `json.dump` writes, the `\uXXXX` escaping that `ensure_ascii` applies,
// and the trailing newline. {@link emit} is where that contract lives.
// `tests/plugins/gh/fixtures/hook-output.json` is the only thing the tests compare against.
//
// This file keeps the three subcommands beside `session-start`. They are
// the seams that the tests use, and that a person can use to debug the
// hook by hand. To retire them would also retire the usage-error contract.
import { accessSync, constants, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import { discoverRepos } from '../discover.ts'
import {
  currentBranch,
  defaultBranch,
  gitLines,
  gitOut,
  hasRef,
  type RepoOptions,
} from '../lib/git.ts'
import type { Runner } from '../lib/process.ts'
import type { Output } from '../lib/streams.ts'
import { hasMatch, ownRows, type PullRequestRow } from '../prs.ts'
import { REPORT } from './sync-repo.ts'

/** The event name the response names itself with. */
const HOOK_EVENT = 'SessionStart'

/** This hook speaks only when the fan-out report has something worth a
 *  mention: a proposed change ("would ..."), a problem ("✗"), or a
 *  degraded run ("could not ..."). A run whose merge lookups all failed has
 *  nothing to propose. Silence there would read as "everything is in
 *  order", not as "nothing could be checked". */
const ACTIONABLE = ['would ', '✗', 'could not']

/** The hook's own budget is 60 seconds (`hooks.json`). The fan-out must
 *  stop early enough to report that it stopped. One fetch per repository is
 *  the slow part. A directory of repositories against a slow remote is
 *  exactly the case that runs over budget. */
export const SYNC_TIMEOUT = 50
export const SYNC_TIMEOUT_ENV = 'GH_HOOK_SYNC_TIMEOUT'

/** `setTimeout`'s ceiling. Above it, node clamps to 1 ms and fires on the
 *  next tick. A bound this large would kill the child at once, where
 *  `communicate(timeout=...)` waits instead. So anything over this ceiling
 *  is no bound at all. This is what Python does with `float("inf")`. */
const MAX_TIMER_MS = 2_147_483_647

/** These are the variables that name a DIFFERENT repository than the one a
 *  call is about. Every git call, and the one child process, get an
 *  environment with these variables removed.
 *
 *  `git rev-parse --local-env-vars` gives this list, verbatim, plus
 *  `GH_REPO`, which is gh's equivalent. The Python inherited the whole
 *  environment. That was safe only because nothing ran it from inside a
 *  git hook. This hook can start from a session that Claude Code opened
 *  anywhere.
 *
 *  `GIT_DIR` outranks both `cwd` and `git -C` for everything the git
 *  directory holds. So a session started from a `git commit` would learn
 *  about the hook's own repository, not about the user's checkout.
 *  `lib/README.md` records this under "Decisions not taken", as the helper
 *  that this port reopens. It also says the same thing from the other
 *  side: to name an environment variable is not to scrub it. The scrub
 *  itself is the job of the caller that knows which keys displace its
 *  target.
 *
 *  This code deliberately does NOT remove git's configuration discovery
 *  (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_CEILING_DIRECTORIES`),
 *  nor `HOME`, nor `PATH`. These choose which git and which configuration
 *  answer. That choice is the session's business, not this hook's. To
 *  remove them would change what the user's own `git` would have said. */
const REPOSITORY_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GH_REPO',
]

/** `env` without the keys that displace the repository a call names. This
 *  is a copy, never the object it was given. */
export const scrubRepositoryEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed: NodeJS.ProcessEnv = { ...env }
  for (const key of REPOSITORY_ENV_KEYS) delete scrubbed[key]
  return scrubbed
}

/** This is the word that opens a line about a lookup that `sync` could not
 *  make, in `sync-repo.ts`'s own vocabulary. This is not a new dependency
 *  on that text: it is {@link ACTIONABLE}'s third marker. That marker has
 *  decided whether this hook speaks at all, since the Python version. The
 *  trailing space makes sure the match is the whole word, not the start of
 *  a longer one. The code matches it with `startsWith` against a note
 *  line. It never searches for the word inside a line. */
const COULD_NOT = 'could not '

/** What is worth saying about one repository's checkout. All of it comes
 *  from local refs (#110 ruling 4). */
export interface BranchStatus {
  /** The branch the session started on. */
  readonly current: string
  /** The repository's default branch, as far as the clone knows locally. */
  readonly target: string
  /** Commits the cached `origin/<target>` has that the local `<target>` does
   *  not. This is `null` where that pair could not be counted. Zero and
   *  `null` both write no line, but they are deliberately different: only
   *  one of them is an answer. */
  readonly behind: number | null
  /** Local branches whose upstream is gone, or that are already merged into
   *  `<target>`. This never includes `<target>` itself or the current
   *  branch. It is `null` where any of the listings behind it failed. */
  readonly candidates: number | null
}

/** One form or the other. This code writes both forms out. It does not
 *  add a suffix, because the two call sites below need `commits` and
 *  `branches`. */
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many)

/**
 * The count lines that a status carries, in order. A count of zero gets no
 * line.
 *
 * Both counts are as of the last fetch. The closing line of the message
 * says this once, rather than each line saying it again. The word
 * "candidates" is deliberate: ancestry cannot see a squash merge. Only
 * `/gh:sync` decides that, with the merged pull request list. So this
 * message must not claim that any of them will go.
 */
export const countLines = (status: BranchStatus): string[] => {
  const lines: string[] = []
  if (status.behind !== null && status.behind > 0) {
    lines.push(
      `Local '${status.target}' is ${status.behind} ${plural(status.behind, 'commit', 'commits')} behind 'origin/${status.target}'.`,
    )
  }
  if (status.candidates !== null && status.candidates > 0) {
    lines.push(
      `Prunable candidates: ${status.candidates} local ${plural(status.candidates, 'branch', 'branches')} with a gone upstream or already merged into '${status.target}'.`,
    )
  }
  return lines
}

/**
 * This is the in-repo message. It states what is true of this checkout,
 * then what acts on it.
 *
 * This message is deterministic and computed here. It is never a request
 * that asks the agent something (#110). The same text goes out as
 * `systemMessage`, where a user reads it as the agent speaking. An
 * imperative addressed to the agent would read to that user as a question
 * they must answer.
 *
 * The first line is the Python's own line, unchanged. After it comes one
 * count line for each count above zero. Then come two closing lines that
 * state the dry run and the command, as facts, once each. When neither
 * count is above zero, the message is only those three lines.
 *
 * The closing lines name what each command is for. They claim no outcome
 * for this checkout. `/gh:sync` has three possible answers for the default
 * branch, not one. It can fast-forward the branch.
 *
 * It can CREATE the branch, where no local branch of that name exists.
 * This is the state that the captured `origin-head-wins` row shows. Or it
 * can refuse
 * the branch as diverged (`sync-repo.ts`, "needs a manual merge"). The
 * Python version hedged the fast-forward case inside a question to the
 * agent. To state it flatly here would be a claim this message cannot
 * check locally. `--dry-run`, named in the line above, is what reports the
 * real answer for this repository.
 */
export const branchMessageText = (status: BranchStatus): string =>
  `${[
    `This session started on branch '${status.current}'; the repository's default branch is '${status.target}'.`,
    ...countLines(status),
    'These are local refs, as of the last fetch. /gh:sync --dry-run reports what would change here,',
    `including what it would do with '${status.target}'; /gh:sync makes those changes.`,
  ].join('\n')}
`

/** What the fan-out found, one number per bucket. The buckets do not
 *  partition the repositories. The summary line does not read as if they
 *  do: a repository can be both skipped and not fully checked. */
export interface FanOutSummary {
  /** Sections in the report. One section exists per repository the fan-out
   *  ran. */
  readonly checked: number
  readonly upstream: number
  readonly prunable: number
  readonly skipped: number
  readonly unchecked: number
}

/** The indent that every line of a repository's section carries. The
 *  heading above them does not carry it. {@link REPORT}'s three marks open
 *  with this indent. */
const INDENT = '  '

/**
 * This function splits a report into its repository sections. Each section
 * is its own group of lines.
 *
 * This code reads structure, not a match on any heading. A line at the
 * left margin opens a section. The indented lines under it belong to that
 * section. The first line is dropped by position: it is the fan-out's own
 * header. `sync.ts` writes that header, and no repository does.
 *
 * This code uses `split('\n')`, not Python's line boundaries. `sync` wrote
 * this text, and `sync` ends every line with exactly `\n`. A checkout
 * directory whose name holds a `\u2028` character would split under
 * `splitlines`. The report itself does not split there. That mismatch
 * would invent a section that does not exist.
 *
 * A directory whose name begins with two spaces would be read as a mark
 * line of the section above it. Its lines would then count against the
 * previous repository. The repository count would then be one short. This
 * code leaves that case unhandled. The alternative is to match the heading
 * against the paths that discovery found. That approach reads the same
 * text a second time.
 */
const sectionsOf = (report: string): string[][] => {
  const sections: string[][] = []
  let current: string[] | undefined
  for (const line of report.split('\n').slice(1)) {
    if (line === '') continue
    if (line.startsWith(INDENT)) current?.push(line)
    else {
      current = []
      sections.push(current)
    }
  }
  return sections
}

/** Whether any line opens with the bad mark and then `opening`. */
const hasBad = (lines: readonly string[], opening: string): boolean =>
  lines.some((line) => line.startsWith(`${REPORT.bad}${opening}`))

/** Whether any line opens with the note mark and then any of `openings`. */
const hasNote = (lines: readonly string[], openings: readonly string[]): boolean =>
  lines.some((line) => openings.some((opening) => line.startsWith(`${REPORT.note}${opening}`)))

/**
 * The counts for one report. This code reads them off the marks that
 * `sync-repo.ts` exports.
 *
 * The hook's own child always runs `--dry-run`, so this code counts the
 * `would ...` half of the vocabulary. A bad mark that is not a skip means
 * something went wrong for that repository. This includes the line that
 * `sync.ts` writes for a job that threw an error or answered non-zero
 * (#81). That run is counted here, rather than lost between the report and
 * the summary above it. A note that opens with `could not` is counted too.
 * This way, a repository that fell back to ancestry alone is never
 * summarised as all clear.
 */
export const fanOutSummary = (report: string): FanOutSummary => {
  const sections = sectionsOf(report)
  const counts = { checked: sections.length, upstream: 0, prunable: 0, skipped: 0, unchecked: 0 }
  for (const lines of sections) {
    if (hasNote(lines, [REPORT.wouldFastForward, REPORT.wouldCreate])) counts.upstream += 1
    if (hasNote(lines, [REPORT.wouldDelete, REPORT.wouldRemoveWorktree])) counts.prunable += 1
    if (hasBad(lines, REPORT.skipped)) counts.skipped += 1
    const failed = lines.some(
      (line) => line.startsWith(REPORT.bad) && !line.startsWith(`${REPORT.bad}${REPORT.skipped}`),
    )
    if (failed || hasNote(lines, [COULD_NOT])) counts.unchecked += 1
  }
  return counts
}

/**
 * The one line that opens the fan-out message, or `null` when this function
 * finds no repository in the report.
 *
 * A report only reaches here once {@link ACTIONABLE} has found a line worth
 * a mention. So the report body is never empty. A count of zero sections
 * over a body that has content means one thing. The body's shape does not
 * match what the counting logic assumes (`sectionsOf`'s heading and
 * indent). It does not mean that nothing was checked.
 *
 * A line of zeros above a report that says otherwise would be a
 * confident, wrong statement. This message exists so a reader can trust
 * its statements. The report itself still goes out whole, without a
 * summary.
 */
export const summaryLine = (counts: FanOutSummary): string | null =>
  counts.checked === 0
    ? null
    : `${counts.checked} ${plural(counts.checked, 'repository', 'repositories')} checked: ` +
      `${counts.upstream} with upstream changes, ${counts.prunable} with prunable branches, ` +
      `${counts.skipped} skipped, ${counts.unchecked} not fully checked.`

/**
 * The fan-out message: the summary, the report, and what acts on the
 * report.
 *
 * `summary` is `null` when there is nothing to summarise. This covers two
 * cases. The first case is a body that this hook wrote itself, not one
 * that `sync` reported. That body can be a bound that fired, or a run
 * that left no report at all.
 *
 * The second case is a report where no repository could be counted.
 * Neither case counts any repository. A line of zeros above them would
 * falsely claim a check that never happened, or one that was not read.
 */
export const reportMessageText = (report: string, summary: string | null): string =>
  `A read-only /gh:sync check ran for the repositories below. No branch, worktree, or working tree
was changed (it does fetch, so remote-tracking refs are current).
${summary === null ? '' : `${summary}\n`}
${report}

/gh:sync applies this for real.
`

/** The four counts the line can show, each summed over every repository. */
export interface StatusCounts {
  readonly behind: number
  readonly prune: number
  readonly dependencies: number
  readonly alerts: number
}

/**
 * The status line, or `null` when there is nothing to show. This is the
 * only place that shapes the line.
 *
 * A zero count is left out. The repository count follows the prefix only
 * when there is more than one repository. The warning comes last, and
 * shows that an item failed or did not finish in time.
 */
export const statusLine = (
  counts: StatusCounts,
  repoCount: number,
  failed: boolean,
): string | null => {
  const items: string[] = []
  if (counts.behind > 0) items.push(`[behind ${counts.behind}]`)
  if (counts.prune > 0) items.push(`[prune ${counts.prune}]`)
  if (counts.dependencies > 0) items.push(`[🤖 ${counts.dependencies}]`)
  if (counts.alerts > 0) items.push(`[🛡️ ${counts.alerts}]`)
  if (failed) items.push('⚠️')
  if (items.length === 0) return null
  return `gh:${repoCount > 1 ? ` ${repoCount} repos` : ''} ${items.join(' ')}`
}

/**
 * A github.com remote URL, in each form git accepts. The first half is the
 * URL form with a scheme, an optional user, and an optional port. The second
 * half is the scp form, `[user@]github.com:`. Owner and name each hold only
 * the characters GitHub allows, so the two parts can go into a query as text.
 */
const GITHUB_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::[0-9]+)?\/|(?:[^@/:]+@)?github\.com:)([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i

/** `owner/name` for a github.com remote URL, or `null` for any other URL. */
export const githubRepository = (url: string): string | null => {
  const match = GITHUB_URL.exec(url)
  return match === null ? null : `${match[1]}/${match[2]}`
}

export const USAGE = 'usage: hook-io.ts {session-start|cwd|branch <current> <default>|report}\n'

/**
 * This function writes one string the way Python's `json.dumps` writes it,
 * with `ensure_ascii=True`.
 *
 * `JSON.stringify` already escapes the same control characters with the
 * same short forms (`\b \f \n \r \t`, `\u00XX` for the rest). It uses the
 * same quote and backslash too. What it does not do is escape anything
 * above `~`. That is the whole of what `ensure_ascii` does. Python's
 * `ESCAPE_ASCII` is `[^ -~]`, so `\x7f` is escaped too. An astral character
 * is escaped as the two surrogates it is made of. That is exactly the
 * result when code escapes each UTF-16 code unit.
 *
 * The character class below is Python's `ESCAPE_ASCII`, verbatim. This
 * code applies it to what `JSON.stringify` has already written. At that
 * point, it matches only what is left above `~`. Every control character
 * is by then already a `\uXXXX` form or a short form, in ASCII.
 */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(
    /[^ -~]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/**
 * This function builds one SessionStart hook response, byte for byte.
 *
 * `additionalContext` reaches the model's context only. It surfaces only
 * once the model takes a turn. A user's first input can pre-empt that
 * turn: they may already run the command this hook would have suggested.
 * That user never sees it at all. `systemMessage` is rendered directly by
 * the CLI,
 * whether or not the model ever takes a turn. So this code sends the same
 * text both ways (`.claude/rules/path-hooks.md`).
 *
 * This code writes the response out directly. It does not hand it to
 * `JSON.stringify`. The key order, the `", "` between members, and the
 * `": "` after a key are `json.dump`'s defaults. `JSON.stringify` writes
 * none of them. The trailing newline matches the Python's own
 * `sys.stdout.write("\n")`.
 */
export const emit = (context: string): string =>
  `{"systemMessage": ${asciiJson(context)}, "hookSpecificOutput": ` +
  `{"hookEventName": ${asciiJson(HOOK_EVENT)}, "additionalContext": ${asciiJson(context)}}}\n`

/**
 * The `cwd` field of a SessionStart payload, or `""` when there is none to
 * read.
 *
 * A malformed payload is not an error worth a failure. The caller falls
 * back to its own working directory. The hook must never block a session
 * over this. A `cwd` that is not a string is treated as absent, not
 * coerced. The only thing this code does with it is a directory test.
 * There, a number would be read as something else entirely.
 *
 * `Array.isArray` answers the half of the question that `typeof` cannot.
 * Python's guard is `isinstance(payload, dict)`. A JSON array decodes to a
 * Python `list`, which is not a dict, but `typeof [] === 'object'` in
 * JavaScript.
 */
export const payloadCwd = (text: string): string => {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return ''
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
  const value = (payload as Record<string, unknown>).cwd
  return typeof value === 'string' ? value : ''
}

/**
 * This code reads `float(raw)` the way Python reads it, or answers `null`
 * where Python raises ValueError.
 *
 * This is not `Number(raw)`, which answers differently for four inputs,
 * each named in the captured `syncTimeout` table. `Number("")` is 0, not
 * an error. `Number("0x10")` is 16, not an error. `Number("1_000")` is an
 * error, not 1000. `Number("inf")` is an error, not infinity. A bound
 * misread in either direction decides how long a session start waits, so
 * this code writes out its own grammar.
 *
 * Underscores are Python's digit separators. They may sit only between
 * digits. This is why the code validates them here and strips them
 * afterward. It does not strip them first.
 */
const PYTHON_SPECIAL = /^[+-]?(?:inf(?:inity)?|nan)$/i
const PYTHON_DECIMAL =
  /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/

/**
 * What `float()` skips at each end. This is not what `str.strip()` strips,
 * and not what JavaScript's `trim()` trims.
 *
 * Three sets of whitespace characters are at work in this file, and no two
 * are the same. `float()`'s set is `str.strip()`'s set (below), minus the
 * four information separators. `float` refuses those separators:
 * `float("\u001c5")` raises an error, where `"\u001c5".strip()` gives
 * `"5"`. JavaScript's `trim()` set is `float()`'s set, minus NEL, plus
 * `\ufeff`. So `trim()` diverges from `float()` in both directions at
 * once. `float("\u00855")` gives 5.0, where `trim` leaves the NEL in place
 * and the grammar below refuses the string.
 *
 * `float("\ufeff5")` raises an error, where `trim` eats the byte-order
 * mark and the grammar below accepts the string. Both readings decide how
 * long a session start waits for the fan-out. A byte-order mark is what a
 * pasted or generated value often carries. So this code writes out its own
 * set. It does not borrow `trim()`'s set.
 */
const PYTHON_FLOAT_SPACE_CLASS =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PYTHON_FLOAT_SPACE = new RegExp(
  `^[${PYTHON_FLOAT_SPACE_CLASS}]+|[${PYTHON_FLOAT_SPACE_CLASS}]+$`,
  'g',
)

export const pythonFloat = (raw: string): number | null => {
  const text = raw.replace(PYTHON_FLOAT_SPACE, '')
  if (PYTHON_SPECIAL.test(text)) {
    const magnitude = text.toLowerCase().endsWith('nan') ? Number.NaN : Number.POSITIVE_INFINITY
    return text.startsWith('-') ? -magnitude : magnitude
  }
  if (!PYTHON_DECIMAL.test(text)) return null
  return Number(text.replace(/_/g, ''))
}

/**
 * The fan-out's budget in seconds: {@link SYNC_TIMEOUT}, or the value from
 * the override.
 *
 * The environment override exists so a test can reach the timeout arm and
 * not wait out the real bound. Anything unparseable, or not positive,
 * falls back to the default. It does not become an error. This is a hook,
 * and a stray value in the environment must never be the thing
 * that decides a session. `NaN > 0` and `-inf > 0` are both false, so both
 * fall back to the default. This is what Python does with the same
 * comparison.
 */
export const syncTimeout = (env: NodeJS.ProcessEnv): number => {
  const value = pythonFloat(env[SYNC_TIMEOUT_ENV] ?? '')
  if (value === null) return SYNC_TIMEOUT
  return value > 0 ? value : SYNC_TIMEOUT
}

/**
 * This is `format(value, "g")`, for the one number the timeout line
 * prints.
 *
 * This matches C's `%g` with precision 6, which is Python's `g`
 * presentation type. It uses exponent notation when the exponent is below
 * -4 or at least 6, and fixed notation otherwise. Either way, it removes
 * trailing zeros. An exponent always gets at least two digits and a sign.
 * So this writes `50`, not `50.000000`, and `1.23457e+06`, not `1234567`.
 *
 * Only a positive number reaches this function, because
 * {@link syncTimeout} answers with one. Infinity is the one non-finite
 * value it can answer with, through an override of `inf`.
 */
const trimZeros = (text: string): string =>
  text.replace(/(\.[0-9]*[1-9])0+$/, '$1').replace(/\.0*$/, '')

export const formatG = (value: number): string => {
  if (value === Number.POSITIVE_INFINITY) return 'inf'
  const exponential = value.toExponential(5)
  const exponent = Number(exponential.slice(exponential.indexOf('e') + 1))
  if (exponent < -4 || exponent >= 6) {
    const mantissa = exponential.slice(0, exponential.indexOf('e'))
    const sign = exponent < 0 ? '-' : '+'
    return `${trimZeros(mantissa)}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  return trimZeros(value.toFixed(5 - exponent))
}

/**
 * The status that Python's `returncode` carries for a child that has
 * ended. This is its exit code, or the negative of the signal number that
 * killed it.
 *
 * node reports the two in separate fields, and it names the signal. It
 * does not number the signal. So the number comes from
 * `os.constants.signals`. The last arm can never arrive from a `close`
 * event, which always carries one of the two values. That arm answers for
 * a child that neither exited nor received a signal. Code reaches that arm
 * only when a caller sets both arguments.
 */
export const returnCode = (status: number | null, signal: NodeJS.Signals | null): number => {
  if (status !== null) return status
  if (signal !== null) return -osConstants.signals[signal]
  return 0
}

/** The characters that Python counts as whitespace and as line
 *  boundaries, above the ones JavaScript agrees on. The file, group, and
 *  record separators are both: Python splits lines on them and strips
 *  them. The unit separator and NEL are added where each belongs. This
 *  code writes them as a string and builds the regex with `new RegExp`.
 *  It does not use a literal, because biome's
 *  `suspicious/noControlCharactersInRegex` refuses the literal form. The
 *  rule is right about the usual case. These characters are here on
 *  purpose, and the answer is to say so, not to silence the rule. */
const SEPARATORS = '\\u001c-\\u001e'

/** Python's line boundaries, for `str.splitlines`, which is what
 *  `last_line` split on. These are `\r\n` as one boundary, then the five
 *  other ASCII boundaries, and the three above them (`\u0085`, `\u2028`,
 *  `\u2029`). To split on `\n` alone would keep a carriage return inside
 *  a line. The
 *  text this reads is a child's stderr, where git and gh write their
 *  progress with a carriage return. `\u001f` is whitespace to Python, not
 *  a line boundary, so it is absent here and present below instead. */
const PYTHON_LINES = new RegExp(`\\r\\n|[\\n\\r\\v\\f${SEPARATORS}\\u0085\\u2028\\u2029]`)

/** Python's `str.strip()` set. Python's `str.isspace()` set is
 *  JavaScript's whitespace set, plus the four information separators and
 *  NEL, and minus `\ufeff`. So `trim()` reads a line holding only a file
 *  separator as having content, where Python reads that line as blank.
 *  This code builds the set from {@link PYTHON_FLOAT_SPACE_CLASS}, rather
 *  than writing it out a second time. The only difference between what
 *  `strip()` strips and what `float()` skips is the four separators plus
 *  the unit separator beside them. */
const PYTHON_SPACE_CLASS = `${PYTHON_FLOAT_SPACE_CLASS}${SEPARATORS}\\u001f`
const PYTHON_SPACE = new RegExp(`^[${PYTHON_SPACE_CLASS}]+|[${PYTHON_SPACE_CLASS}]+$`, 'g')

/** The last line of `text` with anything in it, stripped, or `""`. */
export const lastLine = (text: string): string => {
  // This code reverses the array. It does not walk the array by index. An
  // index read gives `string | undefined` under
  // `noUncheckedIndexedAccess`. The fallback for that type would be a
  // branch that `split` can never actually produce.
  for (const line of text.split(PYTHON_LINES).reverse()) {
    const trimmed = line.replace(PYTHON_SPACE, '')
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** Whether `target` is a directory. This reads every reason it is not as
 *  the same answer, the way `os.path.isdir` does. */
const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether `target` can be read, the port of `os.access(SYNC, os.R_OK)`. */
const isReadable = (target: string): boolean => {
  try {
    accessSync(target, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * This finds `tool` on `env.PATH`, or answers `null`, the way
 * `shutil.which` answers it.
 *
 * This is a PATH walk, not a run. The Python asks `shutil.which("git")`,
 * and the answer decides which of the hook's two branches runs. So a
 * `git` that is on PATH but not executable must answer "not on PATH" here
 * too, as it does there. `discover.ts`'s `gitUnavailable` asks a different
 * question: it runs git. It gives a different answer for the same state.
 *
 * A directory is not a match, for the reason `harness/sandbox.ts` gives.
 * The executable bit on a directory is its traverse bit. So without this
 * check, a PATH entry that holds a directory named `git` would be found as
 * if it were git.
 */
export const which = (tool: string, env: NodeJS.ProcessEnv): string | null => {
  const listed = env.PATH ?? ''
  // This is `shutil.which`'s own `if not path: return None`. Without this
  // check, the empty string splits into one entry, itself empty.
  // `path.join('', tool)` then gives the bare name, and `accessSync`
  // resolves it against the process's own working directory.
  //
  // A session opened in a directory that holds an executable named `git`
  // would then be told git is on PATH. The Python said it was not on
  // PATH. The silent arm would then become a "could not" line. An empty
  // entry
  // INSIDE a non-empty PATH is a different question, left alone here,
  // because `shutil.which` also looks a bare name up in the working
  // directory in that case.
  if (listed === '') return null
  for (const directory of listed.split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isDirectory()) return candidate
    } catch {
      // Not here, or not executable. Check the next directory.
    }
  }
  return null
}

/** The edges the hook is built from: everything it reads that is not a
 *  file and not git. */
export interface HookEdges {
  /** This process's own working directory, as a call rather than a fixed
   *  value. `os.getcwd()` raises an error on a directory that has been
   *  deleted. The outermost handler in the entry point answers that error.
   *  This function is called only when the payload has no usable `cwd`. */
  readonly cwd: () => string
  readonly env: NodeJS.ProcessEnv
  /** Everything on stdin, decoded. This is a call rather than a fixed
   *  value, because two of the four subcommands never read it. A
   *  `--help`-shaped run must not block on a descriptor that nobody writes
   *  to (round 5's finding on #156). */
  readonly stdin: () => Promise<string>
  readonly output: Output
  /** The runner that starts the one bounded child. This is injected so the
   *  timeout arm is reachable, and a test need not wait out a real time
   *  bound. git is never injected and never mocked (ADR 001). */
  readonly run: Runner
  /** The interpreter that starts the child: this process's own
   *  interpreter, the way the Python used `sys.executable`, and for the
   *  same reason. */
  readonly nodePath: string
  /** `<plugin root>/scripts/gh.ts`, computed once by the entry point. */
  readonly entry: string
}

/**
 * What the fan-out produced.
 *
 * `report` is `sync`'s own report, whole. `degraded` is a sentence this
 * hook wrote itself, about a run that produced no report. This code keeps
 * the two apart as data. It does not read the text back later to tell them
 * apart. The hook wrote the `degraded` sentence itself, so it
 * already knows which kind it has. That distinction is what decides
 * whether there is anything to summarise.
 */
type SyncOutcome =
  | { readonly kind: 'report'; readonly text: string }
  | { readonly kind: 'degraded'; readonly text: string }

/** What the fan-out is worth as a report, or `null` when it is worth
 *  nothing. */
const FAILED_LINE = (detail: string): string => `could not run the sync check: ${detail}`

const TIMEOUT_LINE = (seconds: string, count: number, cwd: string): string =>
  `could not finish the sync check within ${seconds} s (${count} repositories under ${cwd})`

/**
 * How many repositories the fan-out covered.
 *
 * This is the same discovery that `sync` does, so the number in the
 * timeout message is the one `sync` used. Any failure answers 0. This
 * number is one detail inside a message about a different failure, and it
 * must not become a second failure. `hook-io.py:264` caught every
 * exception that discovery could raise, for that reason. Discovery mostly
 * answers with an outcome here instead, and every outcome except `ok`
 * gives the same zero.
 *
 * NOT every case gives zero cleanly, though. `src/discover.ts` calls
 * `realpathSync` without a guard, after its own directory test. It does
 * this in both of its two places: for the target, and again for each
 * subdirectory it walks. node throws there, where Python's non-strict
 * `os.path.realpath` never did. So a directory removed between the two
 * calls still escapes as a rejection.
 *
 * The guard belongs at discovery's own edge, at both sites, not here.
 * This is recorded as a follow-up on `src/discover.ts`. Meanwhile, the
 * outermost handler in `hooks/hook-io.ts` keeps the session safe.
 */
export const repoCount = async (cwd: string, env: NodeJS.ProcessEnv): Promise<number> => {
  const discovered = await discoverRepos(cwd, env)
  return discovered.outcome === 'ok' ? discovered.roots.length : 0
}

/**
 * The dry-run fan-out's report, or a one-line account of a degraded run.
 *
 * This runs one bounded child, started detached by {@link Runner}, so the
 * time bound can be made to stick. `sync` now fans out inside this one
 * process, but it still runs one fetch per repository. If only the child
 * were killed, those fetches would continue against the network long
 * after the session moved on. This is the port of `hook-io.py`'s
 * `Popen(start_new_session=True)` plus `kill_group`. `lib/process.ts`
 * carries both parts.
 *
 * **The child does NOT get a working directory.** The Python's `Popen`
 * inherited the hook's own working directory, and the target reached the
 * child as its positional argument instead. To name the target as the
 * child's `cwd` would read as the more explicit form, but it is a
 * behaviour change. A directory that cannot be entered (mode 000, which
 * `tests/plugins/gh/fixtures/hook-output.json` captures) would then give a child that could
 * not start, and a hook that says nothing. Today, instead, the child runs,
 * refuses the directory in its own words, and the session gets that
 * sentence.
 */
const runSync = async (cwd: string, edges: HookEdges): Promise<SyncOutcome | null> => {
  const env = scrubRepositoryEnv(edges.env)
  const seconds = syncTimeout(edges.env)
  const milliseconds = seconds * 1000
  const result = await edges.run(
    edges.nodePath,
    [edges.entry, 'sync', '--dry-run', '--no-install', cwd],
    {
      env,
      // Above the timer ceiling, there is no bound at all. This is what
      // `communicate(timeout=float("inf"))` does.
      ...(milliseconds > MAX_TIMER_MS ? {} : { timeoutMs: milliseconds }),
    },
  )
  if (result.startFailure !== null) {
    // The entry point was readable, and the child still would not start.
    // This can mean a partial install, or a machine out of processes.
    // There is nothing to say about it here.
    return null
  }
  if (result.timedOut) {
    return {
      kind: 'degraded',
      text: TIMEOUT_LINE(formatG(seconds), await repoCount(cwd, env), cwd),
    }
  }
  if (result.status !== 0) {
    // This is the child's own diagnosis, kept whole for the debug log.
    // The session gets only one line, because a person reads that line.
    const text = result.stderr
    edges.output.err.write(text.endsWith('\n') || text === '' ? text : `${text}\n`)
    // #81 (found when this function was read for round 7 layer 2).
    // `sync` now answers a non-zero status when one of its own
    // repositories fails. It answers this way AFTER it writes the whole
    // report to stdout, exactly as it does for a clean run.
    //
    // To fall straight to `FAILED_LINE` here would throw that report
    // away. It would also say something strictly less true: "could not
    // run the sync check". That check ran to completion and found a real
    // problem. So this code reads a non-zero status with a report still
    // on stdout the same way it reads a zero status.
    //
    // Only a run that left NO report at all falls through to the line
    // below. That means a crash before a byte reached stdout, or a
    // refusal, whose stdout is empty by `lib/envelope.ts`'s own contract.
    //
    // `result.signal === null` is also required here (round 7 layer 2,
    // review round 1 finding). `result.timedOut` above only catches the
    // case where the hook's OWN bound fires. So a non-null signal that
    // reaches here is an EXTERNAL kill, such as an OOM kill or a stray
    // `SIGTERM`. It does not mean `sync` answered `failed(...)`.
    //
    // On the single-repository path, `sync` hands `syncRepo` the real
    // stdout directly. `syncRepo` writes its report line by line, across
    // several awaited git and `gh` calls. So a kill mid-run can leave a
    // genuinely partial report on stdout, with no closing statement and a
    // non-zero status. `result.stdout !== ''` alone cannot tell that
    // partial report apart from a complete `failed(...)` report.
    //
    // A throw inside `syncRepo` cannot produce this partial state.
    // `sync.ts`'s `try`/`catch` around the whole job always appends a
    // closing failure line before it returns `failed(...)`. So a signal
    // death is exactly the case this gate exists FOR.
    //
    // A signal death is not the only way to reach this state (review
    // round 2 finding). `lib/streams.ts`'s `createWriter` re-throws
    // anything on the stream that is not `EPIPE` (such as `ENOSPC` or
    // `EIO`). That throw fires from a stream `error` event. It fires
    // outside `sync.ts`'s `try`/`catch`, at any depth of nested blocks. A
    // real write failure on the child's actively-drained stdout pipe would
    // crash it the same way, with `signal` still `null`. That case is
    // narrower than a signal death: it is a disk error, not a reader that
    // leaves.
    //
    // The re-throw itself lives in `lib/streams.ts`, a lower layer that
    // this gate cannot see into. This comment records that case. It does
    // not guard against it.
    if (result.signal === null && result.stdout !== '') {
      return { kind: 'report', text: result.stdout }
    }
    // This code uses `||`, not `??`. A child that fails without a word
    // leaves `""` here, and `""` is exactly what the exit-status fallback
    // exists for.
    const detail = lastLine(text) || `exit status ${returnCode(result.status, result.signal)}`
    return { kind: 'degraded', text: FAILED_LINE(detail) }
  }
  return { kind: 'report', text: result.stdout }
}

/**
 * The fan-out message, or `null` when the dry run found nothing to report.
 *
 * A degraded run goes back through this same path, rather than around it.
 * "could not" is already the vocabulary that `sync` uses to report a
 * lookup it could not make. {@link ACTIONABLE} already treats that
 * vocabulary as worth a mention.
 */
const reportMessage = async (cwd: string, edges: HookEdges): Promise<string | null> => {
  if (!isReadable(edges.entry)) {
    edges.output.err.write(`missing ${edges.entry}\n`)
    return null
  }
  const outcome = await runSync(cwd, edges)
  if (outcome === null) return null
  if (!ACTIONABLE.some((marker) => outcome.text.includes(marker))) return null
  const body = outcome.text.replace(/\n+$/, '')
  return reportMessageText(
    body,
    outcome.kind === 'report' ? summaryLine(fanOutSummary(body)) : null,
  )
}

/**
 * The repository's default branch. This code resolves it without a trip
 * to the network.
 *
 * This code checks the cached `origin/HEAD` first. Where a clone never
 * fetched one, it falls back to the first of `main` and `master` that
 * exists locally. To ask the remote would mean a round trip on every
 * session start. That round trip is exactly what the in-repo branch of
 * this hook exists to avoid.
 */
const localDefaultBranch = async (options: RepoOptions): Promise<string | null> => {
  const ref = await defaultBranch(options)
  // This is Python's `if ref:`. A ref read as the empty string counts as
  // no ref. `lib/git.ts`'s `defaultBranch` already folds that case in.
  if (ref !== null) return ref
  for (const candidate of ['main', 'master']) {
    if (await hasRef(`refs/heads/${candidate}`, options)) return candidate
  }
  return null
}

/** The two namespaces that the count lookups name in full. `--merged main`
 *  would accept a tag named `main` just as happily as the branch. The
 *  default branch here is always a local branch name, or nothing. */
const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const ORIGIN = `${REMOTES}origin/`

/** The field separator that the local branch listing is read back with.
 *  git refuses an ASCII control character in a ref name (`git
 *  check-ref-format`), so a tab cannot appear in either field. The split
 *  is unambiguous. */
const FIELD = '\t'

/**
 * A branch's own name, stripped of `refs/heads/` mechanically.
 *
 * This is NOT `%(refname:short)`, which gives the shortest UNAMBIGUOUS
 * name. A tag named after a branch makes git answer `heads/<name>` for the
 * branch instead. But the names this is compared against (`currentBranch`,
 * `localDefaultBranch`) are plain names. So the default branch would
 * survive both deletion checks below. It would get reported as a prunable
 * candidate, in a repository whose only oddity is a release tag.
 * `lstrip=2` removes exactly two path components, whatever else exists, so
 * `refs/heads/a/b/c` becomes `a/b/c`.
 */
const SHORT = '%(refname:lstrip=2)'

/**
 * `git rev-list --count`'s answer, or `null` for anything that is not a
 * count.
 *
 * `null` means git failed. This is how a missing ref, on either end of the
 * range, arrives (status 128). The empty string is the other shape a
 * `git` on PATH can take: it exits 0 with nothing to say. That empty
 * string is not a count. Reading it as zero would report "up to date"
 * about a question that was never answered.
 */
export const parseCount = (out: string | null): number | null => {
  if (out === null || !/^[0-9]+$/.test(out)) return null
  return Number(out)
}

/** How far the local default branch is behind the CACHED
 *  `origin/<target>`. This runs no fetch. The closing line of the message
 *  says the number is as of the last fetch (#110 ruling 4). */
const behindCount = async (target: string, options: RepoOptions): Promise<number | null> =>
  parseCount(
    await gitOut(['rev-list', '--count', `${HEADS}${target}..${ORIGIN}${target}`], options),
  )

/**
 * How many local branches are safe to prune, or `null` when a ref listing
 * could not be read.
 *
 * This function is pure. It takes the listings as arguments, so every way
 * it can end is reachable from a test with no git at all.
 *
 * - `branches` is `name<tab>upstream<tab>tip`, per local branch.
 * - `refs` is every ref under `refs/heads/` and `refs/remotes/`.
 * - `merged` is the local branches reachable from `origin/<target>`.
 * - `pulls` is the merged pull requests, or `null` when none were read.
 *
 * A branch counts when one of three rules holds:
 *
 * - Its upstream is set, and the ref it names is gone.
 * - It is merged into `origin/<target>`, and it tracks its own upstream. A
 *   new branch made from `origin/<target>` tracks that ref, and sits on its
 *   tip. That branch is new work, so it does not count.
 * - Its tip is the head of a merged pull request from this repository. This
 *   rule finds a squash merge, which ancestry cannot see.
 *
 * The default branch and the current branch never count.
 *
 * This code reads refs, not `%(upstream:track)`. Git translates the
 * `[gone]` text, so a session in another locale would find no gone
 * upstream at all.
 */
export const countCandidates = (
  branches: readonly string[] | null,
  refs: readonly string[] | null,
  merged: readonly string[] | null,
  pulls: readonly PullRequestRow[] | null,
  current: string,
  target: string,
): number | null => {
  if (branches === null || refs === null || merged === null) return null
  const existing = new Set(refs)
  const landed = new Set(merged)
  const own = ownRows(pulls ?? [])
  let count = 0
  for (const line of branches) {
    const [name = '', upstream = '', tip] = line.split(FIELD)
    if (name === current || name === target) continue
    const gone = upstream !== '' && !existing.has(upstream)
    const ancestry = landed.has(name) && upstream !== '' && upstream !== `${ORIGIN}${target}`
    // A line with no tip field has nothing to match a pull request against.
    const squashed = tip !== undefined && hasMatch(own, name, tip)
    if (gone || ancestry || squashed) count += 1
  }
  return count
}

/** The candidate count for one checkout, from three local ref listings. */
const prunableCandidates = async (
  current: string,
  target: string,
  pulls: readonly PullRequestRow[] | null,
  options: RepoOptions,
): Promise<number | null> => {
  const [branches, refs, merged] = await Promise.all([
    gitLines(
      ['for-each-ref', `--format=${SHORT}${FIELD}%(upstream)${FIELD}%(objectname)`, HEADS],
      options,
    ),
    gitLines(['for-each-ref', '--format=%(refname)', HEADS, REMOTES], options),
    gitLines(
      ['for-each-ref', `--format=${SHORT}`, '--merged', `${ORIGIN}${target}`, HEADS],
      options,
    ),
  ])
  return countCandidates(branches, refs, merged, pulls, current, target)
}

/**
 * The in-repo message, or `null` when there is nothing worth a report.
 *
 * There is nothing to say on a detached HEAD, because there is no branch
 * to compare. The same is true for a repository whose default branch
 * cannot be resolved locally. It is also true when the session already
 * started on the default branch. The fact that the session is off the
 * default branch is itself worth one line. So this code gathers the
 * counts only once that fact is established. On the silent paths, no
 * lookup runs at all.
 *
 * Every lookup here is local, and every one may answer with nothing (#110
 * ruling 4). A count that could not be read simply leaves its line out.
 * This is true of a failing git, a missing ref, an empty answer, or a
 * non-numeric answer. None of these can throw here, or cost the message
 * its first line.
 */
const branchMessage = async (options: RepoOptions): Promise<string | null> => {
  const current = await currentBranch(options)
  // This is Python's `if not current or current == "HEAD"`. `null` here
  // covers both git failing and git answering with nothing at all.
  // `lib/git.ts` folds those two cases together.
  if (current === null || current === 'HEAD') return null
  const target = await localDefaultBranch(options)
  if (target === null || target === current) return null
  return branchMessageText({
    current,
    target,
    behind: await behindCount(target, options),
    candidates: await prunableCandidates(current, target, null, options),
  })
}

/**
 * Everything on stdin, or `""` when this cannot read it at all.
 *
 * `hook-io.py:144` guards the READ, not only the parse. The `except
 * (ValueError, AttributeError, OSError, UnicodeDecodeError)` sits around
 * `json.load(sys.stdin)`. There, `OSError` means the descriptor failed,
 * not that the document was malformed. A hook whose stdin fails a read
 * answered `""` there, and still ran the whole check from `os.getcwd()`.
 * Without this guard, the hook would lose the whole check to a rejection
 * instead.
 *
 * One way to build this state is a descriptor 0 opened for writing.
 * `hook-io.ts session-start 0>/dev/null` leaves that state, and a read of
 * it answers `EBADF`. A descriptor on a directory answers `EISDIR` on
 * Linux, and reads as zero bytes on macOS. So it reaches the same fallback
 * by a different route, and it is not the example to reason from.
 *
 * `report` deliberately does not come through here. The Python's
 * `sys.stdin.read()`, in that arm, is not guarded the way the payload read
 * is, and it has no fallback report to write. That arm still sits inside
 * `main`'s `except BrokenPipeError` and the outermost handler, the way
 * this arm sits inside the entry point's handler. So a failure there
 * still ends in an account on stderr and exit 0.
 */
const readPayload = async (edges: HookEdges): Promise<string> => {
  try {
    return await edges.stdin()
  } catch {
    return ''
  }
}

/** The whole hook. It picks the branch that the payload's directory calls
 *  for, or it stays quiet. */
const sessionStart = async (edges: HookEdges): Promise<string | null> => {
  const stated = payloadCwd(await readPayload(edges))
  // This is Python's `if not cwd or not os.path.isdir(cwd)`. The empty
  // string here means a payload with no usable cwd, not a directory
  // named "".
  const cwd = stated !== '' && isDirectory(stated) ? stated : edges.cwd()
  if (which('git', edges.env) === null) {
    // Both branches need git. The in-repo check cannot ask what branch
    // this is, and `sync` refuses outright. Neither answer is worth a
    // line in a session's context, but both are worth one line in the
    // debug log.
    edges.output.err.write('git is not on PATH\n')
    return null
  }
  const options = { cwd, env: scrubRepositoryEnv(edges.env) }
  // This code uses `git_out`, not `toplevel`. The Python asks whether
  // the call FAILED (`is not None`). To the Python, a git that exits 0
  // and prints nothing still counts as inside a repository. `toplevel`
  // folds that empty answer into `null`, which is the right reading for
  // a caller that wants the root path. It is the wrong reading for a
  // caller that wants to know "did this succeed".
  if ((await gitOut(['rev-parse', '--show-toplevel'], options)) !== null) {
    return branchMessage(options)
  }
  return reportMessage(cwd, edges)
}

/**
 * The hook. It takes argv in and gives an exit status out.
 *
 * `session-start` is the mode that `hooks.json` runs. The other three
 * modes are the pieces that decision is built from. This code keeps them
 * as subcommands, because they are the seams that the tests use. A person
 * can also use them to debug the hook by hand.
 */
export const runHookIo = async (argv: readonly string[], edges: HookEdges): Promise<number> => {
  const [mode, current, target] = argv
  if (mode === 'session-start') {
    const message = await sessionStart(edges)
    // This is Python's `if message:`. Neither branch can answer with the
    // empty string today. Reading an empty string as silence is what the
    // Python does.
    if (message) edges.output.out.write(emit(message))
    return 0
  }
  if (mode === 'cwd') {
    edges.output.out.write(`${payloadCwd(await readPayload(edges))}\n`)
    return 0
  }
  // The two `typeof` guards come before the length check. Each guard is
  // tested against a command line that fails it: `branch` alone, and
  // `branch <one>`. The length check then refuses `branch <a> <b> <c>`.
  // Python's `len(argv) == 4` refuses that case too.
  if (mode === 'branch' && typeof current === 'string' && typeof target === 'string') {
    if (argv.length === 3) {
      // There is no repository to read here, so neither count has an
      // answer. This seam is given two names and nothing else.
      edges.output.out.write(
        emit(branchMessageText({ current, target, behind: null, candidates: null })),
      )
      return 0
    }
  }
  if (mode === 'report') {
    // This gives no summary. The seam only wraps a body it was handed. A
    // summary is a statement about a fan-out that this process ran.
    edges.output.out.write(emit(reportMessageText((await edges.stdin()).replace(/\n+$/, ''), null)))
    return 0
  }
  edges.output.err.write(USAGE)
  return 2
}
