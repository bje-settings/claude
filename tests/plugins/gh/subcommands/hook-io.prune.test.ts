// The prune rule of the SessionStart hook. The pure half takes the three
// ref listings and the merged pull requests as arguments. The real half
// builds the listings with real git (`harness/git.ts`), so ancestry, a gone
// upstream and a squash merge are the states git itself produces.
import { expect, it } from 'vitest'
import { countCandidates } from '#gh/subcommands/hook-io.ts'
import { createGhMock } from '#harness/gh.ts'
import { createRig, githubRepo, type Rig, side, statusOf } from './hook-io.test-support.ts'

/** One branch listing line, as `for-each-ref` writes it with the format
 *  `%(refname:lstrip=2)<tab>%(upstream)<tab>%(objectname)`. */
const branch = (name: string, upstream = '', tip = `${name}-tip`): string =>
  `${name}\t${upstream}\t${tip}`

const ORIGIN_MAIN = 'refs/remotes/origin/main'

it('counts a branch whose upstream is gone', () => {
  const branches = [branch('goner', 'refs/remotes/origin/goner')]

  expect(countCandidates(branches, [ORIGIN_MAIN], [], [], 'side', 'main')).toBe(1)
  // The same branch, with its upstream still there, is not a candidate.
  expect(
    countCandidates(branches, [ORIGIN_MAIN, 'refs/remotes/origin/goner'], [], [], 'side', 'main'),
  ).toBe(0)
})

it('counts a branch merged by ancestry only when it tracks its own upstream', () => {
  const refs = [ORIGIN_MAIN, 'refs/remotes/origin/landed', 'refs/heads/base']
  const merged = ['landed', 'fresh', 'bare', 'stacked']
  const branches = [
    branch('landed', 'refs/remotes/origin/landed'),
    // A new branch made from `origin/main` tracks it, and sits on its tip.
    // It is merged by ancestry, and it is new work, not landed work.
    branch('fresh', ORIGIN_MAIN),
    // No upstream at all: nothing says this branch was ever pushed.
    branch('bare'),
    // An upstream that is a local branch still counts as an upstream.
    branch('stacked', 'refs/heads/base'),
  ]

  expect(countCandidates(branches, refs, merged, [], 'side', 'main')).toBe(2)
  expect(countCandidates([branch('fresh', ORIGIN_MAIN)], refs, merged, [], 'side', 'main')).toBe(0)
  expect(countCandidates([branch('bare')], refs, merged, [], 'side', 'main')).toBe(0)
})

it('counts a squash merge only through a merged pull request at the same tip', () => {
  const branches = [branch('squashed', '', 'abc123')]
  const row = { headRefName: 'squashed', headRefOid: 'abc123', isCrossRepository: false }

  expect(countCandidates(branches, [ORIGIN_MAIN], [], [row], 'side', 'main')).toBe(1)
  // A branch that gained a commit after the merge is not landed work.
  expect(
    countCandidates(
      branches,
      [ORIGIN_MAIN],
      [],
      [{ ...row, headRefOid: 'def456' }],
      'side',
      'main',
    ),
  ).toBe(0)
  // No pull request rows at all is the same answer as rows that do not match.
  expect(countCandidates(branches, [ORIGIN_MAIN], [], null, 'side', 'main')).toBe(0)
})

it('ignores a merged pull request from a fork, whatever it names', () => {
  const branches = [branch('patch-1', '', 'abc123')]
  const fork = { headRefName: 'patch-1', headRefOid: 'abc123', isCrossRepository: true }

  expect(countCandidates(branches, [ORIGIN_MAIN], [], [fork], 'side', 'main')).toBe(0)
})

it('never counts the default branch or the current branch, whatever else is true', () => {
  const rows = [
    { headRefName: 'main', headRefOid: 'main-tip', isCrossRepository: false },
    { headRefName: 'side', headRefOid: 'side-tip', isCrossRepository: false },
  ]
  const branches = [
    branch('main', 'refs/remotes/origin/gone-main'),
    branch('side', 'refs/remotes/origin/side'),
  ]

  expect(countCandidates(branches, [ORIGIN_MAIN], ['main', 'side'], rows, 'side', 'main')).toBe(0)
  // The same listing, read with a different current branch, counts `side`.
  expect(countCandidates(branches, [ORIGIN_MAIN], ['main', 'side'], rows, 'other', 'main')).toBe(1)
})

it('counts a branch once, when more than one rule holds for it', () => {
  const branches = [branch('all', 'refs/remotes/origin/all', 'abc123')]
  const row = { headRefName: 'all', headRefOid: 'abc123', isCrossRepository: false }

  expect(countCandidates(branches, [ORIGIN_MAIN], ['all'], [row], 'side', 'main')).toBe(1)
})

