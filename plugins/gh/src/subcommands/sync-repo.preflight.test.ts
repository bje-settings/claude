// sync-repo, part of its tests: the command line and the preflight.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync-repo.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture, ghDouble, PYTHON, run, SCENARIOS, silenced } from './sync-repo.test-support.ts'
import { parseSyncRepoArgs, USAGE } from './sync-repo.ts'

// --- the argument handling ----------------------------------------------------

describe('the command line', () => {
  it('prints usage for --help without leaking code', async () => {
    const f = fixture()

    const result = await run(f, ['--help'])

    expect(result.status).toBe(0)
    expect(result.envelope.outcome === 'ok' && result.envelope.value).toContain('Usage:')
    expect(result.envelope.outcome === 'ok' && result.envelope.value).not.toContain('import')
    // The Python answered the same question with the same status. This test
    // compares that to the port's own answer, not to a literal string beside
    // it.
    expect(result.status).toBe(PYTHON['sync-repo']?.help?.status)
    expect(PYTHON['sync-repo']?.help?.stdout).toContain('Usage:')
  })

  it('rejects an unknown flag', async () => {
    const f = fixture()

    const result = await run(f, ['--wat', f.repo])

    expect(result.status).toBe(2)
    expect(`${result.stderr}\n`).toBe(PYTHON['sync-repo']?.unknown_flag?.stderr)
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
    // "1" means on, and "0" or unset means off. This is how the fan-out
    // passed these flags to its jobs. It is also what they mean wherever else
    // something sets them.
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
    // A corrupt index makes git status exit non-zero with empty stdout. A
    // naive check reads that as "clean" and then deletes branches based on
    // it.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')
    f.git.corruptIndex(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('cannot read the working tree state')
    expect(f.git.branches(f.repo)).toContain('wip')
  })

  it('names a git that is not on PATH as that, not as a bad repository', async () => {
    // The first failed git call could look like "not a git repository". That
    // would send the reader to inspect a checkout that is perfectly fine.
    const f = fixture()

    const result = await run(f, [f.repo], {
      env: { ...f.env, PATH: f.sandbox.pathWithout('git') },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: git is not on PATH')
    expect(result.stdout).not.toContain('not a git repository')
  })

  it('names a git that is present and will not run as its own reason', async () => {
    // This test uses a file on PATH without the execute bit, with nothing
    // else on PATH. The lookup finds it, but the exec fails with EACCES on
    // both platforms. An empty file WITH the bit set is not the same test: on
    // Linux that is ENOEXEC. execvp re-runs it through /bin/sh, so the fake
    // git exits 0 and prints nothing. The example below covers that case
    // instead. EACCES on one entry of a longer PATH makes execvp keep
    // searching.
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
    // a git repository", paired with a non-zero status. Real git always
    // answers with a status. But a caller can arrange a `git` on PATH that
    // exits 0 in silence. Without the guard, the run carries on with no
    // checkout root. It then reports "already up to date ()" about a
    // repository it never found.
    const f = fixture()
    const stubs = f.sandbox.join('silent-git')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = await run(f, [f.repo], { env: { ...f.env, PATH: stubs } })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: not a git repository')
    expect(result.stdout).not.toContain('already up to date')
  })

  it('asks the fallbacks when a git that exits 0 and prints nothing names no default branch', async () => {
    // This is the sibling of the example above, one guard further on.
    // `gh-sync-repo.py:241` and `:247` are `if not ref` and `if ref:`. So an
    // empty `symbolic-ref` answer falls through to the repair, then to gh,
    // then to origin/main and origin/master. If the code read that empty
    // answer as a real one instead, the default branch would become the
    // empty string. The run would report `origin/ does not exist locally`,
    // about a repository whose default branch either fallback would have
    // found.
    const f = fixture()

    const result = await run(f, [f.repo], {
      gh: ghDouble({ defaultBranch: 'main' }),
      env: silenced(f, 'symbolic-ref'),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('main already up to date')
    expect(result.stdout).not.toContain('origin/ does not exist locally')
  })

  // --- an empty answer at every other guard --------------------------------
  //
  // `gh-sync-repo.py` guards an empty git answer with `or`/`if not`, at nine
  // places. The port has to guard the same nine. A `git` that exits 0 and
  // prints nothing is a shape a caller can arrange, and CI reached it. Two of
  // the nine are the examples above (the checkout root and the default
  // branch).
  //
  // The other seven are here. They need `GIT_STUB_SILENT`, not
  // `GIT_STUB_FAIL`, to reach. A git that FAILS answers `null`, and real git
  // already drives that arm, so coverage already counts it. The change from
  // `||` to `??`, or from `!x` to `x === null`, is not a branch at all. So
  // the coverage gate cannot see any of these go.

  it('falls back to the full sha when every abbreviation reads empty', async () => {
    // `gh-sync-repo.py:368` and `:381` are `or self.tip` and
    // `or git_out("rev-parse", self.default)`. An empty abbreviation is no
    // abbreviation, so the full form behind it still answers. If the code
    // read that empty value as an answer instead, `before` and `target`
    // would both be `""`. They would compare equal. The run would then
    // report the literal `main already up to date ()`, about a branch it was
    // about to move. `:664`'s `and advanced_from` would then hand
    // `git diff --name-only "" ""` a range with no ends.
    const f = fixture()
    SCENARIOS.lock_file_changed?.(f)

    const result = await run(f, ['--dry-run', f.repo], {
      env: silenced(f, 'rev-parse --short'),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('lock file changed in that range; would run install')
    expect(result.stdout).not.toContain('already up to date ()')
    expect(result.stdout).not.toContain('could not diff the lock files over that range')
  })

  it('keeps the sha that makes a deletion recoverable when the abbreviation reads empty', async () => {
    // `gh-sync-repo.py:631` is `or sha`. Its own comment says the full sha is
    // in hand precisely so this line keeps "the recoverability the line
    // exists for". If the code read the empty value as an answer, the line
    // would become `deleted ff-done (, merged into main)`. The one thing
    // that makes `git branch -D` undoable would then be gone.
    const f = fixture()
    SCENARIOS.delete_on_ancestry?.(f)

    const result = await run(f, [f.repo], { env: silenced(f, 'rev-parse --short') })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/deleted ff-done \([0-9a-f]{7,}, merged into main\)/)
    expect(result.stdout).not.toContain('deleted ff-done (,')
  })

  it('reads an empty origin tip as no tip, rather than as one nothing can equal', async () => {
    // `gh-sync-repo.py:673` is `if not self.tip`. This test names the whole
    // ref, so it silences this question but not the per-branch one below. If
    // the code read the empty value as an answer, `this.tip` would be `""`.
    // Nothing equals an empty string, so `kept ... nothing to prune` could
    // never fire. A branch that sits exactly on the default tip would then be
    // force-deleted instead of kept.
    const f = fixture()
    SCENARIOS.keep_a_branch_on_the_tip?.(f)

    const result = await run(f, [f.repo], {
      env: silenced(f, 'rev-parse --verify --quiet refs/remotes/origin/main'),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'origin/main does not exist locally; nothing to compare against',
    )
    expect(result.stdout).not.toContain('deleted')
  })

  it('keeps a branch whose own tip reads empty, rather than deleting it unread', async () => {
    // `gh-sync-repo.py:546` is `if not sha`. If the code read the empty value
    // as an answer, the branch would carry `""` into the pull-request match.
    // Nothing can equal an empty string, so that signal would die silently.
    // Ancestry could still prove the branch, though, and force-delete it on a
    // tip the code never read.
    const f = fixture()
    SCENARIOS.delete_on_ancestry?.(f)

    const result = await run(f, [f.repo], {
      env: silenced(f, 'rev-parse --verify --quiet refs/heads/ff-done'),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('kept ff-done (cannot resolve its tip)')
    expect(f.git.branches(f.repo)).toContain('ff-done')
  })

  it('names HEAD when the current branch reads empty, not the empty string', async () => {
    // `gh-sync-repo.py:349` is `or "HEAD"`. This is the sibling of the
    // failing-git example above, which reaches the same fallback through
    // `null`. If the code read the empty value as an answer, the line would
    // become `would switch from  to main`. It would name no branch, and the
    // report would quote a value that is not one.
    const f = fixture()
    SCENARIOS.switch_to_the_default_branch?.(f)

    const result = await run(f, ['--dry-run', f.repo], {
      env: silenced(f, 'rev-parse --abbrev-ref'),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('would switch from HEAD to main')
    expect(result.stdout).not.toContain('would switch from  to')
  })

  it('skips a repository whose path is a file rather than a directory', async () => {
    const f = fixture()

    const result = await run(f, [path.join(f.repo, 'file.txt')])

    expect(result.stdout).toContain('skipped: cannot enter directory')
  })
})
