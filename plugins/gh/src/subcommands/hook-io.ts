// This file is the gh plugin's SessionStart hook. It writes one status line,
// or nothing (#230):
//
//   gh: 3 repos [behind 2] [prune 1] [🤖 4] [🛡️ 1] ⚠️
//
// The hook finds the repository that holds the session's directory, or the
// repositories directly inside it (`discover.ts`). It skips a repository
// whose `origin` is not on github.com. It fetches each repository, then
// counts from local refs. One GraphQL query per five repositories reads the
// GitHub counts, at the same time as the fetches.
//
// One deadline applies to the whole check. A task that fails, or does not
// finish in time, gives no count. The line then ends with ⚠️, and the
// reason goes to stderr, one line for each failure. Claude Code keeps
// stderr in its debug log.
//
// The hook never changes a branch, a worktree, or a working tree. The
// fetch changes only remote-tracking refs. `session-start` always exits 0,
// so nothing here can stop a session. `status [dir]` writes the bare line,
// for a person who debugs the hook by hand. Anything else writes the usage
// line to stderr and exits 2. `hooks.json`'s `; exit 0` absorbs that status.
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

import { discoverRepos } from '../discover.ts'
import type { GhClient, GhResults } from '../lib/gh.ts'
import {
  currentBranch,
  defaultBranch,
  gitLines,
  gitOut,
  hasRef,
  type RepoOptions,
  runGit,
} from '../lib/git.ts'
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
   *  throws for a directory that was deleted, and the hook asks only when
   *  the payload names no directory. */
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

/**
 * The default branch, without a trip to the network: the cached
 * `origin/HEAD`, else the first of `main` and `master` that exists locally.
 */
const localDefaultBranch = async (options: RepoOptions): Promise<string | null> => {
  const ref = await defaultBranch(options)
  if (ref !== null) return ref
  for (const candidate of ['main', 'master']) {
    if (await hasRef(`refs/heads/${candidate}`, options)) return candidate
  }
  return null
}

/** The namespaces that the ref lookups name in full. `--merged main` would
 *  accept a tag named `main` as easily as the branch. */
const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const ORIGIN = `${REMOTES}origin/`

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

