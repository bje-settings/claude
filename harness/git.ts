// Real git repositories in known states: the port of the pure-git half of
// the gh plugin's Python conftest, deleted at #127. The file and line
// references below are to what `tests/gh/conftest.py`, `tests/gh/bin/gh` and
// `plugins/gh/scripts/*.py` held at `cd0d515`; this file carries more of them
// than any of its siblings.
//
// git is not mocked (ADR 001, RFC 001 "The testing seam"). Every fixture here
// is an actual repository with an actual (local, bare) origin, so `git fetch`,
// `git merge --ff-only`, ancestry checks and worktree operations behave exactly
// as they do in production, and a command that deletes a branch or removes a
// worktree is asserted against what it actually did. Nothing here reaches the
// network.
//
// Deferred to #127, the port whose tests consume them: the package-manager
// builders (`js_project`, `remote_update_lock`, `remote_break_lock`,
// `remote_drop_lockfile`, `corepack_cache`) and the pull-request data (`pr`,
// `write_prs`, `no_prs`, `many_prs`, `dep_pr`). Building them before anything
// consumes them would be a horizontal slice, and the package-manager ones
// would also skip on a machine without all three managers, which would leave
// this directory below its own coverage floor locally.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { findOnPath, type Sandbox } from './sandbox.ts'

export const DEFAULT_BRANCH = 'main'

/** The result of a git command that was allowed to fail. */
export interface GitRun {
  /** null when a signal killed git, which is what spawnSync reports. */
  status: number | null
  stdout: string
  stderr: string
}

// A shim that forwards to the real git except for the subcommands it is told
// to fail, so the branches guarding an unreadable ref or worktree list can be
// provoked without corrupting a repository. `sh` rather than the Python
// original: the whole point of the port is that a plugin's tests need no
// second runtime, and a shim that shelled out to python3 would put one back.
const GIT_SHIM = `#!/bin/sh
# Walk past git's own options so the comparison below sees the subcommand and
# its arguments, the way "git -C dir -c key=value fetch origin" hides "fetch".
real=__REAL_GIT__
tail=''
started=''
skip=''
for arg in "$@"; do
  if [ -n "$started" ]; then
    tail="$tail $arg"
    continue
  fi
  if [ -n "$skip" ]; then
    skip=''
    continue
  fi
  case "$arg" in
    -C|-c) skip=1 ;;
    -*) ;;
    *) started=1; tail="$arg" ;;
  esac
done
IFS=,
for failing in \${GIT_STUB_FAIL:-}; do
  [ -n "$failing" ] || continue
  case "$tail " in
    "$failing "*)
      echo "git stub: refusing $failing" >&2
      exit 1
      ;;
  esac
done
# GIT_STUB_SILENT is the other shape a git on PATH can take, and the one CI
# reached: exit 0 and print nothing. Real git answers these questions with a
# status, but the Python guards an empty answer at every one of them
# (\`discover.py:66\`, \`gh-sync-repo.py:210\`, \`:241\`, \`:349\`, \`:546\`, \`:673\`),
# so the port has to be exercised against it. Separate from GIT_STUB_FAIL
# because a refusal and a silent success send a caller to different arms.
for silent in \${GIT_STUB_SILENT:-}; do
  [ -n "$silent" ] || continue
  case "$tail " in
    "$silent "*)
      exit 0
      ;;
  esac
done
exec "$real" "$@"
`

const FIXTURE_SUFFIX = '.fixture.md'

/** A fixture file's real name. Two names cannot be stored as themselves inside
 *  this repository: a committed `.gitignore` would apply to the fixture
 *  directory it sits in, and a committed `CLAUDE.md` under `fixtures/` would
 *  be read as guidance for this repository by every session that opened it. */
const undisguise = (name: string): string => {
  if (name === '_gitignore') return '.gitignore'
  if (!name.endsWith(FIXTURE_SUFFIX)) return name
  return `${name.slice(0, -FIXTURE_SUFFIX.length)}.md`
}

