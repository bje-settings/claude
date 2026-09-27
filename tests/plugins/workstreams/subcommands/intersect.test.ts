// The intersect command, against real repositories. git is never mocked.
// Each example builds an origin and the checkout the command runs in. A
// second clone pushes the pull request heads. So the heads exist on origin
// and not in the checkout. The command must fetch each one by sha, as on a
// real repository. `gh` is the injected double.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createGhMock,
  type GhReplies,
  type PullRequestHead,
  type WorkflowRun,
} from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'
import {
  type IntersectReport,
  renderReport,
  runIntersect,
} from '#workstreams/subcommands/intersect.ts'

interface Rig {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  /** The checkout the command runs in. */
  readonly work: string
  /** Pushes a branch from `start` with these files written, and answers
   *  its head sha. */
  push(name: string, files: Readonly<Record<string, string>>, start?: string): string
  /** Moves origin's default branch on by one commit with these files. */
  advanceMain(files: Readonly<Record<string, string>>): string
}

const rig = (): Rig => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('root'))
  const origin = git.git(work, 'remote', 'get-url', 'origin')
  const other = sandbox.join('other')
  git.git(sandbox.path, 'clone', '-q', origin, other)
  const commit = (files: Readonly<Record<string, string>>, message: string): string => {
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(other, file), content)
    }
    git.git(other, 'add', '-A')
    git.git(other, 'commit', '-qm', message)
    return git.git(other, 'rev-parse', 'HEAD')
  }
  return {
    sandbox,
    git,
    work,
    push(name, files, start = 'origin/main') {
      git.git(other, 'fetch', '-q', 'origin')
      git.git(other, 'checkout', '-q', '-B', name, start)
      const sha = commit(files, `work on ${name}`)
      git.git(other, 'push', '-q', '-f', 'origin', name)
      return sha
    },
    advanceMain(files) {
      git.git(other, 'fetch', '-q', 'origin')
      git.git(other, 'checkout', '-q', '-B', 'main', 'origin/main')
      const sha = commit(files, 'main moves on')
      git.git(other, 'push', '-q', 'origin', 'main')
      return sha
    },
  }
}

const pull = (number: number, head: string, headSha: string, base = 'main'): PullRequestHead => ({
  number,
  title: `pull request ${number}`,
  head,
  headSha,
  base,
  draft: true,
  crossRepository: false,
  checks: [],
})

const run = (headSha: string, event = 'pull_request'): WorkflowRun => ({
  name: 'CI',
  event,
  headSha,
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-09-26T10:00:00Z',
  updatedAt: '2026-09-26T10:05:00Z',
})

/** Runs the command over these pull requests and answers the JSON report. */
const intersect = async (
  r: Rig,
  pulls: readonly PullRequestHead[],
  replies: GhReplies = {},
): Promise<IntersectReport> => {
  const gh = createGhMock({
    listOpenPullRequestHeads: { rows: pulls, unavailable: null },
    listWorkflowRuns: { rows: [], unavailable: null },
    ...replies,
  })
  const answer = await runIntersect(['--json'], { gh, cwd: r.work, env: r.sandbox.env })
  if (answer.outcome !== 'ok')
    throw new Error(`intersect answered ${answer.outcome}: ${answer.error}`)
  return JSON.parse(answer.value) as IntersectReport
}

const LINES = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n')

