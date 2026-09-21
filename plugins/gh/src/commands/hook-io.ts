// The gh plugin's SessionStart hook: the port of
// `plugins/gh/hooks/hook-io.py` (deleted at #127), whose docstring is the
// argument for everything below and is kept here rather than summarised.
//
// A report-only sync check at session start. It never changes a branch,
// worktree, or working tree: the fan-out branch runs
// `gh.ts sync --dry-run --no-install`, and the in-repo branch does not touch
// the network at all. The fan-out branch does fetch, which updates
// remote-tracking refs.
//
// It stays silent unless there is something worth acting on, because a hook
// that speaks every single time stops being read, and it always exits 0 on
// the `session-start` path, so nothing here can stop a session from starting.
// The `; exit 0` in `hooks.json` holds the same guarantee for the cases this
// file is never reached in at all: no node on PATH, or a hooks directory it
// was never installed into.
//
// Anything else (no subcommand, one that is not a subcommand, or `branch`
// without exactly two branch names) is the one path that answers with a usage
// message and exit 2: a typo in `hooks.json` is a wiring mistake, and a hook
// that swallowed it would be silent about the check it was supposed to run
// for the life of the install. `hooks.json`'s `; exit 0` absorbs the status,
// so the diagnostic that actually survives is the usage line on stderr, which
// Claude Code's debug log keeps. Nothing is written to stdout there, so the
// hook still contributes no context. stderr is where the other degraded runs
// leave their trace too, for the same reason: a missing entry point or a
// missing git is worth one line in the debug log and nothing at all in the
// session.
//
// **The acceptance of #127 is that this file's stdout is BYTE-IDENTICAL to
// the Python's on the same repository state.** Its stdout is a JSON document
// Claude Code parses, so key order, the `", "` and `": "` separators Python's
// `json.dump` writes, the `\uXXXX` escaping `ensure_ascii` applies, and the
// trailing newline are all contract; {@link emit} is where that lives, and
// `fixtures/hook-output.json` is the only thing the tests compare against.
//
// The three subcommands beside `session-start` are kept: they are the seams
// the tests and a human debugging the hook by hand work at, and retiring them
// would retire the usage-error contract with them.
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
import { REPORT } from './sync-repo.ts'

/** The event name the response names itself with. */
const HOOK_EVENT = 'SessionStart'

/** Only speak when the fan-out report contains something actionable: a
 *  proposed change ("would ..."), a problem ("✗"), or a degraded run
 *  ("could not ..."). A run whose merge lookups all failed has nothing to
 *  propose, and silence there would read as "everything is in order" rather
 *  than "nothing could be checked". */
const ACTIONABLE = ['would ', '✗', 'could not']

/** The hook's own budget is 60 seconds (`hooks.json`), so the fan-out has to
 *  be stopped with time left to say that it was. One fetch per repository is
 *  the slow part, and a directory of repositories against a remote that is
 *  answering slowly is exactly the case that runs over. */
export const SYNC_TIMEOUT = 50
export const SYNC_TIMEOUT_ENV = 'GH_HOOK_SYNC_TIMEOUT'

/** `setTimeout`'s ceiling. Above it node clamps to 1 ms and fires on the next
 *  tick, so a bound this large would kill the child immediately where
 *  `communicate(timeout=...)` waits. Anything over it is therefore no bound at
 *  all, which is what Python does with `float("inf")`. */
const MAX_TIMER_MS = 2_147_483_647

/** The variables that name a DIFFERENT repository than the one a call is
 *  about, removed from the environment every git call and the one child get.
 *
 *  `git rev-parse --local-env-vars` is this list, verbatim, plus `GH_REPO`,
 *  which is gh's equivalent. The Python inherited the whole environment,
 *  which was safe only because nothing ran it from inside a git hook; this
 *  hook is reached from a session Claude Code may have started anywhere, and
 *  `GIT_DIR` outranks both `cwd` and `git -C` for everything the git
 *  directory holds, so a session started from a `git commit` would be told
 *  about the hook's own repository rather than about the user's checkout.
 *  `lib/README.md` records this under "Decisions not taken" as the helper
 *  that reopens at this port, and says the same thing from the other side:
 *  naming an environment is not scrubbing it, and scrubbing belongs to the
 *  caller that knows which keys displace its target.
 *
 *  What is deliberately NOT removed is git's configuration discovery
 *  (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_CEILING_DIRECTORIES`),
 *  `HOME` and `PATH`: those choose which git and which configuration answer,
 *  which is the session's business and not this hook's, and taking them would
 *  change what the user's own `git` would have said. */
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

/** `env` without the keys that displace the repository a call names. A copy,
 *  never the object it was given. */
export const scrubRepositoryEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed: NodeJS.ProcessEnv = { ...env }
  for (const key of REPOSITORY_ENV_KEYS) delete scrubbed[key]
  return scrubbed
}