export interface GitFixtures {
  /** git in `directory`, isolated from the developer's config. Throws on a
   *  non-zero exit, naming the command and git's own stderr. */
  git(directory: string, ...args: string[]): string
  /** The same, for a command that is allowed to fail. */
  tryGit(directory: string, ...args: string[]): GitRun
  /** A work tree at `<root>/work` with the bare origin at `<root>/origin.git`. */
  create(root: string): string
  /** A work tree at `<parent>/<name>`, origin parked in `<parent>/.origins`. */
  createAt(parent: string, name: string): string
  /** One commit appending to a tracked file. */
  commit(work: string, message: string, file?: string, content?: string): void
  /** Copy a fixture directory into `work` and commit it, undoing the two
   *  disguises a committed fixture tree needs: `_gitignore` becomes
   *  `.gitignore` and a `.fixture.md` suffix becomes `.md`. */
  importTree(work: string, fromDir: string): void
  /** Push a branch to origin. */
  push(work: string, branch?: string): void
  /** Create a branch and leave the checkout on the default branch. */
  branch(work: string, name: string, start?: string): void
  /** A branch carrying one real commit. */
  branchWithWork(work: string, name: string): void
  /** Fast-forward into the default branch, leaving the branch AT the tip. */
  mergeFf(work: string, name: string): void
  /** Merge with a merge commit, leaving the branch strictly BEHIND the tip. */
  mergeCommit(work: string, name: string): void
  /** Squash into the default branch, leaving NO ancestry. */
  mergeSquash(work: string, name: string): void
  /** An uncommitted change to a TRACKED file, which blocks a sync. */
  dirty(work: string, file?: string): void
  /** An untracked file, which must NOT block a sync. */
  untracked(work: string, file?: string): void
  /** `git status` then exits non-zero with empty stdout. */
  corruptIndex(work: string): void
  /** Leave a git operation marker, e.g. `rebase-merge` or `MERGE_HEAD`. */
  inProgress(work: string, marker: string): void
  /** A linked worktree at `at`, checked out on `branch`. */
  worktree(work: string, at: string, branch: string): void
  /** A local-only commit plus an origin-only commit, so no fast-forward. */
  diverge(work: string): void
  /** Commit a lock file and its package.json, and push them. */
  lockfile(work: string, name: string, content?: string): void
  /** Origin gains a commit the clone lacks, so the branch can fast-forward. */
  remoteAdvance(work: string, file?: string): void
  /** Drop the `origin` remote. */
  removeOrigin(work: string): void
  /** An index lock: tolerated by `git status`, refused by anything writing refs. */
  lockIndex(work: string): void
  /** The remote exists but is unreachable, so fetch fails and preflight passes. */
  breakOrigin(work: string): void
  /** Drop the cached `origin/HEAD`, forcing the later resolution strategies. */
  forgetOriginHead(work: string): void
  /** Remove every remote-tracking branch, so no default branch resolves. */
  dropRemoteBranches(work: string): void
  /** The commit a revision names. */
  sha(work: string, rev: string): string
  /** The local branch names. */
  branches(work: string): string[]
  /** The commit HEAD points at. */
  headSha(work: string): string
  /** The branch HEAD is on. */
  currentBranch(work: string): string
  /** A directory whose `git` refuses the named subcommands, and the value to
   *  pass as `GIT_STUB_FAIL` beside it. Both are needed: with the directory
   *  missing from PATH, or `GIT_STUB_FAIL` unset, or a typo in a subcommand,
   *  the shim forwards to the real git and says nothing. Assert on the
   *  `git stub: refusing ` line, not merely on a non-zero status, or a test
   *  that meant to exercise the failure passes on the success path.
   *
   *  The same shim also reads `GIT_STUB_SILENT`, a comma-separated list of
   *  subcommands it answers with exit 0 and no output at all. That is the
   *  other shape a `git` on PATH can take, the one CI reached, and the one
   *  the Python guards against at six call sites; pass it in the environment
   *  beside the directory, with or without `GIT_STUB_FAIL`. Assert on the
   *  report line the guard produces, never merely on a status. */
  gitShim(...failing: string[]): { directory: string; failing: string }
}

/** Builders for repositories in known states, all inside one sandbox.
 *
 *  Every git call is isolated from the developer's own configuration, which
 *  may set a different default branch, sign commits, install hooks, or hide
 *  untracked files, any of which would change what a fixture actually
 *  produces. Identity, signing and hooks are pinned per command below; the
 *  rest is pinned by `sandbox.env`, which holds git's config lookup inside the
 *  sandbox rather than leaving it to HOME alone (see `sandboxEnv`).
 */