describe('pairs of pull requests', () => {
  it('finds the path two heads both edit on one line, and calls neither a conflict with main', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })
    const b = r.push('beta', { 'file.txt': 'beta\n' })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'beta', b)])

    expect(report.pairs).toEqual([
      {
        pullRequests: [1, 2],
        shared: ['file.txt'],
        merge: { result: 'conflict', paths: ['file.txt'] },
      },
    ])
    expect(report.pullRequests.map((row) => row.againstDefault)).toEqual([
      { result: 'clean' },
      { result: 'clean' },
    ])
    expect(report.unavailable).toEqual([])
  })

  it('reports no pair for two heads that share no file', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    const b = r.push('beta', { 'b.txt': 'b\n' })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'beta', b)])

    expect(report.pairs).toEqual([])
    expect(report.pullRequests.map((row) => row.files)).toEqual([['a.txt'], ['b.txt']])
  })

  it('reports a shared file that merges clean as clean', async () => {
    const r = rig()
    r.advanceMain({ 'lines.txt': `${LINES}\n` })
    const a = r.push('alpha', { 'lines.txt': `${LINES.replace('line 1\n', 'first\n')}\n` })
    const b = r.push('beta', { 'lines.txt': `${LINES.replace('line 10', 'last')}\n` })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'beta', b)])

    expect(report.pairs).toEqual([
      { pullRequests: [1, 2], shared: ['lines.txt'], merge: { result: 'clean' } },
    ])
  })
})