/** The word a lookup `sync` could not make opens with, in `sync-repo.ts`'s
 *  own vocabulary. Not a new dependency on its prose: it is {@link ACTIONABLE}'s
 *  third marker, which has decided whether this hook speaks at all since the
 *  Python. The trailing space is carried so the opening is the whole word and
 *  not the start of a longer one; it is matched with `startsWith` against a
 *  note line, never searched for inside one. */
const COULD_NOT = 'could not '

/** What one repository is worth saying about its checkout, all of it read from
 *  local refs (#110 ruling 4). */
export interface BranchStatus {
  /** The branch the session started on. */
  readonly current: string
  /** The repository's default branch, as far as the clone knows locally. */
  readonly target: string
  /** Commits the cached `origin/<target>` has that the local `<target>` does
   *  not, or `null` where that pair could not be counted. Zero and `null` both
   *  write no line and are deliberately different: only one of them is an
   *  answer. */
  readonly behind: number | null
  /** Local branches whose upstream is gone or that are already merged into
   *  `<target>`, never `<target>` and never the current branch; `null` where
   *  any of the listings behind it failed. */
  readonly candidates: number | null
}

/** One form or the other. Written out rather than suffixed, because the two
 *  call sites below need `commits` and `branches`. */
const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many)

/**
 * The count lines a status carries, in order, and none for a count of zero.
 *
 * Both counts are as of the last fetch, which the closing line of the message
 * says once rather than each line saying it again. `candidates` is the word
 * on purpose: ancestry cannot see a squash merge, and it is `/gh:sync` that
 * decides with the merged pull request list, so this message must not claim
 * that any of them will go.
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
 * The in-repo message: what is true of this checkout, then what acts on it.
 *
 * Deterministic and computed here, never a request for the agent to ask
 * something (#110). The same text goes out as `systemMessage`, where a user
 * reads it as the agent speaking, so an imperative addressed to the agent
 * reads to them as a question they have to answer.
 *
 * The first line is the Python's, unchanged. What follows it is a count line
 * per count that is above zero, and two closing lines that name the dry run
 * and the command, as facts, once each. With neither count above zero the
 * message is those three lines.
 */
export const branchMessageText = (status: BranchStatus): string =>
  `${[
    `This session started on branch '${status.current}'; the repository's default branch is '${status.target}'.`,
    ...countLines(status),
    'These are local refs, as of the last fetch. /gh:sync --dry-run reports the current state;',
    `/gh:sync moves to '${status.target}', fast-forwards it, and prunes branches whose work has landed.`,
  ].join('\n')}
`

/** What the fan-out found, one number per bucket. The buckets are not a
 *  partition and the line does not read as one: a repository can be both
 *  skipped and not fully checked. */
export interface FanOutSummary {
  /** Sections in the report, which is one per repository the fan-out ran. */
  readonly checked: number
  readonly upstream: number
  readonly prunable: number
  readonly skipped: number
  readonly unchecked: number
}

/** The indent every line of a repository's section carries, and the heading
 *  above them does not. {@link REPORT}'s three marks open with it. */
const INDENT = '  '

/**
 * A report's repository sections, each as its own lines.
 *
 * Structural rather than a match on any heading: a line at the left margin
 * opens a section and the indented lines under it belong to it. The first line
 * is dropped by position because it is the fan-out's own header, which
 * `sync.ts` writes and no repository does.
 *
 * `split('\n')` and not Python's line boundaries: this text is what `sync`
 * wrote, and `sync` ends every line with exactly `\n`. A checkout directory
 * whose name holds a `\u2028` would be split by `splitlines` where the report
 * itself is not, which would invent a section.
 *
 * A directory whose name begins with two spaces would be read as a mark line
 * of the section above it. Its lines would then be counted against the
 * previous repository, and the count of repositories would be one short. It is
 * left unhandled: the alternative is matching the heading against the paths
 * discovery found, which is a second reading of the same text.
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
 * The counts for one report, read off the marks `sync-repo.ts` exports.
 *
 * The hook's own child always runs `--dry-run`, so the vocabulary counted is
 * the `would ...` half of it. A bad mark that is not a skip is a repository
 * something went wrong for, which includes the line `sync.ts` writes for a job
 * that threw or answered non-zero (#81): that run is counted here rather than
 * disappearing between the report and the summary above it. A note that opens
 * with `could not` is counted too, so a repository that fell back to ancestry
 * alone is never summarised as all clear.
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

/** The one line the fan-out message leads with. */
export const summaryLine = (counts: FanOutSummary): string =>
  `${counts.checked} ${plural(counts.checked, 'repository', 'repositories')} checked: ` +
  `${counts.upstream} with upstream changes, ${counts.prunable} with prunable branches, ` +
  `${counts.skipped} skipped, ${counts.unchecked} not fully checked.`

/**
 * The fan-out message: the summary, the report, and what acts on it.
 *
 * `summary` is `null` where there is nothing to summarise, which is a body
 * this hook wrote itself rather than one `sync` reported: a bound that fired,
 * or a run that left no report at all. Those count no repositories, and a line
 * of zeros above them would be a claim about a check that never happened.
 */
export const reportMessageText = (report: string, summary: string | null): string =>
  `A read-only /gh:sync check ran for the repositories below. No branch, worktree, or working tree
