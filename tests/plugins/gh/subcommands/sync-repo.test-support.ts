// This file tests one checkout's sync, against real repositories. It is the
// port of `tests/gh/test_gh_sync_repo.py`, `test_gh_sync_repo_edges.py`, and
// `test_output_parity.py`. Their scenarios come from `tests/gh/scenarios.py`.
//
// The parity block at the end is the contract. It compares every scenario's
// report, byte for byte, with `fixtures/bash-output.json`. `gh-sync-repo.sh`
// printed that fixture before its deletion. Only the divergences in
// `fixtures/divergences.json` differ. The examples above the parity block
// make claims. The report alone does not prove those claims, above all the
// side effects: which branches and worktrees remain afterwards.
//
// git is real (`harness/git.ts`); `gh` is injected. The double here answers
// from a canned set. It applies the same server-side filtering that real
// `gh pr list` applies (`--base`, `--head`, `--limit`). This is what the
// Python's stub `gh` does, and what lets the per-branch fallback run at all.
// `createGhMock` answers every call with one registered reply, by design. So
// it cannot tell a bulk window from a per-branch query.
//
// **Issue #127 deleted the Python this file ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from the
// tree. The file and line references below match commit `cd0d515`, the last
// commit with these files. Each reference stays because it shows where a rule
// came from.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitCodeFor } from '#gh/lib/envelope.ts'
import { createOutput, type OutputStream } from '#gh/lib/streams.ts'
import { runSyncRepo } from '#gh/subcommands/sync-repo.ts'
import { type GhClient, type GhReplies, ghFails } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createGhServer, manyPrs, type PullRequestRow, pr } from '#harness/pulls.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

export const GOLDEN: Record<string, { status: number; stdout: string }> = JSON.parse(
  read('bash-output.json'),
)

export const DIVERGENCES: {
  'bash-output.json': Record<string, { was: string; now: string }>
  ghVocabulary: {
    lines: { state: string; was: string; now: string; account: string; message: string }[]
    closed: { lines: { state: string; was: string; account: string; message: string }[] }
  }
} = JSON.parse(read('divergences.json'))

export const PYTHON: Record<
  string,
  Record<string, { status: number; stdout: string; stderr: string }>
> = JSON.parse(read('python-cli-output.json'))

export interface GhOptions {
  /** The canned set every query is answered from. */
  readonly prs?: PullRequestRow[]
  /** `all` fails every call, `head` only the per-branch ones, so a bulk lookup
   *  can succeed while the fallback does not. */
  readonly fail?: 'all' | 'head'
  /** What `gh repo view` answers with, for the default-branch fallback. */
  readonly defaultBranch?: string
}

/**
 * A `gh` that answers about merged pull requests the way the real one does.
 *
 * The double itself is now `harness/pulls.ts` `createGhServer` (#127 layer
 * 3). That layer needed the same two properties for the shepherd, so it moved
 * the double out of this file. What is left here is the translation from this
 * file's own options to that server's. So no example below changed. The row
 * builders `pr` and `manyPrs` moved with it.
 *
 * The server gives one thing `createGhMock` cannot: the server-side filtering
 * that real `gh pr list` applies (`--state`, `--base`, `--head`, `--limit`).
 * This filter is what turns a saturated window into a window, not a full
 * answer. Without it, nothing could ever reach the per-branch fallback.
 * Otherwise, the bulk window and the per-branch query are the same endpoint.
 *
 * This double gives up one property of `createGhMock`, for the endpoints
 * with a registered reply. `createGhMock` always answers
 * `listMergedPullRequests`. So a query nobody expected reads as an answer
 * here, rather than throwing. The test "does not ask about a branch the bulk
 * lookup already proved" checks that same property from the other side. It
 * does this by making the per-branch query fail.
 */
export function ghDouble(options: GhOptions = {}): GhClient {
  // This uses `ghFails`, not a hand-built `GhError`. `ghFails` is the
  // harness's own fail switch, and it sets `detail`, the field the report
  // quotes. So these doubles fail the way the real client does. `fail: 'all'`
  // matches the stub `gh`'s `GH_FIXTURE_FAIL`. It fails every call, including
  // `gh repo view`. So the default-branch fallback sees a gh that cannot
  // answer, not one nobody registered.
  const replies: GhReplies =
    options.defaultBranch === undefined
      ? {}
      : { viewRepository: { defaultBranchRef: { name: options.defaultBranch } } }
  return createGhServer({
    prs: options.prs ?? [],
    replies,
    fail: options.fail === 'all' ? ghFails('gh: simulated failure') : undefined,
    failHead: options.fail === 'head' ? ghFails('gh: simulated per-branch failure') : undefined,
  })
}

