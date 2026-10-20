// The row builders' and the server's own claims. These are asserted here
// the way the gh plugin's Python fixture test asserted the Python
// fixtures', before it was deleted at #127. A builder that quietly stopped
// producing its state, or a filter that quietly stopped filtering, would
// make every test built on it pass for the wrong reason.
//
// The Python this ports, `tests/gh/conftest.py` and the stub `gh` at
// `tests/gh/bin/gh`, was deleted at #127. The file and line references
// below point to what they held at `cd0d515`, kept because they say where
// each rule came from.
import { expect, it } from 'vitest'
import { createGhMock, GhError, ghFails } from '#harness/gh.ts'
import {
  createGhServer,
  depPr,
  manyPrs,
  noPrs,
  type PullRequestRow,
  pr,
  writePrs,
} from '#harness/pulls.ts'

const rollupOf = (row: PullRequestRow): PullRequestRow[] =>
  row.statusCheckRollup as PullRequestRow[]

// --- the row builders ---------------------------------------------------------

it('builds a merged pull request row with the fields the merged window reads', () => {
  expect(pr('feature-a', 'abc123')).toEqual({
    headRefName: 'feature-a',
    headRefOid: 'abc123',
    baseRefName: 'main',
    isCrossRepository: false,
    state: 'MERGED',
  })
})

it('takes the base branch and the fork flag when the caller names them', () => {
  const row = pr('feature-a', 'abc123', 'release', true)

  expect(row.baseRefName).toBe('release')
  expect(row.isCrossRepository).toBe(true)
})

it('adds the number and the merge commit in the shape gh answers them', () => {
  const row = pr('feature-a', 'abc123', 'main', false, { number: 7, mergeCommit: 'def456' })

  expect(row.number).toBe(7)
  expect(row.mergeCommit).toEqual({ oid: 'def456' })
})

it('collects the rows it was given, and no rows at all for no_prs', () => {
  expect(writePrs(pr('a', '1'), pr('b', '2'))).toHaveLength(2)
  expect(noPrs()).toEqual([])
})

it('fills a window with numbered rows and appends what was given explicitly', () => {
  const rows = manyPrs(3, pr('late', 'z'))

  expect(rows.map((row) => row.headRefName)).toEqual(['old-0', 'old-1', 'old-2', 'late'])
})

it('builds a dependencies pull request with every field PR_FIELDS asks for', () => {
  expect(depPr(1)).toEqual({
    number: 1,
    title: 'build(deps): bump dep-1',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'app/dependabot', is_bot: true },
    labels: [{ name: 'dependencies' }],
    autoMergeRequest: { mergeMethod: 'MERGE' },
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefOid: 'sha1',
    headRefName: 'dependabot/npm/dep-1',
    isCrossRepository: false,
    baseRefName: 'main',
    createdAt: '2026-01-01T00:00:00Z',
    mergeCommit: null,
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/21',
      },
      {
        __typename: 'CheckRun',
        name: 'lint',
        status: 'COMPLETED',
        conclusion: 'SKIPPED',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/21',
      },
    ],
  })
})

it('takes every key dep_pr takes, with the same meanings', () => {
  const row = depPr(4, {
    state: 'MERGED',
    merge: 'DIRTY',
    checks: 'none',
    auto: false,
    bot: false,
    draft: true,
    review: 'CHANGES_REQUESTED',
    risk: 'high',
    created: '2020-02-02T00:00:00Z',
    head: 'deadbeef',
  })

  expect(row).toMatchObject({
    state: 'MERGED',
    mergeStateStatus: 'DIRTY',
    // DIRTY is the one merge state that also decides `mergeable`.
    mergeable: 'CONFLICTING',
    statusCheckRollup: [],
    autoMergeRequest: null,
    author: { login: 'someone', is_bot: false },
    isDraft: true,
    reviewDecision: 'CHANGES_REQUESTED',
    labels: [{ name: 'dependencies' }, { name: 'merge-risk:high' }],
    createdAt: '2020-02-02T00:00:00Z',
    headRefOid: 'deadbeef',
    mergeCommit: { oid: 'merged4' },
  })
})

it('reads an empty created stamp and an empty head as the defaults, the way `or` did', () => {
  // `??` here would take the empty string as the caller's choice and build a
  // row with no createdAt, which sorts before every other row.
  const row = depPr(7, { created: '', head: '' })

  expect(row.createdAt).toBe('2026-01-07T00:00:00Z')
  expect(row.headRefOid).toBe('sha7')
})