was changed (it does fetch, so remote-tracking refs are current).
${summary === null ? '' : `${summary}\n`}
${report}

/gh:sync applies this for real.
`

export const USAGE = 'usage: hook-io.ts {session-start|cwd|branch <current> <default>|report}\n'

/**
 * One string as Python's `json.dumps` writes it with `ensure_ascii=True`.
 *
 * `JSON.stringify` already escapes the same control characters with the same
 * short forms (`\b \f \n \r \t`, `\u00XX` for the rest), and the same quote
 * and backslash. What it does not do is escape anything above `~`, which is
 * the whole of `ensure_ascii`: Python's `ESCAPE_ASCII` is `[^ -~]`, so `\x7f`
 * goes too, and an astral character is escaped as the two surrogates it is
 * made of, which is exactly what escaping each UTF-16 code unit produces.
 *
 * The class below is Python's `ESCAPE_ASCII` verbatim. Applied to what
 * `JSON.stringify` has already written, it matches only what is left above
 * `~`: every control character is by then a `\uXXXX` or a short form, in
 * ASCII.
 */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(
    /[^ -~]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/**
 * One SessionStart hook response, byte for byte.
 *
 * `additionalContext` is model-context-only: it surfaces only once the model
 * takes a turn, and a user whose first input pre-empts that turn (running the
 * very command this hook would have suggested) never sees it at all.
 * `systemMessage` is rendered directly by the CLI regardless of whether the
 * model ever takes a turn, so the same text goes out both ways
 * (`.claude/rules/path-hooks.md`).
 *
 * Written out rather than handed to `JSON.stringify`, because the key order,
 * the `", "` between members and the `": "` after a key are `json.dump`'s
 * defaults and `JSON.stringify` writes none of them. The trailing newline is
 * the Python's own `sys.stdout.write("\n")`.
 */
export const emit = (context: string): string =>
  `{"systemMessage": ${asciiJson(context)}, "hookSpecificOutput": ` +
  `{"hookEventName": ${asciiJson(HOOK_EVENT)}, "additionalContext": ${asciiJson(context)}}}\n`

/**
 * The `cwd` of a SessionStart payload, or `""` when there is not one to read.
 *
 * A malformed payload is not an error worth failing on: the caller falls back
 * to its own working directory, and the hook must never block a session. A
 * cwd that is not a string is treated as absent rather than coerced, because
 * the only thing done with it is a directory test, where a number would be
 * read as something else entirely.
 *
 * `Array.isArray` is the half `typeof` cannot answer: Python's guard is
 * `isinstance(payload, dict)`, and a JSON array decodes to a `list`, which is
 * not a dict, while `typeof [] === 'object'`.
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
 * `float(raw)` as Python reads it, or `null` where Python raises ValueError.
 *
 * Not `Number(raw)`, which answers for four inputs Python refuses or reads
 * differently and which the captured `syncTimeout` table names one by one:
 * `""` is 0 rather than an error, `"0x10"` is 16 rather than an error,
 * `"1_000"` is an error rather than 1000, and `"inf"` is an error rather than
 * infinity. A bound misread in either direction decides how long a session
 * start waits, so the grammar is written out.
 *
 * Underscores are Python's digit separators and may sit only between digits,
 * which is why they are validated here and stripped afterwards rather than
 * stripped first.
 */
const PYTHON_SPECIAL = /^[+-]?(?:inf(?:inity)?|nan)$/i
const PYTHON_DECIMAL =
  /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/

/**
 * What `float()` skips at each end, which is not what `str.strip()` strips and
 * not what `trim()` trims.
 *
 * Three sets are in play in this file and no two of them are the same.
 * `float()`'s is `str.strip()`'s (below) MINUS the four information separators,
 * which `float` refuses: `float("\u001c5")` raises where `"\u001c5".strip()`
 * is `"5"`. JavaScript's `trim()` is `float()`'s MINUS NEL PLUS `\ufeff`, so
 * `trim()` diverges in both directions at once: `float("\u00855")` is 5.0
 * where `trim` leaves the NEL and the grammar below refuses the string, and
 * `float("\ufeff5")` raises where `trim` eats the byte-order mark and the
 * grammar accepts it. Both readings decide how long a session start waits for
 * the fan-out, and a byte-order mark is what a pasted or generated value
 * carries, so the set is written out rather than borrowed.
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
 * The fan-out's budget in seconds: {@link SYNC_TIMEOUT}, or the override.
 *
 * The environment override exists so a test can reach the timeout arm without
 * waiting out the real bound. Anything unparseable or not positive is the
 * default rather than an error: this is a hook, and a stray value in the
 * environment must not be the thing that decides a session. `NaN > 0` and
 * `-inf > 0` are both false, so both land on the default, which is what
 * Python does with the same comparison.
 */
export const syncTimeout = (env: NodeJS.ProcessEnv): number => {
  const value = pythonFloat(env[SYNC_TIMEOUT_ENV] ?? '')
  if (value === null) return SYNC_TIMEOUT
  return value > 0 ? value : SYNC_TIMEOUT
}

/**
 * `format(value, "g")`, for the one number the timeout line prints.
 *
 * C's `%g` with precision 6, which is what Python's `g` presentation type is:
 * exponent notation when the exponent is below -4 or at least 6, fixed
 * notation otherwise, trailing zeros removed either way, and an exponent
 * written with at least two digits and always a sign. `50` rather than
 * `50.000000`, and `1.23457e+06` rather than `1234567`.
 *
 * Only a positive number reaches this, because {@link syncTimeout} answers
 * with one; infinity is the one non-finite value it can answer with, through
 * an override of `inf`.
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
 * The status Python's `returncode` carries for a child that has ended: its
 * exit code, or the negative of the signal number that killed it.
 *
 * node reports the two in separate fields and names the signal rather than
 * numbering it, so the number comes from `os.constants.signals`. The last arm
 * cannot arrive from a `close` event, which always carries one of the two;
 * it is the answer for a child that neither exited nor was signalled, and it
 * is reachable only by calling this function with both.
 */
export const returnCode = (status: number | null, signal: NodeJS.Signals | null): number => {
  if (status !== null) return status
  if (signal !== null) return -osConstants.signals[signal]
  return 0
}

/** The characters Python counts as whitespace and as line boundaries above
 *  the ones JavaScript agrees about. The file, group and record separators
 *  are both: Python splits lines on them and strips them. The unit separator
 *  and NEL are added where each belongs. Written as a string and composed
 *  with `new RegExp` rather than put in a literal, because biome's
 *  `suspicious/noControlCharactersInRegex` refuses the literal form, and the
 *  rule is right about the usual case: these are here on purpose and the
 *  answer is to say so, not to silence the rule. */
const SEPARATORS = '\\u001c-\\u001e'

/** Python's line boundaries for `str.splitlines`, which is what `last_line`
 *  split on: `\r\n` as one, then the five other ASCII ones and the three
 *  above them (`\u0085`, `\u2028`, `\u2029`). Splitting on `\n` alone would
 *  keep a carriage return inside a line, and the text this reads is a child's
 *  stderr, where git and gh write their progress with one. `\u001f` is
 *  whitespace to Python and not a line boundary, so it is absent here and
 *  present below. */
const PYTHON_LINES = new RegExp(`\\r\\n|[\\n\\r\\v\\f${SEPARATORS}\\u0085\\u2028\\u2029]`)

/** Python's `str.strip()` set. `str.isspace()` is JavaScript's whitespace plus
 *  the four information separators and NEL, and minus `\ufeff`, so `trim()`
 *  reads a line holding only a file separator as having something in it where
 *  Python reads it as blank. Composed from {@link PYTHON_FLOAT_SPACE_CLASS}
 *  rather than written out a second time: the only difference between what
 *  `strip()` strips and what `float()` skips is the four separators and the
 *  unit separator beside them. */
const PYTHON_SPACE_CLASS = `${PYTHON_FLOAT_SPACE_CLASS}${SEPARATORS}\\u001f`
const PYTHON_SPACE = new RegExp(`^[${PYTHON_SPACE_CLASS}]+|[${PYTHON_SPACE_CLASS}]+$`, 'g')

/** The last line of `text` with anything in it, stripped, or `""`. */
export const lastLine = (text: string): string => {
  // Reversed rather than walked by index: an index read is `string |
  // undefined` under `noUncheckedIndexedAccess`, and the fallback would be an
  // arm `split` can never produce.
  for (const line of text.split(PYTHON_LINES).reverse()) {
    const trimmed = line.replace(PYTHON_SPACE, '')
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** Whether `target` is a directory, reading every reason it is not as the
 *  same answer, the way `os.path.isdir` does. */
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
 * `tool` on `env.PATH`, or `null`, as `shutil.which` answers it.
 *
 * A PATH walk and not a run: the Python asks `shutil.which("git")` and the
 * answer decides which of the hook's two branches is taken, so a `git` that
 * is on PATH and not executable has to be "not on PATH" here as it is there.
 * `discover.ts`'s `gitUnavailable` asks the other question, by running git,
 * and gives a different answer for the same state.
 *
 * A directory is not a match, for the reason `harness/sandbox.ts` gives: the
 * executable bit on a directory is its traverse bit, so a PATH entry holding
 * one named `git` would otherwise be found as git.
 */
export const which = (tool: string, env: NodeJS.ProcessEnv): string | null => {
  const listed = env.PATH ?? ''
  // `shutil.which`'s own `if not path: return None`. Without it the empty
  // string splits to one entry that is the empty string, `path.join('', tool)`
  // is the bare name, and `accessSync` resolves it against the process's own
  // working directory: a session opened in a directory holding an executable
  // named `git` would be told git is on PATH where the Python said it was not,
  // and the silent arm would become a "could not" line. An empty entry INSIDE
  // a non-empty PATH is a different question and is left alone, because
  // `shutil.which` looks a bare name up in the working directory there too.
  if (listed === '') return null
  for (const directory of listed.split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isDirectory()) return candidate
    } catch {
      // Not here, or not executable. Keep walking.
    }
  }
  return null
}

