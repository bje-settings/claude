// The watch: a long poll of every open pull request in the repository. It
// writes one line to stdout for each event. The /workstreams:start skill
// arms this command with the Monitor tool itself (round 10 ruling 9,
// round 11 #279). Each line the watch writes is one wake of the
// orchestrator.
//
// **Memory only.** The watch keeps what it has seen in this process, and
// writes no file (`.claude/rules/_design-principles.md`, "State"). A watch
// that starts again learns the heads again. `--since-head` and
// `--concluded` let a caller say what it already knows. The new watch then
// stays silent about it.
//
// **A head this watch has seen is not new by itself.** For a short time
// after a push, the API answers the old head, then the new one. The watch
// keeps every head it has seen for each pull request, not only the current
// head (#264). `--since-head` and `--concluded` seed this memory with their
// own head.
//
// **A seen head becomes current only on its second answer in a row.** A
// push back to an earlier, already-seen head writes no line on its first
// poll. The same head must answer again on the very next poll. Only then
// does the watch move the current head, and write that line (ruling 5,
// #296). Any other answer ends the wait at once. A head not yet seen
// becomes current right away, and a poll that repeats the current head
// leaves nothing pending.
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
// that reads again after a failure says so. A list that fell short still
// gives the rows that arrived, and the watch keeps them. It writes a "poll incomplete" line once for each new reason.
// So one row that cannot be read does not stop the watch for every other
// pull request. A pull request that is absent from a short list is not
// reported as closed: only its own state names that.
//
// **Each base reads its required contexts on its own.** A base whose read
// fails leaves unread only the pull requests that need its list. Every
// other pull request still reads, and can still conclude. The failure
// writes one line for each new reason, and a line when that base reads
// again. A failed default branch leaves unread every pull request that
// falls back to it (#265).
//
// **An empty list is not the same fact as a list nobody could read**
// (ruling 6, #298). A base with no ruleset of its own is unread too, when
// its fallback, the default branch, cannot be read. Nothing here reads
// that base's pull requests as ones that need no check.
//
// **One event is one line.** gh can say a reason on more than one line. The
// watch writes each event on one line, because a Monitor makes one wake of
// each line.
//
// **Every gh call this watch makes carries a bound.** The bound is the
// poll interval, in milliseconds, so a hung call cannot outlast one whole
// poll cycle. A call that times out is a failed read, reported the same
// way as any other (ruling 4, #295). `lib/gh.ts` keeps no such bound by
// default. Only this command sets one.
//
// **One run read, and only when it can matter** (round 15 ruling 6, #370).
// A newer workflow run that made no check yet is visible only in the
// head's workflow runs. The watch reads them for a pull request only on a
// poll where a cancelled check has no newer check. An ordinary poll makes
// no extra call, so the one-call poll of round 14 holds in the common case.
// The read carries the same bound as every other call.
//
// **A draft does not wait for a check that skips drafts** (#365, round 15
// ruling 5). On a draft head, a required context that has not reported is
// left out when a check from a skipped check suite has a `${{ ... }}` name
// that matches it. The CONCLUDED line names each one.
//
// The command function is the seam (ADR 001). Parsed arguments, a client
// factory, a clock, a sleep and a writer go in. An envelope comes out.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError, type PullRequestHead, type WorkflowRun } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import { repeated } from '../number-list.ts'
import {
  namesOrDefault,
  needsHeadRuns,
  type ReportedContext,
  reportContexts,
  splitDraftSkipped,
} from '../required-contexts.ts'