it('leaves the merge commit null on a pull request that has not merged', () => {
  expect(depPr(1, { state: 'CLOSED' }).mergeCommit).toBeNull()
})

it('builds a status context rollup for the older commit-status shapes', () => {
  expect(rollupOf(depPr(1, { checks: 'status-pending' }))).toEqual([
    {
      __typename: 'StatusContext',
      context: 'ci/legacy',
      state: 'PENDING',
      targetUrl: 'https://ci.example/1',
    },
  ])
})

it('builds a failing status context ahead of a failing job for the mixed shape', () => {
  const rollup = rollupOf(depPr(1, { checks: 'status-then-job-failed' }))

  expect(rollup.map((row) => row.__typename)).toEqual(['StatusContext', 'CheckRun'])
  expect(rollup[1]?.detailsUrl).toContain('/actions/runs/11/job/21')
})

it('builds no rollup at all for a shape nobody named', () => {
  expect(rollupOf(depPr(1, { checks: 'none' }))).toEqual([])
})

// --- the server: filtering ----------------------------------------------------

const SET = [
  depPr(1),
  depPr(2, { auto: false }),
  { ...depPr(3), labels: [{ name: 'enhancement' }] },
  { ...depPr(4, { state: 'MERGED' }) },
]

it('filters a listing by state the way gh does, matching case-insensitively', async () => {
  const gh = createGhServer({ prs: SET })

  const open = (await gh.listPullRequests({ state: 'open' })) as PullRequestRow[]

  expect(open.map((row) => row.number)).toEqual([1, 2, 3])
})

it('filters a listing by label', async () => {
  const gh = createGhServer({ prs: SET })

  const rows = (await gh.listPullRequests({ label: 'dependencies' })) as PullRequestRow[]

  expect(rows.map((row) => row.number)).toEqual([1, 2, 4])
})

it('filters a listing by base branch and truncates at the limit', async () => {
  const gh = createGhServer({ prs: [pr('a', '1'), pr('b', '2', 'release'), pr('c', '3')] })

  const rows = (await gh.listMergedPullRequests({ base: 'main', limit: 1 })) as PullRequestRow[]

  expect(rows.map((row) => row.headRefName)).toEqual(['a'])
})

it('answers a merged listing that names no base with every base', async () => {
  // #348: `sync-repo` sends no base, so a stacked pull request is in the
  // window too.
  const gh = createGhServer({ prs: [pr('a', '1'), pr('b', '2', 'a')] })

  const rows = (await gh.listMergedPullRequests({ limit: 10 })) as PullRequestRow[]

  expect(rows.map((row) => row.headRefName)).toEqual(['a', 'b'])
})

it('filters a merged listing by head, which is the per-branch question', async () => {
  const gh = createGhServer({ prs: [pr('a', '1'), pr('b', '2')] })

  const rows = (await gh.listMergedPullRequests({
    base: 'main',
    head: 'b',
    limit: 100,
  })) as PullRequestRow[]

  expect(rows.map((row) => row.headRefOid)).toEqual(['2'])
})

it('answers a merged listing with only the merged rows', async () => {
  // The real client sends --state merged on this endpoint, so an open row in
  // the same set is not an answer to it.
  const gh = createGhServer({ prs: [depPr(1), { ...pr('a', '1') }] })

  const rows = (await gh.listMergedPullRequests({ base: 'main', limit: 10 })) as PullRequestRow[]

  expect(rows.map((row) => row.headRefName)).toEqual(['a'])
})

it('reads a row with no state at all as merged, the way the stub did', async () => {
  const gh = createGhServer({ prs: [{ headRefName: 'a', baseRefName: 'main' }] })

  const rows = (await gh.listPullRequests({ state: 'merged' })) as PullRequestRow[]

  expect(rows).toHaveLength(1)
})

it('reads a row whose state is the empty string as merged, the way `or` did', async () => {
  // `r.get("state") or "MERGED"` in `tests/gh/bin/gh:212` is truthiness. A
  // `??` here would answer the empty string and drop the row from every
  // listing. That filter would disagree with the gh it stands in for.
  const gh = createGhServer({ prs: [{ headRefName: 'a', baseRefName: 'main', state: '' }] })

  await expect(gh.listPullRequests({ state: 'merged' })).resolves.toHaveLength(1)
})

it('reads a row whose labels are missing as a row with no labels', async () => {
  const gh = createGhServer({ prs: [{ number: 1 }] })

  await expect(gh.listPullRequests({ label: 'dependencies' })).resolves.toEqual([])
})