/** What one checkout says about itself, from local refs after the fetch. */
interface LocalRead {
  readonly behind: number | null
  /** `null` when git names no current branch, as on a branch with no
   *  commit yet. */
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

/**
 * Fetch one checkout, then read its refs. `failed` takes a line for each
 * thing that could not be read. A fetch that fails leaves the cached refs,
 * so the counts still come from them.
 */
const readCheckout = async (
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: () => number,
  failed: (line: string) => void,
): Promise<LocalRead | null> => {
  const fetched = await runGit(['fetch', '--prune', '--quiet', 'origin'], {
    cwd: root,
    env,
    timeoutMs: timeoutMs(),
  })
  if (fetched.status !== 0) failed(`${root}: git fetch failed: ${oneLine(fetched.stderr)}`)
  const options = { cwd: root, env, timeoutMs: timeoutMs() }
  const target = await localDefaultBranch(options)
  if (target === null) {
    failed(`${root}: no default branch`)
    return null
  }
  const [current, hasLocal, branches, refs, merged] = await Promise.all([
    currentBranch(options),
    hasRef(`${HEADS}${target}`, options),
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
  // With no local default branch, nothing is behind: there is nothing to
  // update.
  const behind = hasLocal ? await behindCount(target, options) : 0
  return { behind, current, target, branches, refs, merged }
}

/** A version of {@link StatusCounts} that the sum can change. */
type Tally = { -readonly [K in keyof StatusCounts]: number }

/** Add the GitHub counts of each repository once, however many checkouts
 *  it has. */
const addGitHub = (
  tally: Tally,
  names: readonly string[],
  answer: GhResults['repositoryStatus'],
  failed: (line: string) => void,
): void => {
  if (answer.unavailable !== null) failed(`GitHub: ${oneLine(answer.unavailable)}`)
  for (const name of names) {
    const status = answer.repositories[name]
    if (status === undefined) {
      // A reason given already covers the repositories it cost.
      if (answer.unavailable === null) failed(`${name}: GitHub gave no answer`)
      continue
    }
    if (status.alerts === null) failed(`${name}: alerts could not be read`)
    else tally.alerts += status.alerts
    if (status.dependencies === null) failed(`${name}: dependency pull requests could not be read`)
    else tally.dependencies += status.dependencies
    if (status.mergedPullRequests === null)
      failed(`${name}: merged pull requests could not be read`)
  }
}

/** Add the local counts of one checkout. */
const addLocal = (
  tally: Tally,
  root: string,
  read: LocalRead,
  pulls: readonly PullRequestRow[] | null,
  failed: (line: string) => void,
): void => {
  if (read.behind === null) failed(`${root}: behind could not be counted`)
  else tally.behind += read.behind
  const prune = countCandidates(
    read.branches,
    read.refs,
    read.merged,
    pulls,
    read.current,
    read.target,
  )
  if (prune === null) failed(`${root}: branches could not be listed`)
  else tally.prune += prune
}

/**
 * The status line for `target`, or `null` when there is nothing to show.
 * Each failure goes to stderr, one line each.
 */
const checkStatus = async (target: string, edges: HookEdges): Promise<string | null> => {
  if (which('git', edges.env) === null) {
    edges.output.err.write('git is not on PATH\n')
    return null
  }
  const env = scrubRepositoryEnv(edges.env)
  const started = Date.now()
  const timeoutMs = (): number => Math.max(1, edges.deadlineMs - (Date.now() - started))
  const failures: string[] = []
  const failed = (line: string): void => {
    failures.push(line)
  }

  // One deadline for every task. A task still open when it fires gives no
  // count. Each child also has its own time limit, from `timeoutMs`, so no
  // child stays alive long after the deadline.
  let timer: NodeJS.Timeout | undefined
  const late = Symbol('late')
  const deadline = new Promise<typeof late>((resolve) => {
    timer = setTimeout(resolve, edges.deadlineMs, late)
  })
  /** What `task` answers, or `null` and a failure line when it throws or
   *  does not finish before the deadline. */
  const settle = async <T>(label: string, task: () => Promise<T>): Promise<T | null> => {
    try {
      const answer = await Promise.race([task(), deadline])
      if (answer !== late) return answer as T
      failed(`${label}: did not finish in ${edges.deadlineMs} ms`)
    } catch (error) {
      failed(`${label}: ${oneLine(String(error))}`)
    }
    return null
  }

  const tally: Tally = { behind: 0, prune: 0, dependencies: 0, alerts: 0 }
  let checkouts: Checkout[] = []
  try {
    // `discoverRepos` calls `realpathSync` with no guard, so it can throw.
    // That throw is a failure like any other.
    const discovered = await settle(target, () => discoverRepos(target, env))
    if (discovered?.outcome === 'not-a-directory') failed(`${target}: not a directory`)
    if (discovered?.outcome === 'unreadable') failed(`${target}: ${oneLine(discovered.reason)}`)
    const roots = discovered?.outcome === 'ok' ? discovered.roots : []
    // The URL git holds in its configuration, not `git remote get-url`,
    // which rewrites it by `insteadOf`.
    const named = await Promise.all(
      roots.map(async (root) => {
        const url = await gitOut(['config', '--get', 'remote.origin.url'], {
          cwd: root,
          env,
          timeoutMs: timeoutMs(),
        })
        return { root, name: githubRepository(url ?? '') }
      }),
    )
    checkouts = named.filter((checkout): checkout is Checkout => checkout.name !== null)
    const names = [...new Set(checkouts.map((checkout) => checkout.name))]

    const [answer, ...reads] = await Promise.all([
      names.length === 0
        ? null
        : settle('GitHub', () =>
            edges.createGh(env).repositoryStatus(names, { boundMs: timeoutMs() }),
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
  for (const line of failures) edges.output.err.write(`${line}\n`)
  return statusLine(tally, checkouts.length, failures.length > 0)
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
