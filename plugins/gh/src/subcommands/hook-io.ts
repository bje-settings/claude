// This file is the gh plugin's SessionStart hook (#230). It writes at most
// one status line, then one problem line for each kind of failure, or
// nothing. When git or the GitHub CLI is not on PATH, it checks nothing, and
// writes one problem line for each missing tool. {@link statusLine} and
// {@link problemLines} shape the lines, and `plugins/gh/README.md` shows them.
//
// The hook finds the repository that holds the session's directory, or the
// repositories directly inside it (`discover.ts`). It skips a repository
// whose `origin` is not on github.com. It fetches each repository, then
// counts from local refs. One GraphQL query per five repositories reads the
// GitHub counts, at the same time as the fetches.
//
// One deadline applies to the whole check. A task that fails, or does not
// finish in time, gives no count. It gives a problem line for its kind
// instead, and its full reason goes to stderr, one line for each failure.
// Claude Code keeps stderr in its debug log.
//
// The hook never changes a branch, a worktree, or a working tree. The
// fetch changes only remote-tracking refs. `session-start` always exits 0,
// so nothing here can stop a session. `status [dir]` writes the bare line,
// for a person who debugs the hook by hand. Anything else writes the usage
// line to stderr and exits 2. `hooks.json`'s `; exit 0` absorbs that status.
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

import { discoverRepos } from '../discover.ts'
import { type GhClient, GhError, type GhResults } from '../lib/gh.ts'
import { gitLines, gitOut, type RepoOptions, runGit } from '../lib/git.ts'
import type { Output } from '../lib/streams.ts'
import { hasMatch, ownRows, type PullRequestRow } from '../prs.ts'

/** The time the whole check may take, in milliseconds. `hooks.json` gives
 *  the hook 10 seconds, so the line still arrives when the check runs out. */
export const DEADLINE_MS = 5_000

export const USAGE = 'usage: hook-io.ts {session-start|status [dir]}\n'

/** These variables name a DIFFERENT repository than the one a call is
 *  about. Every git call, and the `gh` client, get an environment without
 *  them. The list is `git rev-parse --local-env-vars`, plus `GH_REPO`, which
 *  is gh's equivalent. A session that starts inside a git hook inherits
 *  `GIT_DIR`, and `GIT_DIR` outranks both `cwd` and `git -C`.
 *
 *  This does not remove git's configuration discovery, `HOME`, or `PATH`.
 *  These choose which git and which configuration answer, and that choice
 *  belongs to the session. */
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

/** The four counts the line can show, each summed over every repository. */
export interface StatusCounts {
  readonly behind: number
  readonly prune: number
  readonly dependencies: number
  readonly alerts: number
}

/** The start of every line the hook writes. */
const PREFIX = 'gh:'

/**
 * The status line, or `null` when there is nothing to show. This and
 * {@link problemLines} are the only places that shape a line.
 *
 * A zero count is left out. `behind` shows no number. The repository count
 * comes first, only when there is more than one repository, and never
 * alone.
 */
export const statusLine = (counts: StatusCounts, repoCount: number): string | null => {
  const items: string[] = []
  if (counts.behind > 0) items.push('[behind]')
  if (counts.prune > 0) items.push(`[✂️ ${counts.prune}]`)
  if (counts.dependencies > 0) items.push(`[🤖 ${counts.dependencies}]`)
  if (counts.alerts > 0) items.push(`[🛡️ ${counts.alerts}]`)
  if (items.length === 0) return null
  if (repoCount > 1) items.unshift(`[repos: ${repoCount}]`)
  return `${PREFIX} ${items.join(' ')}`
}

/** The tools the hook needs, in the order their lines show. The hook
 *  checks each one, so this is the only list. */
const TOOLS = ['git', 'gh'] as const

/** A tool the hook needs. */
type Tool = (typeof TOOLS)[number]

/** The name the line gives each tool. A tool with no name here, or a name
 *  for a tool that is not in {@link TOOLS}, does not compile. */
const TOOL_NAMES: Readonly<Record<Tool, string>> = { git: 'git', gh: 'GitHub CLI (gh)' }

/** The line for one problem. */
const problemLine = (problem: string): string => `${PREFIX} ⚠️ ${problem}`