it('resolves a pull request by number', async () => {
  const gh = createGhServer({ prs: SET })

  await expect(gh.viewPullRequest({ pullRequest: 2 })).resolves.toMatchObject({ number: 2 })
})

it('fails a number that resolves to nothing, in gh’s own words', async () => {
  const gh = createGhServer({ prs: SET })

  await expect(gh.viewPullRequest({ pullRequest: 99 })).rejects.toThrow(
    'Could not resolve to a PullRequest with the number of 99',
  )
})

it('answers the ref of a branch with the head of the row that names it', async () => {
  // The fixture claims a pull request whose head is in step with its
  // branch (#467). A name with a slash is one branch, not a path.
  const gh = createGhServer({ prs: [depPr(1), depPr(2, { head: 'moved2' })] })

  await expect(gh.branchRef({ branch: 'dependabot/npm/dep-2' })).resolves.toEqual({
    sha: 'moved2',
    unavailable: null,
  })
})

it('answers the ref of a branch that no row names as GitHub’s 404', async () => {
  const gh = createGhServer({ prs: [depPr(1)] })

  await expect(gh.branchRef({ branch: 'dependabot/npm' })).resolves.toEqual({
    sha: null,
    unavailable: 'the ref of dependabot/npm carried no commit (404: Not Found)',
  })
})

it('lets a registered ref reply or sequence outrank the pull-request set', async () => {
  const stale = { sha: 'newer1', unavailable: null }
  const replied = createGhServer({ prs: [depPr(1)], replies: { branchRef: stale } })
  const sequenced = createGhServer({ prs: [depPr(1)], sequences: { branchRef: [stale] } })

  await expect(replied.branchRef({ branch: 'dependabot/npm/dep-1' })).resolves.toEqual(stale)
  await expect(sequenced.branchRef({ branch: 'dependabot/npm/dep-1' })).resolves.toEqual(stale)
})

it('throws for a pull-request endpoint when no set was registered at all', async () => {
  const gh = createGhServer({})

  await expect(gh.listPullRequests()).rejects.toThrow('no reply registered for listPullRequests')
  await expect(gh.listMergedPullRequests({ base: 'main', limit: 1 })).rejects.toThrow(
    'no reply registered for listMergedPullRequests',
  )
  await expect(gh.viewPullRequest({ pullRequest: 1 })).rejects.toThrow(
    'no reply registered for viewPullRequest',
  )
  await expect(gh.branchRef({ branch: 'main' })).rejects.toThrow(
    'no reply registered for branchRef',
  )
})

