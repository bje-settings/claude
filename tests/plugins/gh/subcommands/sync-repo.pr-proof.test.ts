// sync-repo, part of its tests: a merge proof for stacked, rebased and moved branches.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync-repo.test-support.ts` holds the helpers and the header that says what the tests prove.
//
// Each test builds the remote side of a pull request in a second clone of the
// origin. A pull request head that the remote rebased is then a commit that the
// checkout under test does not have, as in the field cases of #450.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { manyPrs, pr } from '#harness/pulls.ts'
import { type Fixture, fixture, ghDouble, run, shimmed } from './sync-repo.test-support.ts'

/** The bare origin of the fixture. */
const originOf = (f: Fixture): string => f.git.git(f.repo, 'remote', 'get-url', 'origin')

/** A second clone of the origin, where the remote side of a pull request
 *  happens: a rebase, an update of the branch, or the squash merge. */
function remoteSide(f: Fixture): string {
  const at = f.sandbox.join('remote')
  f.git.git(f.sandbox.path, 'clone', '-q', originOf(f), at)
  f.git.git(at, 'config', 'gc.auto', '0')
  return at
}

/** Squash `head` onto `main` in `at`, push it, and give the merge commit. */
function squashOnRemote(f: Fixture, at: string, head: string): string {
  f.git.git(at, 'checkout', '-q', 'main')
  f.git.git(at, 'merge', '-q', '--squash', head)
  f.git.git(at, 'commit', '-qm', `squash ${head}`)
  f.git.git(at, 'push', '-q', 'origin', 'main')
  return f.git.sha(at, 'main')
}

/** A local branch with two commits, pushed. The remote then rebases it onto a
 *  newer `main`, keeps the result at `refs/pull/<number>/head`, and squashes
 *  it. This is the shape of #432, #435 and #437. */
function rebasedByRemote(f: Fixture, branch: string, number: number) {
  f.git.git(f.repo, 'checkout', '-q', '-b', branch)
  f.git.commit(f.repo, 'one', 'one.txt', 'one')
  f.git.commit(f.repo, 'two', 'two.txt', 'two')
  f.git.git(f.repo, 'checkout', '-q', 'main')
  f.git.git(f.repo, 'push', '-q', 'origin', branch)
  const at = remoteSide(f)
  f.git.commit(at, 'main moves on', 'main.txt', 'newer')
  f.git.git(at, 'push', '-q', 'origin', 'main')
  f.git.git(at, 'checkout', '-q', '-b', branch, `origin/${branch}`)
  f.git.git(at, 'rebase', '-q', 'main')
  const head = f.git.sha(at, 'HEAD')
  f.git.git(at, 'push', '-q', 'origin', `HEAD:refs/pull/${number}/head`)
  const landed = squashOnRemote(f, at, head)
  return { head, landed, row: pr(branch, head, 'main', false, { number, mergeCommit: landed }) }
}

/** A PATH whose git ends `merge-base --is-ancestor <commit>` with status 128,
 *  the status of a git that could not answer. The harness shim refuses with
 *  status 1, which this probe reads as "not an ancestor". */