/** The edges the hook is built from: everything it reads that is not a file
 *  and not git. */
export interface HookEdges {
  /** This process's own working directory, as a call rather than a value:
   *  `os.getcwd()` raises on a directory that has been deleted, and the
   *  outermost handler in the entry point is where that is answered. It is
   *  only asked for when the payload has no usable `cwd`. */
  readonly cwd: () => string
  readonly env: NodeJS.ProcessEnv
  /** Everything on stdin, decoded. A call rather than a value because two of
   *  the four subcommands never read it and `--help`-shaped runs must not
   *  block on a descriptor nobody writes (round 5's finding on #156). */
  readonly stdin: () => Promise<string>
  readonly output: Output
  /** The runner the one bounded child is started with. Injected so the
   *  timeout arm is reachable without waiting out a real bound; git is never
   *  injected and never mocked (ADR 001). */
  readonly run: Runner
  /** The interpreter the child is started with: this process's own, as the
   *  Python used `sys.executable` and for the same reason. */
  readonly nodePath: string
  /** `<plugin root>/bin/gh.ts`, derived once by the entry point. */
  readonly entry: string
}

/**
 * What the fan-out produced.
 *
 * `report` is `sync`'s own, whole. `degraded` is a sentence this hook wrote
 * about a run that produced none. The two are kept apart as data rather than
 * told apart later by reading the text back, because the hook is the one that
 * wrote the second and already knows which it has; it is what decides whether
 * there is anything to summarise.
 */
