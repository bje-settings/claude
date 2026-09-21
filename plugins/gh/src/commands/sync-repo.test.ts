// One checkout's sync, against real repositories: the port of
// `tests/gh/test_gh_sync_repo.py`, `test_gh_sync_repo_edges.py` and
// `test_output_parity.py`, whose scenarios are `tests/gh/scenarios.py`.
//
// The parity block at the end is the contract: every scenario's report is
// compared byte for byte with `fixtures/bash-output.json`, which
// `gh-sync-repo.sh` printed before it was deleted, with only the divergences
// `fixtures/divergences.json` records. The examples above it are the claims
// the report alone does not prove, above all the side effects: which branches
// and worktrees are still there afterwards.
//
// git is real (`harness/git.ts`); `gh` is injected. The double here answers
// from a canned set and applies the same server-side filtering real `gh pr
// list` applies (`--base`, `--head`, `--limit`), which is what the Python's
// stub `gh` does and what the per-branch fallback needs to be exercised at
// all: `createGhMock` answers every call with one registered reply, by
// design, so it cannot tell a bulk window from a per-branch query.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createGhMock,
  type GhClient,
  GhError,
  type GhReplies,
  ghFails,
  type MergedPullRequestQuery,
} from '../../../../harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '../../../../harness/git.ts'
import { corepackEnv, createPackageFixtures } from '../../../../harness/packages.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { exitCodeFor } from '../lib/envelope.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import { parseSyncRepoArgs, runSyncRepo, USAGE } from './sync-repo.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

const GOLDEN: Record<string, { status: number; stdout: string }> = JSON.parse(
  read('bash-output.json'),
)

const DIVERGENCES: {
  'bash-output.json': Record<string, { was: string; now: string }>
} = JSON.parse(read('divergences.json'))

const PYTHON: Record<
  string,
  Record<string, { status: number; stdout: string; stderr: string }>
> = JSON.parse(read('python-cli-output.json'))

/** One merged pull request, for composing a canned set. The row builders stay
 *  here rather than in `harness/`: the round 4 note puts `pr`, `write_prs`,
 *  `many_prs` and `dep_pr` with the shepherd layer, which is the one that
 *  needs them all, and what this file needs is two object literals. */
const pr = (headRefName: string, headRefOid: string, baseRefName = 'main', cross = false) => ({
  headRefName,
  headRefOid,
  baseRefName,
  isCrossRepository: cross,
  state: 'MERGED',
})

/** `count` filler pull requests, followed by any given explicitly. When
 *  `count` is at least the bulk lookup limit, anything appended is past the
 *  window: invisible to the bulk query and reachable only by asking about that
 *  branch directly. */
const manyPrs = (count: number, ...extra: ReturnType<typeof pr>[]) => [
  ...Array.from({ length: count }, (_, index) => pr(`old-${index}`, String(index))),
  ...extra,
]

type Row = ReturnType<typeof pr>

interface GhOptions {
  /** The canned set every query is answered from. */
  readonly prs?: Row[]
  /** `all` fails every call, `head` only the per-branch ones, so a bulk lookup
   *  can succeed while the fallback does not. */
  readonly fail?: 'all' | 'head'
  /** What `gh repo view` answers with, for the default-branch fallback. */
  readonly defaultBranch?: string
}

/**
 * A `gh` that answers about merged pull requests the way the real one does.
 *
 * `createGhMock` is the base, so every endpoint this plugin does not use still
 * throws and names itself; only the two endpoints the sync asks for are
 * answered here. The filtering is the stub `gh`'s: `--base` and `--head` are
 * applied server-side and `--limit` truncates, which is what makes a saturated
 * window a window and not an answer.
 */
function ghDouble(options: GhOptions = {}): GhClient {
  const rows = options.prs ?? []
  // `fail: 'all'` is the stub's GH_FIXTURE_FAIL, which fails every call
  // including `gh repo view`, so the default-branch fallback sees a gh that
  // cannot answer rather than one nobody registered.
  const replies: GhReplies =
    options.fail === 'all'
      ? { viewRepository: ghFails('gh: simulated failure') }
      : options.defaultBranch === undefined
        ? {}
        : { viewRepository: { defaultBranchRef: { name: options.defaultBranch } } }
  return {
    ...createGhMock(replies),
    listMergedPullRequests: async (query: MergedPullRequestQuery) => {
      if (options.fail === 'all') throw new GhError('gh: simulated failure', 1, { cause: 'test' })
      if (options.fail === 'head' && query.head !== undefined) {
        throw new GhError('gh: simulated per-branch failure', 1, { cause: 'test' })
      }
      const matching = rows.filter(
        (row) =>
          row.baseRefName === query.base &&
          (query.head === undefined || row.headRefName === query.head),
      )
      return matching.slice(0, query.limit)
    },
  }
}

/** The pair of writers a command reports through, over two buffers. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })
  return {
    output: createOutput(stream(out), stream(err)),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

interface Fixture {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
}

function fixture(): Fixture {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))
  return { sandbox, git, repo, env: sandbox.env }
}

/** Run the command and hand back everything it did. */
async function run(
  f: Fixture,
  argv: readonly string[],
  options: { gh?: GhClient; env?: NodeJS.ProcessEnv } = {},
) {
  const captured = capture()
  const gh = options.gh ?? ghDouble()
  const envelope = await runSyncRepo(argv, {
    cwd: f.sandbox.path,
    env: options.env ?? f.env,
    output: captured.output,
    createGh: () => gh,
  })
  return {
    envelope,
    status: exitCodeFor(envelope),
    stdout: captured.stdout(),
    stderr: envelope.outcome === 'ok' ? captured.stderr() : envelope.error,
  }
}

/** One run's report with the per-run detail replaced by placeholders, as
 *  `tests/gh/scenarios.py` `normalise` does it: commit hashes, and the
 *  temporary directory the fixtures were built in. */
function normalise(text: string, sandbox: Sandbox): string {
  let out = text
  for (const spelling of [realpathSync(sandbox.path), sandbox.path]) {
    out = out.split(spelling).join('<sandbox>')
  }
  return out.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
}