describe('a stack of pull requests', () => {
  /** Each row's stack facts, and the two fields a stack layer changes. */
  const stackFacts = (report: IntersectReport) =>
    report.pullRequests.map((row) => ({
      number: row.number,
      base: row.base,
      draft: row.draft,
      stackedOn: row.stackedOn,
      files: row.files,
      ownFiles: row.ownFiles,
    }))

  it('pairs two layers on the files each changes against the layer below, as gh pr diff does', async () => {
    const r = rig()
    const lower = r.push('lower', { 'shared.txt': 'lower\n', 'lower.txt': 'l\n' })
    const upper = r.push('upper', { 'upper.txt': 'u\n' }, 'origin/lower')

    const report = await intersect(r, [
      pull(1, 'lower', lower),
      { ...pull(2, 'upper', upper, 'lower'), draft: false },
    ])

    expect(stackFacts(report)).toEqual([
      {
        number: 1,
        base: 'main',
        draft: true,
        stackedOn: null,
        files: ['lower.txt', 'shared.txt'],
        ownFiles: ['lower.txt', 'shared.txt'],
      },
      {
        number: 2,
        base: 'lower',
        draft: false,
        stackedOn: 1,
        files: ['lower.txt', 'shared.txt', 'upper.txt'],
        ownFiles: ['upper.txt'],
      },
    ])
    expect(report.pairs).toEqual([])
    expect(report.unavailable).toEqual([])
  })

  it('still pairs a file that the upper layer changes again', async () => {
    const r = rig()
    const lower = r.push('lower', { 'shared.txt': 'lower\n' })
    const upper = r.push('upper', { 'shared.txt': 'upper\n' }, 'origin/lower')

    const report = await intersect(r, [pull(1, 'lower', lower), pull(2, 'upper', upper, 'lower')])

    expect(report.pairs).toEqual([
      { pullRequests: [1, 2], shared: ['shared.txt'], merge: { result: 'clean' } },
    ])
  })

  it('never stacks a pull request on the default branch, even under a head of that name', async () => {
    const r = rig()
    // A fork's pull request often comes from a branch named `main`.
    const fork = r.push('fork', { 'shared.txt': 'fork\n' })
    const a = r.push('alpha', { 'shared.txt': 'alpha\n' })

    const report = await intersect(r, [pull(1, 'main', fork), pull(2, 'alpha', a)])

    expect(report.pullRequests.map((row) => row.stackedOn)).toEqual([null, null])
    expect(report.pairs).toEqual([
      {
        pullRequests: [1, 2],
        shared: ['shared.txt'],
        merge: { result: 'conflict', paths: ['shared.txt'] },
      },
    ])
  })

  it('never stacks a pull request on itself, as a fork whose head and base share a name', async () => {
    const r = rig()
    const fork = r.push('fork', { 'a.txt': 'a\n' })

    const report = await intersect(r, [pull(1, 'topic', fork, 'topic')])

    expect(stackFacts(report)[0]).toMatchObject({ stackedOn: null, ownFiles: ['a.txt'] })
  })

  it('never stacks a layer on a fork whose head branch has the base branch name', async () => {
    const r = rig()
    const fork = r.push('fork-topic', { 'fork.txt': 'f\n' })
    const lower = r.push('topic', { 'lower.txt': 'l\n' })
    const upper = r.push('upper', { 'upper.txt': 'u\n' }, 'origin/topic')

    // The fork's pull request comes first, as the older one.
    const report = await intersect(r, [
      { ...pull(1, 'topic', fork), crossRepository: true },
      pull(2, 'topic', lower),
      pull(3, 'upper', upper, 'topic'),
    ])

    expect(stackFacts(report)[2]).toMatchObject({ stackedOn: 2, ownFiles: ['upper.txt'] })
    expect(report.unavailable).toEqual([])
  })

  it('reports the own files of a layer as unread when the layer below was not fetched', async () => {
    const r = rig()
    const upper = r.push('upper', { 'upper.txt': 'u\n' })

    const report = await intersect(r, [
      pull(1, 'lower', 'f'.repeat(40)),
      pull(2, 'upper', upper, 'lower'),
    ])

    expect(stackFacts(report)[1]).toMatchObject({ stackedOn: 1, ownFiles: null })
    expect(report.unavailable).toContainEqual(
      expect.stringMatching(/^#2: its own files against #1 are unread: fatal: /),
    )
    expect(report.unavailable).toContain(
      '#2: its own files are unread, so no pair with it was compared',
    )
  })
})

describe('each head against the default branch', () => {
  it('counts the commits main has gained since the merge base: the rebase debt', async () => {
    const r = rig()
    const base = r.git.git(r.work, 'rev-parse', 'origin/main')
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    r.advanceMain({ 'm1.txt': 'one\n' })
    const tip = r.advanceMain({ 'm2.txt': 'two\n' })

    const report = await intersect(r, [pull(1, 'alpha', a)])

    expect(report.defaultBranch).toEqual({ name: 'main', sha: tip, fetched: true })
    expect(report.pullRequests[0]).toMatchObject({
      number: 1,
      headSha: a,
      fetched: true,
      mergeBase: base,
      behind: 2,
      files: ['a.txt'],
      againstDefault: { result: 'clean' },
    })
  })

  it('names the path a head conflicts with main on', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })
    r.advanceMain({ 'file.txt': 'main\n' })

    const report = await intersect(r, [pull(1, 'alpha', a)])

    expect(report.pullRequests[0]?.againstDefault).toEqual({
      result: 'conflict',
      paths: ['file.txt'],
    })
  })

  it('fetches each head by sha and leaves no named ref behind (ruling 10)', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    const refs = (): string =>
      r.git.git(r.work, 'for-each-ref', '--format=%(refname) %(objectname)')
    const before = refs()

    await intersect(r, [pull(1, 'alpha', a)])

    expect(refs()).toBe(before)
    expect(r.git.tryGit(r.work, 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD').status).not.toBe(
      0,
    )
    expect(r.git.tryGit(r.work, 'cat-file', '-e', `${a}^{commit}`).status).toBe(0)
  })

  it('reports a head it could not fetch as itself, never as clean', async () => {
    const r = rig()
    const missing = 'f'.repeat(40)

    const report = await intersect(r, [pull(1, 'gone', missing)])

    expect(report.pullRequests[0]).toMatchObject({
      fetched: false,
      mergeBase: null,
      behind: null,
      files: null,
      againstDefault: { result: 'unread' },
    })
    expect(report.unavailable).toHaveLength(1)
    expect(report.unavailable[0]).toMatch(/^#1: head fffffff could not be fetched: /)
  })

  it('does not compare a pair when one side could not be fetched', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'gone', 'f'.repeat(40))])

    expect(report.pairs).toEqual([])
    expect(report.unavailable).toContain(
      '#2: its own files are unread, so no pair with it was compared',
    )
  })
})

