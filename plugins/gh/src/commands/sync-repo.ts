// Sync one checkout: move to the default branch, fast-forward, install if a
// lock file changed, and prune branches whose work has landed. The port of
// `plugins/gh/scripts/gh-sync-repo.py`, whose report is a byte-pinned contract
// (`src/fixtures/bash-output.json`, captured from the shell version before it
// was deleted, and asserted line for line in `sync-repo.test.ts`).
//
// Exit status is 0 for a synced repository AND for a skipped one: skipping is
// a normal outcome, not a failure. 2 is an argument this command refuses.
//
// **Three differences from the Python, each forced by the port's own rules.**
//
//  1. *Nothing changes directory.* The Python `os.chdir`s into the checkout
//     and lets every git call inherit it. `sync` now fans out IN-PROCESS (the
//     approved plan: an injected `gh` mock cannot cross a process boundary),
//     and several repositories sharing one process cannot each own the working
//     directory, so every git call names its `cwd`. The two `chdir` failures
//     the Python reports go with it: "cannot enter directory" is answered by
//     asking whether the path is a directory at all, and "cannot enter work
//     tree" has no counterpart, because nothing enters it.
//  2. *No `shutil.which` preflight.* "git is not on PATH" and "cannot run git"
//     are read off the runner's `startFailure` instead, which separates the
//     two for the same two sentences (`lib/README.md`, "could not start apart
//     from ran and failed").
//  3. *pnpm only* (the maintainer's ruling, 2026-09-20). `install.ts` knows
//     one lock file and one command; the arm that says no recognised lock file
//     remains is kept for the pull that deletes `pnpm-lock.yaml`.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { statSync } from 'node:fs'
import path from 'node:path'

import { installDeps, LOCKFILES, NO_LOCKFILE } from '../install.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError } from '../lib/gh.ts'
import {
  gitLines,
  gitOk,
  gitOut,
  hasRef,
  type RepoOptions,
  defaultBranch as readDefaultBranch,
  runGit,
} from '../lib/git.ts'
import type { Output, Writer } from '../lib/streams.ts'
import { hasMatch, isPullRequestRow, namesBranch, ownRows, type PullRequestRow } from '../prs.ts'

/** The bulk lookup: one API call covers every branch in the repository. A
 *  window this size that comes back full is a window, not an answer, which is
 *  what {@link SyncRepoRun} records as `prBulkSaturated`. */
const PR_LIMIT = 200

/** The per-branch fallback, asked only for a branch the saturated bulk window
 *  could not settle. Smaller because it is scoped to one head ref, and
 *  saturated here means the same thing: too many merged pull requests share
 *  the name to conclude anything about this commit. */
const PR_BRANCH_LIMIT = 100

/** The markers git leaves behind mid-operation. Checked for every worktree,
 *  not just this one: a rebase in a linked worktree leaves its HEAD detached,
 *  so that worktree contributes no branch mapping later and its branch would
 *  otherwise look free to delete. */
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

/** Everything a command function is given: the process's edges, as arguments.
 *
 *  Shared with `sync.ts` and with `bin/gh.ts`, which is what lets both
 *  commands be dispatched through one signature and lets either be driven from
 *  a test with no process at all (ADR 001, "the command function is the
 *  seam"). `createGh` is a factory rather than a client because the fan-out
 *  needs one per repository, each scoped to that checkout. */
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

/** One repository's job. `report` is where its lines go: the process's stdout
 *  for a single repository, and a buffer of its own for each job in a fan-out,
 *  so that the sections cannot interleave. */
export interface SyncRepoOptions {
  readonly repo: string
  readonly dryRun: boolean
  readonly noInstall: boolean
  readonly env: NodeJS.ProcessEnv
  readonly createGh: (cwd: string) => GhClient
  readonly report: Writer
}

/** An env flag as `sync` sets it: "1" on, "0" or unset off. */
export const flagIsSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const value = env[name] ?? '0'
  return value !== '' && value !== '0'
}

/** The last line of a command's output, the way `"${var##*$'\n'}"` read it.
 *  `slice(-1).join('')` rather than an index: an empty transcript answers with
 *  an empty line rather than with a fallback no test can reach. */
