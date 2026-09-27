// The watch: a long poll of every open pull request in the repository. It
// writes one line to stdout for each event. A Monitor turns each line into
// one wake of the orchestrator (round 10 ruling 9). The plugin monitor that
// layer 5 adds does the same.
//
// **Memory only.** The watch keeps what it has seen in this process, and
// writes no file (`.claude/rules/_design-principles.md`, "State"). A watch
// that starts again learns the heads again. `--since-head` and
// `--concluded` let a caller say what it already knows. The new watch then
// stays silent about it.
//
// **A head concludes only when every required context has reported**
// (ruling P9). The list comes from the base branch's rules, and from the
// DEFAULT branch's rules when no ruleset covers the base. That is the case
// for each stack layer above the first. In round 5, a watch concluded on
// the checks that had reported on the head. Those were seven CodeQL checks,
// and none of the required ones.
//
// **A value that could not be read is reported as itself.** A poll that
// read no pull request writes a "poll failed" line and changes nothing. The
// line comes once for each new reason, and not on each poll. The first poll
// that reads again after a failure says so. A that fell short still gives the rows that arrived, and the watch
// keeps them. It writes a "poll incomplete" line once for each new reason.
// So one row that cannot be read does not stop the watch for every other
// pull request. A pull request that is absent from a short list is not
// reported as closed: only its own state names that.
//
// **One event is one line.** gh can say a reason on more than one line. The
// watch writes each event on one line, because a Monitor makes one wake of
// each line.
//
// The command function is the seam (ADR 001). Parsed arguments, an injected
// `GhClient`, a clock, a sleep and a writer go in. An envelope comes out.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError, type PullRequestHead } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import { namesOrDefault, type ReportedContext, reportContexts } from '../required-contexts.ts'

export const HELP = `Every open pull request's head and required checks, as one line per event.

Usage:
  workstreams.ts watch [--interval 60] [--ticks 0]
                       [--since-head <n>=<sha>,...] [--concluded <n>=<sha>,...]

Polls every open pull request of the repository, including ones no round
opened, and writes one line for each of these events:

  #<n> open: ...        a pull request this watch has not seen, with its head
  #<n> new head <sha>   a head that moved, compared by the full sha
  #<n> <sha> <name>: X  a required context that reported conclusion X
  #<n> <sha> CONCLUDED  every required context has reported, with each failure
  #<n> merged           a pull request that left the open list
  heartbeat: ...        ten minutes with no other line
  poll failed: ...      a poll that read nothing; the watch polls again.
                        Written once for each new reason.
  poll read again ...   the first poll that read after a failed poll
  poll incomplete: ...  a list that fell short; the rows that arrived are
                        still watched. Written once for each new reason.

The required contexts come from the rules of the base branch. When no ruleset
covers the base, as for each stack layer above the first, they come from the
rules of the default branch. A head is CONCLUDED only when every one of them
has reported. A check that no ruleset requires never concludes a head.

--interval is the time between polls, in seconds. --ticks stops the watch
after that many polls; 0, the default, polls until the watch is stopped.

--since-head and --concluded tell a watch that starts again what the caller
already knows, as a comma-separated list of <number>=<full head sha>. A known
head is not reported as open, and its contexts that have already reported are
not reported again. A head given to --concluded is also not concluded again.
A head that has moved since is reported as a new head.

Outside a git checkout, or with no gh to run, the watch writes one line and
exits 0. It exits 0 when it is stopped, and 2 on a usage error.`

const SPEC = {
  interval: { type: 'string', default: '60' },
  ticks: { type: 'string', default: '0' },
  'since-head': { type: 'string', default: '' },
  concluded: { type: 'string', default: '' },
  help: { type: 'boolean', short: 'h' },
} as const

/** The time with no other line before the watch writes a heartbeat. */
export const HEARTBEAT_MS = 10 * 60_000

/** The status that `lib/process.ts` gives a child that is not on PATH. It
 *  is the shell's own "command not found". */
const NOT_ON_PATH = 127

/** The edges the watch reads and writes. Each one is an argument, so a test
 *  runs a hundred polls with no real wait and no real `gh`. */
export interface WatchContext {
  readonly gh: GhClient
  /** The directory the watch stands in, and the environment for git. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Writes one line. The caller adds the newline. */
  readonly write: (line: string) => void
  readonly now: () => number
  /** Waits `ms`, or less when the watch is stopped during the wait. */
  readonly sleep: (ms: number) => Promise<void>
  /** True once the watch must end: a SIGTERM, or a reader that closed the
   *  pipe. */
  readonly stopped: () => boolean
}