/**
 * The kinds of failure, in the order of their problem lines. `words` is
 * the fixed text of the line. `repos` is true when each failure of the
 * kind is about one repository. Then a folder check can say how many.
 */
const KINDS = {
  notDirectory: { words: 'not a directory', repos: false },
  unreadable: { words: 'folder could not be read', repos: false },
  origin: { words: 'origin could not be read', repos: true },
  fetch: { words: 'fetch failed', repos: true },
  defaultUnread: { words: 'default branch could not be read', repos: true },
  noDefault: { words: 'no default branch', repos: true },
  behind: { words: 'behind could not be counted', repos: true },
  branches: { words: 'branches could not be listed', repos: true },
  late: { words: 'timed out', repos: true },
  thrown: { words: 'check failed', repos: true },
  github: { words: 'GitHub request failed', repos: false },
  githubLate: { words: 'GitHub request timed out', repos: false },
  noAnswer: { words: 'GitHub gave no answer', repos: true },
  alerts: { words: 'alerts could not be read', repos: true },
  dependencies: { words: 'dependency pull requests could not be read', repos: true },
  merged: { words: 'merged pull requests could not be read', repos: true },
} as const

/** A kind of failure. */
type Kind = keyof typeof KINDS

/** One failure. `line` is its full account for stderr. `cause` is the
 *  message it came with, or `null` when it came with none. */
interface Failure {
  readonly kind: Kind
  readonly line: string
  readonly cause: string | null
}

/** The longest cause a problem line shows, in characters. */
const CAUSE_LIMIT = 80

/**
 * A short form of `cause`. It is the first line, with no `remote: `,
 * `fatal: ` or `gh: ` at the start. It stops at the first sentence end, and
 * has at most {@link CAUSE_LIMIT} characters. `; ` is a sentence end too,
 * because `lib/gh.ts` joins the reasons of its batches with it.
 */
const shortCause = (cause: string): string => {
  // A split with a limit of 1 gives the text before the first match, or
  // all of the text when there is no match.
  const first = cause.trim().split('\n', 1).join('')
  const bare = first.replace(/^(?:remote|fatal|gh): /, '')
  const sentence = bare.split(/[.;] /, 1).join('')
  return Array.from(sentence).slice(0, CAUSE_LIMIT).join('').trimEnd()
}

/**
 * One problem line for each kind that failed, in the order of
 * {@link KINDS}. `folder` is true when the check found more than one
 * repository. Then a kind about repositories says how many it hit. The
 * cause is the one the first failure of the kind came with. Failures are in
 * the order they arrive, so in a folder the cause can change between runs.
 */
const problemLines = (failures: readonly Failure[], folder: boolean): string[] =>
  (Object.keys(KINDS) as Kind[]).flatMap((kind) => {
    const hits = failures.filter((failure) => failure.kind === kind)
    const [first] = hits
    if (first === undefined) return []
    const { words, repos } = KINDS[kind]
    const count =
      folder && repos ? ` in ${hits.length} ${hits.length === 1 ? 'repo' : 'repos'}` : ''
    const cause = first.cause === null ? '' : shortCause(first.cause)
    return [problemLine(`${words}${count}${cause === '' ? '' : `: ${cause}`}`)]
  })

/**
 * A github.com remote URL, in each form git accepts. The first half is the
 * URL form with a scheme, an optional user, and an optional port. The second
 * half is the scp form, `[user@]github.com:`. Owner and name each hold only
 * letters, digits, `-`, `_` and `.`. So no part can end a quoted string in a
 * query.
 */
