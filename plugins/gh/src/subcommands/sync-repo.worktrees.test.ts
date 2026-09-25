// sync-repo, part of its tests: worktrees, the default branch, the install, --dry-run and a reader that goes away.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync-repo.test-support.ts` holds the helpers and the header that says what the tests prove.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { corepackEnv, createPackageFixtures } from '../../../../harness/packages.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import { fixture, ghDouble, run, SCENARIOS, shimmed } from './sync-repo.test-support.ts'
import { runSyncRepo } from './sync-repo.ts'

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
    // This fails closed. An empty branch-to-worktree map would make every
    // branch look free of a worktree. That map is the only thing between
    // real uncommitted work and a force delete.
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
    // With main held by another worktree, the sync cannot switch away. So it
    // still stands on the very branch it has proof to delete.
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
    // Only `git worktree prune` clears the administrative entry for a
    // worktree whose directory is gone. So its absence afterwards proves the
    // run reached the end.
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

    // gh answered, so the run got as far as the fetch before it failed.
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
    // `{}` and `{name: ""}` both mean "gh answered, and not with a branch
    // name". The Python reads both the same way, as falsy, and falls through
    // to the local refs. It does not sync a branch called "".
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

    // This falls through to the local refs, which still name main.
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
    // This is the pnpm-only ruling, seen from the report. The run syncs
    // another package manager's checkout as a repository with no
    // dependencies to install.
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
    // "no lock file changed" and "I could not tell" leave the checkout in
    // very different states. The second means new code with possibly stale
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
    // The remote side is broken, so the default branch still fast-forwards.
    // The install is what fails, for a real and reportable reason.
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
    // The field reproduced this on a checkout with 601 prunable branches. A
    // pipe into `head` closed partway through the prune. The run exited 0,
    // with 78 branches still there and no message about it. The write that
    // should have reported this was the very thing that had failed.
    const f = fixture()
    for (const name of ['landed-a', 'landed-b', 'landed-c']) {
      f.git.branchWithWork(f.repo, name)
      f.git.mergeCommit(f.repo, name)
    }
    // `test_finishes_the_prune_when_the_reader_closes_the_pipe` builds two
    // things here: a merged branch in a LIVE worktree, and a worktree whose
    // directory is gone. Together they cover one half of the field bug. The
    // run exited 0 with branches still there, and it never called
    // `git worktree prune` at all. Only the stale entry's absence afterward
    // proves the run reached the end, instead of stopping at the first
    // failed write. A test that asserts the branches alone leaves the prune
    // unproven, on the one path where it once regressed.
    f.git.branchWithWork(f.repo, 'wt-landed')
    f.git.mergeCommit(f.repo, 'wt-landed')
    f.git.worktree(f.repo, f.sandbox.join('wt'), 'wt-landed')
    f.git.branchWithWork(f.repo, 'open-work')
    f.git.worktree(f.repo, f.sandbox.join('stale'), 'open-work')
    rmSync(f.sandbox.join('stale'), { recursive: true, force: true })
    const written: string[] = []
    let listener: ((error: NodeJS.ErrnoException) => void) | undefined
    const closing: OutputStream = {
      write(text: string) {
        // The reader leaves on the first line, which is how `| head` behaves.
        // The failure arrives as an event, rather than at the call.
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
    // This test asserts that as text, not as a write count. A count would
    // pin how the code chunks the report. It would go red for a re-chunking
    // that changes nothing.
    expect(written.join('')).toBe(`${path.basename(f.repo)}\n`)
    // The work finished anyway, which is the whole point.
    const branches = f.git.branches(f.repo)
    for (const name of ['landed-a', 'landed-b', 'landed-c', 'wt-landed']) {
      expect(branches).not.toContain(name)
    }
    expect(existsSync(f.sandbox.join('wt'))).toBe(false)
    expect(f.git.git(f.repo, 'worktree', 'list')).not.toContain(f.sandbox.join('stale'))
  })
})