export function createGitFixtures(sandbox: Sandbox): GitFixtures {
  function run(directory: string, args: string[], allowFailure: boolean): GitRun {
    const result = spawnSync(
      'git',
      [
        '-C',
        directory,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { env: sandbox.env },
    )
    // Before the decode, because a child that never started leaves `stdout` and
    // `stderr` undefined rather than empty: reading them first turns "git is not
    // on the PATH this sandbox hands out" into a TypeError naming neither git
    // nor the PATH, and it fires through `tryGit` too, whose whole contract is
    // to hand back a result instead of throwing. `spawn.ts` guards the same way.
    if (result.error) {
      throw result.error
    }
    const stdout = result.stdout.toString('utf8')
    const stderr = result.stderr.toString('utf8')
    if (!allowFailure && result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${directory}: ${stderr}`)
    }
    return { status: result.status, stdout, stderr }
  }

  /** git's output as a list of lines: no output is an empty list rather than a
   *  list holding one empty string. */
  function lines(text: string): string[] {
    return text.split('\n').filter((line) => line !== '')
  }

  const git = (directory: string, ...args: string[]): string =>
    run(directory, args, false).stdout.trim()
  const tryGit = (directory: string, ...args: string[]): GitRun => run(directory, args, true)

  /** A bare origin, a clone of it, and one commit pushed to the default branch.
   *
   *  `--initial-branch` rather than a fallback for an older git: it has been
   *  there since 2.28, and a fixture silently seeding `master` where the tests
   *  say `main` is the kind of quiet wrong answer this harness exists to
   *  refuse. An older git fails here, naming the command.
   */
  function seed(bare: string, work: string): string {
    const parent = path.dirname(bare)
    git(parent, 'init', '-q', '--bare', `--initial-branch=${DEFAULT_BRANCH}`, bare)
    git(parent, 'clone', '-q', bare, work)
    git(work, 'checkout', '-q', '-B', DEFAULT_BRANCH)
    writeFileSync(path.join(work, 'file.txt'), 'base\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'base')
    git(work, 'push', '-q', '-u', 'origin', DEFAULT_BRANCH)
    // Tolerated: a repository whose origin has no HEAD to resolve is a state
    // some tests want, and this is the only step that would refuse it.
    tryGit(work, 'remote', 'set-head', 'origin', '--auto')
    return work
  }

  /** A throwaway clone of the same origin, for the builders that have to make
   *  origin move without touching the work tree under test. */
  function cloneOrigin(work: string): string {
    const origin = git(work, 'remote', 'get-url', 'origin')
    const scratch = mkdtempSync(path.join(sandbox.path, 'scratch-'))
    git(scratch, 'clone', '-q', origin, path.join(scratch, 'c'))
    return path.join(scratch, 'c')
  }

  const fixtures: GitFixtures = {
    git,
    tryGit,

    create(root: string): string {
      mkdirSync(root, { recursive: true })
      return seed(path.join(root, 'origin.git'), path.join(root, 'work'))
    },

    createAt(parent: string, name: string): string {
      // The origins directory is hidden, so a non-recursive scan of `parent`
      // finds work trees and nothing else.
      mkdirSync(path.join(parent, '.origins'), { recursive: true })
      return seed(path.join(parent, '.origins', `${name}.git`), path.join(parent, name))
    },

    commit(work: string, message: string, file = 'file.txt', content = message): void {
      const target = path.join(work, file)
      writeFileSync(target, `${content}\n`, { flag: 'a' })
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', message)
    },

    importTree(work: string, fromDir: string): void {
      for (const entry of readdirSync(fromDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const from = path.join(entry.parentPath, entry.name)
        const under = path.relative(fromDir, entry.parentPath)
        const target = path.join(work, under, undisguise(entry.name))
        mkdirSync(path.dirname(target), { recursive: true })
        copyFileSync(from, target)
      }
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', `import ${path.basename(fromDir)}`)
    },

    push(work: string, branch = DEFAULT_BRANCH): void {
      git(work, 'push', '-q', 'origin', branch)
    },

    branch(work: string, name: string, start = DEFAULT_BRANCH): void {
      git(work, 'branch', name, start)
    },

    branchWithWork(work: string, name: string): void {
      git(work, 'checkout', '-q', '-b', name)
      fixtures.commit(work, `work on ${name}`, `${name}.txt`, name)
      git(work, 'checkout', '-q', DEFAULT_BRANCH)
    },

    mergeFf(work: string, name: string): void {
      // Ancestry finds it, but the tip guard takes over before ancestry
      // matters.
      git(work, 'merge', '-q', '--ff-only', name)
      fixtures.push(work)
    },

    mergeCommit(work: string, name: string): void {
      // What a pull request merged with the "merge commit" strategy leaves
      // behind, and the state in which ancestry is the interesting signal.
      git(work, 'merge', '-q', '--no-ff', '-m', `Merge ${name}`, name)
      fixtures.push(work)
    },

    mergeSquash(work: string, name: string): void {
      // Only a pull-request signal can prove this one.
      git(work, 'merge', '-q', '--squash', name)
      git(work, 'commit', '-qm', `squash ${name}`)
      fixtures.push(work)
    },

    dirty(work: string, file = 'file.txt'): void {
      writeFileSync(path.join(work, file), 'dirty\n', { flag: 'a' })
    },

    untracked(work: string, file = 'untracked.txt'): void {
      writeFileSync(path.join(work, file), 'untracked\n')
    },

    corruptIndex(work: string): void {
      // Resolves the real git dir rather than assuming `<work>/.git` is a
      // directory, which it is not in a linked worktree.
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      writeFileSync(path.join(gitdir, 'index'), 'GARBAGE')
    },

    inProgress(work: string, marker: string): void {
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      if (marker.includes('-')) {
        // rebase-merge and rebase-apply are directories; MERGE_HEAD and
        // CHERRY_PICK_HEAD are files holding a commit.
        mkdirSync(path.join(gitdir, marker), { recursive: true })
        return
      }
      writeFileSync(path.join(gitdir, marker), `${git(work, 'rev-parse', 'HEAD')}\n`)
    },

    worktree(work: string, at: string, branch: string): void {
      git(work, 'worktree', 'add', '-q', at, branch)
    },

    diverge(work: string): void {
      const clone = cloneOrigin(work)
      fixtures.commit(clone, 'origin side')
      fixtures.push(clone)
      rmSync(path.dirname(clone), { recursive: true, force: true })
      fixtures.commit(work, 'local side', 'local.txt', 'local')
    },

    lockfile(work: string, name: string, content = '{"lockfileVersion":3}'): void {
      writeFileSync(path.join(work, name), `${content}\n`)
      writeFileSync(path.join(work, 'package.json'), '{"name":"fixture"}\n')
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', `add ${name}`)
      fixtures.push(work)
    },

    remoteAdvance(work: string, file = 'file.txt'): void {
      const clone = cloneOrigin(work)
      fixtures.commit(clone, 'remote advance', file, 'advanced')
      fixtures.push(clone)
      rmSync(path.dirname(clone), { recursive: true, force: true })
    },

    removeOrigin(work: string): void {
      git(work, 'remote', 'remove', 'origin')
    },

    lockIndex(work: string): void {
      // Lets a mid-run git failure be provoked without corrupting anything.
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      writeFileSync(path.join(gitdir, 'index.lock'), '')
    },

    breakOrigin(work: string): void {
      git(work, 'remote', 'set-url', 'origin', '/nonexistent/gone.git')
    },

    forgetOriginHead(work: string): void {
      // It is a *symbolic* ref, so it has to be deleted as one; `update-ref -d`
      // leaves it resolvable and the resolution never falls through. Tolerated
      // when it is already gone, so a test can ask for the state rather than
      // for the deletion.
      tryGit(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    },

    dropRemoteBranches(work: string): void {
      // origin/HEAD first, and as a symbolic ref: `update-ref -d` is a silent
      // no-op on one, so looping alone empties `for-each-ref` (it skips a
      // symref whose target is gone) while `symbolic-ref
      // refs/remotes/origin/HEAD` still answers with the branch just deleted.
      // A command resolving the default branch that way would read a default
      // branch out of a repository that has none, which is the state this
      // builder exists to produce.
      fixtures.forgetOriginHead(work)
      const refs = git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')
      for (const ref of lines(refs)) {
        git(work, 'update-ref', '-d', ref)
      }
    },

    sha: (work: string, rev: string) => git(work, 'rev-parse', rev),

    branches: (work: string) =>
      lines(git(work, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')),

    headSha: (work: string) => git(work, 'rev-parse', 'HEAD'),

    currentBranch: (work: string) => git(work, 'rev-parse', '--abbrev-ref', 'HEAD'),

    gitShim(...failing: string[]): { directory: string; failing: string } {
      const real = findOnPath('git', sandbox.env.PATH)
      if (real === undefined) {
        throw new Error('git is not on PATH; cannot build a shim that forwards to it')
      }
      const directory = mkdtempSync(path.join(sandbox.path, 'git-shim-'))
      // A shell literal, not a bare interpolation, and both halves matter. The
      // quoting keeps a path holding a space or an apostrophe from ending the
      // literal and breaking the script, and the replacer function keeps a `$&`
      // in the path from being read as a replacement pattern and rewriting
      // itself. The Python original got both from `{real!r}`.
      const quoted = `'${real.replaceAll("'", `'\\''`)}'`
      writeFileSync(
        path.join(directory, 'git'),
        GIT_SHIM.replace('__REAL_GIT__', () => quoted),
        {
          mode: 0o755,
        },
      )
      return { directory, failing: failing.join(',') }
    },
  }

  return fixtures
}