/** What a scenario builds: the state, and how the run is asked for. */
type Scenario = (f: Fixture) => {
  argv: string[]
  gh?: GhClient
  env?: NodeJS.ProcessEnv
}

/** A PATH whose git refuses the named subcommands and forwards the rest. */
function shimmed(f: Fixture, ...failing: string[]): NodeJS.ProcessEnv {
  const shim = f.git.gitShim(...failing)
  return {
    ...f.env,
    PATH: `${shim.directory}${path.delimiter}${f.env.PATH ?? ''}`,
    GIT_STUB_FAIL: shim.failing,
  }
}

// The scenarios of `tests/gh/scenarios.py`, one for one. The three lock-file
// ones build a `pnpm-lock.yaml` where the Python builds a `package-lock.json`:
// the port watches one lock file (the pnpm-only ruling), the state being
// asserted is "the pull touched the lock file this checkout uses", and the
// reported line is unchanged, which is why the golden still applies.
// `fixtures/divergences.json` records that substitution.
const SCENARIOS: Record<string, Scenario> = {
  not_a_git_repository: (f) => {
    mkdirSync(f.sandbox.join('plain'))
    return { argv: [f.sandbox.join('plain')] }
  },
  cannot_enter_directory: (f) => ({ argv: [f.sandbox.join('nowhere')] }),
  no_origin_remote: (f) => {
    f.git.removeOrigin(f.repo)
    return { argv: [f.repo] }
  },
  uncommitted_changes: (f) => {
    f.git.dirty(f.repo)
    return { argv: [f.repo] }
  },
  cannot_read_the_working_tree: (f) => {
    f.git.corruptIndex(f.repo)
    return { argv: [f.repo] }
  },
  operation_in_progress: (f) => {
    f.git.inProgress(f.repo, 'rebase-merge')
    return { argv: [f.repo] }
  },
  operation_in_progress_in_a_linked_worktree: (f) => {
    f.git.branchWithWork(f.repo, 'wt-branch')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt-branch')
    f.git.inProgress(f.sandbox.join('wt'), 'rebase-merge')
    return { argv: [f.repo] }
  },
  cannot_determine_the_default_branch: (f) => {
    f.git.forgetOriginHead(f.repo)
    f.git.dropRemoteBranches(f.repo)
    f.git.breakOrigin(f.repo)
    return { argv: [f.repo], gh: ghDouble({ fail: 'all' }) }
  },
  origin_default_missing: (f) => {
    // gh names a default branch this clone has no remote-tracking ref for. In
    // --dry-run origin/HEAD is not repaired, so the answer stands.
    f.git.forgetOriginHead(f.repo)
    return { argv: ['--dry-run', f.repo], gh: ghDouble({ defaultBranch: 'trunk' }) }
  },
  cannot_list_local_branches: (f) => ({ argv: [f.repo], env: shimmed(f, 'for-each-ref') }),
  already_up_to_date: (f) => ({ argv: [f.repo] }),
  fast_forward: (f) => {
    f.git.remoteAdvance(f.repo)
    return { argv: [f.repo] }
  },
  switch_to_the_default_branch: (f) => {
    f.git.git(f.repo, 'checkout', '-q', '-b', 'side')
    return { argv: [f.repo] }
  },
  diverged: (f) => {
    f.git.diverge(f.repo)
    return { argv: [f.repo] }
  },
  fetch_failed: (f) => {
    f.git.branchWithWork(f.repo, 'wip')
    f.git.breakOrigin(f.repo)
    return { argv: [f.repo] }
  },
  delete_on_ancestry: (f) => {
    f.git.branchWithWork(f.repo, 'ff-done')
    f.git.mergeCommit(f.repo, 'ff-done')
    return { argv: [f.repo] }
  },
  keep_without_merge_proof: (f) => {
    f.git.branchWithWork(f.repo, 'wip')
    return { argv: [f.repo] }
  },
  delete_on_pull_request_proof: (f) => {
    f.git.branchWithWork(f.repo, 'squashed')
    const sha = f.git.sha(f.repo, 'squashed')
    f.git.mergeSquash(f.repo, 'squashed')
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('squashed', sha)] }) }
  },
  keep_a_branch_whose_tip_has_moved: (f) => {
    f.git.branchWithWork(f.repo, 'reused')
    const merged = f.git.sha(f.repo, 'reused')
    f.git.mergeSquash(f.repo, 'reused')
    f.git.git(f.repo, 'checkout', '-q', 'reused')
    f.git.commit(f.repo, 'unpushed work', 'danger.txt', 'secret')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('reused', merged)] }) }
  },
  ignore_a_fork_pull_request: (f) => {
    f.git.branchWithWork(f.repo, 'patch-1')
    const sha = f.git.sha(f.repo, 'patch-1')
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('patch-1', sha, 'main', true)] }) }
  },
  ignore_another_base: (f) => {
    f.git.branchWithWork(f.repo, 'for-release')
    const sha = f.git.sha(f.repo, 'for-release')
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('for-release', sha, 'release')] }) }
  },
  keep_a_branch_on_the_tip: (f) => {
    f.git.branch(f.repo, 'fresh')
    return { argv: [f.repo] }
  },
  pull_request_lookup_failed: (f) => {
    f.git.branchWithWork(f.repo, 'ff-done')
    f.git.mergeCommit(f.repo, 'ff-done')
    return { argv: [f.repo], gh: ghDouble({ fail: 'all' }) }
  },
  remove_a_clean_worktree: (f) => {
    f.git.branchWithWork(f.repo, 'wt-clean')
    f.git.mergeCommit(f.repo, 'wt-clean')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt-clean')
    return { argv: [f.repo] }
  },
  keep_a_dirty_worktree: (f) => {
    f.git.branchWithWork(f.repo, 'wt-dirty')
    f.git.mergeCommit(f.repo, 'wt-dirty')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt-dirty')
    f.git.dirty(f.sandbox.join('wt'), 'wt-dirty.txt')
    return { argv: [f.repo] }
  },
  keep_an_unreadable_worktree: (f) => {
    f.git.branchWithWork(f.repo, 'wt')
    f.git.mergeCommit(f.repo, 'wt')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt')
    f.git.corruptIndex(f.sandbox.join('wt'))
    return { argv: [f.repo] }
  },
  keep_a_worktree_that_cannot_be_removed: (f) => {
    f.git.branchWithWork(f.repo, 'wt')
    f.git.mergeCommit(f.repo, 'wt')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt')
    writeFileSync(f.sandbox.join('wt', 'notes.txt'), 'scratch\n')
    return { argv: [f.repo] }
  },
  dry_run: (f) => {
    f.git.branchWithWork(f.repo, 'ff-done')
    f.git.mergeCommit(f.repo, 'ff-done')
    f.git.git(f.repo, 'checkout', '-q', '-b', 'side')
    return { argv: ['--dry-run', f.repo] }
  },
  dry_run_worktree_removal: (f) => {
    f.git.branchWithWork(f.repo, 'wt')
    f.git.mergeCommit(f.repo, 'wt')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt')
    return { argv: ['--dry-run', f.repo] }
  },
  lock_file_changed: (f) => {
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'pnpm-lock.yaml')
    return { argv: ['--dry-run', f.repo] }
  },
  lock_file_untouched: (f) => {
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'other.txt')
    return { argv: ['--dry-run', f.repo] }
  },
  no_install: (f) => {
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'pnpm-lock.yaml')
    return { argv: ['--dry-run', '--no-install', f.repo] }
  },
  cannot_switch_pruning_only: (f) => {
    f.git.branchWithWork(f.repo, 'gone')
    f.git.mergeCommit(f.repo, 'gone')
    f.git.git(f.repo, 'checkout', '-q', '-b', 'side')
    f.git.worktree(f.repo, f.sandbox.join('wt-main'), 'main')
    return { argv: [f.repo] }
  },
  would_create_the_default_branch: (f) => {
    f.git.git(f.repo, 'checkout', '-q', '-b', 'side')
    f.git.git(f.repo, 'branch', '-D', 'main')
    return { argv: ['--dry-run', f.repo] }
  },
  could_not_fast_forward: (f) => {
    f.git.remoteAdvance(f.repo)
    f.git.lockIndex(f.repo)
    return { argv: [f.repo] }
  },
  could_not_delete_a_branch: (f) => {
    f.git.branchWithWork(f.repo, 'side')
    f.git.mergeCommit(f.repo, 'side')
    f.git.git(f.repo, 'checkout', '-q', 'side')
    f.git.worktree(f.repo, f.sandbox.join('wt-main'), 'main')
    return { argv: [f.repo] }
  },
  past_the_bulk_window: (f) => {
    f.git.branchWithWork(f.repo, 'landed')
    const sha = f.git.sha(f.repo, 'landed')
    return { argv: [f.repo], gh: ghDouble({ prs: manyPrs(200, pr('landed', sha)) }) }
  },
  per_branch_query_failed: (f) => {
    f.git.branchWithWork(f.repo, 'first')
    f.git.branchWithWork(f.repo, 'second')
    return { argv: [f.repo], gh: ghDouble({ prs: manyPrs(200), fail: 'head' }) }
  },
  per_branch_window_crowded: (f) => {
    f.git.branchWithWork(f.repo, 'busy')
    const crowd = Array.from({ length: 100 }, (_, index) => pr('busy', `sha${index + 1}`))
    return { argv: [f.repo], gh: ghDouble({ prs: manyPrs(200, ...crowd) }) }
  },
  per_branch_tip_moved: (f) => {
    f.git.branchWithWork(f.repo, 'moved')
    const merged = f.git.sha(f.repo, 'moved')
    f.git.git(f.repo, 'checkout', '-q', 'moved')
    f.git.commit(f.repo, 'work after the merge', 'after.txt', 'after')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    return { argv: [f.repo], gh: ghDouble({ prs: manyPrs(200, pr('moved', merged)) }) }
  },
}

