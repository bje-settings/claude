// The git calls the ported scripts make more than once, and the two that need
// care. Not a git SDK: RFC 001 decision 3 records "typed functions written
// before anything calls them" as the argument against this whole directory,
// so every export below names the Python call site that is its first
// consumer, and a command that needs a git subcommand nobody else runs calls
// {@link gitOut} with it rather than growing a function here.
//
// git is never mocked (ADR 001, RFC 001 "The testing seam"), so this file's
// own suite runs real git against `harness/git.ts` fixtures.
//
// This file ships. It imports nothing outside the root lib, and stays inside
// the erasable subset (ADR 001).

//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree; every
// file and line reference below is to what they held at `cd0d515`, kept
// because each says where a rule came from. Nothing here changed with the
// deletion.
import { type RunResult, run } from './process.ts'

export interface GitOptions {
  /** The repository to run in. The port of both `git -C <dir> ...` and the
   *  `chdir` `gh-sync-repo.py:195` does before its own git calls. */
  readonly cwd?: string
  /** The child's whole environment, for a caller that has one to pin. The
   *  suite passes `harness/sandbox.ts`'s `env`, which is what keeps a
   *  developer's own git configuration out of a fixture. */
  readonly env?: NodeJS.ProcessEnv
  /** A bound, in milliseconds. Nothing in the port sets one today: every git
   *  call here is local. It is here because {@link run} takes one and a
   *  caller that fetches over the network should not have to reach past this
   *  file to get it. */
  readonly timeoutMs?: number
}

/**
 * git, with everything the child did.
 *
 * First consumer: `gh-sync-repo.py:65` to `86`, whose preflight is the one
 * caller that needs more than "git said no". It reports "git is not on PATH"
 * (a {@link RunResult.startFailure} whose code is `ENOENT`) apart from "git
 * is on PATH and still would not run" apart from "this is not a git
 * repository" (the child ran and exited non-zero), and gives the reader a
 * different sentence for each. Everything else in the port wants
 * {@link gitOut} or {@link gitOk}.
 *
 * The middle sentence is "any other code" only for a libuv errno. A code
 * beginning `ERR_` means node refused the argv this process built and git was
 * never asked at all, so printing "git is on PATH and still would not run"
 * there sends the reader to inspect an install over a bug in our own call.
 * {@link StartFailure.code} has the two vocabularies.
 */
export const runGit = (args: readonly string[], options: GitOptions = {}): Promise<RunResult> =>
  run('git', args, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })

/**
 * git's stdout without its trailing newlines, or `null` when git failed.
 *
 * The port of `git_out` (`gh-sync-repo.py:88`), which is the workhorse:
 * fifteen call sites there, plus `hook-io.py:159` and `lib/discover.py:50`.
 * `null` and `""` are deliberately different answers and both are used:
 * `show-ref --verify --quiet` succeeds with no output at all, so only `null`
 * can mean "the ref is not there", and `git status --porcelain` answering
 * `""` is the whole tree being clean while `null` is a probe that could not
 * be run (`gh-sync-repo.py:231`, where reading the second as the first is how
 * a corrupt index passes a cleanliness check).
 *
 * Only trailing newlines are stripped, never leading space, because
 * `status --porcelain` encodes the staged and unstaged columns there: " M
 * file" and "?? file" differ in a leading blank that a full trim eats.
 *
 * git's stderr is dropped, as the Python drops it: every caller below already
 * reports "git said no" in its own words, and the one caller that needs git's
 * own account uses {@link runGit}.
 *
 * What `null` does NOT separate: a bound that fired, a git that is not on
 * PATH, a git that would not run, and a pipe that failed part-way
 * ({@link RunResult.streamErrors}) all arrive here as `null` or, for the
 * pipe on an otherwise successful run, as the short text that did get
 * through. `lib/gh.ts` can tell those apart because it takes its runner as a
 * parameter; this file calls {@link run} directly, so a branch here would be
 * an arm only a real failing pipe could reach, and the coverage rule refuses
 * a branch no test can reach rather than excusing it. A caller that needs the
 * distinction uses {@link runGit}, which hands back the whole result.
 */
export const gitOut = async (
  args: readonly string[],
  options: GitOptions = {},
): Promise<string | null> => {
  const result = await runGit(args, options)
  if (result.status !== 0) return null
  return result.stdout.replace(/\n+$/, '')
}

