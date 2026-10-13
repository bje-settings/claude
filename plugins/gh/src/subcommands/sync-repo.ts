// This file syncs one checkout. It moves to the default branch,
// fast-forwards it, and installs if a lock file changed. It also prunes
// branches whose work has landed. It is the port of
// `plugins/gh/scripts/gh-sync-repo.py`. Its report is a byte-pinned contract
// (`tests/plugins/gh/fixtures/bash-output.json`, captured from the shell version before
// the port deleted it). `tests/plugins/gh/subcommands/sync-repo.parity.test.ts` asserts that contract line for
// line.
//
// Exit status is 0 for a synced repository, and also for a skipped one. A
// skip is a normal outcome, not a failure. Exit status 2 means this command
// refused an argument.
//
// **Three differences from the Python, each forced by the port's own rules.**
//
//  1. *Nothing changes directory.* The Python `os.chdir`s into the checkout
//     and lets every git call inherit it. `sync` now fans out IN-PROCESS, by
//     the approved plan, because an injected `gh` mock cannot cross a
//     process boundary. Several repositories share one process and cannot
//     each own the working directory, so every git call names its own
//     `cwd`. The Python reports two `chdir` failures. This port answers
//     "cannot enter directory" with a check for whether the path is a
//     directory at all. It has no counterpart for "cannot enter work tree",
//     because nothing here enters a work tree.
//  2. *No `shutil.which` preflight.* This port reads "git is not on PATH"
//     and "cannot run git" off the runner's `startFailure` instead. This
//     separates the two cases for the same two sentences (`lib/README.md`,
//     "could not start apart from ran and failed").
//  3. *pnpm only* (the maintainer's ruling, 2026-09-20). `install.ts` knows
//     one lock file and one command. It still keeps the branch that reports
//     no recognized lock file. That branch is ready for the future pull
//     request that deletes `pnpm-lock.yaml`.
//
// **#127 deleted the Python this file ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from
// the tree. The file and line references below point to what they held at
// `cd0d515`. This file keeps them because each one says where a rule came
// from.
import { statSync } from 'node:fs'
import path from 'node:path'

import { installDeps, LOCKFILES, NO_LOCKFILE } from '../install.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError } from '../lib/gh.ts'
import {
  currentBranch,
  gitLines,
  gitOk,
  gitOut,
  hasRef,
  type RepoOptions,
  defaultBranch as readDefaultBranch,
  runGit,
} from '../lib/git.ts'
import type { Output, Writer } from '../lib/streams.ts'
import {
  isOid,
  isPullRequestRow,
  mergeCommitOf,
  ownRows,
  type PullRequestRow,
  pullRefOf,
} from '../prs.ts'

/** The bulk lookup: one API call covers every branch in the repository. When
 *  a window this size comes back full, it is a window, not an answer. This
 *  file records that state as {@link SyncRepoRun}'s `prBulkSaturated`. */
const PR_LIMIT = 200

/** The per-branch fallback. This file asks it only for a branch the
 *  saturated bulk window could not settle. It is smaller because it is
 *  scoped to one head ref. "Saturated" means the same thing here: too many
 *  merged pull requests share the name to prove anything about this commit. */
const PR_BRANCH_LIMIT = 100

/** The markers git leaves behind mid-operation. This file checks every
 *  worktree, not just this one. A rebase in a linked worktree leaves its
 *  HEAD detached. That worktree then contributes no branch mapping later,
 *  so its branch would otherwise look free to delete. */
const IN_PROGRESS_MARKERS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
]

export const USAGE = 'usage: gh.ts sync-repo [--dry-run] [--no-install] <repo-path>'

export const HELP = `Sync one checkout: move to the default branch, fast-forward, install if a lock
file changed, and prune branches whose work has landed.

Usage:
  gh.ts sync-repo [--dry-run] [--no-install] <repo-path>

Flags may also arrive as GH_SYNC_DRY_RUN=1 / GH_SYNC_NO_INSTALL=1, which is how
gh.ts sync passes them to the jobs it runs one per repository.

Only pnpm is installed for. A checkout whose lock file is yarn.lock or
package-lock.json is synced as a repository with no dependencies to install.

Exit status is 0 for a synced repo AND for a skipped one: skipping is a normal
outcome, not a failure. 2 means the arguments were refused.`

/** Everything a command function is given: the process's edges, as
 *  arguments.
 *
 *  `sync.ts` and `scripts/gh.ts` share this shape. It lets both commands
 *  dispatch through one signature, and lets a test drive either with no
 *  process at all (ADR 001, "the command function is the seam"). `createGh`
 *  is a factory, not a client, because the fan-out needs one client per
 *  repository, each scoped to that checkout. */
export interface CommandContext {
  /** The directory the caller started in, which is `sync`'s default target. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly createGh: (cwd: string) => GhClient
}

export type Command = (
  argv: readonly string[],
  context: CommandContext,
) => Promise<Envelope<string>>

/** One repository's job. `report` is where its lines go: the process's
 *  stdout for a single repository, or a buffer of its own for each job in a
 *  fan-out. This keeps the sections from interleaving. */
export interface SyncRepoOptions {
  readonly repo: string
  readonly dryRun: boolean
  readonly noInstall: boolean
  readonly env: NodeJS.ProcessEnv
  readonly createGh: (cwd: string) => GhClient
  readonly report: Writer
}

/**
 * The vocabulary of a report line. This file names each term here. It does
 * not write the term out again at each call site that builds a line.
 *
 * No other code reads the report since #230: the SessionStart hook counts
 * from git refs and GitHub, not from this text.
 *
 * `marks` are the three line prefixes, indent included. The indent is what
 * tells a repository's lines from the heading above them. The rest are the
 * openings of lines: `skipped` in every mode, and the `would` notes of a
 * `--dry-run`.
 */
export const REPORT = {
  ok: '  ✓ ',
  bad: '  ✗ ',
  note: '  · ',
  /** What a skipped repository says, after the {@link REPORT.bad} mark. */
  skipped: 'skipped: ',
  /** The two notes that mean the default branch would move. */
  wouldFastForward: 'would fast-forward ',
  wouldCreate: 'would create ',
  /** The two notes that mean a branch would go. */
  wouldDelete: 'would delete ',
  wouldRemoveWorktree: 'would remove worktree ',
} as const

/** An env flag as `sync` sets it: "1" on, "0" or unset off. */
export const flagIsSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const value = env[name] ?? '0'
  return value !== '' && value !== '0'
}