// --- the argument handling ----------------------------------------------------

describe('the command line', () => {
  it('prints usage for --help without leaking code', async () => {
    const f = fixture()

    const result = await run(f, ['--help'])

    expect(result.status).toBe(0)
    expect(result.envelope.outcome === 'ok' && result.envelope.value).toContain('Usage:')
    expect(result.envelope.outcome === 'ok' && result.envelope.value).not.toContain('import')
    // The Python answered the same question with the same status.
    expect(PYTHON['sync-repo']?.help?.status).toBe(0)
    expect(PYTHON['sync-repo']?.help?.stdout).toContain('Usage:')
  })

  it('rejects an unknown flag', async () => {
    const f = fixture()

    const result = await run(f, ['--wat', f.repo])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('unknown flag: --wat')
    expect(PYTHON['sync-repo']?.unknown_flag?.stderr).toBe('unknown flag: --wat\n')
  })

  it('requires a repository path', async () => {
    const f = fixture()

    const result = await run(f, [])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(USAGE)
    expect(PYTHON['sync-repo']?.no_path?.stderr).toContain('usage:')
  })

  it('answers --help even when a repository was named, and touches nothing', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')

    const result = await run(f, ['--help', f.repo])

    expect(result.status).toBe(0)
    expect(f.git.branches(f.repo)).toContain('wip')
  })

  it('reads GH_SYNC_DRY_RUN and GH_SYNC_NO_INSTALL as the flags they stand for', () => {
    // "1" on, "0" or unset off, which is how the fan-out passed them to its
    // jobs and what anything else setting them still means.
    const parsed = parseSyncRepoArgs(['/somewhere'], {
      GH_SYNC_DRY_RUN: '1',
      GH_SYNC_NO_INSTALL: '1',
    })
    expect(parsed.outcome === 'ok' && parsed.value.kind === 'run' && parsed.value.request).toEqual({
      repo: '/somewhere',
      dryRun: true,
      noInstall: true,
    })

    const off = parseSyncRepoArgs(['/somewhere'], { GH_SYNC_DRY_RUN: '0', GH_SYNC_NO_INSTALL: '' })
    expect(off.outcome === 'ok' && off.value.kind === 'run' && off.value.request.dryRun).toBe(false)
    expect(off.outcome === 'ok' && off.value.kind === 'run' && off.value.request.noInstall).toBe(
      false,
    )
  })

  it('honours the dry-run environment flag', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'ff-done')
    f.git.mergeCommit(f.repo, 'ff-done')

    const result = await run(f, [f.repo], { env: { ...f.env, GH_SYNC_DRY_RUN: '1' } })

    expect(result.stdout).toContain('would delete ff-done')
    expect(f.git.branches(f.repo)).toContain('ff-done')
  })

  it('honours the no-install environment flag', async () => {
    const f = fixture()
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'pnpm-lock.yaml')

    const result = await run(f, ['--dry-run', f.repo], {
      env: { ...f.env, GH_SYNC_NO_INSTALL: '1' },
    })

    expect(result.stdout).not.toContain('lock file changed')
  })
})