describe('the facts beside each head', () => {
  it('finds a pull_request run for the exact head, and ignores a push run', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    const b = r.push('beta', { 'b.txt': 'b\n' })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'beta', b)], {
      listWorkflowRuns: { rows: [run(a), run(b, 'push')], unavailable: null },
    })

    expect(report.pullRequests.map((row) => row.pullRequestRun)).toEqual([true, false])
  })

  it('reports a run list it could not read as unread, not as no run', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    const b = r.push('beta', { 'b.txt': 'b\n' })

    const report = await intersect(r, [pull(1, 'alpha', a), pull(2, 'beta', b)], {
      listWorkflowRuns: { rows: [run(a)], unavailable: '1 workflow run row(s) could not be read' },
    })

    expect(report.pullRequests.map((row) => row.pullRequestRun)).toEqual([true, null])
    expect(report.unavailable).toEqual([
      '#1: runs: 1 workflow run row(s) could not be read',
      '#2: runs: 1 workflow run row(s) could not be read',
    ])
  })

  it('reports the root checkout and the worktree on a head, clean or not', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    const b = r.push('beta', { 'b.txt': 'b\n' })
    r.git.git(r.work, 'fetch', '-q', 'origin', 'alpha:alpha', 'beta:beta')
    const alphaTree = r.sandbox.join('wt-alpha')
    const betaTree = r.sandbox.join('wt-beta')
    r.git.git(r.work, 'worktree', 'add', '-q', alphaTree, 'alpha')
    r.git.git(r.work, 'worktree', 'add', '-q', betaTree, 'beta')
    // A detached worktree is on no branch, so it is no pull request's.
    r.git.git(r.work, 'worktree', 'add', '-q', '--detach', r.sandbox.join('wt-loose'), a)
    writeFileSync(path.join(betaTree, 'b.txt'), 'changed\n')
    writeFileSync(path.join(r.work, 'stray.txt'), 'left behind\n')

    // A fork's head branch named like a local branch is not that branch.
    const fork = { ...pull(4, 'alpha', b), crossRepository: true }

    const report = await intersect(r, [
      pull(1, 'alpha', a),
      pull(2, 'beta', b),
      pull(3, 'x', a),
      fork,
    ])

    const real = (directory: string): string => r.git.git(directory, 'rev-parse', '--show-toplevel')
    expect(report.checkout).toEqual({ path: real(r.work), clean: false })
    expect(report.pullRequests.map((row) => row.worktree)).toEqual([
      { path: real(alphaTree), clean: true },
      { path: real(betaTree), clean: false },
      null,
      null,
    ])
  })
})

describe('what it could not read', () => {
  it('fails, exit 1, when no pull request could be read at all', async () => {
    const r = rig()
    const gh = createGhMock({
      listOpenPullRequestHeads: { rows: [], unavailable: 'gh: HTTP 502' },
    })

    const answer = await runIntersect([], { gh, cwd: r.work, env: r.sandbox.env })

    expect(answer).toEqual({
      outcome: 'failed',
      error: 'intersect read no pull requests: gh: HTTP 502',
    })
  })

  it('answers with the rows that arrived when the list fell short', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })

    const report = await intersect(r, [], {
      listOpenPullRequestHeads: {
        rows: [pull(1, 'alpha', a)],
        unavailable: '1 pullRequests row(s) could not be read',
      },
    })

    expect(report.pullRequests.map((row) => row.number)).toEqual([1])
    expect(report.unavailable).toEqual([
      'open pull requests: 1 pullRequests row(s) could not be read',
    ])
  })

  it('answers an empty report for a repository with no open pull request', async () => {
    const r = rig()

    const report = await intersect(r, [])

    expect(report.pullRequests).toEqual([])
    expect(report.pairs).toEqual([])
    expect(report.unavailable).toEqual([])
  })

  it('fails outside a git checkout, and asks gh nothing', async () => {
    const sandbox = createSandbox()

    const answer = await runIntersect([], {
      gh: createGhMock(),
      cwd: sandbox.path,
      env: sandbox.env,
    })

    expect(answer).toEqual({
      outcome: 'failed',
      error: `intersect runs inside a git checkout, and ${sandbox.path} is not in one`,
    })
  })

  it('reports a default branch it cannot name, and compares nothing against it', async () => {
    const r = rig()
    r.git.forgetOriginHead(r.work)
    const a = r.push('alpha', { 'a.txt': 'a\n' })

    const report = await intersect(r, [pull(1, 'alpha', a)])

    expect(report.defaultBranch).toBeNull()
    expect(report.pullRequests[0]).toMatchObject({ mergeBase: null, files: null })
    expect(report.pullRequests[0]?.againstDefault).toEqual({
      result: 'unread',
      reason: 'no default branch to compare against',
    })
    expect(report.unavailable[0]).toBe(
      'the default branch is unknown: origin/HEAD is not set (git remote set-head origin --auto)',
    )
  })

  it('uses the local default branch when its fetch fails, and says so', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    r.git.git(r.work, 'fetch', '-q', 'origin', a)
    const local = r.git.git(r.work, 'rev-parse', 'origin/main')
    r.git.breakOrigin(r.work)

    const report = await intersect(r, [pull(1, 'alpha', a)])

    expect(report.defaultBranch).toEqual({ name: 'main', sha: local, fetched: false })
    expect(report.pullRequests[0]).toMatchObject({
      fetched: true,
      againstDefault: { result: 'clean' },
    })
    expect(report.unavailable[0]).toMatch(
      /^main could not be fetched, so the local origin\/main is used: /,
    )
  })

  it('compares nothing when the default branch has no local copy either', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })
    r.git.breakOrigin(r.work)
    r.git.git(r.work, 'update-ref', '-d', 'refs/remotes/origin/main')

    const report = await intersect(r, [pull(1, 'alpha', a)])

    expect(report.defaultBranch).toEqual({ name: 'main', sha: null, fetched: false })
    expect(report.pullRequests[0]?.againstDefault).toEqual({
      result: 'unread',
      reason: 'no default branch to compare against',
    })
  })
})