/** The last line of a command's output, the way `"${var##*$'\n'}"` read it.
 *  This uses `slice(-1).join('')`, not an index. An empty transcript then
 *  answers with an empty line, not a fallback that no test can reach. */
const lastLine = (text: string): string => text.replace(/\n+$/, '').split('\n').slice(-1).join('')

/**
 * Why a `gh` failure could not be read. This uses the vocabulary that
 * `gh-sync-repo.py:263` to `290` prints.
 *
 * Only 127 is spelled here. The runner answers 127 for a command that is
 * not there. That one case keeps the Python's own sentence, so a reader who
 * has seen it before will recognise it. Everything else reaches the report
 * through `GhError.detail`. This includes an unrunnable gh (126), a
 * refusal, a silent non-zero exit, and an answer that is not JSON.
 * `GhError.detail`'s last line is gh's own last line, when gh said anything
 * at all.
 *
 * That is the same rule the Python applies to a multi-line stderr. It means
 * the wording for those arms now belongs to `lib/gh.ts`, not this file.
 * `tests/plugins/gh/fixtures/divergences.json` lists each one.
 *
 * This uses `detail`, not `message`. The message carries a
 * `gh <argv> failed: ` prefix. gh's ordinary refusal is a SINGLE line of
 * stderr (for example, "gh: API rate limit exceeded"). If the code used
 * only the tail of the message, that would put the whole argv inside this
 * report line. Only a multi-line stderr would then happen to read like the
 * Python's. `detail` is gh's own account, with no prefix, so the one-line
 * case reads like the Python's too.
 */
const reasonFor = (error: GhError): string =>
  error.status === 127 ? 'gh is not on PATH' : lastLine(error.detail)

/** Whether `target` is a directory. This is as much of `os.chdir` as a port
 *  that never changes directory needs to ask. */
const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** A gh answer, or the reason it could not be read. */
type Asked<T> = { readonly value: T } | { readonly reason: string }

/** Merged pull requests, or the reason they could not be read. */
type Listed = { readonly rows: PullRequestRow[] } | { readonly reason: string }

/** What the proof established. Every state but `match` is a reason to keep
 *  a branch, but each is a different statement, and the report says which
 *  one applies. A failed query reported as "none" would wrongly assert an
 *  absence that the code never checked. `unfetched` and `unprobed` are the
 *  git failures: a fetch that failed, and a probe that could not answer. */
type ProofState = 'match' | 'moved' | 'none' | 'crowded' | 'error' | 'unfetched' | 'unprobed'

/** The order in which one state outranks another. A state can only be
 *  raised, never reset, so a fact that one signal found survives the
 *  failure of the next. `error` replaces only `none`: a "moved" verdict is
 *  a fact that a failed query does not undo. A git failure outranks
 *  `moved`, because "none at this commit" is a claim that the failed probe
 *  never checked. */
const RANK: Record<ProofState, number> = {
  none: 0,
  error: 1,
  moved: 2,
  unfetched: 3,
  unprobed: 3,
  crowded: 4,
  match: 5,
}

/** The state that outranks the other. On a tie, the first stays. */
const stronger = (held: ProofState, found: ProofState): ProofState =>
  RANK[found] > RANK[held] ? found : held

/** What {@link SyncRepoRun.advance} did. This is a union, not a triple, so a
 *  caller that reads `target` has already confirmed there is one. */
type Advance =
  | { readonly canAdvance: false }
  | {
      readonly canAdvance: true
      /** The short SHA of `origin/<default>`, the commit the branch moves
       *  to. */
      readonly target: string
      /** The short SHA the branch actually moved off, or `null` when it did
       *  not move. That covers: already up to date, diverged, a failed
       *  merge, or a branch that does not exist yet. The caller reads this
       *  value as the answer to "is there a range to diff for a lock
       *  file?" */
      readonly advancedFrom: string | null
    }

/** One checkout's sync, from preflight to prune. */
class SyncRepoRun {
  private readonly repo: string
  private readonly dryRun: boolean
  private readonly noInstall: boolean
  private readonly env: NodeJS.ProcessEnv
  private readonly report: Writer
  private readonly gh: GhClient
  /** Refined to the work tree name once the checkout root is resolved. */
  private name: string
  private headerPrinted = false
  private top = ''
  private defaultBranch = ''
  private tip = ''
  /** branch -> worktree path. Filled once the prune section is reached. */
  private readonly worktrees = new Map<string, string>()
  /** Pull-request state, all of it "unknown" until the bulk lookup runs. */
  private prLookupOk = false
  private prOwn: PullRequestRow[] = []
  private prBulkSaturated = false
  private prFallbackOff = false
  private prUnchecked = 0
  /** Each fetch the proof made, by ref. The per-branch query can name a row
   *  that the bulk window already named, and a ref is fetched only once. */
  private readonly fetches = new Map<string, Promise<boolean>>()

  constructor(options: SyncRepoOptions) {
    this.repo = options.repo
    this.dryRun = options.dryRun
    this.noInstall = options.noInstall
    this.env = options.env
    this.report = options.report
    this.name = path.basename(options.repo)
    // This uses the path the caller named, not the checkout root, because
    // the root is not known yet. gh resolves the repository by walking up
    // from its working directory, so both answer about the same repository.
    // A path that turns out not to be a checkout never reaches a gh call at
    // all.
    this.gh = options.createGh(options.repo)
  }

  // ------------------------------------------------------------- output ---

  // Each of the three prints the repository's name first, if nothing has
  // printed it yet. A report whose lines sit under no heading names no
  // repository at all. The fan-out prints one of these sections after
  // another.
  private ok(text: string): void {
    this.ensureHeader()
    this.emit(`${REPORT.ok}${text}`)
  }