/** A number and a full head sha, 40 hexadecimal digits. A short sha is
 *  refused: on a re-arm, a short sha made a known head read as new. */
const SEED = /^([1-9][0-9]*)=([0-9a-fA-F]{40})$/

/** The pairs a `--since-head` or `--concluded` value names, by number, or a
 *  refusal that says what was wrong. */
export const parseSeeds = (value: string, flag: string): Envelope<Map<number, string>> => {
  const seeds = new Map<number, string>()
  if (value === '') return ok(seeds)
  for (const word of value.split(',')) {
    const match = SEED.exec(word.trim())
    if (match === null) {
      return refused(`${flag} takes <number>=<full head sha> pairs, not "${word.trim()}"`)
    }
    const number = Number(match[1])
    if (seeds.has(number)) return refused(`${flag} names #${number} twice`)
    seeds.set(number, (match[2] as string).toLowerCase())
  }
  return ok(seeds)
}

/** Whether the command line names `flag` more than once. `parseArgs`
 *  answers a repeated option with its last value, and no complaint. So a
 *  second list would replace the first in silence. `sweep.ts` has the same
 *  check for `--milestone`. */
const repeated = (argv: readonly string[], flag: string): boolean =>
  argv.filter((word) => word === flag || word.startsWith(`${flag}=`)).length > 1

/** A whole number from a flag, or null when the word is not one. */
const wholeNumber = (word: string, least: number): number | null =>
  /^[0-9]+$/.test(word) && Number(word) >= least ? Number(word) : null

/** What the watch remembers about one pull request. */
interface Tracked {
  sha: string
  /** The last conclusion written for each required context of this head. */
  readonly reported: Map<string, string>
  concluded: boolean
  /** True for a head the caller seeded and this watch has not polled yet.
   *  Its first poll writes nothing about what has already reported. */
  seeded: boolean
}

/** What one poll read. */
interface Snapshot {
  readonly defaultBranch: string
  readonly pulls: readonly PullRequestHead[]
  /** The required contexts of each branch the poll asked about. */
  readonly required: ReadonlyMap<string, readonly string[]>
  /** Why the list of pull requests fell short, or null when it did not. */
  readonly short: string | null
}

const short = (sha: string): string => sha.slice(0, 7)

/** A line with each line break in it made one space. */
const oneLine = (line: string): string => line.replace(/\s*[\r\n]+\s*/g, ' ').trimEnd()

/** The failures among the contexts, for a person. */
const failures = (contexts: readonly ReportedContext[]): string[] =>
  contexts
    .filter((context) => context.verdict === 'failed')
    .map((context) => `${context.name} (${context.conclusion})`)

/** "required 2/3 reported", and each failure so far. */
const progress = (contexts: readonly ReportedContext[]): string => {
  const reported = contexts.filter((context) => context.conclusion !== null).length
  const failed = failures(contexts)
  const tail = failed.length === 0 ? '' : `, failed: ${failed.join(', ')}`
  return `required ${reported}/${contexts.length} reported${tail}`
}

/** The error a gh call threw, as its status and one line. `viewRepository`
 *  throws `GhError`; a test double may throw something else, which is then
 *  reported in its own words. */
const reasonOf = (error: unknown): { status: number | null; reason: string } =>
  error instanceof GhError
    ? { status: error.status, reason: error.detail }
    : { status: null, reason: String(error) }

/** The default branch's name from a `gh repo view` reply, or null. */
const defaultBranchOf = (repository: Record<string, unknown>): string | null => {
  const ref = repository.defaultBranchRef
  const name = typeof ref === 'object' && ref !== null ? (ref as { name?: unknown }).name : null
  return typeof name === 'string' && name !== '' ? name : null
}

/** What one poll came to. That is a snapshot, or a reason it fell short. It
 *  is the end of the watch when gh is not there to run. */
type PollOutcome =
  | { readonly kind: 'read'; readonly snapshot: Snapshot }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'end'; readonly reason: string }