describe('the command line and the report', () => {
  it('prints its own usage for --help, and refuses a flag it does not know', async () => {
    const sandbox = createSandbox()
    const context = { gh: createGhMock(), cwd: sandbox.path, env: sandbox.env }

    const help = await runIntersect(['--help'], context)
    expect(help.outcome === 'ok' && help.value).toMatch(/^Every open pull request's head/)

    await expect(runIntersect(['--nope'], context)).resolves.toMatchObject({
      outcome: 'refused',
    })
  })

  it('prints the report for a person without --json', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })
    const b = r.push('beta', { 'file.txt': 'beta\n' })
    const gh = createGhMock({
      listOpenPullRequestHeads: {
        rows: [pull(1, 'alpha', a), pull(2, 'beta', b)],
        unavailable: null,
      },
      listWorkflowRuns: { rows: [run(a)], unavailable: null },
    })

    const answer = await runIntersect([], { gh, cwd: r.work, env: r.sandbox.env })

    expect(answer.outcome).toBe('ok')
    const text = answer.outcome === 'ok' ? answer.value : ''
    expect(text).toContain(`#1  alpha -> main  draft\n    head ${a.slice(0, 7)}`)
    expect(text).toContain('    against main: clean\n    pull_request run: yes')
    expect(text).toContain('    pull_request run: no\n    worktree: none')
    expect(text).toContain('#1 and #2 share 1 file (file.txt): conflict in file.txt')
  })
})