type SyncOutcome =
  | { readonly kind: 'report'; readonly text: string }
  | { readonly kind: 'degraded'; readonly text: string }

/** What the fan-out is worth saying, or `null` when it is worth nothing. */
const FAILED_LINE = (detail: string): string => `could not run the sync check: ${detail}`

const TIMEOUT_LINE = (seconds: string, count: number, cwd: string): string =>
  `could not finish the sync check within ${seconds} s (${count} repositories under ${cwd})`

/**
 * How many repositories the fan-out was working through.
 *
 * The same discovery `sync` does, so the number in the timeout message is the
 * one it was working from. Any failure answers 0: this is one detail inside a
 * message about a different failure, and it must not become a second one.
 * `hook-io.py:264` catches every exception discovery can raise for that;
 * discovery mostly answers with an outcome here instead, and every outcome
 * but `ok` is the same zero. NOT every one: `src/discover.ts` calls
 * `realpathSync` unguarded after its own directory test in BOTH of its two
 * places, for the target and again for each subdirectory it walks, and
 * node's throws where Python's non-strict `os.path.realpath` never did, so a
 * directory removed between the two calls still escapes as a rejection. The
 * guard belongs at discovery's edge rather than here, at both sites, and is
 * recorded as a follow-up on `src/discover.ts`; the outermost handler in
 * `hooks/hook-io.ts` keeps the session safe meanwhile.
 */
export const repoCount = async (cwd: string, env: NodeJS.ProcessEnv): Promise<number> => {
  const discovered = await discoverRepos(cwd, env)
  return discovered.outcome === 'ok' ? discovered.roots.length : 0
}