it('answers nothing when a ref listing could not be read', () => {
  const branches = [branch('goner', 'refs/remotes/origin/goner')]

  expect(countCandidates(null, [ORIGIN_MAIN], [], [], 'side', 'main')).toBeNull()
  expect(countCandidates(branches, null, [], [], 'side', 'main')).toBeNull()
  expect(countCandidates(branches, [ORIGIN_MAIN], null, [], 'side', 'main')).toBeNull()
})

it('reads a listing line with no separator as a branch with no upstream and no tip', () => {
  // The format cannot produce this shape. The line is read as a branch name
  // alone, not as a branch whose upstream is the whole line.
  expect(countCandidates(['orphan'], [], [], [], 'side', 'main')).toBe(0)
  const row = { headRefName: 'orphan', headRefOid: '', isCrossRepository: false }
  expect(countCandidates(['orphan'], [], [], [row], 'side', 'main')).toBe(0)
})

// --- the same rule, on real repositories -------------------------------------

/** Push `name`, and make it track its own remote branch. */
const pushed = (rig: Rig, work: string, name: string): void => {
  rig.git.branchWithWork(work, name)
  rig.git.push(work, name)
  rig.git.git(work, 'branch', `--set-upstream-to=origin/${name}`, name)
}

/** The prune count `status` writes for `work`, or 0 for a silent run. */
const pruneOf = async (rig: Rig, work: string, merged: unknown[] = []): Promise<number> => {
  const gh = createGhMock({
    repositoryStatus: {
      repositories: { 'acme/widgets': side(0, 0, merged) },
      unavailable: null,
    },
  })
  const ran = await statusOf(rig, work, gh)
  expect(ran.stderr).toBe('')
  if (ran.stdout === '') return 0
  const match = /^gh: \[prune ([0-9]+)\]\n$/.exec(ran.stdout)
  expect(match, ran.stdout).not.toBeNull()
  return Number(match?.[1])
}

it('counts a branch whose remote branch was deleted, once the fetch prunes it', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  pushed(rig, work, 'goner')
  // The remote branch goes after the merge. The fetch the hook runs is what
  // removes `origin/goner` here.
  rig.git.git(rig.sandbox.join('r', 'origin.git'), 'branch', '-D', 'goner')

  expect(await pruneOf(rig, work)).toBe(1)
})

it('counts a branch merged by ancestry that tracks its own remote branch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  pushed(rig, work, 'landed')
  rig.git.mergeCommit(work, 'landed')

  expect(await pruneOf(rig, work)).toBe(1)
})

it('counts a fast-forward merge that tracks its own remote branch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  pushed(rig, work, 'landed')
  rig.git.mergeFf(work, 'landed')

  expect(await pruneOf(rig, work)).toBe(1)
})

it('does not count a new branch that tracks origin/main', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  // `git switch -c <new> origin/main` makes exactly this branch: merged by
  // ancestry, because it has no commit of its own yet.
  rig.git.git(work, 'branch', '--track', 'fresh', 'origin/main')

  expect(await pruneOf(rig, work)).toBe(0)
})

it('does not count a merged branch that was never pushed', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'local-only')
  rig.git.mergeCommit(work, 'local-only')

  expect(await pruneOf(rig, work)).toBe(0)
})

it('counts a squash merge only through a merged pull request at the same tip', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'squashed')
  rig.git.mergeSquash(work, 'squashed')
  const tip = rig.git.sha(work, 'squashed')
  const row = { headRefName: 'squashed', headRefOid: tip, isCrossRepository: false }

  expect(await pruneOf(rig, work, [row])).toBe(1)
  expect(await pruneOf(rig, work, [{ ...row, headRefOid: rig.git.sha(work, 'main') }])).toBe(0)
  expect(await pruneOf(rig, work, [])).toBe(0)
})

it('ignores a merged pull request from a fork that names a local branch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'patch-1')
  const fork = {
    headRefName: 'patch-1',
    headRefOid: rig.git.sha(work, 'patch-1'),
    isCrossRepository: true,
  }

  expect(await pruneOf(rig, work, [fork])).toBe(0)
})

it('never counts the current branch or the default branch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  pushed(rig, work, 'side')
  rig.git.git(work, 'checkout', '-q', 'side')
  rig.git.git(rig.sandbox.join('r', 'origin.git'), 'branch', '-D', 'side')
  // `main` tracks a remote branch that does not exist either.
  rig.git.git(work, 'config', 'branch.main.merge', 'refs/heads/gone-main')

  expect(await pruneOf(rig, work)).toBe(0)
})

it('does not count the default branch because a tag shares its name', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.git(work, 'tag', 'main')
  rig.git.git(work, 'config', 'branch.main.merge', 'refs/heads/gone-main')

  expect(await pruneOf(rig, work)).toBe(0)
})