describe('renderReport', () => {
  const row = {
    number: 7,
    title: 't',
    head: 'h',
    headSha: 'c'.repeat(40),
    base: 'main',
    draft: false,
    crossRepository: false,
    fetched: false,
    mergeBase: null,
    behind: null,
    files: null,
    stackedOn: null,
    ownFiles: null,
    pullRequestRun: null,
    worktree: { path: '/w', clean: null },
  }

  it('says what it could not read, line by line', () => {
    const text = renderReport({
      defaultBranch: null,
      checkout: { path: '/r', clean: null },
      pullRequests: [
        { ...row, stackedOn: 4, againstDefault: { result: 'unread', reason: 'no fetch' } },
      ],
      pairs: [
        { pullRequests: [7, 8], shared: ['a', 'b'], merge: { result: 'unread', reason: 'boom' } },
        { pullRequests: [7, 9], shared: ['a'], merge: { result: 'clean' } },
      ],
      unavailable: ['#7: head ccccccc could not be fetched: x'],
    })

    expect(text).toBe(
      [
        'INCOMPLETE: the facts below are short of what was asked for.',
        '  #7: head ccccccc could not be fetched: x',
        '',
        'default branch: unknown',
        'root checkout /r: unread',
        '',
        'open pull requests (1)',
        '  #7  h -> main  ready',
        '    head ccccccc (not fetched), merge base unread',
        '    changed files: unread',
        '    stacked on #4, own files: unread',
        '    against the default branch: unread (no fetch)',
        '    pull_request run: unread',
        '    worktree: /w, unread',
        '',
        'pairs that share a file (2)',
        '  #7 and #8 share 2 files (a, b): unread (boom)',
        '  #7 and #9 share 1 file (a): clean',
      ].join('\n'),
    )
  })

  it('names a tip, a count and a checkout it could not read, and a dirty one', () => {
    const text = renderReport({
      defaultBranch: { name: 'main', sha: null, fetched: false },
      checkout: { path: '/r', clean: false },
      pullRequests: [
        {
          ...row,
          fetched: true,
          mergeBase: 'e'.repeat(40),
          behind: null,
          files: [],
          pullRequestRun: true,
          worktree: null,
          againstDefault: { result: 'clean' },
        },
      ],
      pairs: [],
      unavailable: ['origin/main could not be read'],
    })

    expect(text.split('\n').slice(3, 7)).toEqual([
      'default branch: main, tip unread',
      'root checkout /r: dirty',
      '',
      'open pull requests (1)',
    ])
    expect(text).toContain(
      '    head ccccccc, merge base eeeeeee, main is an unread number of commits ahead of it',
    )
    expect(text).toContain(
      '    changed files: 0\n    against main: clean\n    pull_request run: yes',
    )
  })

  it('names a stale default branch and the rebase debt', () => {
    const text = renderReport({
      defaultBranch: { name: 'main', sha: 'd'.repeat(40), fetched: false },
      checkout: { path: '/r', clean: true },
      pullRequests: [
        {
          ...row,
          fetched: true,
          mergeBase: 'e'.repeat(40),
          behind: 1,
          files: ['a', 'b'],
          stackedOn: 3,
          ownFiles: ['b'],
          pullRequestRun: false,
          worktree: { path: '/w', clean: true },
          againstDefault: { result: 'conflict', paths: ['a', 'b'] },
        },
      ],
      pairs: [],
      unavailable: [],
    })

    expect(text).toBe(
      [
        'default branch: main at ddddddd (local, not fetched)',
        'root checkout /r: clean',
        '',
        'open pull requests (1)',
        '  #7  h -> main  ready',
        '    head ccccccc, merge base eeeeeee, main is 1 commit ahead of it',
        '    changed files: 2',
        '    stacked on #3, own files: 1',
        '    against main: conflict in a, b',
        '    pull_request run: no',
        '    worktree: /w, clean',
        '',
        'pairs that share a file (0)',
      ].join('\n'),
    )
  })
})