/**
 * The dry-run fan-out's report, or a one-line account of a degraded run.
 *
 * One bounded child, started detached by {@link Runner} so the bound can be
 * made to stick: `sync` fans out in this one process now, but it still runs a
 * fetch per repository, and killing the child alone would leave those running
 * against the network long after the session moved on. That is the port of
 * `hook-io.py`'s `Popen(start_new_session=True)` plus `kill_group`, and
 * `lib/process.ts` carries both.
 *
 * **The child is NOT given a working directory.** The Python's `Popen`
 * inherits the hook's, and the target reaches the child as its positional
 * argument instead. Naming the target as the child's `cwd` would read as the
 * more explicit form and is a behaviour change: a directory that cannot be
 * entered (mode 000, which `fixtures/hook-output.json` captures) would then
 * be a child that could not be started and a hook that says nothing, where
 * today the child runs, refuses the directory in its own words, and the
 * session gets that sentence.
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
      // Above the timer ceiling there is no bound at all, which is what
      // `communicate(timeout=float("inf"))` does.
      ...(milliseconds > MAX_TIMER_MS ? {} : { timeoutMs: milliseconds }),
    },
  )
  if (result.startFailure !== null) {
    // The entry point was readable and the child still would not start: a
    // partial install, or a machine out of processes. Nothing to say.
    return null
  }
  if (result.timedOut) {
    return {
      kind: 'degraded',
      text: TIMEOUT_LINE(formatG(seconds), await repoCount(cwd, env), cwd),
    }
  }
  if (result.status !== 0) {
    // The child's own diagnosis, kept whole where the debug log will have it;
    // the session gets one line, because a person reads that one.
    const text = result.stderr
    edges.output.err.write(text.endsWith('\n') || text === '' ? text : `${text}\n`)
    // #81 (found while reading this function for round 7 layer 2): `sync` now
    // answers a non-zero status when one of its own repositories failed,
    // AFTER writing the whole report to stdout, exactly as it does for a
    // clean run. Falling straight to `FAILED_LINE` here would throw that
    // report away and say something strictly less true: "could not run the
    // sync check" about a check that ran to completion and found a real
    // problem. So a non-zero status with a report still on stdout is read the
    // same way a zero status is; only a run that left NO report at all (a
    // crash before a byte reached stdout, or a refusal, whose stdout is empty
    // by `lib/envelope.ts`'s own contract) falls through to the line below.
    //
    // `result.signal === null` is also required (round 7 layer 2, review
    // round 1 finding): `result.timedOut` above only catches the hook's OWN
    // bound firing, so a non-null signal reaching here is an EXTERNAL kill
    // (an OOM kill, a stray `SIGTERM`), not `sync` answering `failed(...)`.
    // On the single-repository path `sync` hands `syncRepo` the real stdout
    // directly, and `syncRepo` writes its report line by line across several
    // awaited git and `gh` calls, so a kill mid-run can leave a genuinely
    // partial report with no closing statement, on stdout, with a non-zero
    // status: exactly what `result.stdout !== ''` alone cannot tell apart
    // from a complete `failed(...)` report. A throw inside `syncRepo` cannot
    // produce this: `sync.ts`'s `try`/`catch` around the whole job always
    // appends a closing failure line before returning `failed(...)`, so a
    // signal death is the case this gate is FOR.
    //
    // It is not the only way there (review round 2 finding): `lib/streams.ts`
    // `createWriter` re-throws anything on the stream that is not `EPIPE`
    // (`ENOSPC`, `EIO`), and that throw fires from a stream `error` event,
    // outside `sync.ts`'s `try`/`catch` regardless of nesting. A real write
    // failure on the child's actively-drained stdout pipe would crash it the
    // same way, with `signal` still `null`. That is narrower than a signal
    // death (a disk error, not a reader going away) and the re-throw itself
    // lives in `lib/streams.ts`, a lower layer this gate cannot see into;
    // recorded here rather than guarded against.
    if (result.signal === null && result.stdout !== '') {
      return { kind: 'report', text: result.stdout }
    }
    // `or`, not `??`: a child that failed without a word leaves `""` here,
    // and `""` is what the exit-status fallback exists for.
    const detail = lastLine(text) || `exit status ${returnCode(result.status, result.signal)}`
    return { kind: 'degraded', text: FAILED_LINE(detail) }
  }
  return { kind: 'report', text: result.stdout }
}

/**
 * The fan-out message, or `null` when the dry run said nothing actionable.
 *
 * A degraded run goes back through this same path rather than around it:
 * "could not" is already the vocabulary `sync` reports a lookup it could not
 * make in, and {@link ACTIONABLE} already treats it as worth saying.
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
 * The repository's default branch, resolved without going to the network.
 *
 * The cached `origin/HEAD` first, and where a clone never fetched one, the
 * first of `main` and `master` that exists locally. Asking the remote would
 * mean a round trip on every session start, which is exactly what the in-repo
 * branch of this hook exists to avoid.
 */
const localDefaultBranch = async (options: RepoOptions): Promise<string | null> => {
  const ref = await defaultBranch(options)
  // `if ref:` in the Python: a ref read as the empty string is no ref, which
  // is the fold `lib/git.ts`'s `defaultBranch` already does.
  if (ref !== null) return ref
  for (const candidate of ['main', 'master']) {
    if (await hasRef(`refs/heads/${candidate}`, options)) return candidate
  }
  return null
}