const lastLine = (text: string): string => text.replace(/\n+$/, '').split('\n').slice(-1).join('')

/**
 * Why a `gh` failure could not be read, in the vocabulary
 * `gh-sync-repo.py:263` to `290` prints.
 *
 * Only 127 is spelled here. The runner answers 127 for a command that is not
 * there, so that one case keeps the Python's own sentence, which a reader who
 * has seen it will recognise. Everything else, an unrunnable gh (126), a
 * refusal, a silent non-zero exit, an answer that is not JSON, reaches the
 * report through `GhError.detail`, whose last line is gh's own last line when
 * gh said anything at all. That is the same rule the Python applies to a
 * multi-line stderr, and it means the wording for those arms is now
 * `lib/gh.ts`'s rather than this file's: `fixtures/divergences.json` lists
 * each one.
 *
 * `detail` and not `message`: the message carries a `gh <argv> failed: `
 * prefix, and gh's ordinary refusal is a SINGLE line of stderr ("gh: API
 * rate limit exceeded"), so tailing the message would put the whole argv
 * inside this report line and only a multi-line stderr would happen to read
 * as the Python's. `detail` is gh's account with no prefix, so the one-line
 * case reads as the Python's too.
 */
const reasonFor = (error: GhError): string =>
  error.status === 127 ? 'gh is not on PATH' : lastLine(error.detail)

/** Whether `target` is a directory, which is as much of `os.chdir` as a port
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

/** What a per-branch query established. The last three are all reasons to keep
 *  a branch, but they are different statements and the report says which:
 *  reporting a failed query as "none" would assert an absence that was never
 *  checked. */
type ProofState = 'match' | 'moved' | 'none' | 'crowded' | 'error'

/** What {@link SyncRepoRun.advance} did. A union rather than a triple, so a
 *  caller that reads `target` has already established there was one. */