// --- preflight, which must refuse before touching anything --------------------

describe('the preflight', () => {
  it('does not skip for untracked files alone', async () => {
    const f = fixture()
    f.git.untracked(f.repo)

    const result = await run(f, [f.repo])

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('skipped')
  })

  it('fails closed when the working tree cannot be read at all', async () => {
    // A corrupt index makes git status exit non-zero with EMPTY stdout, which
    // a naive check reads as "clean" and proceeds to delete branches on.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')
    f.git.corruptIndex(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('cannot read the working tree state')
    expect(f.git.branches(f.repo)).toContain('wip')
  })

  it('names a git that is not on PATH as that, not as a bad repository', async () => {
    // Reporting the first failed git call as "not a git repository" sends the
    // reader to inspect a checkout that is perfectly fine.
    const f = fixture()

    const result = await run(f, [f.repo], {
      env: { ...f.env, PATH: f.sandbox.pathWithout('git') },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: git is not on PATH')
    expect(result.stdout).not.toContain('not a git repository')
  })

  it('names a git that is present and will not run as its own reason', async () => {
    // A file on PATH without the execute bit, and nothing else on PATH: the
    // lookup finds it and the exec fails with EACCES on both platforms. An
    // empty file WITH the bit set is not the same test: on Linux that is
    // ENOEXEC, which execvp re-runs through /bin/sh, so the fake git exits 0
    // and prints nothing (which the example below is about instead), and
    // EACCES on one entry of a longer PATH makes execvp keep searching.
    const f = fixture()
    const broken = f.sandbox.join('broken-git')
    mkdirSync(broken)
    writeFileSync(path.join(broken, 'git'), '', { mode: 0o644 })

    const result = await run(f, [f.repo], { env: { ...f.env, PATH: broken } })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: cannot run git: ')
    expect(result.stdout).not.toContain('not a git repository')
  })

  it('skips a git that exits 0 and prints nothing, rather than syncing nowhere', async () => {
    // `gh-sync-repo.py:210` reads an empty `rev-parse --show-toplevel` as "not
    // a git repository" beside a non-zero status. Real git answers with a
    // status, but a `git` on PATH that exits 0 in silence is something a
    // caller can arrange: without the guard the run carries on with no
    // checkout root and reports "already up to date ()" about a repository it
    // never found.
    const f = fixture()
    const stubs = f.sandbox.join('silent-git')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = await run(f, [f.repo], { env: { ...f.env, PATH: stubs } })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: not a git repository')
    expect(result.stdout).not.toContain('already up to date')
  })

  it('skips a repository whose path is a file rather than a directory', async () => {
    const f = fixture()

    const result = await run(f, [path.join(f.repo, 'file.txt')])

    expect(result.stdout).toContain('skipped: cannot enter directory')
  })
})

// --- advancing the default branch ---------------------------------------------

describe('advancing', () => {
  it('fast-forwards a default branch that is behind', async () => {
    const f = fixture()
    SCENARIOS.fast_forward?.(f)
    const before = f.git.headSha(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('fast-forwarded')
    expect(f.git.headSha(f.repo)).not.toBe(before)
  })

  it('switches to the default branch from a feature branch', async () => {
    const f = fixture()
    SCENARIOS.switch_to_the_default_branch?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('switched from side to main')
    expect(f.git.currentBranch(f.repo)).toBe('main')
  })

  it('refuses to merge a diverged default branch and keeps the local commit', async () => {
    const f = fixture()
    SCENARIOS.diverged?.(f)
    const local = f.git.headSha(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('has diverged')
    expect(f.git.headSha(f.repo)).toBe(local)
  })

  it('reports a failed fetch and changes nothing', async () => {
    const f = fixture()
    SCENARIOS.fetch_failed?.(f)
    const before = f.git.branches(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('fetch failed; nothing changed')
    expect(f.git.branches(f.repo)).toEqual(before)
  })

  it('names HEAD rather than printing a null branch name', async () => {
    // "HEAD" is what git itself echoes for an unborn or unreadable HEAD, and
    // what the shell version printed.
    const f = fixture()

    const result = await run(f, ['--dry-run', f.repo], {
      env: shimmed(f, 'rev-parse --abbrev-ref'),
    })

    expect(result.stdout).toContain('would switch from HEAD to main')
    expect(result.stdout).not.toContain('null')
  })

  it('falls back to the full sha when an abbreviation cannot be read', async () => {
    // The commit is the recoverable part of "deleted <branch> (<sha>)".
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    const sha = f.git.sha(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')

    const result = await run(f, [f.repo], { env: shimmed(f, 'rev-parse --short') })

    expect(result.stdout).toContain(`deleted landed (${sha}, merged into main)`)
    expect(result.stdout).not.toContain('null')
  })

  it('reports a default branch tip it could not read, and still advances', async () => {
    // With no left end there is no range to print and nothing to diff a lock
    // file over, so the install has to be skipped. Skipping it in silence
    // leaves the checkout on new code with possibly stale dependencies.
    const f = fixture()
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'pnpm-lock.yaml')

    const result = await run(f, [f.repo], {
      env: shimmed(f, 'rev-parse --short', 'rev-parse main'),
    })

    expect(result.stdout).toContain(
      'could not read the tip of main; install by hand if a lock file changed',
    )
    expect(result.stdout).toContain('fast-forwarded main to')
    expect(result.stdout).not.toContain('null')
    expect(result.stdout).not.toContain('dependencies installed')
    expect(f.git.sha(f.repo, 'main')).toBe(f.git.sha(f.repo, 'refs/remotes/origin/main'))
  })
})

// --- proving a branch has merged ----------------------------------------------

describe('merge proof', () => {
  it('deletes a branch merged with a merge commit, on ancestry alone', async () => {
    const f = fixture()
    SCENARIOS.delete_on_ancestry?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('deleted ff-done')
    expect(f.git.branches(f.repo)).not.toContain('ff-done')
  })

  it('deletes a squash-merged branch on pull-request proof', async () => {
    // Ancestry cannot see a squash merge at all.
    const f = fixture()
    const built = SCENARIOS.delete_on_pull_request_proof?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('deleted squashed')
    expect(result.stdout).toContain('merged PR')
    expect(f.git.branches(f.repo)).not.toContain('squashed')
  })

  it('KEEPS a branch whose name matches a merged PR but whose tip has moved', async () => {
    // The regression that mattered: a reused branch name, or work committed
    // after the PR merged, was force-deleted on a name match alone.
    const f = fixture()
    const built = SCENARIOS.keep_a_branch_whose_tip_has_moved?.(f)
    const danger = f.git.sha(f.repo, 'reused')

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept reused (merged PRs used this name; none at this commit)')
    expect(f.git.branches(f.repo)).toContain('reused')
    expect(f.git.sha(f.repo, 'reused')).toBe(danger)
  })

  it('ignores a merged pull request that came from a fork', async () => {
    // A fork PR's head ref is just a name like patch-1, which collides with
    // local branches trivially.
    const f = fixture()
    const built = SCENARIOS.ignore_a_fork_pull_request?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept patch-1 (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('patch-1')
  })

  it('ignores a pull request merged into another base', async () => {
    const f = fixture()
    const built = SCENARIOS.ignore_another_base?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept for-release (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('for-release')
  })

  it('keeps a branch sitting on the default branch tip', async () => {
    const f = fixture()
    SCENARIOS.keep_a_branch_on_the_tip?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('kept fresh (already at origin/main')
    expect(f.git.branches(f.repo)).toContain('fresh')
  })

  it('falls back to ancestry and says why when the pull request lookup fails', async () => {
    const f = fixture()
    const built = SCENARIOS.pull_request_lookup_failed?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh: simulated failure); using ancestry alone',
    )
    expect(result.stdout).toContain('deleted ff-done')
  })

  it('names a gh that is not on PATH in the words the Python used', async () => {
    // 127 is the runner's answer for a command that is not there, and this is
    // the one gh failure whose sentence the port spells itself.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = {
      ...ghDouble(),
      listMergedPullRequests: async () => {
        throw new GhError('gh pr list failed: cannot run gh: spawn gh ENOENT', 127, {
          cause: 'test',
        })
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh is not on PATH); using ancestry alone',
    )
    expect(result.stdout).toContain('deleted landed')
  })

  it("carries gh's own last line into the report for every other failure", async () => {
    // gh's last line is the useful half of a failure: an auth prompt, a rate
    // limit, a repository it cannot see.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = {
      ...ghDouble(),
      listMergedPullRequests: async () => {
        throw new GhError('gh: warming up\ngh: API rate limit exceeded', 1, { cause: 'test' })
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh: API rate limit exceeded)',
    )
    expect(result.stdout).not.toContain('warming up')
  })

  it('names every other way gh can fail, in the words the failure arrived with', async () => {
    // The Python spells four of these itself (a silent non-zero exit, a gh
    // that is there and will not run, an answer that is not JSON, and one
    // that is JSON but not a list). `lib/gh.ts` owns that vocabulary now and
    // puts it in the error's message, so the port reports the last line of
    // whatever arrived rather than re-deciding it. Each still reaches the
    // reader as its own sentence, which is what the Python's `gh_json`
    // comment asks for: three failures that send the reader to three
    // different places.
    const accounts = [
      'gh pr list --state merged failed: gh exited 4',
      'gh pr list --state merged failed: cannot run gh: spawn gh EACCES',
      'gh answered the merged pull requests with something that is not JSON: unexpected token',
      'gh answered the merged pull requests with something that is not a list: {"message":"Not Found"}',
    ]
    for (const account of accounts) {
      const f = fixture()
      f.git.branchWithWork(f.repo, 'landed')
      f.git.mergeCommit(f.repo, 'landed')
      const gh = {
        ...ghDouble(),
        listMergedPullRequests: async () => {
          throw new GhError(account, 1, { cause: 'test' })
        },
      }

      const result = await run(f, [f.repo], { gh })

      expect(result.stdout).toContain(`could not read merged pull requests (${account});`)
      // The degraded path is the point: ancestry still proves this branch.
      expect(result.stdout).toContain('deleted landed')
    }
  })

  it('treats a list of things that are not pull requests as unreadable', async () => {
    // Every reader asks a row for a field, so this has to route to the same
    // degraded path a failed query takes rather than be read as an empty
    // window.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = { ...ghDouble(), listMergedPullRequests: async () => [1, 2, 3] }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh returned rows that are not pull requests); ' +
        'using ancestry alone',
    )
    expect(result.stdout).toContain('deleted landed')
  })

  it('lets a failure that is not gh out, rather than reading it as an empty window', async () => {
    // `createGhMock` throws a plain Error for an endpoint nobody registered,
    // which is the property a stub binary cannot give. Swallowing it here
    // would make a command that asked for an endpoint the test did not expect
    // look like a repository with no merged pull requests.
    const f = fixture()

    await expect(run(f, [f.repo], { gh: createGhMock({}) })).rejects.toThrow(
      /no reply registered for listMergedPullRequests/,
    )
  })

  it('uses pull requests alone when ancestry cannot be read', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'squashed')
    const sha = f.git.sha(f.repo, 'squashed')
    f.git.mergeSquash(f.repo, 'squashed')

    const result = await run(f, [f.repo], {
      gh: ghDouble({ prs: [pr('squashed', sha)] }),
      env: shimmed(f, 'branch --merged'),
    })

    expect(result.stdout).toContain('could not read merged branches; using pull requests alone')
    expect(result.stdout).toContain('deleted squashed')
  })

  it('skips pruning entirely when neither signal can be read', async () => {
    // Pruning on no proof is exactly the force delete every guard here
    // prevents.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')

    const result = await run(f, [f.repo], {
      gh: ghDouble({ fail: 'all' }),
      env: shimmed(f, 'branch --merged'),
    })

    expect(result.stdout).toContain('no way to prove what has merged; skipped pruning entirely')
    expect(f.git.branches(f.repo)).toContain('wip')
  })
})

// --- the per-branch fallback ---------------------------------------------------

describe('the per-branch fallback', () => {
  it('proves a branch whose pull request falls outside the bulk lookup window', async () => {
    // Found in the field: a repo with more merged pull requests than the bulk
    // limit drops the oldest, and branches merged before that window looked
    // unproven and were kept forever.
    const f = fixture()
    const built = SCENARIOS.past_the_bulk_window?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('deleted landed')
    expect(result.stdout).toContain('merged PR')
    expect(f.git.branches(f.repo)).not.toContain('landed')
  })

  it('does not ask about a branch the bulk lookup already proved', async () => {
    // Guards the call volume: the per-branch query is a fallback, not a second
    // opinion. Asked unconditionally, a repository with many branches would
    // make an API call for each. Asserted by making the per-branch query fail:
    // a run that asked would report the failure, and this one does not.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    const sha = f.git.sha(f.repo, 'landed')
    const prs = manyPrs(199, pr('landed', sha), pr('spare', 'zzz'))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('deleted landed')
    expect(result.stdout).not.toContain('could not ask about this branch')
  })

  it('stops asking after the first failure, and says the run was incomplete', async () => {
    const f = fixture()
    const built = SCENARIOS.per_branch_query_failed?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept first (could not ask about this branch')
    expect(result.stdout).toContain('kept second (could not ask about this branch')
    expect(result.stdout).toContain('2 branch(es) were never checked')
  })

  it('refuses to conclude when one name fills the per-branch window', async () => {
    const f = fixture()
    const built = SCENARIOS.per_branch_window_crowded?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('too many merged PRs used this name to tell')
    expect(f.git.branches(f.repo)).toContain('busy')
  })

  it('ignores another base in the per-branch query', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'for-release-2')
    const sha = f.git.sha(f.repo, 'for-release-2')
    const prs = manyPrs(200, pr('for-release-2', sha, 'release'))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept for-release-2 (no merge proof)')
  })

  it('still requires the commit to match in the fallback', async () => {
    // The fallback must not be a weaker signal than the bulk lookup.
    const f = fixture()
    const built = SCENARIOS.per_branch_tip_moved?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept moved (merged PRs used this name; none at this commit)')
    expect(f.git.branches(f.repo)).toContain('moved')
  })

  it('ignores a fork pull request in the fallback too', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'patch-2')
    const sha = f.git.sha(f.repo, 'patch-2')
    const prs = manyPrs(200, pr('patch-2', sha, 'main', true))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept patch-2 (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('patch-2')
  })

  it('keeps a moved verdict when the per-branch query fails', async () => {
    // The bulk window already proved merged pull requests used this name, and
    // that fact is not undone by a later call failing. Reporting it as "never
    // checked" would throw away a real answer.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'reused')
    const prs = manyPrs(199, pr('reused', 'othersha'))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('kept reused (merged PRs used this name; none at this commit)')
    expect(result.stdout).not.toContain('never checked')
    expect(f.git.branches(f.repo)).toContain('reused')
  })

  it('keeps a moved verdict once the fallback is switched off', async () => {
    // `aaa` sorts first, has no pull request naming it, and its query fails,
    // which turns the fallback off. `zzz-reused` then reaches the no-call arm
    // with a "moved" already in hand, and that verdict has to survive there
    // too.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'aaa')
    f.git.branchWithWork(f.repo, 'zzz-reused')
    const prs = manyPrs(199, pr('zzz-reused', 'othersha'))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('kept aaa (could not ask about this branch')
    expect(result.stdout).toContain(
      'kept zzz-reused (merged PRs used this name; none at this commit)',
    )
    expect(result.stdout).toContain('1 branch(es) were never checked')
  })

  it('says it could not check when the per-branch query fails', async () => {
    // Distinct from "no merge proof": nothing was established either way, and
    // reporting an absence that was never checked is the defect this fixes.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'unchecked')

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: manyPrs(200), fail: 'head' }) })

    expect(result.stdout).toContain('could not ask about this branch')
    expect(f.git.branches(f.repo)).toContain('unchecked')
  })
})