/** The two namespaces the count lookups name in full. `--merged main` would
 *  take a tag named `main` as happily as the branch, and the default branch
 *  here is a local branch name or nothing. */
const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const ORIGIN = `${REMOTES}origin/`

/** The field separator the local branch listing is read back with. git refuses
 *  an ASCII control character in a ref name (`git check-ref-format`), so a tab
 *  cannot appear in either field and the split is unambiguous. */
const FIELD = '\t'

/**
 * `git rev-list --count`'s answer, or `null` for anything that is not one.
 *
 * `null` is git failing, which is how a missing ref on either end of the range
 * arrives (status 128). The empty string is the other shape a `git` on PATH
 * can take, exiting 0 with nothing to say, and it is not a count: reading it
 * as zero would report "up to date" about a question that was never answered.
 */
export const parseCount = (out: string | null): number | null => {
  if (out === null || !/^[0-9]+$/.test(out)) return null
  return Number(out)
}

/** How far the local default branch is behind the CACHED `origin/<target>`.
 *  No fetch: the closing line of the message says the number is as of the last
 *  one (#110 ruling 4). */
const behindCount = async (target: string, options: RepoOptions): Promise<number | null> =>
  parseCount(
    await gitOut(['rev-list', '--count', `${HEADS}${target}..${ORIGIN}${target}`], options),
  )

/**
 * The prunable candidates among `locals`, or `null` when a listing failed.
 *
 * Pure, and given all three listings rather than fetching them, so that every
 * way this can end is reachable without arranging a git that fails one call
 * and answers the next two.
 *
 * `locals` is `name<tab>upstream` per local branch, `refs` is every ref an
 * upstream can name that exists, and `merged` is the local branches already
 * reachable from the default branch. A branch counts when its upstream is
 * configured and no longer exists, or when its work is already in the default
 * branch. Neither the default branch nor the branch the session is on ever
 * counts: one is where the work lands and the other is where the session is.
 *
 * `refs` spans both namespaces because `%(upstream)` does: a branch set to
 * track another LOCAL branch answers `refs/heads/<name>`, and a set built from
 * the remote-tracking refs alone would call that live upstream gone and count
 * every such branch as a candidate.
 *
 * `null` when ANY listing failed rather than a count of what the rest hold:
 * the line states a number of candidates, and a number assembled from a
 * partial answer understates what it says it counted.
 */
export const countCandidates = (
  locals: readonly string[] | null,
  refs: readonly string[] | null,
  merged: readonly string[] | null,
  current: string,
  target: string,
): number | null => {
  if (locals === null || refs === null || merged === null) return null
  const existing = new Set(refs)
  const candidates = new Set(merged)
  for (const line of locals) {
    const separator = line.indexOf(FIELD)
    // No separator at all is a line this format cannot produce; it is read as
    // a branch with no upstream rather than as a branch named after the whole
    // line with an upstream of nothing.
    if (separator === -1) continue
    const upstream = line.slice(separator + 1)
    if (upstream !== '' && !existing.has(upstream)) candidates.add(line.slice(0, separator))
  }
  candidates.delete(current)
  candidates.delete(target)
  return candidates.size
}

/** The candidate count for one checkout, from three local ref listings. */
const prunableCandidates = async (
  current: string,
  target: string,
  options: RepoOptions,
): Promise<number | null> => {
  const locals = await gitLines(
    ['for-each-ref', `--format=%(refname:short)${FIELD}%(upstream)`, HEADS],
    options,
  )
  // Asked as refs rather than as `%(upstream:track)`, whose `[gone]` is a
  // translated string: a session in a French locale would report no gone
  // upstreams at all, silently.
  //
  // Both namespaces in one listing, because an upstream may name either. git
  // writes `refs/heads/<name>` for a branch tracking a local branch, and a
  // set of remote-tracking refs alone would not hold it.
  const refs = await gitLines(['for-each-ref', '--format=%(refname)', HEADS, REMOTES], options)
  const merged = await gitLines(
    ['for-each-ref', '--format=%(refname:short)', '--merged', `${HEADS}${target}`, HEADS],
    options,
  )
  return countCandidates(locals, refs, merged, current, target)
}

/**
 * The in-repo message, or `null` when there is nothing worth saying.
 *
 * Nothing to say on a detached HEAD (there is no branch to compare), on a
 * repository whose default branch cannot be resolved locally, or when the
 * session already started on the default branch. Being off the default branch
 * is itself the status worth one line, so the counts are gathered only once
 * that is established: on the silent paths no lookup runs at all.
 *
 * Every one of them is local, and every one of them may answer with nothing
 * (#110 ruling 4). A count that could not be read leaves its line out; neither
 * a failing git, a missing ref, an empty answer nor an answer that is not a
 * number can throw here or cost the message its first line.
 */