  private bad(text: string): void {
    this.ensureHeader()
    this.emit(`${REPORT.bad}${text}`)
  }

  private note(text: string): void {
    this.ensureHeader()
    this.emit(`${REPORT.note}${text}`)
  }

  private ensureHeader(): void {
    if (this.headerPrinted) return
    this.headerPrinted = true
    this.emit(this.name)
  }

  /** One report line. A reader that has gone away stops the output only.
   *  The writer stays quiet on a broken pipe, and the sync carries on to
   *  the end. A run abandoned there leaves the prune half done, with `git
   *  worktree prune` never called. It exits 0, so nothing reports that
   *  (`gh-sync-repo.py:157`; `lib/streams.ts` is where that now lives). */
  private emit(text: string): void {
    this.report.write(`${text}\n`)
  }

  // --------------------------------------------------------------- git ---

  /** git in one directory, with the environment named at the call
   *  (`lib/README.md`: `GIT_DIR` outranks both `cwd` and `git -C`). */
  private at(directory: string): RepoOptions {
    return { cwd: directory, env: this.env }
  }

  /** The options for the checkout root, which is where every call after the
   *  preflight runs. */
  private get here(): RepoOptions {
    return this.at(this.top)
  }

  // ---------------------------------------------------------- preflight ---

  /** The name of the marker git left in `directory`, or "" for none. */
  private async checkInProgress(directory: string): Promise<string> {
    const gitdir = await gitOut(['rev-parse', '--git-dir'], this.at(directory))
    if (gitdir === null) return ''
    // Relative for the main work tree, absolute for a linked one.
    const resolved = path.isAbsolute(gitdir) ? gitdir : path.join(directory, gitdir)
    for (const marker of IN_PROGRESS_MARKERS) {
      if (isPresent(path.join(resolved, marker))) return marker
    }
    return ''
  }