// --- worktrees ------------------------------------------------------------------

describe('worktrees', () => {
  it('removes a clean worktree and deletes its merged branch', async () => {
    const f = fixture()
    SCENARIOS.remove_a_clean_worktree?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('removed worktree')
    expect(result.stdout).toContain('deleted wt-clean')
    expect(existsSync(f.sandbox.join('wt'))).toBe(false)
  })

  it('keeps a merged branch whose worktree is dirty, and preserves the work', async () => {
    const f = fixture()
    SCENARIOS.keep_a_dirty_worktree?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('uncommitted changes')
    expect(f.git.branches(f.repo)).toContain('wt-dirty')
    expect(readFileSync(f.sandbox.join('wt', 'wt-dirty.txt'), 'utf8')).toContain('dirty')
  })

  it('keeps a branch whose worktree cannot be read', async () => {
    const f = fixture()
    SCENARIOS.keep_an_unreadable_worktree?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('cannot read worktree')
    expect(f.git.branches(f.repo)).toContain('wt')
  })

  it('keeps a branch whose worktree cannot be removed', async () => {
    // An untracked file passes the cleanliness guard but makes git worktree
    // remove refuse without --force, which this deliberately never passes.
    const f = fixture()
    SCENARIOS.keep_a_worktree_that_cannot_be_removed?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('could not remove worktree')
    expect(f.git.branches(f.repo)).toContain('wt')
    expect(existsSync(f.sandbox.join('wt'))).toBe(true)
  })

  it('describes a worktree removal in --dry-run without doing it', async () => {
    const f = fixture()
    SCENARIOS.dry_run_worktree_removal?.(f)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).toContain('would remove worktree')
    expect(existsSync(f.sandbox.join('wt'))).toBe(true)
    expect(f.git.branches(f.repo)).toContain('wt')
  })

  it('skips when the worktree list cannot be read', async () => {
    // Fails closed: an empty branch-to-worktree map would make every branch
    // look free of a worktree, and that map is the only thing between real
    // uncommitted work and a force delete.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')

    const result = await run(f, [f.repo], { env: shimmed(f, 'worktree list') })

    expect(result.stdout).toContain('skipped: cannot list worktrees')
    expect(f.git.branches(f.repo)).toContain('wip')
  })

  it('prunes anyway but does not try to advance when the default branch is elsewhere', async () => {
    const f = fixture()
    SCENARIOS.cannot_switch_pruning_only?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('cannot switch to main')
    expect(result.stdout).toContain('pruning only')
    expect(result.stdout).toContain('deleted gone')
  })

  it('reports the branch it could not delete rather than claiming success', async () => {
    // With main held by another worktree the sync cannot switch away, so it is
    // still standing on the very branch it has proof to delete.
    const f = fixture()
    SCENARIOS.could_not_delete_a_branch?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('could not delete side')
    expect(f.git.branches(f.repo)).toContain('side')
  })

  it('keeps a branch whose tip cannot be resolved', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')

    const result = await run(f, [f.repo], {
      env: shimmed(f, 'rev-parse --verify --quiet refs/heads/wip'),
    })

    expect(result.stdout).toContain('kept wip (cannot resolve its tip)')
    expect(f.git.branches(f.repo)).toContain('wip')
  })

  it('clears a stale worktree entry once the prune has run', async () => {
    // Only `git worktree prune` clears the administrative entry for a worktree
    // whose directory is gone, so its absence afterwards is proof the run
    // reached the end.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'open-work')
    f.git.worktree(f.repo, f.sandbox.join('stale'), 'open-work')
    rmSync(f.sandbox.join('stale'), { recursive: true, force: true })

    await run(f, [f.repo])

    expect(f.git.git(f.repo, 'worktree', 'list')).not.toContain(f.sandbox.join('stale'))
  })
})