/** Whether git succeeded. The port of `git_ok` (`gh-sync-repo.py:95`), which
 *  is how every write in that script is attempted: checkout, merge --ff-only,
 *  branch -D, worktree remove. */
export const gitOk = async (args: readonly string[], options: GitOptions = {}): Promise<boolean> =>
  (await runGit(args, options)).status === 0

/** git's stdout as its non-empty lines, or `null` when git failed. The port
 *  of `git_lines` (`gh-sync-repo.py:98`), whose two callers are the merged
 *  branch list and the local branch list, both of which must be able to tell
 *  "no branches" from "the list could not be read". */
export const gitLines = async (
  args: readonly string[],
  options: GitOptions = {},
): Promise<string[] | null> => {
  const out = await gitOut(args, options)
  if (out === null) return null
  return out.split('\n').filter((line) => line !== '')
}

/**
 * The options every question below takes: one repository, named, and the
 * environment it is asked in.
 *
 * Both are required here where {@link GitOptions} leaves them optional, and
 * the whole object is required where `gitOut` defaults it, because each of
 * these asks about ONE repository and neither `cwd` alone nor `env` alone
 * pins which one.
 *
 * `cwd` is the obvious half: a call that named no directory would be asking
 * about wherever the process happens to sit. `env` is the half that actually
 * bites, and it is required rather than optional because `GIT_DIR` outranks
 * both `cwd` and `git -C` for everything the git directory holds. With it
 * set, {@link currentBranch} reads the named repository's HEAD,
 * {@link defaultBranch} reads its `origin/HEAD`, and {@link hasRef} reads its
 * refs, whatever directory the call gave. ({@link toplevel} is the exception
 * and is worth knowing: `GIT_DIR` with no `GIT_WORK_TREE` makes the CURRENT
 * DIRECTORY the top of the work tree, so `rev-parse --show-toplevel` still
 * answers about `cwd`. `GIT_WORK_TREE` is what displaces that one, and it is
 * exported into a hook's children beside the others.) git exports `GIT_DIR`
 * and `GIT_INDEX_FILE` into every child of a hook, and a pre-commit hook is
 * one of the places this suite runs (`lefthook.yml`), so an optional `env`
 * here is an invariant argued in a comment and enforced nowhere: the caller
 * that most needs to pin it is the one that would most easily leave it out.
 *
 * **Requiring it buys the naming, not the scrubbing.** `env: process.env`
 * satisfies this type and, inside the hook the paragraph above is about,
 * carries `GIT_DIR` at full strength. Nothing here strips anything and nothing
 * here can: this file calls {@link run} directly, so it has no seam, and a
 * caller who chose an environment is entitled to the one it chose. What the
 * required field does is put the environment at the call, where a reader sees
 * which one is being used and a reviewer can ask whether it is the right one.
 * Read it as "say which environment", never as "git is insulated from
 * `GIT_DIR`".
 *
 * The port's own answer, for a caller with nothing to pin, is `process.env`:
 * every ported call site inherits today (`grep GIT_DIR plugins/gh/` finds
 * nothing) and passing `{}` would take `HOME` and `PATH` with it, so global
 * config discovery and credential helpers would behave differently. Named here
 * so layers 2 to 4 do not each invent a different one. `lib/README.md`'s
 * "Decisions not taken" carries the scrubbing helper and what reopens it.
 *
 * The four helpers above keep `env` optional on purpose. They are the generic
 * escape hatch and the preflight that reports on git itself, and for those the
 * ambient environment is sometimes the thing being asked about
 * (`gh-sync-repo.py:65` to `86`); silently rewriting an environment a caller
 * chose would be its own defect.
 */
export interface RepoOptions extends GitOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/**
 * An empty answer read as no answer, for the three questions below whose
 * answer the empty string cannot be.
 *
 * A checkout root, the branch HEAD is on and the ref `origin/HEAD` points at
 * are each either a name or nothing, so `""` is git saying nothing rather
 * than git answering. The Python reads all three that way (`lib/discover.py`
 * is `return top or None`; `gh-sync-repo.py:210`, `:241` and `:349` are `not
 * top`, `not ref` and `or "HEAD"`), and every caller of these three was
 * repeating the fold.
 *
 * {@link gitOut}, {@link gitOk}, {@link gitLines}, {@link hasRef} and
 * {@link runGit} deliberately do NOT fold. `null` against `""` is load
 * bearing there: `git status --porcelain` answering `""` is a clean tree
 * while `null` is a probe that could not be run, and `show-ref --verify
 * --quiet` succeeds with no output at all.
 */