it('answers every endpoint it was given no set for the way createGhMock does', async () => {
  const gh = createGhServer({ replies: { viewRepository: { nameWithOwner: 'acme/widgets' } } })

  await expect(gh.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
  await expect(gh.listRuns()).rejects.toThrow('no reply registered for listRuns')
  await expect(gh.readFailedRunLog({ run: 1 })).rejects.toThrow('no reply registered')
  await expect(gh.updateBranch({ pullRequest: 1, rebase: true })).rejects.toThrow(
    'no reply registered',
  )
  await expect(gh.addComment({ pullRequest: 1, body: 'x' })).rejects.toThrow('no reply registered')
})

it('lets a registered reply outrank the pull-request set', async () => {
  const gh = createGhServer({
    prs: SET,
    replies: {
      listPullRequests: ghFails('gh: API rate limit exceeded'),
      listMergedPullRequests: [{ headRefName: 'from the reply' }],
      viewPullRequest: { number: 500 },
    },
  })

  await expect(gh.listPullRequests()).rejects.toThrow('rate limit')
  await expect(gh.listMergedPullRequests({ base: 'main', limit: 1 })).resolves.toEqual([
    { headRefName: 'from the reply' },
  ])
  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toEqual({ number: 500 })
})

// --- the server: failure switches ---------------------------------------------

it('fails every call when the whole gh is failing', async () => {
  const gh = createGhServer({ prs: SET, fail: ghFails('gh: simulated failure') })

  await expect(gh.listPullRequests()).rejects.toThrow('gh: simulated failure')
  await expect(gh.viewRepository()).rejects.toThrow('gh: simulated failure')
  await expect(gh.viewPullRequest({ pullRequest: 1 })).rejects.toThrow('gh: simulated failure')
  await expect(gh.listMergedPullRequests({ base: 'main', limit: 1 })).rejects.toThrow(
    'gh: simulated failure',
  )
})

it('fails only the queries that name a head when the per-branch switch is on', async () => {
  const gh = createGhServer({
    prs: [pr('a', '1')],
    failHead: ghFails('gh: simulated per-branch failure'),
  })

  await expect(gh.listMergedPullRequests({ base: 'main', limit: 10 })).resolves.toHaveLength(1)
  await expect(gh.listMergedPullRequests({ base: 'main', head: 'a', limit: 10 })).rejects.toThrow(
    'per-branch',
  )
  await expect(gh.listPullRequests({ head: 'a' })).rejects.toThrow('per-branch')
})

it('carries the status and the detail a real gh failure carries', async () => {
  const gh = createGhServer({ prs: SET, fail: ghFails('gh: API rate limit exceeded', 1) })

  await expect(gh.listPullRequests()).rejects.toMatchObject({
    status: 1,
    detail: 'gh: API rate limit exceeded',
  })
  await expect(gh.listPullRequests()).rejects.toBeInstanceOf(GhError)
})

// --- the server: sequences ----------------------------------------------------

it('answers a sequence in order and then repeats its last entry', async () => {
  const gh = createGhServer({
    sequences: {
      viewPullRequest: [
        { number: 1, state: 'OPEN' },
        { number: 1, state: 'MERGED' },
      ],
    },
  })

  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toMatchObject({ state: 'OPEN' })
  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toMatchObject({ state: 'MERGED' })
  // The poll that runs one read longer reads the settled answer. It does
  // not run off the end of the sequence.
  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toMatchObject({ state: 'MERGED' })
})

it('throws the entry of a sequence that is an error, and carries on afterwards', async () => {
  const gh = createGhServer({
    sequences: {
      viewPullRequest: [ghFails('gh: API rate limit exceeded'), { number: 1, state: 'MERGED' }],
    },
  })

  await expect(gh.viewPullRequest({ pullRequest: 1 })).rejects.toThrow('rate limit')
  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toMatchObject({ state: 'MERGED' })
})

it('counts each endpoint’s sequence on its own', async () => {
  const gh = createGhServer({
    sequences: {
      viewPullRequest: [{ number: 1 }, { number: 2 }],
      readFailedRunLog: ['a log\n'],
    },
  })

  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toEqual({ number: 1 })
  await expect(gh.readFailedRunLog({ run: 1 })).resolves.toBe('a log\n')
  await expect(gh.viewPullRequest({ pullRequest: 1 })).resolves.toEqual({ number: 2 })
})

it('drives every endpoint from a sequence, not just the pull-request ones', async () => {
  const gh = createGhServer({
    sequences: {
      listPullRequests: [[{ number: 1 }]],
      listMergedPullRequests: [[{ headRefName: 'a' }]],
      viewRepository: [{ nameWithOwner: 'acme/widgets' }],
      listRuns: [[{ databaseId: 1 }]],
      readFailedRunLog: ['a log\n'],
      updateBranch: ['updated\n'],
      addComment: ['posted\n'],
    },
  })

  await expect(gh.listPullRequests()).resolves.toEqual([{ number: 1 }])
  await expect(gh.listMergedPullRequests({ base: 'main', limit: 1 })).resolves.toEqual([
    { headRefName: 'a' },
  ])
  await expect(gh.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
  await expect(gh.listRuns()).resolves.toEqual([{ databaseId: 1 }])
  await expect(gh.readFailedRunLog({ run: 1 })).resolves.toBe('a log\n')
  await expect(gh.updateBranch({ pullRequest: 1, rebase: true })).resolves.toBe('updated\n')
  await expect(gh.addComment({ pullRequest: 1, body: 'x' })).resolves.toBe('posted\n')
})

it('refuses an empty sequence rather than answering undefined', async () => {
  const gh = createGhServer({ sequences: { viewRepository: [] } })

  await expect(gh.viewRepository()).rejects.toThrow(
    'gh server: the sequence registered for viewRepository is empty',
  )
})

it('answers an empty log from a sequence rather than reading it as no reply', async () => {
  // `??` on the reply would send an empty string back to the base mock, which
  // has no reply registered, and the test would read "gh answered nothing" as
  // "nobody registered this".
  const gh = createGhServer({ sequences: { readFailedRunLog: [''] } })

  await expect(gh.readFailedRunLog({ run: 1 })).resolves.toBe('')
})

it('is a GhClient the commands take, so the mock and the server are swappable', async () => {
  const mock = createGhMock({ viewRepository: { nameWithOwner: 'acme/widgets' } })
  const server = createGhServer({ replies: { viewRepository: { nameWithOwner: 'acme/widgets' } } })

  await expect(server.viewRepository()).resolves.toEqual(await mock.viewRepository())
})