/** One poll's reads. Nothing here decides an event. */
const readPoll = async (gh: GhClient): Promise<PollOutcome> => {
  let repository: Record<string, unknown>
  try {
    repository = await gh.viewRepository()
  } catch (error) {
    const { status, reason } = reasonOf(error)
    return status === NOT_ON_PATH ? { kind: 'end', reason } : { kind: 'failed', reason }
  }
  const defaultBranch = defaultBranchOf(repository)
  if (defaultBranch === null) {
    return { kind: 'failed', reason: 'the repository reply named no default branch' }
  }
  const heads = await gh.listOpenPullRequestHeads()
  // A short list with rows still gives those rows. One row with too many
  // checks must not stop the watch for every other pull request.
  if (heads.unavailable !== null && heads.rows.length === 0) {
    return { kind: 'failed', reason: heads.unavailable }
  }

  const required = new Map<string, readonly string[]>()
  for (const branch of new Set([defaultBranch, ...heads.rows.map((pull) => pull.base)])) {
    const answer = await gh.requiredContexts({ branch })
    if (answer.unavailable !== null) return { kind: 'failed', reason: answer.unavailable }
    required.set(branch, answer.contexts)
  }
  return {
    kind: 'read',
    snapshot: { defaultBranch, pulls: heads.rows, required, short: heads.unavailable },
  }
}

/** What became of a pull request that left the open list: a line, and
 *  whether the watch can forget it. A state that could not be read keeps it
 *  in memory, so the next poll asks again. For a moment after the list
 *  drops a pull request, GitHub can still call it open. Then there is no
 *  line at all. */
const leftOpenList = async (
  gh: GhClient,
  number: number,
): Promise<{ line: string | null; settled: boolean }> => {
  const viewed = await gh.viewPullRequestDetail({ pullRequest: number })
  if (viewed.pullRequest === null) {
    return {
      line: `#${number} left the open list; its state could not be read: ${viewed.unavailable}`,
      settled: false,
    }
  }
  if (viewed.pullRequest.state === 'OPEN') return { line: null, settled: false }
  return { line: `#${number} ${viewed.pullRequest.state.toLowerCase()}`, settled: true }
}

/** The memory, seeded from the caller's two lists. */
const seededMemory = (
  sinceHead: ReadonlyMap<number, string>,
  concluded: ReadonlyMap<number, string>,
): Map<number, Tracked> => {
  const memory = new Map<number, Tracked>()
  for (const [number, sha] of sinceHead) {
    memory.set(number, { sha, reported: new Map(), concluded: false, seeded: true })
  }
  for (const [number, sha] of concluded) {
    memory.set(number, { sha, reported: new Map(), concluded: true, seeded: true })
  }
  return memory
}

/**
 * The lines one pull request adds, and the memory brought up to date.
 *
 * A head seen for the first time gets one line, with its progress so far.
 * It does not get a line for each context that already reported. After
 * that, each required context gets a line when its conclusion changes.
 */
const pullLines = (
  pull: PullRequestHead,
  names: readonly string[],
  memory: Map<number, Tracked>,
): string[] => {
  const lines: string[] = []
  const contexts = reportContexts(pull.checks, names)
  let tracked = memory.get(pull.number)
  let quiet = false
  if (tracked === undefined) {
    const draft = pull.draft ? 'draft' : 'ready'
    lines.push(
      `#${pull.number} open: ${pull.head} -> ${pull.base}, head ${pull.headSha}, ${draft}, ` +
        progress(contexts),
    )
    tracked = { sha: pull.headSha, reported: new Map(), concluded: false, seeded: false }
    memory.set(pull.number, tracked)
    quiet = true
  } else if (tracked.sha !== pull.headSha) {
    lines.push(`#${pull.number} new head ${pull.headSha}, ${progress(contexts)}`)
    tracked.sha = pull.headSha
    tracked.reported.clear()
    tracked.concluded = false
    quiet = true
  } else if (tracked.seeded) {
    quiet = true
  }
  tracked.seeded = false

  for (const context of contexts) {
    if (context.conclusion === null) continue
    if (tracked.reported.get(context.name) === context.conclusion) continue
    tracked.reported.set(context.name, context.conclusion)
    if (!quiet) {
      lines.push(`#${pull.number} ${short(pull.headSha)} ${context.name}: ${context.conclusion}`)
    }
  }

  // An empty list concludes nothing: "no ruleset requires anything" is not
  // "every required context passed".
  const complete = contexts.length > 0 && contexts.every((context) => context.conclusion !== null)
  if (complete && !tracked.concluded) {
    tracked.concluded = true
    const failed = failures(contexts)
    const verdict = failed.length === 0 ? 'all passed' : `failed: ${failed.join(', ')}`
    lines.push(
      `#${pull.number} ${short(pull.headSha)} CONCLUDED: ` +
        `${contexts.length}/${contexts.length} required reported, ${verdict}`,
    )
  }
  return lines
}

/**
 * Poll every open pull request, and write a line for each event. Stop at a
 * SIGTERM, at a closed reader, or after `--ticks` polls.
 */