type Advance =
  | { readonly canAdvance: false }
  | {
      readonly canAdvance: true
      /** The short SHA of `origin/<default>`, the commit the branch is being
       *  moved to. */
      readonly target: string
      /** The short SHA the branch actually moved off, or `null` when it did
       *  not move (already up to date, diverged, a failed merge, or a branch
       *  that does not exist yet). The caller reads it as "is there a range to
       *  diff for a lock file". */
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
  private prRows: PullRequestRow[] = []
  private prOwn: PullRequestRow[] = []
  private prBulkSaturated = false
  private prFallbackOff = false
  private prUnchecked = 0

  constructor(options: SyncRepoOptions) {
    this.repo = options.repo
    this.dryRun = options.dryRun
    this.noInstall = options.noInstall
    this.env = options.env
    this.report = options.report
    this.name = path.basename(options.repo)
    // Built from the path the caller named rather than from the checkout root,
    // which is not known yet: gh resolves the repository by walking up from
    // its working directory, so both answer about the same repository, and a
    // path that turns out not to be a checkout never reaches a gh call at all.
    this.gh = options.createGh(options.repo)
  }

  // ------------------------------------------------------------- output ---

  // Each of the three prints the repository's name first if nothing has yet: a
  // report whose lines sit under no heading names no repository at all, and
  // the fan-out prints one of these sections after another.
  private ok(text: string): void {
    this.ensureHeader()
    this.emit(`  ✓ ${text}`)
  }

  private bad(text: string): void {
    this.ensureHeader()
    this.emit(`  ✗ ${text}`)
  }

  private note(text: string): void {
    this.ensureHeader()
    this.emit(`  · ${text}`)
  }

  private ensureHeader(): void {
    if (this.headerPrinted) return
    this.headerPrinted = true
    this.emit(this.name)
  }

  /** One report line. A reader that has gone away stops the output only: the
   *  writer goes quiet on a broken pipe and the sync carries on to the end,
   *  because "a run abandoned there leaves the prune half done and `git
   *  worktree prune` never called, and it exits 0, so nothing says so"
   *  (`gh-sync-repo.py:157`, and `lib/streams.ts` is where that now lives). */
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

  /** Refuse before anything is written, or resolve the checkout root. Answers
   *  with the reason to skip, or `null` to carry on. */
  private async preflight(): Promise<string | null> {
    if (!isDirectory(this.repo)) return 'cannot enter directory'

    const probe = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: this.repo,
      env: this.env,
    })
    if (probe.startFailure !== null) {
      // Named for what it is. Every git call below would fail, and reporting
      // the first of them as "not a git repository" sends the reader to
      // inspect a checkout that is fine. On PATH and still unrunnable is its
      // own sentence: not executable, a bad interpreter line, an exec format
      // it cannot load.
      return probe.startFailure.code === 'ENOENT'
        ? 'git is not on PATH'
        : `cannot run git: ${probe.startFailure.message}`
    }
    const top = probe.stdout.replace(/\n+$/, '')
    // Both halves, as `gh-sync-repo.py:210` has them. Real git refuses
    // `rev-parse --show-toplevel` outside a work tree with a status rather
    // than by answering empty, but a `git` on PATH that exits 0 and prints
    // nothing is a shape a caller can arrange and CI reached: without the
    // second half the run carries on with no checkout root at all and reports
    // "already up to date ()" about a repository it never found.
    if (probe.status !== 0 || top === '') return 'not a git repository'
    this.top = top
    this.name = path.basename(this.top)

    if (!(await gitOk(['remote', 'get-url', 'origin'], this.here))) return "no 'origin' remote"

    const marker = await this.checkInProgress(this.top)
    if (marker !== '') return `git operation in progress (${marker})`

    // Untracked files deliberately do not block: checkout, fast-forward, and
    // branch deletion cannot touch them. Only tracked modifications and staged
    // changes do. A failed probe must not read as clean, which is why `null`
    // and `""` are different answers here: a corrupt or unreadable index exits
    // non-zero with empty stdout.
    const dirty = await gitOut(['status', '--porcelain', '--untracked-files=no'], this.here)
    if (dirty === null) return 'cannot read the working tree state'
    if (dirty !== '') return 'uncommitted changes'
    return null
  }

  // ---------------------------------------------------- default branch ---

  private async resolveDefaultBranch(): Promise<string | null> {
    let named = await readDefaultBranch(this.here)
    // Truthiness, not a null test, because `gh-sync-repo.py:241` and `:247`
    // are `if not ref` and `if ref:`. A `git` that exits 0 and prints nothing
    // has named no default branch, and reading `""` as one skips the repair,
    // the gh fallback AND the main/master fallback, then reports about a
    // branch called nothing: `skipped: origin/ does not exist locally`. The
    // same shape as the empty checkout root CI reached (`discover.py:66`).
    if (!named && !this.dryRun) {
      // Repairing origin/HEAD writes a ref, so it is skipped in --dry-run; the
      // fallbacks below answer the same question without touching the
      // repository.
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
   * The port of `gh_json` (`gh-sync-repo.py:263`): "a missing gh is one of
   * those failures rather than a crash: the caller falls back to ancestry and
   * says so". Only a `GhError` is an answer, because only `lib/gh.ts` throws
   * one; anything else reaching here is this code or the test double saying
   * something went wrong that is not gh's refusal, and swallowing it would let
   * a command that asked for an endpoint nobody registered read the silence as
   * an empty window.
   */
  private async ask<T>(call: () => Promise<T>): Promise<Asked<T>> {
    try {
      return { value: await call() }
    } catch (error) {
      if (error instanceof GhError) return { reason: reasonFor(error) }
      throw error
    }
  }

  /** Merged pull requests into the default branch, or the reason they could
   *  not be read. */
  private async prList(limit: number, head?: string): Promise<Listed> {
    const asked = await this.ask(() =>
      this.gh.listMergedPullRequests({ base: this.defaultBranch, limit, head }),
    )
    if ('reason' in asked) return asked
    // Every reader below asks a row for a field. A payload that is a list of
    // something else is not an answer about merged pull requests, so it takes
    // the same route a failed query does rather than being read as an empty
    // window. ("Is it a list at all" is `lib/gh.ts`'s own check, and reaches
    // here as a `GhError`.)
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
   * The default branch may be checked out in another worktree, in which case
   * the checkout cannot succeed. That is not fatal: pruning still has value,
   * so the caller carries on with `canAdvance` false.
   */
  private async advance(): Promise<Advance> {
    const branch = this.defaultBranch
    // An unborn HEAD, or a probe that could not run at all, has no branch name
    // to report. "HEAD" is what git itself echoes there and what the shell
    // version printed, and it keeps a null out of the "switched from ..." line.
    // `||`, not `??`: `gh-sync-repo.py:349` is `or "HEAD"`, so an empty
    // answer is no answer here too, and `""` would name no branch in the line
    // below.
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

    // `tip` is the same commit in full, already verified to exist, so it is
    // the honest fallback if the abbreviation itself cannot be read: a shorter
    // name for a commit is a convenience, and printing null instead would be a
    // lie in every line that quotes it.
    const target =
      (await gitOut(['rev-parse', '--short', `origin/${branch}`], this.here)) || this.tip
    if (!(await hasRef(`refs/heads/${branch}`, this.here))) {
      // Only reachable in --dry-run, where the checkout above was not
      // performed.
      this.note(`would create ${branch} from origin/${branch} (${target})`)
      return { canAdvance: true, target, advancedFrom: null }
    }

    // Always compare the default branch itself, never HEAD: in --dry-run we
    // have not switched, so HEAD is still whatever branch the user was sitting
    // on. Same fallback as `target`: the branch was just verified to exist, so
    // an unreadable abbreviation still has a full SHA behind it, and this value
    // is both printed and used as the left end of the lock-file diff.
    // `||`, not `??`, matching `gh-sync-repo.py:381`'s `or`: an empty
    // abbreviation falls through to the full form. The null test below is
    // unchanged, because Python's `or` answers with the SECOND value whatever
    // it is, so only a second failure is "no left end".
    const before =
      (await gitOut(['rev-parse', '--short', branch], this.here)) ||
      (await gitOut(['rev-parse', branch], this.here))
    let moved: string
    if (before === null) {
      // Both forms failed, so there is no left end: nothing to compare with the
      // target, nothing honest to print as a range, and nothing to diff a lock
      // file over. Reported the way a failed lock-file diff is, because it has
      // the same consequence, a checkout that may end up on new code with stale
      // dependencies, and skipping the install without a word is the silent
      // half of that. The branch is still advanced, which is the part that does
      // not need the old tip.
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
      this.note(`would fast-forward ${moved}`)
      // `before` is null here only when it could not be read, and the caller
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

  /** Install if the range the branch moved over touched the lock file. Diffs
   *  the range rather than hashing files on disk, so --dry-run can answer this
   *  without having merged anything. */
  private async install(advancedFrom: string, target: string): Promise<void> {
    const changed = await gitOut(
      ['diff', '--name-only', advancedFrom, target, '--', ...LOCKFILES],
      this.here,
    )
    if (changed === null) {
      // A failed diff is not "no lock file changed". Treating it as that would
      // leave the checkout on new code with stale dependencies and no sign
      // anything was missed, which is the silent half of this failure.
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
      // The reason matters here: a missing package manager, a lock file out of
      // sync with package.json, and a registry outage all land on this line.
      this.bad(`install failed (${lastLine(installed.log)}); run it by hand`)
    }
  }

  // -------------------------------------------------------- merge proof ---

  /** The bulk pull-request window and the ancestry set. Answers with the
   *  ancestry list, or `null` when it could not be read; a failure of one
   *  signal is reported and the other carries on. */
  private async readMergeProof(): Promise<string[] | null> {
    const listed = await this.prList(PR_LIMIT)
    if ('reason' in listed) {
      this.note(`could not read merged pull requests (${listed.reason}); using ancestry alone`)
    } else {
      this.prLookupOk = true
      this.prRows = listed.rows
      // A saturated window is a window, not an answer: a repository with more
      // merged pull requests than the limit drops the oldest, so a branch
      // merged before it is absent from the list without being unmerged.
      this.prBulkSaturated = listed.rows.length >= PR_LIMIT
      this.prOwn = ownRows(listed.rows)
    }

    // Ancestry catches the other case: merged locally with no pull request at
    // all. A failed probe must not masquerade as "nothing is merged", which
    // would silently reduce the proof to the pull-request signal alone.
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
   * The state can only be raised here, never reset: a "moved" from the bulk
   * list is a fact this call's failure does not undo.
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
    if (own.length > 0 && hasMatch(own, branch, sha)) return { proved: true, state: 'match' }
    // A saturated result is a window, not an answer. Concluding "none at this
    // commit" from a truncated list is the mistake this guard exists to fix.
    if (listed.rows.length >= PR_BRANCH_LIMIT) return { proved: false, state: 'crowded' }
    if (own.length > 0) return { proved: false, state: 'moved' }
    return { proved: false, state }
  }

  // ------------------------------------------------------------- prune ---

  /** Fill `worktrees` with branch -> worktree path. Answers with a reason to
   *  skip when the list cannot be read, or when a linked worktree is
   *  mid-operation; both mean this run must not delete anything. */
  private async readWorktrees(): Promise<string | null> {
    const out = await gitOut(['worktree', 'list', '--porcelain'], this.here)
    if (out === null) {
      // Fails closed: an empty map would make every branch look free of a
      // worktree, and this map is what stands between real uncommitted work
      // and a force delete.
      return 'cannot list worktrees'
    }
    let current = ''
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length)
        // Any linked worktree mid-operation has a detached HEAD, so it maps to
        // no branch and its work would be invisible to the guards below.
        if (current !== this.top) {
          const marker = await this.checkInProgress(current)
          if (marker !== '') return `git operation in progress in ${current} (${marker})`
        }
      } else if (line.startsWith('branch refs/heads/')) {
        // The Python writes this with `setdefault`, which keeps the first
        // worktree named for a branch. git refuses to check one branch out in
        // two worktrees at once, so the second entry it guards against cannot
        // occur and a guard here would be a branch no test could reach.
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
      // `gh-sync-repo.py:546` is `if not sha`. An empty answer is no tip:
      // without this the branch reaches `pruneBranch` and is force-deleted on
      // a tip that was never read.
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
    // Reset per branch rather than relying on the arms below to always run, so
    // a verdict can never carry over from the previous iteration.
    let state: ProofState = 'none'
    if (this.prLookupOk && this.prRows.length > 0 && hasMatch(this.prOwn, branch, sha)) {
      return 'merged PR'
    }
    // `?.` rather than a null check: an ancestry that could not be read and
    // one that does not name this branch are the same answer here, which is
    // what the Python's `if ancestry and branch in ancestry` says too.
    if (ancestry?.includes(branch)) return `merged into ${this.defaultBranch}`

    // The bulk list can already show this name at another commit, so say so
    // without a second call. The per-branch query below can only raise this.
    if (this.prLookupOk && this.prOwn.length > 0 && namesBranch(this.prOwn, branch)) {
      state = 'moved'
    }
    // Only worth asking when the bulk window filled up: an unsaturated window
    // already listed every merged pull request, so a second call cannot find
    // one it missed, and asking anyway would be an API call per branch.
    if (this.prLookupOk && this.prBulkSaturated) {
      if (this.prFallbackOff) {
        // A previous branch's query already failed. Whatever is wrong is very
        // unlikely to be branch-specific, and a rate limit only gets worse if
        // we keep asking, so stop calling and say these were never checked.
        if (state === 'none') state = 'error'
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
    } else {
      this.note(`kept ${branch} (no merge proof)`)
    }
    return null
  }

  private async pruneBranch(branch: string, sha: string, proof: string): Promise<void> {
    const worktree = this.worktrees.get(branch) ?? ''
    const linked = worktree !== '' && worktree !== this.top

    // Checked before the tip guard below, so that a branch protected by
    // unfinished work in a worktree is reported for that reason rather than an
    // incidental one. An unreadable worktree counts as occupied: this guard is
    // the only thing between real uncommitted work and a force delete, so it
    // fails closed.
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
    }

    // A branch pointing at the same commit as origin/<default> has nothing to
    // prune, and is typically one that was just created and not committed to
    // yet.
    if (sha === this.tip) {
      this.note(`kept ${branch} (already at origin/${this.defaultBranch}, nothing to prune)`)
      return
    }

    // The full SHA is already in hand from the caller, so an unreadable
    // abbreviation costs legibility rather than the recoverability the line
    // exists for.
    const short = (await gitOut(['rev-parse', '--short', branch], this.here)) || sha

    if (linked) {
      if (this.dryRun) {
        this.note(`would remove worktree ${worktree} and delete ${branch} (${short}, ${proof})`)
        return
      }
      if (!(await gitOk(['worktree', 'remove', worktree], this.here))) {
        this.bad(`kept ${branch} (could not remove worktree ${worktree})`)
        return
      }
      this.ok(`removed worktree ${worktree}`)
    }

    if (this.dryRun) {
      this.note(`would delete ${branch} (${short}, ${proof})`)
    } else if (await gitOk(['branch', '-D', branch], this.here)) {
      // -D rather than -d because a squash-merged branch is not an ancestor of
      // the default branch. The SHA makes it recoverable: git branch <name>
      // <sha>.
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
    // missing, git reports it by echoing the name back rather than failing
    // loudly, which would turn the tip guard into a silent no-op and empty the
    // ancestry set.
    const tip = await gitOut(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      this.here,
    )
    // `gh-sync-repo.py:673` is `if not self.tip`. An empty answer read as a
    // tip is the silent no-op the comment above warns about: nothing would
    // ever equal it, so `kept ... nothing to prune` never fires and a branch
    // sitting exactly on the default tip is deleted instead of kept.
    if (!tip) return `origin/${branch} does not exist locally; nothing to compare against`
    this.tip = tip

    const advanced = await this.advance()
    // Truthiness, as `gh-sync-repo.py:664` has it: an empty left end is no
    // range to diff a lock file over, and passing it on asks git for
    // `diff --name-only "" <target>`, which fails and reports a lock-file diff
    // it could not read where the Python installed nothing and said nothing.
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

  /** The job's own status, which is 0 for a synced repository and for a
   *  skipped one alike. */
  async run(): Promise<number> {
    const skipped = await this.attempt()
    if (skipped !== null) {
      // A skipped repository prints its reason and ends cleanly. The preflight
      // skips all fire before anything is written; the later ones (a missing
      // origin/<default>, an unreadable ref list) can follow a fetch.
      this.bad(`skipped: ${skipped}`)
    }
    return 0
  }
}

/** Whether a path exists, for the in-progress markers. `statSync` rather than
 *  `existsSync` so this file reaches the filesystem one way. */
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
 * This is what the fan-out calls once per repository, in this process, with a
 * buffer of its own for `report` (the approved plan's design ruling: an
 * injected `gh` mock cannot cross a process boundary, so the child process the
 * Python starts becomes a direct call with a concurrency limit).
 */
export const syncRepo = (options: SyncRepoOptions): Promise<number> =>
  new SyncRepoRun(options).run()

/** What the command line asked for. */
export interface SyncRepoRequest {
  readonly repo: string
  readonly dryRun: boolean
  readonly noInstall: boolean
}

/** A parsed command line: a repository to sync, or the help text to print.
 *  Two shapes rather than a payload that is sometimes one and sometimes the
 *  other, so the caller reads which it got rather than asking what type it
 *  is. */
export type SyncRepoArgs =
  | { readonly kind: 'run'; readonly request: SyncRepoRequest }
  | { readonly kind: 'help'; readonly text: string }

/**
 * The command line, as `gh-sync-repo.py:701` reads it.
 *
 * Hand-written rather than `lib/args.ts` `parseArguments`, which refuses
 * positionals outright and whose own header says a command that needs them
 * widens it "with a test rather than inherit an untested path": `lib/` is not
 * this layer's to edit, and this command's whole subject is a positional path.
 * The refusal still travels as a `lib/envelope.ts` refusal, which is exit 2,
 * the status `argparse` already used and the one the captured contract records.
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
 * The command function: argv and the process's edges in, an exit status out.
 *
 * The report is written through `output.out` as it is produced rather than
 * returned, because it is written as the work happens and a reader that leaves
 * partway through must stop the report without stopping the prune.
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