const branchMessage = async (options: RepoOptions): Promise<string | null> => {
  const current = await currentBranch(options)
  // `if not current or current == "HEAD"`: `null` here is git failing and
  // git answering with nothing at all, which `lib/git.ts` folds together.
  if (current === null || current === 'HEAD') return null
  const target = await localDefaultBranch(options)
  if (target === null || target === current) return null
  return branchMessageText({
    current,
    target,
    behind: await behindCount(target, options),
    candidates: await prunableCandidates(current, target, options),
  })
}

/**
 * Everything on stdin, or `""` when it cannot be read at all.
 *
 * `hook-io.py:144` guards the READ and not only the parse: the `except
 * (ValueError, AttributeError, OSError, UnicodeDecodeError)` sits around
 * `json.load(sys.stdin)`, and `OSError` there is the descriptor failing
 * rather than the document being malformed. A hook whose stdin is something
 * a read fails on answered `""` there and went on to run the whole check
 * from `os.getcwd()`; without this it loses the check to a rejection
 * instead. The state to construct it with is a descriptor 0 opened for
 * writing, which `hook-io.ts session-start 0>/dev/null` leaves and a read of
 * answers `EBADF`. A descriptor on a directory is `EISDIR` on Linux and
 * reads as zero bytes on macOS, so it reaches the same fallback by the other
 * route and is not the example to reason from.
 *
 * `report` deliberately does not come through here: the Python's
 * `sys.stdin.read()` in that arm is not guarded the way the payload read is,
 * and there is no fallback report to write. It is still inside `main`'s
 * `except BrokenPipeError` and the outermost handler, as this arm is inside
 * the entry point's, so a failure there is an account on stderr and exit 0.
 */
const readPayload = async (edges: HookEdges): Promise<string> => {
  try {
    return await edges.stdin()
  } catch {
    return ''
  }
}

/** The whole hook: pick the branch the payload's directory calls for, or stay
 *  quiet. */
const sessionStart = async (edges: HookEdges): Promise<string | null> => {
  const stated = payloadCwd(await readPayload(edges))
  // `if not cwd or not os.path.isdir(cwd)`: the empty string is a payload
  // with no usable cwd, not a directory named "".
  const cwd = stated !== '' && isDirectory(stated) ? stated : edges.cwd()
  if (which('git', edges.env) === null) {
    // Both branches need git: the in-repo check cannot ask what branch this
    // is, and `sync` refuses outright. Neither is worth a line of a session's
    // context, and both are worth one in the debug log.
    edges.output.err.write('git is not on PATH\n')
    return null
  }
  const options = { cwd, env: scrubRepositoryEnv(edges.env) }
  // `git_out` and not `toplevel`: the Python asks whether the call FAILED
  // (`is not None`), and a git that exits 0 printing nothing is inside a
  // repository to it. `toplevel` folds that empty answer into `null`, which
  // is the right reading for a caller that wants the root and the wrong one
  // for a caller that wants "did this succeed".
  if ((await gitOut(['rev-parse', '--show-toplevel'], options)) !== null) {
    return branchMessage(options)
  }
  return reportMessage(cwd, edges)
}

/**
 * The hook, argv in and an exit status out.
 *
 * `session-start` is what `hooks.json` runs. The other three are the pieces
 * that decision is built from, kept as subcommands because they are the seams
 * the tests and a human debugging the hook work at.
 */
export const runHookIo = async (argv: readonly string[], edges: HookEdges): Promise<number> => {
  const [mode, current, target] = argv
  if (mode === 'session-start') {
    const message = await sessionStart(edges)
    // `if message:` in the Python. Neither branch can answer with the empty
    // string today, and reading it as silence is what the Python does.
    if (message) edges.output.out.write(emit(message))
    return 0
  }
  if (mode === 'cwd') {
    edges.output.out.write(`${payloadCwd(await readPayload(edges))}\n`)
    return 0
  }
  // The two `typeof` guards come before the length check so each is asked of
  // a command line that fails it: `branch` alone, and `branch <one>`. The
  // length check then refuses `branch <a> <b> <c>`, which Python's
  // `len(argv) == 4` refuses too.
  if (mode === 'branch' && typeof current === 'string' && typeof target === 'string') {
    if (argv.length === 3) {
      // No repository to read, so neither count has an answer here: the seam
      // is given two names and nothing else.
      edges.output.out.write(
        emit(branchMessageText({ current, target, behind: null, candidates: null })),
      )
      return 0
    }
  }
  if (mode === 'report') {
    // No summary: the seam wraps a body it was handed, and a summary is a
    // statement about a fan-out this process ran.
    edges.output.out.write(emit(reportMessageText((await edges.stdin()).replace(/\n+$/, ''), null)))
    return 0
  }
  edges.output.err.write(USAGE)
  return 2
}