// --- the default branch ---------------------------------------------------------

describe('resolving the default branch', () => {
  it('repairs a missing origin/HEAD from the remote', async () => {
    const f = fixture()
    f.git.forgetOriginHead(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('already up to date')
    expect(f.git.git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
      'refs/remotes/origin/main',
    )
  })

  it('asks gh for the default branch when the remote cannot be reached', async () => {
    const f = fixture()
    f.git.forgetOriginHead(f.repo)
    f.git.breakOrigin(f.repo)

    // gh answered, so the run got as far as the fetch before failing.
    const result = await run(f, [f.repo], { gh: ghDouble({ defaultBranch: 'main' }) })

    expect(result.stdout).toContain('fetch failed')
  })

  it('falls back to a local main ref when gh cannot answer either', async () => {
    const f = fixture()
    f.git.forgetOriginHead(f.repo)
    f.git.breakOrigin(f.repo)

    const result = await run(f, [f.repo], { gh: ghDouble({ fail: 'all' }) })

    expect(result.stdout).toContain('fetch failed')
  })

  it('ignores a gh answer whose default branch is named by nothing', async () => {
    // `{}` and `{name: ""}` are both "gh answered, and not with a branch
    // name": the Python reads the same two as falsy and falls through to the
    // local refs rather than syncing a branch called "".
    const f = fixture()
    f.git.forgetOriginHead(f.repo)
    f.git.breakOrigin(f.repo)

    for (const ref of [{}, { name: '' }]) {
      const gh = { ...ghDouble(), viewRepository: async () => ({ defaultBranchRef: ref }) }

      const result = await run(f, [f.repo], { gh })

      expect(result.stdout).toContain('fetch failed')
    }
  })

  it('ignores a gh answer with no default branch in it', async () => {
    const f = fixture()
    f.git.forgetOriginHead(f.repo)
    f.git.breakOrigin(f.repo)
    const gh = { ...ghDouble(), viewRepository: async () => ({ defaultBranchRef: null }) }

    // Falls through to the local refs, which still name main.
    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain('fetch failed')
  })

  it('skips when the default branch has no local remote-tracking ref', async () => {
    const f = fixture()
    const built = SCENARIOS.origin_default_missing?.(f)

    const result = await run(f, built?.argv ?? [], { gh: built?.gh })

    expect(result.stdout).toContain('origin/trunk does not exist locally')
  })
})

// --- the install ----------------------------------------------------------------

describe('the install', () => {
  it('offers to install when the pull changed the lock file', async () => {
    const f = fixture()
    SCENARIOS.lock_file_changed?.(f)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).toContain('lock file changed in that range')
  })

  it('stays quiet when the pull did not touch the lock file', async () => {
    const f = fixture()
    SCENARIOS.lock_file_untouched?.(f)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).not.toContain('lock file changed')
  })

  it('says nothing about a yarn or npm lock file the pull changed', async () => {
    // The pnpm-only ruling, seen from the report: another package manager's
    // checkout is synced as a repository with no dependencies to install.
    const f = fixture()
    f.git.lockfile(f.repo, 'package-lock.json')
    f.git.remoteAdvance(f.repo, 'package-lock.json')

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).not.toContain('lock file changed')
    expect(result.stdout).toContain('would fast-forward')
  })

  it('honours --no-install even when the lock file changed', async () => {
    const f = fixture()
    SCENARIOS.no_install?.(f)

    const result = await run(f, ['--dry-run', '--no-install', f.repo])

    expect(result.stdout).not.toContain('lock file changed')
  })

  it('says so when the lock-file diff could not be read', async () => {
    // "no lock file changed" and "I could not tell" leave the checkout in very
    // different states: the second means new code with possibly stale
    // dependencies.
    const f = fixture()
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo)

    const result = await run(f, [f.repo], { env: shimmed(f, 'diff') })

    expect(result.stdout).toContain('could not diff the lock files over that range')
    expect(result.stdout).not.toContain('dependencies installed')
  })

  it('runs the real pnpm when the pull changed pnpm-lock.yaml', async () => {
    const f = fixture()
    const packages = createPackageFixtures(f.sandbox, f.git)
    packages.jsProject(f.repo)
    packages.remoteUpdateLock(f.repo)

    const result = await run(f, [f.repo], { env: corepackEnv(f.env) })

    expect(result.stdout).toContain('dependencies installed')
  })

  it('says so when the pull removed the lock file, rather than claiming an install', async () => {
    const f = fixture()
    const packages = createPackageFixtures(f.sandbox, f.git)
    packages.jsProject(f.repo)
    packages.remoteDropLockfile(f.repo)

    const result = await run(f, [f.repo], { env: corepackEnv(f.env) })

    expect(result.stdout).toContain('no recognised lock file remains')
  })

  it('reports the reason when an install fails', async () => {
    // Broken on the remote side, so the default branch still fast-forwards and
    // the install is what fails, for a real and reportable reason.
    const f = fixture()
    const packages = createPackageFixtures(f.sandbox, f.git)
    packages.jsProject(f.repo)
    packages.remoteBreakLock(f.repo)

    const result = await run(f, [f.repo], { env: corepackEnv(f.env) })

    expect(result.stdout).toContain('install failed')
    expect(result.stdout).toContain('run it by hand')
  })
})