function crashing(f: Fixture, commit: string): NodeJS.ProcessEnv {
  const real = execFileSync('sh', ['-c', 'command -v git'], { env: f.env }).toString().trim()
  const directory = mkdtempSync(f.sandbox.join('crash-'))
  writeFileSync(
    path.join(directory, 'git'),
    `#!/bin/sh\ncase "$*" in\n  'merge-base --is-ancestor ${commit}'*) exit 128 ;;\nesac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  )
  return { ...f.env, PATH: `${directory}${path.delimiter}${f.env.PATH ?? ''}` }
}

const ABSENT = 'f'.repeat(40)

// --- #348: a stacked pull request ------------------------------------------------

describe('a stacked pull request', () => {
  it('prunes a branch merged into a parent base when its merge commit is on main', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'parent')
    f.git.git(f.repo, 'checkout', '-q', '-b', 'child', 'parent')
    f.git.commit(f.repo, 'work on child', 'child.txt', 'child')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    const child = f.git.sha(f.repo, 'child')
    f.git.mergeSquash(f.repo, 'child')
    const landed = f.git.sha(f.repo, 'main')
    const prs = [pr('child', child, 'parent', false, { number: 2, mergeCommit: landed })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toMatch(/deleted child \([0-9a-f]+, merged PR\)/)
    expect(f.git.branches(f.repo)).not.toContain('child')
  })

  it('keeps a branch merged into a parent that never landed (pinning test)', async () => {
    // This was green on e955762 too: the old query never saw the row. It
    // pins the guard that replaces the `--base` filter.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'parent')
    f.git.git(f.repo, 'checkout', '-q', '-b', 'child', 'parent')
    f.git.commit(f.repo, 'work on child', 'child.txt', 'child')
    const child = f.git.sha(f.repo, 'child')
    f.git.git(f.repo, 'checkout', '-q', 'parent')
    f.git.git(f.repo, 'merge', '-q', '--squash', 'child')
    f.git.git(f.repo, 'commit', '-qm', 'squash child into parent')
    f.git.git(f.repo, 'push', '-q', 'origin', 'parent')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    const into = f.git.sha(f.repo, 'parent')
    const prs = [pr('child', child, 'parent', false, { number: 2, mergeCommit: into })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept child (no merge proof)')
    expect(f.git.sha(f.repo, 'child')).toBe(child)
  })

  it('fetches a merge commit it does not have, and keeps the branch when it is not on main', async () => {
    // The merge commit sits under a ref the clone does not fetch. The origin
    // serves it by its SHA, so the fetch works, and the guard still refuses.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'child')
    const child = f.git.sha(f.repo, 'child')
    const at = remoteSide(f)
    f.git.git(at, 'fetch', '-q', 'origin', 'main')
    f.git.git(at, 'checkout', '-q', '-b', 'parent')
    f.git.commit(at, 'the merge into the parent', 'parent.txt', 'parent')
    const into = f.git.sha(at, 'HEAD')
    f.git.git(at, 'push', '-q', 'origin', 'HEAD:refs/merges/2')
    f.git.git(originOf(f), 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    const prs = [pr('child', child, 'main', false, { number: 2, mergeCommit: into })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept child (no merge proof)')
    expect(f.git.sha(f.repo, 'child')).toBe(child)
  })
})

// --- #351 and #450: a pull request head at another commit -----------------------

describe('a merged pull request at another commit', () => {
  it('prunes a local tip that is behind the merged head (#351)', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'behind')
    f.git.git(f.repo, 'push', '-q', 'origin', 'behind')
    const at = remoteSide(f)
    f.git.git(at, 'checkout', '-q', 'behind')
    f.git.commit(at, 'update branch', 'update.txt', 'update')
    const head = f.git.sha(at, 'HEAD')
    f.git.git(at, 'push', '-q', 'origin', 'HEAD:refs/pull/3/head')
    const landed = squashOnRemote(f, at, head)
    const prs = [pr('behind', head, 'main', false, { number: 3, mergeCommit: landed })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toMatch(/deleted behind \([0-9a-f]+, merged PR\)/)
    expect(f.git.branches(f.repo)).not.toContain('behind')
  })

  it('prunes a local tip whose commits the remote rebased, and removes its worktree (#450)', async () => {
    const f = fixture()
    const { row } = rebasedByRemote(f, 'rebased', 4)
    const worktree = f.sandbox.join('wt')
    f.git.worktree(f.repo, worktree, 'rebased')

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: [row] }) })

    expect(result.stdout).toContain('removed worktree')
    expect(result.stdout).toMatch(/deleted rebased \([0-9a-f]+, merged PR\)/)
    expect(f.git.branches(f.repo)).not.toContain('rebased')
    expect(existsSync(worktree)).toBe(false)
  })

  it('keeps a local tip with one commit more than the rebased head (pinning test)', async () => {
    // This was green on e955762 too, with the same note. It pins the refusal
    // of the patch-equal proof: one commit with no match in the head.
    const f = fixture()
    const { row } = rebasedByRemote(f, 'extra', 5)
    f.git.git(f.repo, 'checkout', '-q', 'extra')
    f.git.commit(f.repo, 'not in the pull request', 'extra.txt', 'extra')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    const tip = f.git.sha(f.repo, 'extra')

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: [row] }) })

    expect(result.stdout).toContain('kept extra (merged PRs used this name; none at this commit)')
    expect(f.git.sha(f.repo, 'extra')).toBe(tip)
  })

  it('keeps a local tip with a merge commit that the head does not hold', async () => {
    // `git cherry` skips merge commits, so it finds no `+` line here. The
    // merge carries a change of its own, and a force delete would lose it.
    const f = fixture()
    const { row } = rebasedByRemote(f, 'merged-in', 7)
    f.git.git(f.repo, 'fetch', '-q', 'origin')
    f.git.git(f.repo, 'checkout', '-q', 'merged-in')
    f.git.git(f.repo, 'merge', '-q', '--no-ff', '--no-commit', 'origin/main~1')
    writeFileSync(path.join(f.repo, 'fix.txt'), 'a conflict fix\n')
    f.git.git(f.repo, 'add', 'fix.txt')
    f.git.git(f.repo, 'commit', '-qm', 'merge main, with a fix')
    f.git.git(f.repo, 'checkout', '-q', 'main')
    const tip = f.git.sha(f.repo, 'merged-in')

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: [row] }) })

    expect(result.stdout).toContain(
      'kept merged-in (merged PRs used this name; none at this commit)',
    )
    expect(f.git.sha(f.repo, 'merged-in')).toBe(tip)
  })

  it('keeps the branch when git cannot list the merge commits', async () => {
    const f = fixture()
    const { row } = rebasedByRemote(f, 'rebased', 4)

    const result = await run(f, [f.repo], {
      gh: ghDouble({ prs: [row] }),
      env: shimmed(f, 'rev-list --merges'),
    })

    expect(result.stdout).toContain(
      'kept rebased (git could not compare its commits; unproven, not disproven)',
    )
    expect(f.git.branches(f.repo)).toContain('rebased')
  })

  it('keeps the branch when git cannot compare the commits', async () => {
    const f = fixture()
    const { row } = rebasedByRemote(f, 'rebased', 4)

    const result = await run(f, [f.repo], {
      gh: ghDouble({ prs: [row] }),
      env: shimmed(f, 'cherry'),
    })

    expect(result.stdout).toContain(
      'kept rebased (git could not compare its commits; unproven, not disproven)',
    )
    expect(f.git.branches(f.repo)).toContain('rebased')
  })
})

// --- a fetch that fails ----------------------------------------------------------

describe('a fetch that fails', () => {
  it('keeps the branch when the merged head cannot be fetched', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'gone')
    const landed = f.git.sha(f.repo, 'main')
    const prs = [pr('gone', ABSENT, 'main', false, { number: 9, mergeCommit: landed })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain(
      "kept gone (could not fetch a merged PR's commits; unproven, not disproven)",
    )
    expect(f.git.branches(f.repo)).toContain('gone')
  })

  it('keeps the branch when the merge commit cannot be fetched', async () => {
    // The row names the branch at this very commit. Before #348 that alone
    // was proof, and this branch was deleted.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'unlanded')
    const tip = f.git.sha(f.repo, 'unlanded')
    const prs = [pr('unlanded', tip, 'main', false, { number: 9, mergeCommit: ABSENT })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain(
      "kept unlanded (could not fetch a merged PR's commits; unproven, not disproven)",
    )
    expect(f.git.sha(f.repo, 'unlanded')).toBe(tip)
  })

  it('keeps the branch when the pull ref holds another commit than the head', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'other')
    const landed = f.git.sha(f.repo, 'main')
    f.git.git(f.repo, 'push', '-q', 'origin', 'main:refs/pull/6/head')
    const prs = [pr('other', ABSENT, 'main', false, { number: 6, mergeCommit: landed })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain("kept other (could not fetch a merged PR's commits")
    expect(f.git.branches(f.repo)).toContain('other')
  })

  it('keeps the branch when the row has no number to fetch the head by', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'nameless')
    const landed = f.git.sha(f.repo, 'main')
    const prs = [pr('nameless', ABSENT, 'main', false, { mergeCommit: landed })]

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain("kept nameless (could not fetch a merged PR's commits")
    expect(f.git.branches(f.repo)).toContain('nameless')
  })

  it('fetches each ref once, when the per-branch query names the same row again', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'gone')
    const landed = f.git.sha(f.repo, 'main')
    const row = pr('gone', ABSENT, 'main', false, { number: 9, mergeCommit: landed })

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: manyPrs(199, row) }) })

    expect(result.stdout).toContain("kept gone (could not fetch a merged PR's commits")
    expect(f.git.branches(f.repo)).toContain('gone')
  })
})

// --- #248: ancestry at the tip prune read ----------------------------------------

describe('ancestry at the tip', () => {
  it('keeps a branch, and its worktree, that gets a commit after the ancestry read', async () => {
    // `aaa` sorts first. The bulk window is full, so `aaa` gets its own gh
    // call, after the ancestry read and before the prune loop reads `zzz`.
    // The commit lands on `zzz` in that window. The name `zzz` is still in
    // the ancestry list, but its new tip is not on main.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'aaa')
    f.git.branchWithWork(f.repo, 'zzz')
    f.git.mergeCommit(f.repo, 'zzz')
    const worktree = f.sandbox.join('wt')
    f.git.worktree(f.repo, worktree, 'zzz')

    const base = ghDouble({ prs: manyPrs(200) })
    let late = ''
    const gh = {
      ...base,
      listMergedPullRequests: async (query: Parameters<typeof base.listMergedPullRequests>[0]) => {
        if (query.head === 'aaa' && late === '') {
          writeFileSync(path.join(worktree, '.gitignore'), '*.ignoreme\n')
          f.git.git(worktree, 'add', '.gitignore')
          f.git.git(worktree, 'commit', '-qm', 'late work')
          writeFileSync(path.join(worktree, 'secret.ignoreme'), 'secret\n')
          late = f.git.sha(worktree, 'HEAD')
        }
        return base.listMergedPullRequests(query)
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain('kept zzz (no merge proof)')
    expect(f.git.sha(f.repo, 'zzz')).toBe(late)
    expect(existsSync(path.join(worktree, 'secret.ignoreme'))).toBe(true)
  })

  it('keeps the branch when git cannot answer the ancestry probe', async () => {
    // A failed probe is not "not merged" alone, and never "merged".
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const tip = f.git.sha(f.repo, 'landed')

    const result = await run(f, [f.repo], { env: crashing(f, tip) })

    expect(result.stdout).toContain(
      'kept landed (git could not compare its commits; unproven, not disproven)',
    )
    expect(f.git.sha(f.repo, 'landed')).toBe(tip)
  })
})