export const HELP = `Every open pull request's head and required checks, as one line per event.

Usage:
  workstreams.ts watch [--interval 60] [--ticks 0] [--heads <branch>,...]
                       [--since-head <n>=<sha>,...] [--concluded <n>=<sha>,...]

Polls every open pull request of the repository, including ones no round
opened, or with --heads only those whose head branch it names, and writes
one line for each of these events:

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
  required contexts     a base's required contexts could not be read. Only
    for <branch> ...    its own pull requests go unread this poll. Written
                        once for each new reason.
  required contexts     the first poll that read a base's required
    for <branch> read   contexts again, after a failure.
    again
  #<n> workflow runs    the head's workflow runs could not be read. That
    could not be read   pull request goes unread this poll. Written once for
                        each new reason.
  #<n> workflow runs    the first poll that read them again.
    read again

The required contexts come from the rules of the base branch. When no ruleset
covers the base, as for each stack layer above the first, they come from the
rules of the default branch. A head is CONCLUDED only when every one of them
has reported. A check that no ruleset requires never concludes a head.

On a draft head, a required context that has not reported does not hold
CONCLUDED when a check on the head, from a check suite that concluded SKIPPED,
has a name with \${{ ... }} that matches it. That context runs after ready
for review, and the CONCLUDED line names it. A head that is not a draft
waits for every required context.

A check from a cancelled workflow run does not count when a newer run of the
same workflow exists on the head, also when that run has made no check yet and has not completed.
Then the watch writes no failure line for it, and the head is not CONCLUDED
until the newer run reports each required context. The watch reads the
head's workflow runs only on a poll where a cancelled check has no newer
check. If that read fails, the watch writes one line for each new reason and
leaves the pull request unread that poll.

Each base reads its required contexts on its own. A base whose read fails
leaves unread only the pull requests that need its list, not every pull
request. A head this watch has seen is not new by itself. For a short time
after a push, the API answers the old head, then the new one. A seen head
becomes current only on its second answer in a row. A one-poll flip stays
silent.

--heads takes a comma-separated list of head branch names. A round passes
the branches its plan names, so another round's pull requests in the same
repository do not wake it. A pull request from a fork never matches. A name
with no open pull request yet writes nothing: the caller checks each head it
knows against the names it gave.

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
  heads: { type: 'string', default: '' },
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
  /** Builds the client this run polls with, bound to `boundMs`. `runWatch`
   *  calls this once, with a bound fit to `--interval`. So a hung call
   *  cannot outlast one whole poll cycle (ruling 4, #295). This is a
   *  factory, not a built client, because `--interval` is not known until
   *  `runWatch` parses it. */
  readonly createGh: (boundMs: number) => GhClient
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
  /** Every head this watch has seen for this pull request, the current one
   *  included. A head in here that is not the current one is not a new
   *  head. The API answers an old head again, for a short time after a
   *  push (#264). */
  readonly seenHeads: Set<string>
  /** A seen head this poll answered, while a different head is current, or
   *  null. It becomes current only when the same head answers again on
   *  the very next poll (ruling 5, #296). A different answer on the next
   *  poll drops it with no line, and starts the count over. */
  pending: string | null
}

/** What one poll read. */
interface Snapshot {
  readonly defaultBranch: string
  readonly pulls: readonly PullRequestHead[]
  /** The required contexts of each branch whose read succeeded this poll. */
  readonly required: ReadonlyMap<string, readonly string[]>
  /** Why a branch's required contexts could not be read this poll, by
   *  branch. A branch in here is not in {@link Snapshot.required} (#265). */
  readonly baseFailed: ReadonlyMap<string, string>
  /** Why the list of pull requests fell short, or null when it did not. */
  readonly short: string | null
  /** The pull_request runs on the head of each pull request whose runs were
   *  read this poll (#370), by number. */
  readonly runs: ReadonlyMap<number, readonly WorkflowRun[]>
  /** Why the runs of a pull request could not be read, by number. Such a
   *  pull request is unread this poll. It is never read as having no newer
   *  run. */
  readonly runsFailed: ReadonlyMap<number, string>
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

/** The line for a base whose required contexts could not be read this
 *  poll. The default branch's own line names what that leaves unread
 *  (#265). */
const baseFailureLine = (branch: string, defaultBranch: string, reason: string): string =>
  branch === defaultBranch
    ? `required contexts for the default branch ${branch} could not be read: ${reason}; ` +
      'every pull request that falls back to it is unread'
    : `required contexts for ${branch} could not be read: ${reason}; its pull requests are unread`

/** The line for a base whose required contexts read again, after a poll
 *  where they could not be read. */
const baseRecoveryLine = (branch: string): string => `required contexts for ${branch} read again`

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

/** One poll's reads. Nothing here decides an event. An empty `heads`
 *  keeps every open pull request. */
const readPoll = async (gh: GhClient, heads: ReadonlySet<string>): Promise<PollOutcome> => {
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
  const open = await gh.listOpenPullRequestHeads()
  // A short list with rows still gives those rows. One row with too many
  // checks must not stop the watch for every other pull request.
  if (open.unavailable !== null && open.rows.length === 0) {
    return { kind: 'failed', reason: open.unavailable }
  }
  const pulls =
    heads.size === 0
      ? open.rows
      : open.rows.filter((pull) => !pull.crossRepository && heads.has(pull.head))

  // Each base reads on its own. A base whose read fails leaves only its own
  // pull requests unread this poll. It does not fail the poll for the rest
  // (#265).
  const required = new Map<string, readonly string[]>()
  const baseFailed = new Map<string, string>()
  for (const branch of new Set([defaultBranch, ...pulls.map((pull) => pull.base)])) {
    const answer = await gh.requiredContexts({ branch })
    if (answer.unavailable !== null) {
      baseFailed.set(branch, answer.unavailable)
      continue
    }
    required.set(branch, answer.contexts)
  }
  // Nothing at all could be read: every base asked about failed.
  if (required.size === 0) {
    return { kind: 'failed', reason: [...baseFailed.values()].join('; ') }
  }
  // A newer run with no check yet shows in the head's runs only. Ask for
  // them when a cancelled check has no newer check (#370, ruling 6).
  const runs = new Map<number, readonly WorkflowRun[]>()
  const runsFailed = new Map<number, string>()
  for (const pull of pulls) {
    if (!needsHeadRuns(pull.checks)) continue
    const answer = await gh.listWorkflowRuns({ branch: pull.head })
    if (answer.unavailable !== null) {
      runsFailed.set(pull.number, answer.unavailable)
      continue
    }
    runs.set(
      pull.number,
      answer.rows.filter((run) => run.event === 'pull_request' && run.headSha === pull.headSha),
    )
  }
  return {
    kind: 'read',
    snapshot: {
      defaultBranch,
      pulls,
      required,
      baseFailed,
      short: open.unavailable,
      runs,
      runsFailed,
    },
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
    memory.set(number, {
      sha,
      reported: new Map(),
      concluded: false,
      seeded: true,
      seenHeads: new Set([sha]),
      pending: null,
    })
  }
  for (const [number, sha] of concluded) {
    memory.set(number, {
      sha,
      reported: new Map(),
      concluded: true,
      seeded: true,
      seenHeads: new Set([sha]),
      pending: null,
    })
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
  runs: readonly WorkflowRun[],
): string[] => {
  const seen = memory.get(pull.number)
  // A head this watch has already seen, other than the current one, is not
  // new by itself. The API answers an old head again after a push (#264).
  // It becomes current only once it answers again on the very next poll
  // (ruling 5, #296). Any other answer clears the count. A head not yet
  // seen ends the silence at once. A head unchanged from the current one
  // also leaves nothing pending.
  // A fall-through here means `seen.pending` already equals `pull.headSha`
  // (the confirmed case), so it needs no reset: the "new head" branch
  // below is about to make `pull.headSha` the current `sha`, and a
  // `pending` equal to the current `sha` can never match again.
  if (seen !== undefined && seen.sha !== pull.headSha && seen.seenHeads.has(pull.headSha)) {
    if (seen.pending !== pull.headSha) {
      seen.pending = pull.headSha
      return []
    }
  } else if (seen !== undefined) {
    seen.pending = null
  }

  const lines: string[] = []
  // A draft does not wait for a context that a skipped matrix check stands
  // for (#365).
  const split = splitDraftSkipped(reportContexts(pull.checks, names, runs), pull.checks, pull.draft)
  const contexts = split.counted
  let tracked = seen
  let quiet = false
  if (tracked === undefined) {
    const draft = pull.draft ? 'draft' : 'ready'
    lines.push(
      `#${pull.number} open: ${pull.head} -> ${pull.base}, head ${pull.headSha}, ${draft}, ` +
        progress(contexts),
    )
    tracked = {
      sha: pull.headSha,
      reported: new Map(),
      concluded: false,
      seeded: false,
      seenHeads: new Set([pull.headSha]),
      pending: null,
    }
    memory.set(pull.number, tracked)
    quiet = true
  } else if (tracked.sha !== pull.headSha) {
    lines.push(`#${pull.number} new head ${pull.headSha}, ${progress(contexts)}`)
    tracked.sha = pull.headSha
    tracked.seenHeads.add(pull.headSha)
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
  // "every required context passed". A list that only draft-skipped names
  // emptied is not empty: the ruleset named them.
  const complete =
    contexts.length + split.draftSkipped.length > 0 &&
    contexts.every((context) => context.conclusion !== null)
  if (complete && !tracked.concluded) {
    tracked.concluded = true
    const failed = failures(contexts)
    const verdict = failed.length === 0 ? 'all passed' : `failed: ${failed.join(', ')}`
    const later =
      split.draftSkipped.length === 0
        ? ''
        : `; runs after ready for review: ${split.draftSkipped.join(', ')}`
    lines.push(
      `#${pull.number} ${short(pull.headSha)} CONCLUDED: ` +
        `${contexts.length}/${contexts.length} required reported, ${verdict}${later}`,
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
  // The bound is the poll interval itself. A call that has not answered by
  // the next poll is already a failed read (ruling 4, #295).
  const gh = context.createGh(interval * 1000)
  for (const flag of ['--since-head', '--concluded']) {
    if (repeated(argv, flag)) {
      return refused(`${flag} is not repeatable; pass one comma-separated list`)
    }
  }
  const sinceHead = parseSeeds(parsed.value['since-head'], '--since-head')
  if (sinceHead.outcome !== 'ok') return sinceHead
  const concluded = parseSeeds(parsed.value.concluded, '--concluded')
  if (concluded.outcome !== 'ok') return concluded
  if (repeated(argv, '--heads')) {
    return refused('--heads is not repeatable; pass one comma-separated list')
  }
  const heads = new Set(
    parsed.value.heads
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word !== ''),
  )
  // An empty --heads would watch every pull request, the opposite of what
  // a caller who gave the flag asked for.
  if (heads.size === 0 && argv.some((word) => word === '--heads' || word.startsWith('--heads='))) {
    return refused('--heads takes one or more branch names')
  }

  const top = await toplevel({ cwd: context.cwd, env: context.env })
  if (top === null) {
    return ok(`watch: ${context.cwd} is not inside a git checkout, so there is nothing to watch`)
  }

  const memory = seededMemory(sinceHead.value, concluded.value)
  /** Every pull request number this watch has seen open, whether or not its
   *  base's required contexts have ever been read. A pull request whose
   *  base stays down never enters {@link memory}, but it can still leave
   *  the open list. This set is how the watch notices that (#265). */
  const knownOpen = new Set<number>(memory.keys())
  let noticed = false
  /** The reason the last poll's list fell short, so a reason that stays
   *  the same is written once and not on every poll. */
  let lastShort: string | null = null
  /** The reason of the poll that failed last, while polls fail, and how
   *  many have failed since the last poll that read. */
  let lastFailed: string | null = null
  let failedPolls = 0
  /** The last reason each base's required contexts could not be read, by
   *  branch, while that base stays unread. A reason that stays the same is
   *  written once, and a base's return is written once too (#265). */
  const baseFailures = new Map<string, string>()
  /** The last reason a pull request's workflow runs could not be read, by
   *  number, while they stay unread. A reason that stays the same is written
   *  once, and a return is written once too (#370). */
  const runReasons = new Map<number, string>()
  let quietSince = context.now()
  for (let tick = 1; !context.stopped(); tick += 1) {
    const lines: string[] = []
    const outcome = await readPoll(gh, heads)
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
      const { defaultBranch, pulls, required, baseFailed, short, runs, runsFailed } =
        outcome.snapshot
      if (short !== null && short !== lastShort) {
        lines.push(`poll incomplete: ${short}; the pull requests it read are still watched`)
      }
      lastShort = short
      for (const [branch, reason] of baseFailed) {
        if (baseFailures.get(branch) !== reason) {
          lines.push(baseFailureLine(branch, defaultBranch, reason))
        }
        baseFailures.set(branch, reason)
      }
      for (const branch of [...baseFailures.keys()]) {
        if (required.has(branch)) {
          lines.push(baseRecoveryLine(branch))
          baseFailures.delete(branch)
        } else if (!baseFailed.has(branch)) {
          // No open pull request needs this branch's list any more, so
          // `readPoll` never asked about it this poll. Drop it with no
          // line: this watch cannot say it read again what it did not
          // read (#265).
          baseFailures.delete(branch)
        }
      }
      // A branch's list answers only when its own read succeeded this poll.
      const listFor = (branch: string): readonly string[] | undefined => required.get(branch)
      if (required.has(defaultBranch) && listFor(defaultBranch)?.length === 0 && !noticed) {
        noticed = true
        lines.push(
          `no ruleset requires a status check of ${defaultBranch}, ` +
            'so no head that falls back to it is CONCLUDED',
        )
      }
      const open = new Set(pulls.map((pull) => pull.number))
      for (const number of [...runReasons.keys()]) {
        if (!open.has(number)) runReasons.delete(number)
      }
      for (const number of [...knownOpen]) {
        if (open.has(number)) continue
        const left = await leftOpenList(gh, number)
        if (left.line !== null) lines.push(left.line)
        if (left.settled) {
          memory.delete(number)
          knownOpen.delete(number)
        }
      }
      // A pull request is unread this poll when its own base's read failed.
      // It is also unread when its base falls back to a default branch
      // whose read failed (#265). It is left as this watch last knew it,
      // and read again once the base it needs reads. It still counts as
      // open, so a merge or a close is not lost while its base stays down.
      for (const pull of pulls) {
        knownOpen.add(pull.number)
        const own = listFor(pull.base)
        if (own === undefined) continue
        // `listFor` answers `undefined` exactly when the default branch's
        // own read did not succeed this poll. `namesOrDefault` reads that
        // as `null`, "could not be read", never as "nothing required"
        // (ruling 6, #298).
        const list = namesOrDefault(own, listFor(defaultBranch) ?? null)
        if (list.from === 'unread') continue
        // The head's runs could not be read, so a cancelled check cannot be
        // told from a superseded one. This pull request is left as it was
        // and read again next poll. The reason is written once.
        const runsReason = runsFailed.get(pull.number)
        if (runsReason !== undefined) {
          if (runReasons.get(pull.number) !== runsReason) {
            lines.push(
              `#${pull.number} workflow runs could not be read: ${runsReason}; ` +
                'the pull request is unread this poll',
            )
            // Delete first, so the Map orders the reasons by when each last
            // changed, and the heartbeat's last one is the latest.
            runReasons.delete(pull.number)
            runReasons.set(pull.number, runsReason)
          }
          continue
        }
        // Only a poll that read the runs again says so. A poll that did not
        // need them drops the reason without a line.
        if (runReasons.delete(pull.number) && runs.has(pull.number)) {
          lines.push(`#${pull.number} workflow runs read again`)
        }
        lines.push(...pullLines(pull, list.names, memory, runs.get(pull.number) ?? []))
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
    } else if (context.now() - quietSince >= HEARTBEAT_MS && baseFailures.size > 0) {
      // The memory for a branch still unread is as old as its last good
      // read. "No change" would claim what no poll could see for it (#265).
      const branches = [...baseFailures.keys()].sort().join(', ')
      const reason = [...baseFailures.values()].at(-1)
      context.write(
        oneLine(`heartbeat: required contexts for ${branches} still unread, the last: ${reason}`),
      )
      quietSince = context.now()
    } else if (context.now() - quietSince >= HEARTBEAT_MS && runReasons.size > 0) {
      // A pull request whose runs stay unread is as old as its last good
      // read. "No change" would claim what no poll could see for it (#370).
      const numbers = [...runReasons.keys()]
        .sort((a, b) => a - b)
        .map((number) => `#${number}`)
        .join(', ')
      const reason = [...runReasons.values()].at(-1)
      context.write(
        oneLine(`heartbeat: workflow runs for ${numbers} still unread, the last: ${reason}`),
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