// --- --dry-run --------------------------------------------------------------------

describe('--dry-run', () => {
  it('changes nothing it says it would change', async () => {
    const f = fixture()
    SCENARIOS.dry_run?.(f)
    const branches = f.git.branches(f.repo)
    const head = f.git.headSha(f.repo)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).toContain('would delete ff-done')
    expect(f.git.branches(f.repo)).toEqual(branches)
    expect(f.git.headSha(f.repo)).toBe(head)
    expect(f.git.currentBranch(f.repo)).toBe('side')
  })

  it('offers to create the default branch when the checkout has never had it', async () => {
    const f = fixture()
    SCENARIOS.would_create_the_default_branch?.(f)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.stdout).toContain('would create main from origin/main')
  })
})

// --- a reader that goes away --------------------------------------------------------

describe('a reader that goes away', () => {
  it('stops the report and finishes the prune', async () => {
    // Reproduced in the field on a checkout with 601 prunable branches: piping
    // into `head` closed the pipe partway through the prune, and the run
    // exited 0 with 78 branches still there and nothing saying so, because
    // saying so was the thing that had failed.
    const f = fixture()
    for (const name of ['landed-a', 'landed-b', 'landed-c']) {
      f.git.branchWithWork(f.repo, name)
      f.git.mergeCommit(f.repo, name)
    }
    const written: string[] = []
    let listener: ((error: NodeJS.ErrnoException) => void) | undefined
    const closing: OutputStream = {
      write(text: string) {
        // The reader leaves on the first line, which is how `| head` behaves:
        // the failure arrives as an event rather than at the call.
        listener?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        written.push(text)
        return true
      },
      on(_event: 'error', handler: (error: NodeJS.ErrnoException) => void) {
        listener = handler
        return undefined
      },
    }
    const quiet: OutputStream = {
      write() {
        return true
      },
      on() {
        return undefined
      },
    }

    const envelope = await runSyncRepo([f.repo], {
      cwd: f.sandbox.path,
      env: f.env,
      output: createOutput(closing, quiet),
      createGh: () => ghDouble(),
    })

    expect(envelope.outcome).toBe('ok')
    // One line reached the descriptor, and the writer went quiet after it.
    expect(written).toHaveLength(1)
    // The work finished anyway, which is the whole point.
    for (const name of ['landed-a', 'landed-b', 'landed-c']) {
      expect(f.git.branches(f.repo)).not.toContain(name)
    }
  })
})

// --- parity with the shell version --------------------------------------------------

describe('parity with the report the shell version printed', () => {
  it('has a captured report for every scenario', () => {
    // A scenario with no golden would silently assert nothing.
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(GOLDEN).sort())
  })

  it('applies every recorded divergence to a golden that still contains it', () => {
    for (const [name, change] of Object.entries(DIVERGENCES['bash-output.json'])) {
      expect(GOLDEN[name]?.stdout).toContain(change.was)
    }
  })

  for (const name of Object.keys(SCENARIOS).sort()) {
    it(`matches the shell report for ${name}`, async () => {
      const f = fixture()
      const built = SCENARIOS[name]?.(f)
      if (built === undefined) throw new Error(`no scenario named ${name}`)

      const result = await run(f, built.argv, { gh: built.gh, env: built.env })

      const golden = GOLDEN[name]
      if (golden === undefined) throw new Error(`no golden for ${name}`)
      const change = DIVERGENCES['bash-output.json'][name]
      const expected =
        change === undefined ? golden.stdout : golden.stdout.replace(change.was, change.now)
      expect(result.status).toBe(golden.status)
      expect(normalise(result.stdout, f.sandbox)).toBe(expected)
    })
  }
})