  /** Whether a linked worktree, other than the checkout root itself, is
   *  mid-operation. This answers with the reason to skip, or `null` to
   *  carry on. It fails closed. An unreadable worktree list is a skip.
   *  That is the same answer {@link readWorktrees} gives for the same
   *  failure, because a hidden operation must never look free.
   *
   *  This reads `git worktree list --porcelain` itself, and so does
   *  {@link readWorktrees}, later. A round 1 review (#218) proved why
   *  neither read can replace the other. A fetch, an install, and a gh
   *  call sit between this read and the prune loop. Any of them can take
   *  long enough for someone to switch a linked worktree to another
   *  branch.
   *
   *  A map from this read alone would then be stale exactly where
   *  {@link readWorktrees} needs it fresh. Git's own worktree-remove
   *  refusal does not catch that. It refuses only a tracked change, never
   *  a file `.gitignore` excludes. So this read exists to skip early,
   *  before any fetch. It answers no question {@link readWorktrees} still
   *  needs answered. */
  private async linkedWorktreeInProgress(): Promise<string | null> {
    const out = await gitOut(['worktree', 'list', '--porcelain'], this.here)
    if (out === null) return 'cannot list worktrees'
    let current = ''
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      current = line.slice('worktree '.length)
      if (current === this.top) continue
      const marker = await this.checkInProgress(current)
      if (marker !== '') return `git operation in progress in ${current} (${marker})`
    }
    return null
  }

  /** Refuse before anything is written, or resolve the checkout root. Answers
   *  with the reason to skip, or `null` to carry on. */
  private async preflight(): Promise<string | null> {
    if (!isDirectory(this.repo)) return 'cannot enter directory'

    const probe = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: this.repo,
      env: this.env,
    })
    if (probe.startFailure !== null) {
      // This is named for what it is. Every git call below would fail. If
      // the code reported the first one as "not a git repository", the
      // reader would inspect a checkout that is fine. "On PATH and still
      // unrunnable" is its own sentence: not executable, a bad interpreter
      // line, or an exec format the system cannot load.
      return probe.startFailure.code === 'ENOENT'
        ? 'git is not on PATH'
        : `cannot run git: ${probe.startFailure.message}`
    }
    const top = probe.stdout.replace(/\n+$/, '')
    // This code keeps both halves, as `gh-sync-repo.py:210` does. Real git
    // refuses `rev-parse --show-toplevel` outside a work tree with a
    // status, not with an empty answer. But a `git` on PATH that exits 0
    // and prints nothing is a shape a caller can arrange. CI reached
    // exactly this shape. Without the second half, the run would carry on
    // with no checkout root at all. It would then report "already up to
    // date ()" about a repository it never found.
    if (probe.status !== 0 || top === '') return 'not a git repository'
    this.top = top
    this.name = path.basename(this.top)

    if (!(await gitOk(['remote', 'get-url', 'origin'], this.here))) return "no 'origin' remote"

    const marker = await this.checkInProgress(this.top)
    if (marker !== '') return `git operation in progress (${marker})`

    // #218 finding 6: this also runs here, before the fetch and the
    // advance below. readWorktrees checks again, right before the prune
    // loop. A stopped rebase in another worktree must block the whole
    // sync on sight. This checkout's own in-progress marker, above, does
    // the same.
    const linked = await this.linkedWorktreeInProgress()
    if (linked !== null) return linked

    // Untracked files deliberately do not block this. Checkout,
    // fast-forward, and branch deletion cannot touch them. Only tracked
    // modifications and staged changes block it. A failed probe must not
    // read as clean. That is why `null` and `""` are different answers
    // here: a corrupt or unreadable index exits non-zero with empty stdout.
    const dirty = await gitOut(['status', '--porcelain', '--untracked-files=no'], this.here)
    if (dirty === null) return 'cannot read the working tree state'
    if (dirty !== '') return 'uncommitted changes'
    return null
  }

  // ---------------------------------------------------- default branch ---

  private async resolveDefaultBranch(): Promise<string | null> {
    let named = await readDefaultBranch(this.here)
    // This checks truthiness, not `null`, because `gh-sync-repo.py:241` and
    // `:247` use `if not ref` and `if ref:`. A `git` that exits 0 and
    // prints nothing has named no default branch. If this code read `""`
    // as a name, it would skip the repair, the gh fallback, and the
    // main/master fallback. It would then report about a branch called
    // nothing: `skipped: origin/ does not exist locally`. This is the same
    // shape as the empty checkout root that CI reached (`discover.py:66`).
    if (!named && !this.dryRun) {
      // A repair of origin/HEAD writes a ref, so this code skips it in
      // --dry-run. The fallbacks below answer the same question and never
      // touch the repository.
      await gitOk(['remote', 'set-head', 'origin', '--auto'], this.here)
      named = await readDefaultBranch(this.here)
    }
    if (named) return named

    const view = await this.ask(() => this.gh.viewRepository())
    if ('value' in view) {
      const ref = view.value.defaultBranchRef
      if (typeof ref === 'object' && ref !== null) {
        const name = (ref as { name?: unknown }).name
        if (typeof name === 'string' && name !== '') return name
      }
    }

    for (const candidate of ['main', 'master']) {
      if (await hasRef(`refs/remotes/origin/${candidate}`, this.here)) return candidate
    }
    return null
  }

  // --------------------------------------------------------------- gh ---

  /**
   * A gh call's answer, or the reason it could not be read.
   *
   * This is the port of `gh_json` (`gh-sync-repo.py:263`). It follows the
   * original rule: "a missing gh is one of those failures rather than a
   * crash: the caller falls back to ancestry and says so". Only a
   * `GhError` counts as an answer, because only `lib/gh.ts` throws one.
   * Anything else that reaches here is this code, or the test double,
   * reporting something that went wrong but is not gh's own refusal. If
   * this code swallowed that error, a command that asked for an endpoint
   * nobody registered would read the silence as an empty window.
   */
  private async ask<T>(call: () => Promise<T>): Promise<Asked<T>> {
    try {
      return { value: await call() }
    } catch (error) {
      if (error instanceof GhError) return { reason: reasonFor(error) }
      throw error
    }
  }

  /** Merged pull requests into any base, or the reason they could not be
   *  read. There is no base filter (#348): a stacked pull request keeps its
   *  parent branch as its base after it merges. Each row's merge commit
   *  proves where it landed instead ({@link rowProof}). */
  private async prList(limit: number, head?: string): Promise<Listed> {
    const asked = await this.ask(() => this.gh.listMergedPullRequests({ limit, head }))
    if ('reason' in asked) return asked
    // Every reader below asks a row for a field. A payload that is a list of
    // something else is not an answer about merged pull requests. It takes
    // the same route as a failed query. This code never reads it as an
    // empty window. (`lib/gh.ts` checks "is this a list at all" on its
    // own; that check reaches here as a `GhError`.)
    if (!asked.value.every(isPullRequestRow)) {
      return { reason: 'gh returned rows that are not pull requests' }
    }
    return { rows: asked.value }
  }

  // ------------------------------------------------------------ advance ---

  private async fetch(): Promise<boolean> {
    this.ensureHeader()
    if (!(await gitOk(['fetch', '--prune', 'origin'], this.here))) {
      this.bad('fetch failed; nothing changed')
      return false
    }
    return true
  }

  /**
   * Checkout and fast-forward.
   *
   * The default branch may be checked out in another worktree. In that
   * case, the checkout cannot succeed. That is not fatal, because the
   * prune still has value on its own. The caller carries on with
   * `canAdvance` false.
   */
  private async advance(): Promise<Advance> {
    const branch = this.defaultBranch
    // An unborn HEAD, or a probe that could not run at all, has no branch
    // name to report. "HEAD" is what git itself echoes there, and what the
    // shell version printed. It keeps a `null` out of the "switched from
    // ..." line. This code uses `||`, not `??`: `gh-sync-repo.py:349` uses
    // `or "HEAD"`. So an empty answer is no answer here either, and `""`
    // would name no branch in the line below.
    const current = (await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], this.here)) || 'HEAD'

    if (current !== branch) {
      if (this.dryRun) {
        this.note(`would switch from ${current} to ${branch}`)
      } else if (await gitOk(['checkout', branch], this.here)) {
        this.ok(`switched from ${current} to ${branch}`)
      } else {
        this.bad(`cannot switch to ${branch} (checked out elsewhere?); pruning only`)
        return { canAdvance: false }
      }
    }

    // `tip` is the same commit in full. It is already verified to exist, so
    // it is the honest fallback if the abbreviation itself cannot be read.
    // A shorter name for a commit is only a convenience. To print `null`
    // instead would be a lie in every line that quotes it.
    const target =
      (await gitOut(['rev-parse', '--short', `origin/${branch}`], this.here)) || this.tip
    if (!(await hasRef(`refs/heads/${branch}`, this.here))) {
      // This code only reaches this line in --dry-run, where the checkout
      // above did not run.
      this.note(`${REPORT.wouldCreate}${branch} from origin/${branch} (${target})`)
      return { canAdvance: true, target, advancedFrom: null }
    }

    // This code always compares the default branch itself, never HEAD. In
    // --dry-run, nothing has switched, so HEAD is still whatever branch the
    // user was on. This uses the same fallback as `target`. The branch was
    // just verified to exist, so an unreadable abbreviation still has a
    // full SHA behind it. This code both prints that value and uses it as
    // the left end of the lock-file diff.
    //
    // It uses `||`, not `??`. This matches `gh-sync-repo.py:381`'s `or`: an
    // empty abbreviation falls through to the full form. The `null` test
    // below stays unchanged, because Python's `or` answers with the SECOND
    // value, whatever it is. So only a second failure counts as "no left
    // end".
    const before =
      (await gitOut(['rev-parse', '--short', branch], this.here)) ||
      (await gitOut(['rev-parse', branch], this.here))
    let moved: string
    if (before === null) {
      // Both forms failed, so there is no left end. There is nothing to
      // compare with the target, nothing honest to print as a range, and
      // nothing to diff a lock file over. This code reports it the same
      // way it reports a failed lock-file diff, because both share one
      // consequence: a checkout that may end up on new code with stale
      // dependencies. To skip the install without a word would be the
      // silent half of that. The branch still advances, because that part
      // does not need the old tip.
      this.bad(`could not read the tip of ${branch}; install by hand if a lock file changed`)
      moved = `${branch} to ${target}`
    } else {
      moved = `${branch} ${before}..${target}`
    }

    if (before === target) {
      this.note(`${branch} already up to date (${before})`)
    } else if (
      !(await gitOk(['merge-base', '--is-ancestor', branch, `origin/${branch}`], this.here))
    ) {
      this.bad(`${branch} has diverged from origin/${branch}; needs a manual merge`)
    } else if (this.dryRun) {
      this.note(`${REPORT.wouldFastForward}${moved}`)
      // `before` is `null` here only when it could not be read. The caller
      // reads that as "no range to diff", which is exactly right.
      return { canAdvance: true, target, advancedFrom: before }
    } else if (await gitOk(['merge', '--ff-only', `origin/${branch}`], this.here)) {
      this.ok(`fast-forwarded ${moved}`)
      return { canAdvance: true, target, advancedFrom: before }
    } else {
      this.bad(`could not fast-forward ${branch}`)
    }
    return { canAdvance: true, target, advancedFrom: null }
  }

  /** Installs if the range the branch moved over touched the lock file.
   *  This diffs the range instead of a hash of files on disk, so --dry-run
   *  can answer even when nothing has merged yet. */
  private async install(advancedFrom: string, target: string): Promise<void> {
    const changed = await gitOut(
      ['diff', '--name-only', advancedFrom, target, '--', ...LOCKFILES],
      this.here,
    )
    if (changed === null) {
      // A failed diff is not "no lock file changed". If this code treated
      // it that way, the checkout would end up on new code with stale
      // dependencies, with no sign anything was missed. That is the silent
      // half of this failure.
      this.bad('could not diff the lock files over that range; install by hand if needed')
      return
    }
    if (changed === '') return
    if (this.dryRun) {
      this.note('lock file changed in that range; would run install')
      return
    }
    const installed = await installDeps(this.top, this.env)
    if (installed.status === 0) {
      this.ok('lock file changed; dependencies installed')
    } else if (installed.status === NO_LOCKFILE) {
      this.note('lock file changed but no recognised lock file remains; nothing installed')
    } else {
      // The reason matters here. A missing package manager, a lock file
      // out of sync with package.json, and a registry outage all land on
      // this line.
      this.bad(`install failed (${lastLine(installed.log)}); run it by hand`)
    }
  }

  // -------------------------------------------------------- merge proof ---

  /** The bulk pull-request window and the ancestry set. This answers with
   *  the ancestry list, or `null` when it could not be read. A failure of
   *  one signal is reported, and the other carries on.
   *
   *  The ancestry list holds names, read minutes before the prune loop. It
   *  only selects the branches to probe. {@link proofFor} proves ancestry
   *  for the SHA that the prune loop read (#248). */
  private async readMergeProof(): Promise<string[] | null> {
    const listed = await this.prList(PR_LIMIT)
    if ('reason' in listed) {
      this.note(`could not read merged pull requests (${listed.reason}); using ancestry alone`)
    } else {
      this.prLookupOk = true
      // A saturated window is a window, not an answer. A repository with
      // more merged pull requests than the limit drops the oldest rows. So
      // a branch merged before that point is absent from the list, even
      // though it is still merged.
      this.prBulkSaturated = listed.rows.length >= PR_LIMIT
      this.prOwn = ownRows(listed.rows)
    }

    // Ancestry catches the other case: a branch merged locally with no
    // pull request at all. A failed probe must not read as "nothing is
    // merged". That would silently reduce the proof to the pull-request
    // signal alone.
    const ancestry = await gitLines(
      [
        'branch',
        '--merged',
        `refs/remotes/origin/${this.defaultBranch}`,
        '--format=%(refname:short)',
      ],
      this.here,
    )
    if (ancestry === null) this.note('could not read merged branches; using pull requests alone')
    return ancestry
  }

  /**
   * Ask about a single branch, for the case the bulk window cannot answer.
   *
   * The state can only be raised here, never reset. A "moved" verdict from
   * the bulk list is a fact that this call's failure does not undo.
   */
  private async prProofForBranch(
    branch: string,
    sha: string,
    state: ProofState,
  ): Promise<{ proved: boolean; state: ProofState }> {
    const listed = await this.prList(PR_BRANCH_LIMIT, branch)
    if ('reason' in listed) {
      return { proved: false, state: state === 'none' ? 'error' : state }
    }
    const own = ownRows(listed.rows)
    const here = await this.rowsProof(own, branch, sha, true)
    const found =
      here === 'match' ? here : stronger(here, await this.rowsProof(own, branch, sha, false))
    if (found === 'match') return { proved: true, state: 'match' }
    // A saturated result is a window, not an answer. To conclude "none at
    // this commit" from a truncated list is the mistake this guard exists
    // to fix.
    if (listed.rows.length >= PR_BRANCH_LIMIT) return { proved: false, state: 'crowded' }
    return { proved: false, state: stronger(state, found) }
  }

  /**
   * What the rows that name this branch prove. `atTip` selects the rows at
   * this commit, or the rows at another commit. {@link proofFor} asks for
   * the first set before the ancestry probe, and for the second set after
   * it. {@link prProofForBranch} asks for both sets. Only the second set can
   * need a fetch, of a pull request head.
   */
  private async rowsProof(
    rows: readonly PullRequestRow[],
    branch: string,
    sha: string,
    atTip: boolean,
  ): Promise<ProofState> {
    let found: ProofState = 'none'
    for (const row of rows) {
      if (row.headRefName !== branch || (row.headRefOid === sha) !== atTip) continue
      const proof = await this.rowProof(row, sha)
      if (proof === 'match') return proof
      found = stronger(found, proof)
    }
    return found
  }

  /**
   * What one merged row proves about the commit `sha`.
   *
   * The row's merge commit must be on `origin/<default>` (#348). A row that
   * fails it proves nothing. This also refuses a merge into a parent branch
   * that never landed.
   *
   * A head at another commit proves the branch when `git cherry` finds a
   * patch-equal commit in the head for each commit of the branch (#351,
   * #450). A tip behind the head has no commit outside the head, so
   * `git cherry` lists none. A tip that the remote rebased finds each one.
   * A local commit with no match gives a `+` line, and the branch stays.
   * The lines must also match the count of commits in the range. So an
   * answer that lost its lines is never read as a proof.
   *
   * A patch id ignores whitespace. So a local commit that differs from the
   * head only in whitespace counts as patch-equal.
   *
   * `git cherry` skips merge commits. A local merge that the head does not
   * hold can carry its own changes, a conflict fix for example. So such a
   * merge keeps the branch before `git cherry` runs.
   */
  private async rowProof(row: PullRequestRow, sha: string): Promise<ProofState> {
    const merge = mergeCommitOf(row)
    if (merge === null) return 'none'
    const local = await this.isLocal(merge)
    if (local !== 'match') return local
    const landed = await this.isAncestor(merge)
    if (landed !== 'match' || row.headRefOid === sha) return landed
    const head = row.headRefOid
    // A head that is not a SHA cannot go into a git argv. The row still
    // names the branch at another commit, which is what `moved` says.
    if (!isOid(head)) return 'moved'
    if (!(await this.have(head, pullRefOf(row)))) return 'unfetched'
    const merges = await gitOut(['rev-list', '--merges', '-n', '1', `${head}..${sha}`], this.here)
    if (merges === null) return 'unprobed'
    if (merges !== '') return 'moved'
    const unmatched = await gitLines(['cherry', head, sha], this.here)
    if (unmatched === null) return 'unprobed'
    if (unmatched.some((line) => line.startsWith('+'))) return 'moved'
    // `git cherry` prints one line for each commit of the range that is not
    // a merge, and the check above leaves no merge in it. An answer with
    // another count of lines did not compare every commit, so it proves
    // nothing.
    const count = await gitOut(['rev-list', '--count', `${head}..${sha}`], this.here)
    return count === String(unmatched.length) ? 'match' : 'unprobed'
  }

  /** Whether the merge commit `oid` is here. There is no fetch (ruling 11).
   *  {@link advance} fetched `origin` before the prune loop. So a merge
   *  commit that is not here cannot be on the local `origin/<default>`.
   *  git answers 1 for "not here". Any other failure is a probe that could
   *  not answer. `cat-file -e` is not used, because it answers 128 both
   *  for a missing object and for a broken git. */
  private async isLocal(oid: string): Promise<ProofState> {
    const probe = await runGit(['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], this.here)
    if (probe.status === 0) return 'match'
    return probe.status === 1 ? 'none' : 'unprobed'
  }

  /** Whether `commit` is on `origin/<default>`. git answers 1 for "no". Any
   *  other failure is a probe that could not answer, and never a "no". */
  private async isAncestor(commit: string): Promise<ProofState> {
    const probe = await runGit(
      ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${this.defaultBranch}`],
      this.here,
    )
    if (probe.status === 0) return 'match'
    return probe.status === 1 ? 'none' : 'unprobed'
  }

  /** Whether the pull request head `oid` is here, after one fetch of `ref`
   *  when it was not (ruling 6). A ref of `null` cannot be fetched. */
  private async have(oid: string, ref: string | null): Promise<boolean> {
    if (await gitOk(['cat-file', '-e', `${oid}^{commit}`], this.here)) return true
    if (ref === null) return false
    let fetched = this.fetches.get(ref)
    if (fetched === undefined) {
      fetched = gitOk(['fetch', '--quiet', 'origin', ref], this.here)
      this.fetches.set(ref, fetched)
    }
    return (await fetched) && gitOk(['cat-file', '-e', `${oid}^{commit}`], this.here)
  }

  // ------------------------------------------------------------- prune ---

  /** Fills `worktrees` with branch -> worktree path. This answers with a
   *  reason to skip when the list cannot be read. It reads the list itself,
   *  again, right before the prune loop uses it. {@link preflight} already
   *  read it once, through {@link linkedWorktreeInProgress}, but that read
   *  is minutes old by now. A fetch, an install, and a gh call sit between
   *  it and this call.
   *
   *  A map built from that earlier read alone could go stale. It could
   *  then send a force delete at a worktree that has since moved to
   *  other, uncommitted work. Round 1 review (#218 finding 6) proved this.
   *
   *  This read closes that window. It does not close every window. The
   *  prune loop below can itself make a gh call, per branch. {@link
   *  pruneBranch} checks the worktree's branch once more for that reason,
   *  right before it removes anything (round 2 review). */
  private async readWorktrees(): Promise<string | null> {
    const out = await gitOut(['worktree', 'list', '--porcelain'], this.here)
    if (out === null) {
      // This fails closed. An empty map would make every branch look free
      // of a worktree. This map is what stands between real uncommitted
      // work and a force delete.
      return 'cannot list worktrees'
    }
    let current = ''
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length)
        // Any linked worktree that is mid-operation has a detached HEAD.
        // So it maps to no branch, and its work would be invisible to the
        // guards below.
        if (current !== this.top) {
          const marker = await this.checkInProgress(current)
          if (marker !== '') return `git operation in progress in ${current} (${marker})`
        }
      } else if (line.startsWith('branch refs/heads/')) {
        // The Python writes this with `setdefault`, which keeps the first
        // worktree named for a branch. git refuses to check one branch out
        // in two worktrees at once. So the second entry this guards
        // against can never occur, and a guard here would be a branch no
        // test could reach.
        this.worktrees.set(line.slice('branch refs/heads/'.length), current)
      }
    }
    return null
  }

  private async prune(ancestry: string[] | null): Promise<string | null> {
    const branches = await gitLines(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      this.here,
    )
    if (branches === null) return 'cannot list local branches'

    for (const branch of branches) {
      if (branch === this.defaultBranch) continue
      const sha = await gitOut(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        this.here,
      )
      // `gh-sync-repo.py:546` uses `if not sha`. An empty answer is no tip.
      // Without this check, the branch would reach `pruneBranch` and get
      // force-deleted on a tip that was never read.
      if (!sha) {
        this.bad(`kept ${branch} (cannot resolve its tip)`)
        continue
      }
      const proof = await this.proofFor(branch, sha, ancestry)
      if (proof === null) continue
      await this.pruneBranch(branch, sha, proof)
    }

    if (this.prUnchecked > 0) {
      this.bad(
        `${this.prUnchecked} branch(es) were never checked against pull requests; ` +
          'this run is incomplete',
      )
    }
    return null
  }

  /** The proof this branch landed, or `null` after reporting why there is
   *  none. */
  private async proofFor(
    branch: string,
    sha: string,
    ancestry: string[] | null,
  ): Promise<string | null> {
    // This resets per branch, instead of relying on the arms below to
    // always run. A verdict can then never carry over from the previous
    // iteration. An empty list stands for a lookup that failed: no row
    // then proves anything.
    const rows = this.prLookupOk ? this.prOwn : []
    let state = await this.rowsProof(rows, branch, sha, true)
    if (state === 'match') return 'merged PR'
    // This uses `?.`, not a null check. An ancestry that could not be
    // read, and one that does not name this branch, are the same answer
    // here. The Python's `if ancestry and branch in ancestry` says the
    // same thing. The name only selects the probe. The probe proves the
    // SHA that this loop read, so a commit added since the list was read
    // is never deleted on the old answer (#248).
    if (ancestry?.includes(branch)) {
      const merged = await this.isAncestor(sha)
      if (merged === 'match') return `merged into ${this.defaultBranch}`
      state = stronger(state, merged)
    }

    // The bulk list can show this name at another commit. This code
    // proves or reports that without a second call. The per-branch query
    // below can only raise this state further.
    const moved = await this.rowsProof(rows, branch, sha, false)
    if (moved === 'match') return 'merged PR'
    state = stronger(state, moved)
    // This code only asks when the bulk window filled up. An unsaturated
    // window already listed every merged pull request, so a second call
    // cannot find one it missed. To ask anyway would cost one API call per
    // branch.
    if (this.prLookupOk && this.prBulkSaturated) {
      if (this.prFallbackOff) {
        // A previous branch's query already failed. Whatever is wrong is
        // very unlikely to be branch-specific. A rate limit only gets
        // worse with more requests. So this code stops here and reports
        // these branches as never checked.
        state = stronger(state, 'error')
      } else {
        const answer = await this.prProofForBranch(branch, sha, state)
        if (answer.proved) return 'merged PR'
        state = answer.state
        if (state === 'error') this.prFallbackOff = true
      }
    }

    if (state === 'moved') {
      this.note(`kept ${branch} (merged PRs used this name; none at this commit)`)
    } else if (state === 'crowded') {
      this.note(`kept ${branch} (too many merged PRs used this name to tell)`)
    } else if (state === 'error') {
      this.prUnchecked += 1
      this.bad(`kept ${branch} (could not ask about this branch; unproven, not disproven)`)
    } else if (state === 'unfetched') {
      this.bad(`kept ${branch} (could not fetch a merged PR's commits; unproven, not disproven)`)
    } else if (state === 'unprobed') {
      this.bad(`kept ${branch} (git could not compare its commits; unproven, not disproven)`)
    } else {
      this.note(`kept ${branch} (no merge proof)`)
    }
    return null
  }

  private async pruneBranch(branch: string, sha: string, proof: string): Promise<void> {
    const worktree = this.worktrees.get(branch) ?? ''
    const linked = worktree !== '' && worktree !== this.top

    // This runs before the tip guard below. A branch protected by
    // unfinished work in a worktree is then reported for that reason, not
    // an incidental one. An unreadable worktree counts as occupied. This
    // guard is the only thing between real uncommitted work and a force
    // delete, so it fails closed.
    if (linked) {
      const dirty = await gitOut(
        ['status', '--porcelain', '--untracked-files=no'],
        this.at(worktree),
      )
      if (dirty === null) {
        this.bad(`kept ${branch} (cannot read worktree ${worktree})`)
        return
      }
      if (dirty !== '') {
        this.bad(`kept ${branch} and its worktree ${worktree} (uncommitted changes)`)
        return
      }
      // #218 finding 6, round 2 review. `this.worktrees` was built once, by
      // `readWorktrees`, before this loop began. A branch earlier in the
      // loop can trigger its own gh call. That call can take long enough
      // for someone to switch this worktree to another branch. The dirty
      // check above does not catch it: a clean switch leaves no tracked
      // change. This check reads the worktree's branch again, right before
      // the removal, and fails closed on any answer but a match.
      const onBranch = await currentBranch(this.at(worktree))
      if (onBranch !== branch) {
        this.bad(`kept ${branch} and its worktree ${worktree} (worktree changed branch)`)
        return
      }
    }

    // A branch that points at the same commit as origin/<default> has
    // nothing to prune. It is typically one that was just created, with no
    // commits of its own yet.
    if (sha === this.tip) {
      this.note(`kept ${branch} (already at origin/${this.defaultBranch}, nothing to prune)`)
      return
    }

    // The full SHA is already in hand from the caller. So an unreadable
    // abbreviation only costs legibility, not the recoverability the line
    // exists for.
    const short = (await gitOut(['rev-parse', '--short', branch], this.here)) || sha

    if (linked) {
      if (this.dryRun) {
        this.note(
          `${REPORT.wouldRemoveWorktree}${worktree} and delete ${branch} (${short}, ${proof})`,
        )
        return
      }
      if (!(await gitOk(['worktree', 'remove', worktree], this.here))) {
        this.bad(`kept ${branch} (could not remove worktree ${worktree})`)
        return
      }
      this.ok(`removed worktree ${worktree}`)
    }

    if (this.dryRun) {
      this.note(`${REPORT.wouldDelete}${branch} (${short}, ${proof})`)
    } else if (await gitOk(['branch', '-D', branch], this.here)) {
      // This uses -D, not -d, because a squash-merged branch is not an
      // ancestor of the default branch. The SHA makes it recoverable: git
      // branch <name> <sha>.
      this.ok(`deleted ${branch} (${short}, ${proof})`)
    } else {
      this.bad(`could not delete ${branch}`)
    }
  }

  // -------------------------------------------------------------- drive ---

  /** The sync, answering with the reason to skip or `null`. */
  private async attempt(): Promise<string | null> {
    const blocked = await this.preflight()
    if (blocked !== null) return blocked

    const branch = await this.resolveDefaultBranch()
    if (branch === null) return 'cannot determine the default branch'
    this.defaultBranch = branch

    if (!(await this.fetch())) return null

    // Everything below compares against origin/<default>. If that ref is
    // missing, git does not fail loudly. Instead, it echoes the name back.
    // Left unguarded, that would turn the tip guard into a silent no-op,
    // and empty the ancestry set.
    const tip = await gitOut(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      this.here,
    )
    // `gh-sync-repo.py:673` uses `if not self.tip`. If this code read an
    // empty answer as a tip, that would be the silent no-op the comment
    // above warns about. Nothing would ever equal it, so
    // `kept ... nothing to prune` would never fire. A branch that sits
    // exactly on the default tip would then be deleted instead of kept.
    if (!tip) return `origin/${branch} does not exist locally; nothing to compare against`
    this.tip = tip

    const advanced = await this.advance()
    // This checks truthiness, as `gh-sync-repo.py:664` does. An empty left
    // end is no range to diff a lock file over. To pass it on would ask
    // git for `diff --name-only "" <target>`, which fails. That would
    // report a lock-file diff this code could not read, in the same way
    // the Python installed nothing and said nothing.
    if (advanced.canAdvance && !this.noInstall && advanced.advancedFrom) {
      await this.install(advanced.advancedFrom, advanced.target)
    }

    const ancestry = await this.readMergeProof()
    if (!this.prLookupOk && ancestry === null) {
      this.bad('no way to prove what has merged; skipped pruning entirely')
      return null
    }

    const occupied = await this.readWorktrees()
    if (occupied !== null) return occupied
    const unpruned = await this.prune(ancestry)
    if (unpruned !== null) return unpruned

    if (!this.dryRun) await gitOk(['worktree', 'prune'], this.here)
    return null
  }

  /** Sync or skip. #218 finding 8: this answers nothing, because nothing
   *  read its status. Only a throw ever made this command's own answer
   *  anything but ok. */
  async run(): Promise<void> {
    const skipped = await this.attempt()
    if (skipped !== null) {
      // A skipped repository prints its reason and ends cleanly. Every
      // preflight skip fires before anything is written. The later skips
      // (a missing origin/<default>, an unreadable ref list) can follow a
      // fetch.
      this.bad(`${REPORT.skipped}${skipped}`)
    }
  }
}

/** Whether a path exists, for the in-progress markers. This uses
 *  `statSync`, not `existsSync`, so this file reaches the filesystem one
 *  way. */
const isPresent = (target: string): boolean => {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Sync one repository, writing its report through `report`.
 *
 * The fan-out calls this once per repository, in this process, with a
 * buffer of its own for `report`. This follows the approved plan's design
 * ruling: an injected `gh` mock cannot cross a process boundary. So the
 * child process the Python starts becomes a direct call, with a
 * concurrency limit instead.
 */
export const syncRepo = (options: SyncRepoOptions): Promise<void> => new SyncRepoRun(options).run()

/** What the command line asked for. */
export interface SyncRepoRequest {
  readonly repo: string
  readonly dryRun: boolean
  readonly noInstall: boolean
}

/** A parsed command line: a repository to sync, or the help text to
 *  print. This uses two shapes, not a payload that is sometimes one thing
 *  and sometimes the other. The caller then reads which shape it got,
 *  instead of asking what type it is. */
export type SyncRepoArgs =
  | { readonly kind: 'run'; readonly request: SyncRepoRequest }
  | { readonly kind: 'help'; readonly text: string }

/**
 * The command line, as `gh-sync-repo.py:701` reads it.
 *
 * This is hand-written, not `lib/args.ts` `parseArguments`. That function
 * refuses positionals outright. Its own header says a command that needs
 * them should widen it "with a test rather than inherit an untested path".
 * `lib/` is not this layer's to edit, and this command's whole subject is
 * a positional path. The refusal still travels as a `lib/envelope.ts`
 * refusal, which is exit 2. That is the same status `argparse` already
 * used, and the one the captured contract records.
 */
export const parseSyncRepoArgs = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Envelope<SyncRepoArgs> => {
  let dryRun = flagIsSet(env, 'GH_SYNC_DRY_RUN')
  let noInstall = flagIsSet(env, 'GH_SYNC_NO_INSTALL')
  let repo = ''
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--no-install') noInstall = true
    else if (arg === '-h' || arg === '--help') return ok({ kind: 'help', text: HELP })
    else if (arg.startsWith('-')) return refused(`unknown flag: ${arg}`)
    else repo = arg
  }
  if (repo === '') return refused(USAGE)
  return ok({ kind: 'run', request: { repo, dryRun, noInstall } })
}

/**
 * The command function: argv and the process's edges in, an exit status
 * out.
 *
 * This writes the report through `output.out` as the work happens, not as
 * one block returned at the end. A reader that leaves partway through must
 * then stop the report, but the prune must still continue.
 */
export const runSyncRepo: Command = async (argv, context) => {
  const parsed = parseSyncRepoArgs(argv, context.env)
  if (parsed.outcome !== 'ok') return parsed
  // Help is the one answer this command has that is not a report.
  if (parsed.value.kind === 'help') return ok(parsed.value.text)

  await syncRepo({
    repo: parsed.value.request.repo,
    dryRun: parsed.value.request.dryRun,
    noInstall: parsed.value.request.noInstall,
    env: context.env,
    createGh: context.createGh,
    report: context.output.out,
  })
  return ok('')
}