export const runWatch = async (
  argv: readonly string[],
  context: WatchContext,
): Promise<Envelope<string>> => {
  const parsed = parseArguments(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.help) return ok(HELP)
  const interval = wholeNumber(parsed.value.interval, 1)
  if (interval === null) {
    return refused(`--interval takes a whole number of seconds, not "${parsed.value.interval}"`)
  }
  const ticks = wholeNumber(parsed.value.ticks, 0)
  if (ticks === null) {
    return refused(`--ticks takes a whole number of polls, not "${parsed.value.ticks}"`)
  }
  for (const flag of ['--since-head', '--concluded']) {
    if (repeated(argv, flag)) {
      return refused(`${flag} is not repeatable; pass one comma-separated list`)
    }
  }
  const sinceHead = parseSeeds(parsed.value['since-head'], '--since-head')
  if (sinceHead.outcome !== 'ok') return sinceHead
  const concluded = parseSeeds(parsed.value.concluded, '--concluded')
  if (concluded.outcome !== 'ok') return concluded

  const top = await toplevel({ cwd: context.cwd, env: context.env })
  if (top === null) {
    return ok(`watch: ${context.cwd} is not inside a git checkout, so there is nothing to watch`)
  }

  const memory = seededMemory(sinceHead.value, concluded.value)
  let noticed = false
  /** The reason the last poll's list fell short, so a reason that stays
   *  the same is written once and not on every poll. */
  let lastShort: string | null = null
  /** The reason of the poll that failed last, while polls fail, and how
   *  many have failed since the last poll that read. */
  let lastFailed: string | null = null
  let failedPolls = 0
  let quietSince = context.now()
  for (let tick = 1; !context.stopped(); tick += 1) {
    const lines: string[] = []
    const outcome = await readPoll(context.gh)
    if (outcome.kind === 'end') return ok(`watch: ${outcome.reason}, so there is nothing to watch`)
    if (outcome.kind === 'failed') {
      if (outcome.reason !== lastFailed) lines.push(`poll failed: ${outcome.reason}`)
      lastFailed = outcome.reason
      failedPolls += 1
    } else {
      if (lastFailed !== null) {
        lines.push(
          `poll read again after ${failedPolls} failed poll${failedPolls === 1 ? '' : 's'}`,
        )
      }
      lastFailed = null
      failedPolls = 0
      const { defaultBranch, pulls, required, short } = outcome.snapshot
      if (short !== null && short !== lastShort) {
        lines.push(`poll incomplete: ${short}; the pull requests it read are still watched`)
      }
      lastShort = short
      // `readPoll` asked about the default branch and every base in
      // `pulls`, so each lookup here answers. The cast says so to a
      // compiler that cannot see it.
      const listFor = (branch: string): readonly string[] =>
        required.get(branch) as readonly string[]
      if (listFor(defaultBranch).length === 0 && !noticed) {
        noticed = true
        lines.push(
          `no ruleset requires a status check of ${defaultBranch}, ` +
            'so no head that falls back to it is CONCLUDED',
        )
      }
      const open = new Set(pulls.map((pull) => pull.number))
      for (const number of [...memory.keys()]) {
        if (open.has(number)) continue
        const left = await leftOpenList(context.gh, number)
        if (left.line !== null) lines.push(left.line)
        if (left.settled) memory.delete(number)
      }
      for (const pull of pulls) {
        const names = namesOrDefault(listFor(pull.base), listFor(defaultBranch)).names
        lines.push(...pullLines(pull, names, memory))
      }
    }

    for (const line of lines) context.write(oneLine(line))
    if (lines.length > 0) {
      quietSince = context.now()
    } else if (context.now() - quietSince >= HEARTBEAT_MS && lastFailed !== null) {
      // The memory is as old as the last poll that read. "No change" would
      // claim what no poll could see.
      context.write(
        oneLine(`heartbeat: ${failedPolls} failed polls in a row, the last: ${lastFailed}`),
      )
      quietSince = context.now()
    } else if (context.now() - quietSince >= HEARTBEAT_MS) {
      const open = memory.size
      const done = [...memory.values()].filter((tracked) => tracked.concluded).length
      context.write(
        `heartbeat: ${open} open pull request${open === 1 ? '' : 's'}, ${done} concluded, ` +
          'no change in 10 minutes',
      )
      quietSince = context.now()
    }
    if (ticks > 0 && tick >= ticks) break
    await context.sleep(interval * 1000)
  }
  return ok('')
}