/** The pair of writers a command reports through, over two buffers. */
export function capture() {
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

export interface Fixture {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
}

export function fixture(): Fixture {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))
  return { sandbox, git, repo, env: sandbox.env }
}

/** Run the command and hand back everything it did. */
export async function run(
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

/** This replaces the per-run detail in one run's report with placeholders.
 *  `tests/gh/scenarios.py` `normalise` did the same: it replaced commit
 *  hashes, and the temporary directory that held the fixtures. */
export function normalise(text: string, sandbox: Sandbox): string {
  let out = text
  for (const spelling of [realpathSync(sandbox.path), sandbox.path]) {
    out = out.split(spelling).join('<sandbox>')
  }
  return out.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
}

/** What a scenario builds: the state, and how the run is asked for. */
export type Scenario = (f: Fixture) => {
  argv: string[]
  gh?: GhClient
  env?: NodeJS.ProcessEnv
}

/** A PATH whose git refuses the named subcommands and forwards the rest. */
export function shimmed(f: Fixture, ...failing: string[]): NodeJS.ProcessEnv {
  const shim = f.git.gitShim(...failing)
  return {
    ...f.env,
    PATH: `${shim.directory}${path.delimiter}${f.env.PATH ?? ''}`,
    GIT_STUB_FAIL: shim.failing,
  }
}

/** A PATH whose git answers the named subcommands with exit 0 and nothing at
 *  all, and forwards the rest. This is the shape CI reached. It is also the
 *  shape the Python guards against, with `or`/`if not`, at nine call sites in
 *  this file's subject.
 *
 *  The match is a prefix of the whole subcommand line (`harness/git.ts`). So
 *  `'rev-parse --short'` silences every abbreviation, and the full form still
 *  answers. A test can also name a whole ref, to silence one question and not
 *  its sibling. Tests need both matching styles. Several of these guards sit
 *  on two `rev-parse` forms of the SAME ref. A shim that silenced both would
 *  prove a different arm. */
export function silenced(f: Fixture, ...quiet: string[]): NodeJS.ProcessEnv {
  const shim = f.git.gitShim()
  return {
    ...f.env,
    PATH: `${shim.directory}${path.delimiter}${f.env.PATH ?? ''}`,
    GIT_STUB_SILENT: quiet.join(','),
  }
}

// The scenarios of `tests/gh/scenarios.py`, one for one. The three lock-file
// ones build a `pnpm-lock.yaml` where the Python builds a `package-lock.json`.
// The port watches only one lock file (the pnpm-only ruling). The state under
// test is "the pull touched the lock file this checkout uses". The reported
// line stays the same, so the golden still applies. `fixtures/divergences.json`
// records that substitution.
export const SCENARIOS: Record<string, Scenario> = {
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
    // --dry-run, nothing repairs origin/HEAD, so the answer stands.
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
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('squashed', sha, 'main', false, landed)] }) }
  },
  keep_a_branch_whose_tip_has_moved: (f) => {
    f.git.branchWithWork(f.repo, 'reused')
    const merged = f.git.sha(f.repo, 'reused')
    f.git.mergeSquash(f.repo, 'reused')
    f.git.git(f.repo, 'checkout', '-q', 'reused')
    f.git.commit(f.repo, 'unpushed work', 'danger.txt', 'secret')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('reused', merged, 'main', false, landed)] }) }
  },
  ignore_a_fork_pull_request: (f) => {
    f.git.branchWithWork(f.repo, 'patch-1')
    const sha = f.git.sha(f.repo, 'patch-1')
    return { argv: [f.repo], gh: ghDouble({ prs: [pr('patch-1', sha, 'main', true)] }) }
  },
  ignore_another_base: (f) => {
    f.git.branchWithWork(f.repo, 'for-release')
    const sha = f.git.sha(f.repo, 'for-release')
    // The merge commit is on `release`, not on main, so the guard refuses it.
    const merged = { number: 1, mergeCommit: sha }
    return {
      argv: [f.repo],
      gh: ghDouble({ prs: [pr('for-release', sha, 'release', false, merged)] }),
    }
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
    f.git.mergeSquash(f.repo, 'landed')
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const prs = manyPrs(200, pr('landed', sha, 'main', false, landed))
    return { argv: [f.repo], gh: ghDouble({ prs }) }
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
    // Any commit on main passes the merge-commit guard. The local commit
    // after the merge is what keeps the branch.
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const prs = manyPrs(200, pr('moved', merged, 'main', false, landed))
    return { argv: [f.repo], gh: ghDouble({ prs }) }
  },
}