describe('a git read that fails', () => {
  /** The report, with a git first on the command's PATH that refuses the
   *  named subcommands, or answers them with nothing. The fixtures keep the
   *  real git: only the command sees the shim. */
  const withShim = async (
    r: Rig,
    pulls: readonly PullRequestHead[],
    shim: { fail?: string[]; silent?: string[] },
  ): Promise<IntersectReport> => {
    const { directory, failing } = r.git.gitShim(...(shim.fail ?? []))
    const env = {
      ...r.sandbox.env,
      PATH: `${directory}${path.delimiter}${r.sandbox.env.PATH}`,
      GIT_STUB_FAIL: failing,
      GIT_STUB_SILENT: (shim.silent ?? []).join(','),
    }
    const gh = createGhMock({
      listOpenPullRequestHeads: { rows: pulls, unavailable: null },
      listWorkflowRuns: { rows: [], unavailable: null },
    })
    const answer = await runIntersect(['--json'], { gh, cwd: r.work, env })
    if (answer.outcome !== 'ok') throw new Error(`intersect answered ${answer.outcome}`)
    return JSON.parse(answer.value) as IntersectReport
  }

  it('reports a merge-tree that failed as unread, for a head and for a pair', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })
    const b = r.push('beta', { 'file.txt': 'beta\n' })

    const report = await withShim(r, [pull(1, 'alpha', a), pull(2, 'beta', b)], {
      fail: ['merge-tree'],
    })

    const refused = { result: 'unread', reason: 'git stub: refusing merge-tree' }
    expect(report.pullRequests.map((row) => row.againstDefault)).toEqual([refused, refused])
    expect(report.pairs).toEqual([{ pullRequests: [1, 2], shared: ['file.txt'], merge: refused }])
    expect(report.unavailable).toEqual([
      '#1: merge-tree against the default branch failed: git stub: refusing merge-tree',
      '#2: merge-tree against the default branch failed: git stub: refusing merge-tree',
    ])
  })

  it('reports a merge-tree that exited 0 and said nothing as unread, never clean', async () => {
    const r = rig()
    const a = r.push('alpha', { 'file.txt': 'alpha\n' })

    const report = await withShim(r, [pull(1, 'alpha', a)], { silent: ['merge-tree'] })

    expect(report.pullRequests[0]?.againstDefault).toEqual({
      result: 'unread',
      reason: 'git merge-tree exited 0',
    })
  })

  it('reports each fact after a failed merge-base, count or diff as unread', async () => {
    const r = rig()
    const a = r.push('alpha', { 'a.txt': 'a\n' })

    const noBase = await withShim(r, [pull(1, 'alpha', a)], { fail: ['merge-base'] })
    expect(noBase.pullRequests[0]).toMatchObject({ mergeBase: null, behind: null, files: null })
    expect(noBase.unavailable).toEqual([
      '#1: no merge base with the default branch: git stub: refusing merge-base',
    ])

    const noCount = await withShim(r, [pull(1, 'alpha', a)], { fail: ['rev-list'] })
    expect(noCount.pullRequests[0]).toMatchObject({ behind: null, files: ['a.txt'] })
    expect(noCount.unavailable).toEqual([
      '#1: the commits since the merge base could not be counted: git stub: refusing rev-list',
    ])

    const noDiff = await withShim(r, [pull(1, 'alpha', a)], { fail: ['diff'] })
    expect(noDiff.pullRequests[0]).toMatchObject({ behind: 0, files: null })
    expect(noDiff.unavailable).toEqual([
      '#1: the changed files could not be read: git stub: refusing diff',
    ])
  })

  it('reports the own files of a stack layer that git could not diff as unread', async () => {
    const r = rig()
    const lower = r.push('lower', { 'lower.txt': 'l\n' })
    const upper = r.push('upper', { 'upper.txt': 'u\n' }, 'origin/lower')

    const report = await withShim(r, [pull(1, 'lower', lower), pull(2, 'upper', upper, 'lower')], {
      fail: ['diff'],
    })

    expect(report.pullRequests[1]).toMatchObject({ stackedOn: 1, ownFiles: null })
    expect(report.unavailable).toContain(
      '#2: its own files against #1 are unread: git stub: refusing diff',
    )
  })

  it('reports a worktree list it could not read, and a status it could not run', async () => {
    const r = rig()

    const noList = await withShim(r, [], { fail: ['worktree'] })
    expect(noList.checkout.path).toBe(r.git.git(r.work, 'rev-parse', '--show-toplevel'))
    expect(noList.unavailable).toEqual([
      'the worktree list could not be read: git stub: refusing worktree',
    ])

    const noStatus = await withShim(r, [], { fail: ['status'] })
    expect(noStatus.checkout.clean).toBeNull()
  })

  it('reports a default branch tip it could not read', async () => {
    const r = rig()

    const report = await withShim(r, [], { fail: ['rev-parse --verify'] })

    expect(report.defaultBranch).toEqual({ name: 'main', sha: null, fetched: true })
    expect(report.unavailable).toEqual(['origin/main could not be read'])
  })
})