const GITHUB_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::[0-9]+)?\/|(?:[^@/:]+@)?github\.com:)([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i

/** `owner/name` for a github.com remote URL, or `null` for any other URL.
 *  The answer is in lower case, because GitHub ignores case in these names.
 *  So two spellings of one repository give one name, and count once. */
export const githubRepository = (url: string): string | null => {
  const match = GITHUB_URL.exec(url)
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase()
}

/** The response `session-start` writes: one JSON document on one line. The
 *  line goes in `systemMessage`, which the CLI shows to the user. There is
 *  no `additionalContext`, so the model gets nothing from this hook
 *  (`.claude/rules/path-hooks.md`). */
export const emit = (line: string): string => `${JSON.stringify({ systemMessage: line })}\n`

/**
 * The `cwd` field of a SessionStart payload, or `""` when there is none to
 * read. A malformed payload is not a failure: the caller falls back to its
 * own directory. A `cwd` that is not a string counts as absent.
 * `Array.isArray` is necessary because `typeof []` is `'object'`.
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

/** Whether `target` is a directory. Every reason it is not gives the same
 *  answer. */
const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * The path of `tool` on `env.PATH`, or `null`. This is a PATH walk, not a
 * run, so a `git` that is not executable is not on PATH.
 *
 * A directory is not a match. The executable bit on a directory is its
 * traverse bit, so a PATH entry that holds a directory named `git` would
 * otherwise pass. An empty PATH is no PATH at all. Without that check, the
 * empty string splits into one empty entry, which resolves against the
 * process's own directory.
 */
export const which = (tool: string, env: NodeJS.ProcessEnv): string | null => {
  const listed = env.PATH ?? ''
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

/** Everything the hook reads that is not a file and not git. */
export interface HookEdges {
  /** This process's own directory. It is a call, because `process.cwd()`
   *  throws for a directory that was deleted. The hook asks only when the
   *  payload names no directory. */
  readonly cwd: () => string
  readonly env: NodeJS.ProcessEnv
  /** Everything on stdin. It is a call, because only `session-start` reads
   *  it. `status` must not wait for a descriptor that nobody writes to. */
  readonly stdin: () => Promise<string>
  readonly output: Output
  /** Makes the `gh` client, from the environment the hook cleaned. */
  readonly createGh: (env: NodeJS.ProcessEnv) => GhClient
  /** The time the whole check may take, in milliseconds. */
  readonly deadlineMs: number
}

/** The namespaces that the ref lookups name in full. `--merged main` would
 *  accept a tag named `main` as easily as the branch. */
const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const ORIGIN = `${REMOTES}origin/`

/**
 * What git writes for a question with a yes or no answer. Status 0 gives
 * stdout. Status 1 gives `null`: the ref is not there. Any other end, such
 * as a time limit or a git that did not start, gives `undefined`. So a
 * failed read is never a ref that is not there.
 */
const lookUp = async (
  args: readonly string[],
  options: RepoOptions,
): Promise<string | null | undefined> => {
  const result = await runGit(args, options)
  if (result.status === 1) return null
  return result.status === 0 ? result.stdout.replace(/\n+$/, '') : undefined
}

/**
 * The default branch, without a trip to the network: the cached
 * `origin/HEAD`, else the first of `main` and `master` that exists locally.
 * `null` when there is none. `undefined` when git could not answer, because
 * then a fallback could name the wrong branch.
 */
const localDefaultBranch = async (options: RepoOptions): Promise<string | null | undefined> => {
  const ref = await lookUp(['symbolic-ref', '--quiet', `${ORIGIN}HEAD`], options)
  if (ref === undefined) return undefined
  if (ref?.startsWith(ORIGIN)) return ref.slice(ORIGIN.length)
  for (const candidate of ['main', 'master']) {
    const found = await lookUp(['show-ref', '--verify', '--quiet', `${HEADS}${candidate}`], options)
    if (found === undefined) return undefined
    if (found !== null) return candidate
  }
  return null
}

/** The field separator of the branch listing. git refuses a control
 *  character in a ref name, so the split is unambiguous. */
const FIELD = '\t'

/** A branch's own name. `%(refname:short)` is not safe: a tag with the name
 *  of a branch makes git write `heads/<name>` for that branch. Then the
 *  default branch would not match its own name, and would count. */
const SHORT = '%(refname:lstrip=2)'

/**
 * `git rev-list --count`'s answer, or `null` for anything that is not a
 * count. `null` means git failed. The empty string means git exited 0 with
 * nothing to say. Neither is a count of zero.
 */
export const parseCount = (out: string | null): number | null => {
  if (out === null || !/^[0-9]+$/.test(out)) return null
  return Number(out)
}

/** How many commits `origin/<target>` has that the local `<target>` does
 *  not. */
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
 * - `branches` is `name<tab>upstream<tab>tip<tab>head`, per local branch.
 *   `head` is the `%(HEAD)` mark, which only {@link currentOf} reads.
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
 * The default branch and the current branch never count. `current` is
 * `null` when git names no current branch.
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
  current: string | null,
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

/** The branch that `%(HEAD)` marks in the branch listing, or `null` when
 *  no branch is current. The mark comes from the same listing as the
 *  branches, so a failed read cannot hide the current branch alone. */
const currentOf = (branches: readonly string[] | null): string | null => {
  // `%(HEAD)` is the last field, and it is `*` only on the current branch.
  // The name is the first field, and a ref name holds no tab.
  for (const line of branches ?? []) {
    if (line.endsWith(`${FIELD}*`)) return line.slice(0, line.indexOf(FIELD))
  }
  return null
}

/** What one checkout says about itself, from local refs after the fetch. */
interface LocalRead {
  readonly behind: number | null
  /** `null` when no branch is current: a detached HEAD, or a branch with
   *  no commit yet. */
  readonly current: string | null
  readonly target: string
  readonly branches: string[] | null
  readonly refs: string[] | null
  readonly merged: string[] | null
}

/** One checkout whose `origin` is on GitHub. */
interface Checkout {
  readonly root: string
  readonly name: string
}

/** `text` on one line, so one failure is one line of the debug log. */
const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ')

/** Takes one failure: its kind, its line for stderr, and the message it came
 *  with, if any. */
type Failed = (kind: Kind, line: string, cause?: string) => void

/**
 * The GitHub `owner/name` of the origin of `root`, or `null` when it has no
 * origin on GitHub.
 *
 * This reads the URL git holds in its configuration first. `git remote
 * get-url` rewrites it by `insteadOf`, and a rewrite can send a github.com
 * URL to a mirror. When the configured URL is not on github.com, the
 * rewrite can be what puts it there, as `gh:owner/name` does with
 * `url.https://github.com/.insteadOf gh:`. So only then does this ask for
 * the rewritten URL.
 *
 * git exits 1 for a key that is not set: a checkout with no origin. Any
 * other failure is a problem, not a checkout with no origin.
 */
const originName = async (
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: () => number,
  failed: Failed,
): Promise<string | null> => {
  // Each call gets the time that is left, so the second call cannot run
  // past the deadline.
  const options = (): RepoOptions => ({ cwd: root, env, timeoutMs: timeoutMs() })
  const configured = await runGit(['config', '--get', 'remote.origin.url'], options())
  if (configured.status === 1) return null
  if (configured.status !== 0) {
    failed(
      'origin',
      `${root}: origin could not be read: ${oneLine(configured.stderr)}`,
      configured.stderr,
    )
    return null
  }
  const name = githubRepository(configured.stdout.replace(/\n+$/, ''))
  if (name !== null) return name
  const rewritten = await gitOut(['remote', 'get-url', 'origin'], options())
  if (rewritten === null) {
    failed('origin', `${root}: origin could not be read`)
    return null
  }
  return githubRepository(rewritten)
}

/**
 * Fetch one checkout, then read its refs. `failed` takes a line for each
 * thing that could not be read. A fetch that fails leaves the cached refs,
 * so the counts still come from them.
 */
const readCheckout = async (
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: () => number,
  failed: Failed,
): Promise<LocalRead | null> => {
  const fetched = await runGit(['fetch', '--prune', '--quiet', 'origin'], {
    cwd: root,
    env,
    timeoutMs: timeoutMs(),
  })
  if (fetched.status !== 0)
    failed('fetch', `${root}: git fetch failed: ${oneLine(fetched.stderr)}`, fetched.stderr)
  const options = { cwd: root, env, timeoutMs: timeoutMs() }
  const target = await localDefaultBranch(options)
  if (target === undefined) {
    failed('defaultUnread', `${root}: default branch could not be read`)
    return null
  }
  if (target === null) {
    failed('noDefault', `${root}: no default branch`)
    return null
  }
  const [branches, refs, merged] = await Promise.all([
    gitLines(
      [
        'for-each-ref',
        `--format=${SHORT}${FIELD}%(upstream)${FIELD}%(objectname)${FIELD}%(HEAD)`,
        HEADS,
      ],
      options,
    ),
    gitLines(['for-each-ref', '--format=%(refname)', HEADS, REMOTES], options),
    gitLines(
      ['for-each-ref', `--format=${SHORT}`, '--merged', `${ORIGIN}${target}`, HEADS],
      options,
    ),
  ])
  // With no local default branch, nothing is behind: there is nothing to
  // update. The ref listing gives that answer. A probe of its own would
  // read a failed probe as "no branch", and give 0 with no problem line.
  // When the listing failed, the count asks git, and a failure there shows.
  const behind =
    refs !== null && !refs.includes(`${HEADS}${target}`) ? 0 : await behindCount(target, options)
  return { behind, current: currentOf(branches), target, branches, refs, merged }
}

/** A version of {@link StatusCounts} that the sum can change. */
type Tally = { -readonly [K in keyof StatusCounts]: number }

/** Add the GitHub counts of each repository once, however many checkouts
 *  it has. */
const addGitHub = (
  tally: Tally,
  names: readonly string[],
  answer: GhResults['repositoryStatus'],
  failed: Failed,
): void => {
  if (answer.unavailable !== null)
    failed('github', `GitHub: ${oneLine(answer.unavailable)}`, answer.unavailable)
  for (const name of names) {
    const status = answer.repositories[name]
    if (status === undefined) {
      // A reason given already covers the repositories it cost.
      if (answer.unavailable === null) failed('noAnswer', `${name}: GitHub gave no answer`)
      continue
    }
    if (status.alerts === null) failed('alerts', `${name}: alerts could not be read`)
    else tally.alerts += status.alerts
    if (status.dependencies === null)
      failed('dependencies', `${name}: dependency pull requests could not be read`)
    else tally.dependencies += status.dependencies
    if (status.mergedPullRequests === null)
      failed('merged', `${name}: merged pull requests could not be read`)
  }
}

/** Add the local counts of one checkout. */
const addLocal = (
  tally: Tally,
  root: string,
  read: LocalRead,
  pulls: readonly PullRequestRow[] | null,
  failed: Failed,
): void => {
  if (read.behind === null) failed('behind', `${root}: behind could not be counted`)
  else tally.behind += read.behind
  const prune = countCandidates(
    read.branches,
    read.refs,
    read.merged,
    pulls,
    read.current,
    read.target,
  )
  if (prune === null) failed('branches', `${root}: branches could not be listed`)
  else tally.prune += prune
}

/** The kinds a failed task gives: one for a task that threw, one for a
 *  task that did not finish in time. */
interface TaskKinds {
  readonly thrown: Kind
  readonly late: Kind
}

const LOCAL_TASK: TaskKinds = { thrown: 'thrown', late: 'late' }
const GITHUB_TASK: TaskKinds = { thrown: 'github', late: 'githubLate' }

/** The message of a thrown value. A `GhError` keeps gh's own account in
 *  `detail`, without the command line that `message` holds. */
const causeOf = (error: unknown): string => {
  if (error instanceof GhError) return error.detail
  return error instanceof Error ? error.message : String(error)
}

/**
 * The lines for `target`, or `null` when there is nothing to show: the
 * status line, then one problem line for each kind of failure. Each failure
 * also goes to stderr, one line each. A missing tool stops every check, and
 * each missing tool gets a problem line of its own instead.
 */
const checkStatus = async (target: string, edges: HookEdges): Promise<string | null> => {
  const missing = TOOLS.filter((tool) => which(tool, edges.env) === null)
  if (missing.length > 0) {
    const problems = missing.map((tool) => `${TOOL_NAMES[tool]} not found on PATH`)
    for (const problem of problems) edges.output.err.write(`${problem}\n`)
    return problems.map(problemLine).join('\n')
  }
  const env = scrubRepositoryEnv(edges.env)
  const started = Date.now()
  const timeoutMs = (): number => Math.max(1, edges.deadlineMs - (Date.now() - started))
  const failures: Failure[] = []
  const failed: Failed = (kind, line, cause) => {
    failures.push({ kind, line, cause: cause ?? null })
  }

  // One deadline for every task. A task still open when it fires gives no
  // count. Each child also has its own time limit, from `timeoutMs`, so no
  // child stays alive long after the deadline.
  let timer: NodeJS.Timeout | undefined
  const late = Symbol('late')
  const deadline = new Promise<typeof late>((resolve) => {
    timer = setTimeout(resolve, edges.deadlineMs, late)
  })
  /** What `task` answers, or `null` and a failure when it throws or does
   *  not finish before the deadline. */
  const settle = async <T>(
    label: string,
    task: () => Promise<T>,
    kinds: TaskKinds = LOCAL_TASK,
  ): Promise<T | null> => {
    try {
      const answer = await Promise.race([task(), deadline])
      if (answer !== late) return answer as T
      failed(kinds.late, `${label}: did not finish in ${edges.deadlineMs} ms`)
    } catch (error) {
      failed(kinds.thrown, `${label}: ${oneLine(String(error))}`, causeOf(error))
    }
    return null
  }

  const tally: Tally = { behind: 0, prune: 0, dependencies: 0, alerts: 0 }
  let roots: readonly string[] = []
  let checkouts: Checkout[] = []
  try {
    // `discoverRepos` calls `realpathSync` with no guard, so it can throw.
    // That throw is a failure like any other.
    const discovered = await settle(target, () => discoverRepos(target, env))
    if (discovered?.outcome === 'not-a-directory')
      failed('notDirectory', `${target}: not a directory`)
    if (discovered?.outcome === 'unreadable')
      failed('unreadable', `${target}: ${oneLine(discovered.reason)}`, discovered.reason)
    roots = discovered?.outcome === 'ok' ? discovered.roots : []
    const named = await Promise.all(
      roots.map(async (root) => ({
        root,
        name: await settle(root, () => originName(root, env, timeoutMs, failed)),
      })),
    )
    checkouts = named.filter((checkout): checkout is Checkout => checkout.name !== null)
    const names = [...new Set(checkouts.map((checkout) => checkout.name))]

    const [answer, ...reads] = await Promise.all([
      names.length === 0
        ? null
        : settle(
            'GitHub',
            () => edges.createGh(env).repositoryStatus(names, { boundMs: timeoutMs() }),
            GITHUB_TASK,
          ),
      ...checkouts.map((checkout) =>
        settle(checkout.root, () => readCheckout(checkout.root, env, timeoutMs, failed)),
      ),
    ])
    if (answer !== null) addGitHub(tally, names, answer, failed)
    checkouts.forEach((checkout, index) => {
      const read = reads[index]
      if (read === null || read === undefined) return
      const pulls = answer?.repositories[checkout.name]?.mergedPullRequests ?? null
      addLocal(tally, checkout.root, read, pulls, failed)
    })
  } finally {
    clearTimeout(timer)
  }
  for (const failure of failures) edges.output.err.write(`${failure.line}\n`)
  const status = statusLine(tally, checkouts.length)
  const lines = [...(status === null ? [] : [status]), ...problemLines(failures, roots.length > 1)]
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * Everything on stdin, or `""` when it cannot be read at all. A descriptor
 * that fails a read is not a reason to skip the check. The hook then uses
 * its own directory.
 */
const readPayload = async (edges: HookEdges): Promise<string> => {
  try {
    return await edges.stdin()
  } catch {
    return ''
  }
}

/** The hook: argv in, an exit status out. */
export const runHookIo = async (argv: readonly string[], edges: HookEdges): Promise<number> => {
  const [mode, dir] = argv
  if (mode === 'session-start' && argv.length === 1) {
    const stated = payloadCwd(await readPayload(edges))
    const cwd = stated !== '' && isDirectory(stated) ? stated : edges.cwd()
    const line = await checkStatus(cwd, edges)
    if (line !== null) edges.output.out.write(emit(line))
    return 0
  }
  if (mode === 'status' && argv.length <= 2) {
    const line = await checkStatus(dir ?? edges.cwd(), edges)
    if (line !== null) edges.output.out.write(`${line}\n`)
    return 0
  }
  edges.output.err.write(USAGE)
  return 2
}