const answered = (out: string | null): string | null => (out === '' ? null : out)

/**
 * The checkout root containing `options.cwd`, or `null` when there is none.
 *
 * The port of `toplevel` (`lib/discover.py:50`), and the same question
 * `gh-sync-repo.py:203`, `gh-shepherd-status.py:144` and
 * `gh-shepherd-pr.py:1014` ask. A missing git is the same answer as a
 * directory outside any checkout: no root. The callers have nothing to do
 * with that distinction, and raising here would turn a degraded environment
 * into a crash.
 *
 * The Python reads an empty answer as no root as well, and so does this,
 * through {@link answered}. An earlier comment here said that arm could not
 * be reached, because git 2.54 refuses `rev-parse --show-toplevel` in a bare
 * repository with status 128 rather than answering empty. That is true of
 * real git and false of the git a caller put on PATH, which is the only git
 * this function has: CI on #159 reached the arm, and the callers were each
 * folding the empty answer themselves.
 *
 * The path git prints is symlink-resolved, which is why `discover.py`
 * compares against `os.path.realpath`. Resolving the caller's own path is the
 * caller's business and stays there.
 */
export const toplevel = async (options: RepoOptions): Promise<string | null> =>
  answered(await gitOut(['rev-parse', '--show-toplevel'], options))

/**
 * The branch HEAD is on, `"HEAD"` when it is detached, or `null` when git
 * could not answer.
 *
 * The port of `gh-sync-repo.py:349` and `hook-io.py:210`. Both read `"HEAD"`
 * as "there is no branch to talk about" and it is git's own word for it, so
 * it is passed through rather than folded into `null`, which means something
 * else here. An empty answer IS folded ({@link answered}): git naming no
 * branch at all is not git naming one.
 */
export const currentBranch = async (options: RepoOptions): Promise<string | null> =>
  answered(await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], options))

const ORIGIN_HEAD = 'refs/remotes/origin/HEAD'
const ORIGIN_PREFIX = 'refs/remotes/origin/'

/**
 * The default branch as the cached `origin/HEAD` records it, or `null`.
 *
 * The port of the first half of `default_branch` (`hook-io.py:184`) and of
 * `resolve_default_branch` (`gh-sync-repo.py:239`). Only the half both
 * callers share is here: reading the ref, with no network round trip and
 * nothing written. A ref read as the empty string is no ref, through
 * {@link answered}: a default branch that is `""` is the one answer neither
 * caller can use, and both fall back on `null`.
 *
 * The rest is deliberately left with the callers, because they disagree about
 * it. `gh-sync-repo.py` repairs a missing `origin/HEAD` with `git remote
 * set-head --auto` (a write, which it skips under `--dry-run`) and then falls
 * back to gh and to `refs/remotes/origin/{main,master}`; `hook-io.py` must
 * never write, and falls back to `refs/heads/{main,master}` instead. A
 * "default branch" function here would have to take both fallbacks as
 * arguments, which is the caller's own code with an indirection in front of
 * it.
 */
export const defaultBranch = async (options: RepoOptions): Promise<string | null> => {
  const ref = answered(await gitOut(['symbolic-ref', '--quiet', ORIGIN_HEAD], options))
  if (ref === null) return null
  // `hook-io.py:196` passes a ref that does not carry the prefix through
  // unchanged rather than mangling it, and so does this.
  return ref.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : ref
}

/**
 * Whether `ref` exists, named in full (`refs/heads/main`,
 * `refs/remotes/origin/main`).
 *
 * The port of the `show-ref --verify --quiet` calls at `hook-io.py:199`,
 * `gh-sync-repo.py:369` and `gh-sync-repo.py:262`. Full ref names, not
 * shorthands, because `--verify` wants one and because the three call sites
 * ask about two different namespaces.
 */
export const hasRef = (ref: string, options: RepoOptions): Promise<boolean> =>
  gitOk(['show-ref', '--verify', '--quiet', ref], options)
