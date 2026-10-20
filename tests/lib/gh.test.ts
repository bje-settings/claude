// The real `gh` client. Nothing here spawns anything. The client takes the
// root lib's process runner as a parameter, so a stand-in drives the one
// thing that would start `gh`. Every endpoint is checked against the argv
// it builds and the output shape gh answers with. A suite that spawned `gh`
// would test a machine's login, not this code. The runner itself is the
// file tested against real children (`process.test.ts`).
//
// The argv rows are written out one endpoint at a time, not derived from
// the client, because a table built from the implementation would stay
// green even after the implementation changed.
//
// **The Python this file ports was deleted at #127.**
// `plugins/gh/scripts/*.py`, its `lib/`, and `plugins/gh/hooks/hook-io.py`
// are gone from the tree. The file and line references below point to what
// they held at `cd0d515`. Each reference stays because it says where a rule
// came from. Nothing here changed with the deletion.
import { describe, expect, it } from 'vitest'

import { createGhClient, type GhClient, GhError } from '#lib/gh.ts'
import type { Runner, RunResult } from '#lib/process.ts'

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: NodeJS.ProcessEnv | undefined
  readonly timeoutMs: number | undefined
}

/** What the runner is to answer with. Everything not named is what a child
 *  that succeeded and said nothing would report. */
interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly status?: number | null
  readonly signal?: NodeJS.Signals
  readonly timedOut?: boolean
  readonly elapsedMs?: number
  readonly startFailure?: { code: string; message: string }
  readonly streamErrors?: Array<{ code: string; message: string }>
}

const asResult = (reply: Reply): RunResult => ({
  status: reply.status === undefined ? 0 : reply.status,
  signal: reply.signal ?? null,
  stdout: reply.stdout ?? '',
  stderr: reply.stderr ?? '',
  combined: `${reply.stdout ?? ''}${reply.stderr ?? ''}`,
  timedOut: reply.timedOut ?? false,
  elapsedMs: reply.elapsedMs ?? 0,
  startFailure: reply.startFailure ?? null,
  streamErrors: reply.streamErrors ?? [],
})

/** A runner that answers with `reply` and records the call. */
const answering =
  (reply: Reply, calls: Call[]): Runner =>
  async (command, args, options) => {
    calls.push({
      command,
      args: args ?? [],
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
    })
    return asResult(reply)
  }

interface Harness {
  readonly gh: GhClient
  readonly calls: Call[]
}

const clientAnswering = (
  reply: Reply,
  options: {
    cwd?: string
    repository?: string
    env?: NodeJS.ProcessEnv
    boundMs?: number
  } = {},
): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ ...options, run: answering(reply, calls) }), calls }
}

/** A runner that answers each call from `replies` in order. Once the list
 *  runs out, it repeats the last reply, and it records every call.
 *  `issueStates` is the one endpoint that makes more than one call on its
 *  own: `repo view` for the owner and name, then one `api graphql` call per
 *  chunk. Its tests need a runner that can tell those calls apart. */
const answeringEach =
  (replies: Reply[], calls: Call[]): Runner =>
  async (command, args, options) => {
    calls.push({
      command,
      args: args ?? [],
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
    })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    return asResult(reply ?? {})
  }

const clientAnsweringEach = (replies: Reply[], options: { boundMs?: number } = {}): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ ...options, run: answeringEach(replies, calls) }), calls }
}

describe('argv', () => {
  it('asks gh pr list for the fields the shepherd reads, with no filters by default', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listPullRequests()
    expect(calls[0]?.command).toBe('gh')
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--json',
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision,baseRefName,' +
        'reviews,headRefName,isCrossRepository',
    ])
  })

  it('passes each pull-request filter it was given, and omits the ones it was not', async () => {
    // `gh-shepherd-status.py:166` to `178` is this call: open, labelled
    // `dependencies`, one window of 100.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    // The whole list, not a prefix. A slice pins the filters that were
    // passed, and leaves a stray trailing flag free to appear, which is the
    // defect the `pr view` assertion was changed for. That `--head` and
    // `--base` are absent is now part of the same expectation, not two
    // notes beside it.
    await gh.listPullRequests({ state: 'open', label: 'dependencies', limit: 100 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--state',
      'open',
      '--label',
      'dependencies',
      '--limit',
      '100',
      '--json',
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision,baseRefName,' +
        'reviews,headRefName,isCrossRepository',
    ])
  })

  it('asks gh pr list for the merged window with the fields sync-repo reads', async () => {
    // `gh-sync-repo.py:292`, plus `number` and `mergeCommit` (#348, #450).
    // A caller that names a base gets it filtered server-side.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listMergedPullRequests({ base: 'main', limit: 200 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--state',
      'merged',
      '--base',
      'main',
      '--limit',
      '200',
      '--json',
      'headRefName,headRefOid,isCrossRepository,number,mergeCommit',
    ])
  })

  it('narrows the merged window to one branch when asked', async () => {
    // The single-branch fallback at `gh-sync-repo.py:493`, for a bulk window
    // that saturated. 100 is that script's own `PR_BRANCH_LIMIT`. It is
    // passed, not omitted, because the caller compares the row count against
    // it to find out whether this window saturated too.
    //
    // The whole list, not a prefix. A slice leaves a stray trailing flag
    // free to appear, which is the defect the `pr view` assertion was
    // changed for.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listMergedPullRequests({ base: 'main', head: 'feature-a', limit: 100 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--state',
      'merged',
      '--base',
      'main',
      '--head',
      'feature-a',
      '--limit',
      '100',
      '--json',
      'headRefName,headRefOid,isCrossRepository,number,mergeCommit',
    ])
  })

  it('sends no --base when the merged window names no base', async () => {
    // #348: a stacked pull request keeps its parent branch as its base after
    // it merges. A base filter hides it, so `sync-repo` asks for every base.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listMergedPullRequests({ limit: 200 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      '200',
      '--json',
      'headRefName,headRefOid,isCrossRepository,number,mergeCommit',
    ])
  })

  it('asks gh pr view for one pull request, with the shepherd field list', async () => {
    // `gh-shepherd-pr.py:399`, the read every subcommand there begins with.
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewPullRequest({ pullRequest: 7 })
    // The whole argv, not a prefix. A slice leaves a stray trailing flag
    // free to appear. The field list is the same one `shepherd.py`'s
    // PR_FIELDS holds. It is spelled out here because `summary` shapes
    // whatever it is given, so a missing field comes back as a pull request
    // whose checks read `none`, which `wait` reads as passed.
    expect(calls[0]?.args).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision,baseRefName,' +
        'reviews,headRefName,isCrossRepository',
    ])
  })

  it('asks gh repo view for the name and the default branch', async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewRepository()
    expect(calls[0]?.args).toEqual(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
  })

  it('asks gh run list for the runs a branch produced', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listRuns({ branch: 'main', status: 'completed', limit: 20 })
    expect(calls[0]?.args).toEqual([
      'run',
      'list',
      '--branch',
      'main',
      '--status',
      'completed',
      '--limit',
      '20',
      '--json',
      'databaseId,status,conclusion,createdAt,updatedAt',
    ])
  })

  it('asks gh run list with no filters when it was given none', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listRuns()
    expect(calls[0]?.args).toEqual([
      'run',
      'list',
      '--json',
      'databaseId,status,conclusion,createdAt,updatedAt',
    ])
  })

  it('asks gh run view for the failed steps, of one job when it was given one', async () => {
    // `gh-shepherd-pr.py:726` has followed a check's link to a run and a
    // job. The whole run's failed steps would be a different question.
    const { gh, calls } = clientAnswering({ stdout: 'FAIL tests/thing\n' })
    await gh.readFailedRunLog({ run: 1234, job: '99' })
    await gh.readFailedRunLog({ run: '5678' })
    expect(calls[0]?.args).toEqual(['run', 'view', '1234', '--job', '99', '--log-failed'])
    expect(calls[1]?.args).toEqual(['run', 'view', '5678', '--log-failed'])
  })

  it('asks gh to update a branch, rebasing only when asked', async () => {
    const { gh, calls } = clientAnswering({ stdout: 'Updated branch\n' })
    await gh.updateBranch({ pullRequest: 7, rebase: true })
    await gh.updateBranch({ pullRequest: 7, rebase: false })
    expect(calls[0]?.args).toEqual(['pr', 'update-branch', '7', '--rebase'])
    expect(calls[1]?.args).toEqual(['pr', 'update-branch', '7'])
  })

  it('passes a comment body as one argument', async () => {
    // As an argument, never through a shell: a body that has backticks or a
    // semicolon in it is text, not something a shell gets to re-read.
    const { gh, calls } = clientAnswering({ stdout: 'https://github.com/a/b/pull/7#issue-1\n' })
    await gh.addComment({ pullRequest: 7, body: 'done; `rm -rf /`' })
    expect(calls[0]?.args).toEqual(['pr', 'comment', '7', '--body', 'done; `rm -rf /`'])

    // `body` is required, not a runtime check. #216 removed the file form
    // (`skip`'s only caller), so a call with no body is the one refusal
    // `CommentText` still has to make.
    // @ts-expect-error a comment with no body
    await gh.addComment({ pullRequest: 7 })
  })

  it('names the repository on every call when it was given one', async () => {
    // Round 5's handoff fact 4: the shepherd scripts run from wherever the
    // agent started, not from the checkout, so they name the repository on
    // every call they make. This test drives every endpoint here, not just
    // a sample of two. An endpoint that dropped the name would resolve
    // against the agent's own directory, and act on the wrong repository,
    // and the argv is the only place that shows it.
    const { gh, calls } = clientAnswering(
      { stdout: '{}', status: 0 },
      { repository: 'acme/widgets' },
    )
    const rows = clientAnswering({ stdout: '[]' }, { repository: 'acme/widgets' })
    const log = clientAnswering({ stdout: '' }, { repository: 'acme/widgets' })

    await rows.gh.listPullRequests()
    await rows.gh.listMergedPullRequests({ base: 'main', limit: 200 })
    await rows.gh.listRuns()
    await gh.viewPullRequest({ pullRequest: 7 })
    await gh.viewRepository()
    await log.gh.readFailedRunLog({ run: 1234 })
    await log.gh.updateBranch({ pullRequest: 7, rebase: false })
    await log.gh.addComment({ pullRequest: 7, body: 'hi' })

    const fields =
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision,baseRefName,reviews,headRefName,isCrossRepository'
    expect(rows.calls.map((call) => call.args)).toEqual([
      ['pr', 'list', '--repo', 'acme/widgets', '--json', fields],
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--state',
        'merged',
        '--base',
        'main',
        '--limit',
        '200',
        '--json',
        'headRefName,headRefOid,isCrossRepository,number,mergeCommit',
      ],
      [
        'run',
        'list',
        '--repo',
        'acme/widgets',
        '--json',
        'databaseId,status,conclusion,createdAt,updatedAt',
      ],
    ])
    expect(calls.map((call) => call.args)).toEqual([
      ['pr', 'view', '7', '--repo', 'acme/widgets', '--json', fields],
      ['repo', 'view', 'acme/widgets', '--json', 'nameWithOwner,defaultBranchRef'],
    ])
    expect(log.calls.map((call) => call.args)).toEqual([
      ['run', 'view', '1234', '--repo', 'acme/widgets', '--log-failed'],
      ['pr', 'update-branch', '7', '--repo', 'acme/widgets'],
      ['pr', 'comment', '7', '--repo', 'acme/widgets', '--body', 'hi'],
    ])
  })

  it('hands gh the environment it was built with, and nothing when it was built with none', async () => {
    // `GH_REPO` displaces `cwd` the way `GIT_DIR` does (`gh help
    // environment`). A client with an environment to pin must be able to
    // pass it. A client with none must leave the child to inherit this
    // process's own environment, which is what every ported call site gets
    // today.
    const pinned = clientAnswering({ stdout: '[]' }, { env: { PATH: '/usr/bin' } })
    await pinned.gh.listPullRequests()
    expect(pinned.calls[0]?.env).toEqual({ PATH: '/usr/bin' })

    const ambient = clientAnswering({ stdout: '[]' })
    await ambient.gh.listPullRequests()
    expect(ambient.calls[0]?.env).toBeUndefined()
  })

  it('names the repository to gh repo view positionally, because it has no --repo flag', async () => {
    // `gh repo view` is the one command in this client with no `-R, --repo`.
    // Its inherited flags are `--help` alone, and the repository is the
    // positional argument instead (`gh repo view [<repository>]`). gh
    // 2.98.0 refuses the flag form outright, with "unknown flag: --repo".
    // To build it that way would make every `viewRepository` call fail on a
    // client that names a repository, which is the first call the shepherd
    // path makes. The Python never built it that way either:
    // `gh-shepherd-pr.py:959` and `gh-shepherd-status.py:104` are the only
    // two of its ten gh calls that pass no `--repo`.
    const { gh, calls } = clientAnswering({ stdout: '{}' }, { repository: 'acme/widgets' })
    await gh.viewRepository()

    expect(calls[0]?.args).toEqual([
      'repo',
      'view',
      'acme/widgets',
      '--json',
      'nameWithOwner,defaultBranchRef',
    ])
    expect(calls[0]?.args).not.toContain('--repo')
  })

  it('runs gh where it was told to, and in the current directory otherwise', async () => {
    // `gh-sync-repo.py` names no repository and relies on this: it has
    // already chdir'd into the checkout.
    const here = clientAnswering({ stdout: '{}' }, { cwd: '/tmp/acme-widgets' })
    await here.gh.viewRepository()
    expect(here.calls[0]?.cwd).toBe('/tmp/acme-widgets')
    expect(here.calls[0]?.args).not.toContain('--repo')

    const anywhere = clientAnswering({ stdout: '{}' })
    await anywhere.gh.viewRepository()
    expect(anywhere.calls[0]?.cwd).toBeUndefined()
  })
})

describe('the client bound (ruling 4, #295)', () => {
  // `succeeded` calls `invoke(args)` with no bound of its own. So do
  // `restJson`, `queryOnce` and `collect`: the functions behind
  // `requiredContexts`, `viewPullRequestDetail` and `listOpenPullRequestHeads`.
  // `invoke` defaults the bound to the client's own `options.boundMs`. One
  // test on one such endpoint, `viewRepository`, covers all of them. The
  // default is read at the one place every one of them calls through.
  it('binds every call through invoke, when the client was built with a bound', async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' }, { boundMs: 5_000 })
    await gh.viewRepository()
    expect(calls[0]?.timeoutMs).toBe(5_000)
  })

  // A mutation that drops `invoke`'s default parameter turns this test red:
  // `calls[0].timeoutMs` would read `undefined` instead of `5_000`.
  it("leaves every call unbound when the client was built with none, the `gh` plugin's mode", async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewRepository()
    expect(calls[0]?.timeoutMs).toBeUndefined()
  })

  it('does not override a call that already carries its own bound', async () => {
    const { gh, calls } = clientAnswering({ stdout: '' }, { boundMs: 5_000 })
    await gh.repositoryStatus(['acme/widgets'], { boundMs: 90_000 })
    expect(calls[0]?.timeoutMs).toBe(90_000)
  })

  it("reports a call that timed out as itself, never as gh's own words", async () => {
    const { gh } = clientAnswering(
      // stderr is populated, and elapsedMs differs from boundMs, so a
      // mutation that read either instead of the timeout would turn this
      // red.
      {
        timedOut: true,
        status: null,
        signal: 'SIGKILL',
        elapsedMs: 5_014,
        stderr: 'gh: API rate limit exceeded\n',
      },
      { boundMs: 5_000 },
    )
    await expect(gh.viewRepository()).rejects.toMatchObject({
      detail: 'gh did not answer in 5000 ms',
    })
  })
})

describe('answers', () => {
  it('hands back the rows gh printed', async () => {
    const { gh } = clientAnswering({ stdout: '[{"number":1},{"number":2}]' })
    await expect(gh.listPullRequests()).resolves.toEqual([{ number: 1 }, { number: 2 }])
    await expect(gh.listMergedPullRequests({ base: 'main', limit: 200 })).resolves.toHaveLength(2)
  })

  it('hands back the objects gh printed', async () => {
    const repository = clientAnswering({ stdout: '{"nameWithOwner":"acme/widgets"}' })
    await expect(repository.gh.viewRepository()).resolves.toEqual({
      nameWithOwner: 'acme/widgets',
    })
    const pull = clientAnswering({ stdout: '{"number":7,"state":"OPEN"}' })
    await expect(pull.gh.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({
      number: 7,
      state: 'OPEN',
    })
  })

  it('hands back a log as the text it is', async () => {
    // `--log-failed` is a log, so it is not parsed: a caller reads the lines a
    // human would.
    const { gh } = clientAnswering({ stdout: 'FAIL tests/thing\n  expected 1\n' })
    await expect(gh.readFailedRunLog({ run: 1 })).resolves.toBe('FAIL tests/thing\n  expected 1\n')
  })

  it('hands back what a mutating call printed', async () => {
    // A reply for each call, not one shared between them. An assertion that
    // matches only because the stand-in answers every call the same way
    // says nothing about the endpoint it names.
    const updated = clientAnswering({ stdout: 'Updated branch main\n' })
    await expect(updated.gh.updateBranch({ pullRequest: 7, rebase: true })).resolves.toBe(
      'Updated branch main\n',
    )
    const commented = clientAnswering({ stdout: 'https://github.com/a/b/pull/7#issue-1\n' })
    await expect(commented.gh.addComment({ pullRequest: 7, body: 'hi' })).resolves.toBe(
      'https://github.com/a/b/pull/7#issue-1\n',
    )
  })

  it('answers from stdout alone, leaving what gh wrote to stderr out of it', async () => {
    // gh writes deprecation and auth notices to stderr, while it exits
    // zero. To fold those into the answer would put prose inside a JSON
    // payload, or inside a log a caller reads as the lines a human would.
    const rows = clientAnswering({ stdout: '[{"number":1}]', stderr: 'gh: a new release\n' })
    await expect(rows.gh.listPullRequests()).resolves.toEqual([{ number: 1 }])

    const log = clientAnswering({ stdout: 'FAIL tests/thing\n', stderr: 'gh: a new release\n' })
    await expect(log.gh.readFailedRunLog({ run: 1 })).resolves.toBe('FAIL tests/thing\n')
  })
})

describe('refusals', () => {
  it("throws gh's own words, and its status, when gh exits non-zero", async () => {
    // gh's wording travels with the failure because a caller cannot tell an
    // expired token from a repository that does not exist without it. The
    // status travels with it because round 5's handoff fact 3 is that a
    // caller could otherwise only branch on prose.
    const { gh } = clientAnswering({
      status: 1,
      stderr: 'gh: could not resolve to a Repository\n',
    })
    await expect(gh.viewRepository()).rejects.toThrow(
      'gh repo view --json nameWithOwner,defaultBranchRef failed: ' +
        'gh: could not resolve to a Repository',
    )
  })

  it("carries gh's account without the argv in front of it", async () => {
    // The field a report quotes. The Python prints `last_line(stderr)`, and
    // the ordinary refusal is ONE line. So a tail of the message would hand
    // a reader the whole argv: before this existed,
    // `plugins/gh/src/subcommands/sync-repo.ts` put forty characters of
    // `--json` fields inside a rate-limit line.
    const { gh } = clientAnswering({
      status: 1,
      stderr: 'gh: API rate limit exceeded\n',
    })
    const error = await gh
      .listMergedPullRequests({ base: 'main', limit: 200 })
      .catch((thrown: unknown) => thrown)

    expect((error as GhError).detail).toBe('gh: API rate limit exceeded')
    expect((error as GhError).message).toContain('gh pr list')
    expect((error as GhError).message).toMatch(/failed: gh: API rate limit exceeded$/)
  })

  it('carries the status and the whole run on the error it throws', async () => {
    const { gh } = clientAnswering({ status: 4, stderr: 'gh auth login\n' })
    const error = await gh.listRuns().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(GhError)
    expect(error).toBeInstanceOf(Error)
    expect((error as GhError).name).toBe('GhError')
    expect((error as GhError).status).toBe(4)
    expect((error as GhError).cause).toMatchObject({ status: 4, stderr: 'gh auth login\n' })
  })

  it('names the status when gh exited non-zero and said nothing', async () => {
    const { gh } = clientAnswering({ status: 1 })
    const error = await gh.listRuns().catch((thrown: unknown) => thrown)

    expect((error as GhError).message).toMatch(/failed: gh exited 1$/)
    // The sync report quotes `detail`, and "gh exited <n>" is the Python's own
    // sentence (`gh-sync-repo.py` `gh_json`), so this string is a report line.
    expect((error as GhError).detail).toBe('gh exited 1')
  })

  it('names the signal when something killed gh', async () => {
    // A child a signal ended has no status of its own to report, and "gh
    // exited null" is not an account of anything.
    const { gh } = clientAnswering({ status: null, signal: 'SIGKILL' })
    await expect(gh.listRuns()).rejects.toThrow(/failed: gh was killed by SIGKILL$/)
  })

  it("reports a gh that never started as node's account of it, not as gh's", async () => {
    // Not on PATH, or in a working directory that is gone. Whatever gh had
    // written to stderr before this is not an account of that. 127 is the
    // shell's own "command not found", which `lib/install.py:58` keeps.
    const { gh } = clientAnswering({
      status: 127,
      startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' },
    })
    const error = await gh.listRuns().catch((thrown: unknown) => thrown)

    expect((error as GhError).message).toMatch(/failed: cannot run gh: spawn gh ENOENT$/)
    expect((error as GhError).detail).toBe('cannot run gh: spawn gh ENOENT')
    expect((error as GhError).status).toBe(127)
  })

  it("throws when one of gh's pipes failed, even though gh exited 0", async () => {
    // gh exits happily on the bytes it wrote, but the bytes that arrived
    // here are only the ones that got through. To parse a short answer this
    // way would read a truncated list as a complete one, which is what
    // `rows` refuses to do by default.
    const { gh } = clientAnswering({
      stdout: '[{"number":1}]',
      streamErrors: [{ code: 'EIO', message: 'read EIO' }],
    })
    const error = await gh.listRuns().catch((thrown: unknown) => thrown)

    expect((error as GhError).message).toMatch(
      /failed: gh's output could not be read: EIO, read EIO$/,
    )
    expect((error as GhError).detail).toBe("gh's output could not be read: EIO, read EIO")
    expect((error as GhError).status).toBe(0)
  })

  it('throws when gh answered with something that is not JSON', async () => {
    const { gh } = clientAnswering({ stdout: 'not json at all' })
    await expect(gh.listPullRequests()).rejects.toThrow(
      'gh answered gh pr list with something that is not JSON',
    )
  })

  it('carries the whole run as the cause of an answer it could not read, too', async () => {
    // One shape for everything that goes wrong. The four throw sites in
    // this file report the same `cause`, so a caller that reads
    // `cause.stderr` gets gh's own words, whichever site it caught. The
    // offending value goes in the message, where it is read, not in the
    // cause, where it would displace the run. `status` is 0 here on
    // purpose: gh succeeded, and its answer could not be read, a different
    // fact from gh's own failure.
    const { gh } = clientAnswering({ stdout: 'not json at all', stderr: 'a note\n' })
    const error = await gh.listPullRequests().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(GhError)
    expect((error as GhError).status).toBe(0)
    expect((error as GhError).cause).toMatchObject({
      stdout: 'not json at all',
      stderr: 'a note\n',
    })
    // An answer that could not be read has no argv prefix to strip, so the
    // account and the message are the same string. A caller that reads
    // `detail` gets a whole sentence, whichever throw site it caught.
    expect((error as GhError).detail).toBe((error as GhError).message)
  })

  it('throws when a list endpoint answered with something else', async () => {
    // Never defaulted to an empty list. "Nothing matched" and "the answer
    // was not a list" are different facts, and to fold them together is how
    // a caller acts on a repository it could not read.
    const { gh } = clientAnswering({ stdout: '{"message":"Not Found"}' })
    const error = await gh.listRuns().catch((thrown: unknown) => thrown)

    expect((error as GhError).message).toContain(
      'gh answered gh run list with something that is not a list',
    )
    expect((error as GhError).detail).toBe((error as GhError).message)
  })

  it.each([
    ['a string', '"acme/widgets"'],
    ['null', 'null'],
    ['a list', '[{"nameWithOwner":"acme/widgets"}]'],
  ])('throws when the repository answer is %s', async (_shape, stdout) => {
    const { gh } = clientAnswering({ stdout })
    const error = await gh.viewRepository().catch((thrown: unknown) => thrown)

    expect((error as GhError).message).toContain(
      'gh answered gh repo view with something that is not an object',
    )
    expect((error as GhError).detail).toBe((error as GhError).message)
  })
})

describe('issue and pull request states', () => {
  it('asks gh api graphql for one aliased issueOrPullRequest per number and reads OPEN back', async () => {
    const { gh, calls } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: '{"data":{"repository":{"i0":{"state":"OPEN"}}}}' },
    ])

    const result = await gh.issueStates({ numbers: [127] })

    expect(calls[0]?.args).toEqual(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
    expect(calls[1]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      'query=query {\n' +
        '  repository(owner: "acme", name: "widgets") {\n' +
        '    i0: issueOrPullRequest(number: 127) { ... on Issue { state } ... on PullRequest { state } }\n' +
        '  }\n' +
        '}',
    ])
    expect(result).toEqual({ states: { '127': 'OPEN' }, unavailable: null })
  })

  it('reads a CLOSED state and a MERGED state, one alias per number', async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: '{"data":{"repository":{"i0":{"state":"CLOSED"},"i1":{"state":"MERGED"}}}}',
      },
    ])

    const result = await gh.issueStates({ numbers: [1, 2] })

    expect(result).toEqual({ states: { '1': 'CLOSED', '2': 'MERGED' }, unavailable: null })
  })

  it('reads a null alias as not_found only when a NOT_FOUND error names it', async () => {
    // The rule that took two review rounds on the spike to get right (#170):
    // an alias is `not_found` only when `errors` carries a `NOT_FOUND` entry
    // whose `path` ends in that alias.
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: JSON.stringify({
          data: { repository: { i0: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'i0'],
              message: 'Could not resolve to an issue or pull request with the number of 999999.',
            },
          ],
        }),
      },
    ])

    const result = await gh.issueStates({ numbers: [999999] })

    expect(result).toEqual({ states: { '999999': 'not_found' }, unavailable: null })
  })

  it('leaves a FORBIDDEN alias out rather than calling it absent, and reports why', async () => {
    // The defect the rule above exists for: a permissions error beside a
    // perfectly good answer must not read as "this issue does not exist".
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: JSON.stringify({
          data: { repository: { i0: { state: 'OPEN' }, i1: null } },
          errors: [
            {
              type: 'FORBIDDEN',
              path: ['repository', 'i1'],
              message: 'Resource not accessible by integration',
            },
          ],
        }),
      },
    ])

    const result = await gh.issueStates({ numbers: [138, 164] })

    expect(result).toEqual({
      states: { '138': 'OPEN' },
      unavailable: 'Resource not accessible by integration',
    })
  })

  it('leaves every null alias out for a timeout error, which carries no path', async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: JSON.stringify({
          data: { repository: { i0: null, i1: null } },
          errors: [{ message: 'Something went wrong while executing your query.' }],
        }),
      },
    ])

    const result = await gh.issueStates({ numbers: [138, 164] })

    expect(result).toEqual({
      states: {},
      unavailable: 'Something went wrong while executing your query.',
    })
  })

  it("reports a body whose repository is null as unavailable in accountOf's words", async () => {
    // "Only a body without `data.repository` is `unavailable`, with
    // `accountOf(result)` as the reason" (#170). Unlike the spike, this does
    // not read the GraphQL error message for the reason. It reads what the
    // transport says about the call instead, exactly as every other
    // endpoint here does for a failure.
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        status: 1,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ message: 'Bad credentials' }],
        }),
        stderr: 'gh: Bad credentials\n',
      },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'gh: Bad credentials' })
  })

  it("reports a body that is not JSON as unavailable in accountOf's words", async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: 'not json at all', stderr: 'gh: a note\n' },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'gh: a note' })
  })

  it('reports a gh that could not be started as unavailable, never as a throw', async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { status: 127, startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' } },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'cannot run gh: spawn gh ENOENT' })
  })

  // The bound outranks the body, even a whole, valid one (ruling 4, #295),
  // the same way `viewPullRequestDetail` guards its own read. A mutation
  // that drops this check would read the node as a genuine reply instead
  // of a timeout.
  it('reports an issue-state read that timed out as itself, before it tries to parse the body', async () => {
    const { gh } = clientAnsweringEach(
      [
        { stdout: '{"nameWithOwner":"acme/widgets"}' },
        {
          timedOut: true,
          status: null,
          signal: 'SIGKILL',
          stdout: '{"data":{"repository":{"i0":{"state":"OPEN"}}}}',
        },
      ],
      { boundMs: 5_000 },
    )

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'gh did not answer in 5000 ms' })
  })

  it('reports the measured time when a client with no bound of its own times out', async () => {
    // `accountOf`'s `boundMs` argument is the bound the caller that reads
    // the result was configured with (`options.boundMs` here, through the
    // guard just above). A client built with none, such as the `audit`
    // plugin's, has none to report, so `accountOf` falls back to
    // `result.elapsedMs`, the time it actually measured (`lib/gh.ts`
    // `accountOf`). `invoke`'s own bound is `options.boundMs` too
    // (`const invoke`), so a client with none never truly starts a timer;
    // this reply's `timedOut: true` stands in for that fallback path,
    // which every other endpoint here also reaches only by a stand-in.
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { status: null, signal: 'SIGKILL', timedOut: true, elapsedMs: 9000 },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'gh did not answer in 9000 ms' })
  })

  it('chunks 101 numbers into two calls of 100 and 1, each aliased from i0', async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1)
    const { gh, calls } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: '{"data":{"repository":{}}}' },
      { stdout: '{"data":{"repository":{"i0":{"state":"OPEN"}}}}' },
    ])

    const result = await gh.issueStates({ numbers })

    // Each `api graphql` call aliases from i0 again. The batch is what
    // resets, not a running count, so the second call's one number is still
    // i0. This test asserts only the two ends of the first chunk as
    // literals, rather than reconstruct the whole 100-alias query from the
    // numbers array, which would only prove the query builder against a
    // copy of itself.
    expect(calls[1]?.args[3]).toContain('i0: issueOrPullRequest(number: 1) {')
    expect(calls[1]?.args[3]).toContain('i99: issueOrPullRequest(number: 100) {')
    expect(calls[1]?.args[3]).not.toContain('number: 101')
    expect(calls[2]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      'query=query {\n' +
        '  repository(owner: "acme", name: "widgets") {\n' +
        '    i0: issueOrPullRequest(number: 101) { ... on Issue { state } ... on PullRequest { state } }\n' +
        '  }\n' +
        '}',
    ])
    expect(result).toEqual({ states: { '101': 'OPEN' }, unavailable: null })
  })

  it('reports a repository it could not resolve as unavailable, without a second call', async () => {
    // Owner and name come from `viewRepository`, which throws; this endpoint
    // never does, so a failure there ends the lookup with no `api graphql`
    // call at all rather than one built from an empty owner and name.
    const { gh, calls } = clientAnsweringEach([
      { status: 1, stderr: 'gh: could not resolve to a Repository\n' },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({
      states: {},
      unavailable: 'gh: could not resolve to a Repository',
    })
    expect(calls[0]?.args).toEqual(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
  })

  it('leaves an unrecognised state out: the node exists, so it is not absent', async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: '{"data":{"repository":{"i0":{"state":"DRAFT"}}}}' },
    ])

    const result = await gh.issueStates({ numbers: [138] })

    expect(result).toEqual({ states: {}, unavailable: null })
  })

  it.each([
    ['no path at all', { type: 'NOT_FOUND', message: 'gone' }],
    ['a path that is not an array', { type: 'NOT_FOUND', path: 'repository.i0', message: 'gone' }],
    ['an empty path', { type: 'NOT_FOUND', path: [], message: 'gone' }],
    [
      'a path whose last entry is not a string',
      { type: 'NOT_FOUND', path: ['repository', 0], message: 'gone' },
    ],
  ])('names no alias for a NOT_FOUND error with %s', async (_case, error) => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: JSON.stringify({ data: { repository: { i0: null } }, errors: [error] }) },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(result).toEqual({ states: {}, unavailable: 'gone' })
  })

  it('keeps the states a non-zero exit still answered, alongside a NOT_FOUND', async () => {
    // `gh api graphql` exits 1 when ANY alias in the query errors, even when
    // the body is a perfectly good answer for every other alias: this is the
    // whole reason `issueStates` reads the body through `invoke` rather than
    // `succeeded`, which would throw on this exit status and lose the
    // resolved answer along with it.
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        status: 1,
        stderr: 'gh: some errors occurred processing your query\n',
        stdout: JSON.stringify({
          data: { repository: { i0: { state: 'OPEN' }, i1: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'i1'],
              message: 'Could not resolve to an issue or pull request with the number of 999999.',
            },
          ],
        }),
      },
    ])

    const result = await gh.issueStates({ numbers: [138, 999999] })

    expect(result).toEqual({ states: { '138': 'OPEN', '999999': 'not_found' }, unavailable: null })
  })

  it('joins two non-NOT_FOUND error messages from the same chunk', async () => {
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: JSON.stringify({
          data: { repository: { i0: null, i1: null } },
          errors: [
            { type: 'FORBIDDEN', path: ['repository', 'i0'], message: 'first message' },
            { type: 'RATE_LIMITED', path: ['repository', 'i1'], message: 'second message' },
          ],
        }),
      },
    ])

    const result = await gh.issueStates({ numbers: [138, 164] })

    expect(result).toEqual({ states: {}, unavailable: 'first message; second message' })
  })

  it('joins reasons from two chunks that each failed for a different reason', async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1)
    const { gh } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      {
        stdout: JSON.stringify({
          data: { repository: { i0: { state: 'OPEN' } } },
          errors: [{ type: 'FORBIDDEN', path: ['repository', 'i1'], message: 'first reason' }],
        }),
      },
      { stdout: 'not json at all', stderr: 'second reason\n' },
    ])

    const result = await gh.issueStates({ numbers })

    // Both chunks' resolved states and both chunks' reasons survive: neither
    // overwrites the other, which `reasons.push` across the loop and
    // `Object.assign` promise, and a `reasons[0]` or an assignment that
    // clobbers would not.
    expect(result).toEqual({ states: { '1': 'OPEN' }, unavailable: 'first reason; second reason' })
  })

  it('reports a repository whose name has no owner prefix as unavailable, via the graphql call it still makes', async () => {
    // `nameWithOwner` with no `/` is not a shape any real gh answers with,
    // but the code makes no branch for it either (the comment above the
    // split in `lib/gh.ts`). `parts[1]` is `undefined`, and
    // `String(undefined)` embeds the four characters `undefined` as the
    // query's `name` argument. The resulting query then fails downstream
    // exactly as any other query that names a repository that does not
    // exist would, reported through `accountOf` like every other chunk
    // failure in this file.
    const { gh, calls } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"widgets"}' },
      {
        status: 1,
        stdout: JSON.stringify({ data: { repository: null } }),
        stderr: "gh: Could not resolve to a Repository with the name 'widgets/undefined'.\n",
      },
    ])

    const result = await gh.issueStates({ numbers: [1] })

    expect(calls[1]?.args[3]).toContain('repository(owner: "widgets", name: "undefined")')
    expect(result).toEqual({
      states: {},
      unavailable: "gh: Could not resolve to a Repository with the name 'widgets/undefined'.",
    })
  })
})

it("defaults to the root lib's own process runner", () => {
  // Constructed, not called. To call it would start the real `gh`, which is
  // what every other example here avoids. What this pins is that a client
  // built with no options is a whole client, with every endpoint present.
  // That the transport it falls back to is `process.ts`'s `run` is held by
  // the compiler, not by an assertion: to drive it would spawn a process,
  // and to export the fallback, so a test could compare identities, would
  // add a shipped export whose only caller is this file.
  const gh = createGhClient()
  const endpoints = Object.keys(gh).sort()
  expect(endpoints).toEqual([
    'addComment',
    'branchRef',
    'commitDate',
    'compareCommits',
    'createCommitStatus',
    'issueStates',
    'listIssues',
    'listMergedPullRequests',
    'listMilestones',
    'listOpenPullRequestHeads',
    'listOpenPullRequestLinks',
    'listOpenPullRequests',
    'listPullRequestStatuses',
    'listPullRequests',
    'listRunJobs',
    'listRuns',
    'listWorkflowRuns',
    'readFailedRunLog',
    'readPlanIssues',
    'repositoryStatus',
    'requiredContexts',
    'requiredReviews',
    'searchPlanIssues',
    'updateBranch',
    'viewPullRequest',
    'viewPullRequestDetail',
    'viewRepository',
  ])
})

// --- the paginated sweep reads -----------------------------------------------
//
// One repository resolution, then one `api graphql` call per page, so every
// example here answers the `repo view` first. This suite asserts the argv
// built for each endpoint, the rows read back, and every way an answer can
// be short: a reply that cannot be read at all, a row that is not the shape
// the query asked for, an error beside a good page, a cursor that does not
// advance, and more pages than the client will follow.
describe('milestones, issues and pull requests', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }

  /** One connection page as gh prints it. */
  const page = (
    field: string,
    nodes: readonly unknown[],
    info: { hasNextPage?: boolean; endCursor?: string | null } = {},
    errors?: readonly unknown[],
  ): Reply => ({
    stdout: JSON.stringify({
      data: {
        repository: {
          [field]: {
            pageInfo: { hasNextPage: info.hasNextPage ?? false, endCursor: info.endCursor ?? null },
            nodes,
          },
        },
      },
      ...(errors === undefined ? {} : { errors }),
    }),
  })

  const milestoneNode = {
    number: 4,
    title: 'workstreams primitives',
    issues: { totalCount: 13 },
    closedIssues: { totalCount: 1 },
  }

  const issueNode = {
    number: 130,
    title: 'feat(workstreams): sweep (primitive 1)',
    milestone: { number: 4, title: 'workstreams primitives' },
    labels: { nodes: [{ name: 'enhancement' }] },
    blockedBy: { nodes: [{ number: 127, state: 'CLOSED' }] },
    blocking: { nodes: [{ number: 131, state: 'OPEN' }] },
    closedByPullRequestsReferences: { nodes: [{ number: 158, state: 'MERGED' }] },
  }

  const pullNode = {
    number: 177,
    title: 'feat(audit): plugin skeleton',
    isDraft: true,
    headRefName: 'wktr-171-audit-split',
    baseRefName: 'main',
  }

  it('asks for the open milestones with owner and name as variables, and no cursor on the first page', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, page('milestones', [milestoneNode])])

    const result = await gh.listMilestones()

    expect(calls[1]?.command).toBe('gh')
    expect(calls[1]?.args.slice(0, 6)).toEqual([
      'api',
      'graphql',
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
    ])
    // The cursor is omitted rather than passed empty: `after: null` is the
    // first page, and an empty string is a cursor value GitHub is under no
    // obligation to read as one.
    expect(calls[1]?.args.some((word) => word.startsWith('cursor='))).toBe(false)
    expect(calls[1]?.args[7]).toContain('milestones(states: OPEN, first: 100, after: $cursor')
    expect(calls[1]?.args[7]).toContain('closedIssues: issues(states: CLOSED)')
    expect(result).toEqual({
      rows: [{ number: 4, title: 'workstreams primitives', openIssues: 13, closedIssues: 1 }],
      unavailable: null,
    })
  })

  it('asks for open issues with their dependency relationships, filtered by milestone', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, page('issues', [issueNode])])

    const result = await gh.listIssues({ milestone: '4' })

    expect(calls[1]?.args.slice(0, 8)).toEqual([
      'api',
      'graphql',
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
      '-f',
      'milestone=4',
    ])
    expect(calls[1]?.args[9]).toContain('filterBy: {milestoneNumber: $milestone}')
    expect(calls[1]?.args[9]).toContain('blockedBy(first: 100)')
    expect(calls[1]?.args[9]).toContain('blocking(first: 100)')
    expect(calls[1]?.args[9]).toContain('includeClosedPrs: true')
    expect(result).toEqual({
      rows: [
        {
          number: 130,
          title: 'feat(workstreams): sweep (primitive 1)',
          milestone: { number: 4, title: 'workstreams primitives' },
          labels: ['enhancement'],
          blockedBy: [{ number: 127, state: 'CLOSED' }],
          blocking: [{ number: 131, state: 'OPEN' }],
          pullRequests: [{ number: 158, state: 'MERGED' }],
        },
      ],
      unavailable: null,
    })
  })

  it('omits the milestone variable when no milestone was asked for', async () => {
    // This is the query that answers for the issues on NO milestone. The
    // variable is then null, and GitHub filters on nothing. The caller
    // reads `milestone === null` off the rows instead.
    const { gh, calls } = clientAnsweringEach([
      REPO,
      page('issues', [{ ...issueNode, milestone: null }]),
    ])

    const result = await gh.listIssues()

    expect(calls[1]?.args.some((word) => word.startsWith('milestone='))).toBe(false)
    expect(calls[1]?.args.slice(0, 6)).toEqual([
      'api',
      'graphql',
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
    ])
    expect(result.rows[0]?.milestone).toBeNull()
  })

  it('asks for every open pull request with its head and base', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, page('pullRequests', [pullNode])])

    const result = await gh.listOpenPullRequests()

    expect(calls[1]?.args[7]).toContain('pullRequests(states: OPEN, first: 100, after: $cursor')
    expect(result).toEqual({
      rows: [
        {
          number: 177,
          title: 'feat(audit): plugin skeleton',
          head: 'wktr-171-audit-split',
          base: 'main',
          draft: true,
        },
      ],
      unavailable: null,
    })
  })

  it('follows the cursor to the next page and concatenates the rows', async () => {
    const { gh, calls } = clientAnsweringEach([
      REPO,
      page('milestones', [milestoneNode], { hasNextPage: true, endCursor: 'CUR1' }),
      page('milestones', [{ ...milestoneNode, number: 5, title: 'field-test' }]),
    ])

    const result = await gh.listMilestones()

    expect(calls[2]?.args).toContain('cursor=CUR1')
    // The same query text on both pages: only the cursor variable moves, which
    // is what makes a captured page replayable against the argv that asked
    // for it.
    expect(calls[2]?.args[9]).toBe(calls[1]?.args[7])
    expect(result.rows.map((row) => row.number)).toEqual([4, 5])
    expect(result.unavailable).toBeNull()
  })

  it('stops when the reply wants another page but names no cursor to ask with, and says so', async () => {
    // To ask again with the cursor already used would ask the same question
    // forever. The rows already read are still an answer, and the reason
    // the answer is short is reported: without it a truncated set is handed
    // over as a complete one.
    const { gh } = clientAnsweringEach([
      REPO,
      page('milestones', [milestoneNode], { hasNextPage: true, endCursor: null }),
    ])

    const result = await gh.listMilestones()

    // One row, from the one page that was read: the count of rows is the
    // count of pages here, and it is what says the read stopped.
    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe(
      'milestones has more pages and the reply named no cursor to ask with',
    )
  })

  it('stops after twenty pages and says the answer is short', async () => {
    // A `hasNextPage` field that never goes false is a loop this process
    // would not leave. The ceiling is reported, not silently truncated.
    // Each page's cursor advances, so the repeated-cursor guard does not
    // trip first: `CUR${n}` is a fresh value every time.
    const pages = Array.from({ length: 20 }, (_, index) =>
      page('issues', [issueNode], { hasNextPage: true, endCursor: `CUR${index + 1}` }),
    )
    const { gh } = clientAnsweringEach([REPO, ...pages])

    const result = await gh.listIssues()

    // One row per page, so twenty rows is twenty pages and nothing beyond.
    expect(result.rows).toHaveLength(20)
    expect(result.unavailable).toBe('issues has more pages than the 20 this reads')
  })

  it('stops when a page replies with the same cursor it was just asked with, before reading its rows again', async () => {
    // A cursor that does not advance would otherwise be read and appended
    // forever (up to the page ceiling): the same node counted once per page
    // instead of once. The guard fires on the second page, since the first
    // page is asked with no cursor at all.
    const { gh } = clientAnsweringEach([
      REPO,
      page('issues', [issueNode], { hasNextPage: true, endCursor: 'CUR' }),
    ])

    const result = await gh.listIssues()

    // Only the first page's row: the second page's identical cursor stops
    // the read before its rows are appended a second time.
    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe("issues's reply repeated the same cursor without advancing")
  })

  it('counts a milestone row that is not the shape the query asked for, one field at a time', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      page('milestones', [
        'not a record',
        { ...milestoneNode, number: 'four' },
        { ...milestoneNode, title: 4 },
        { ...milestoneNode, issues: {} },
        { ...milestoneNode, closedIssues: null },
        milestoneNode,
      ]),
    ])

    const result = await gh.listMilestones()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('5 milestones row(s) could not be read')
  })

  it('counts an issue row that is not the shape the query asked for, one field at a time', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      page('issues', [
        { ...issueNode, number: null },
        { ...issueNode, title: null },
        { ...issueNode, blockedBy: {} },
        { ...issueNode, blocking: 'no' },
        { ...issueNode, closedByPullRequestsReferences: null },
        { ...issueNode, labels: { nodes: 'no' } },
        { ...issueNode, labels: { nodes: [{ name: 7 }] } },
        { ...issueNode, milestone: { title: 'no number' } },
        { ...issueNode, milestone: { number: 4 } },
        { ...issueNode, milestone: 'not a record' },
        issueNode,
      ]),
    ])

    const result = await gh.listIssues()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('10 issues row(s) could not be read')
  })

  it('refuses an issue whose dependency list came back at the page ceiling', async () => {
    // A `blockedBy` of exactly 100 is either a complete list or the first page
    // of a longer one, and the query asks for no page signal to tell them
    // apart. Read as complete, an issue whose only OPEN blocker sat past the
    // ceiling would report as unblocked. `labels` and the closing pull
    // requests at the ceiling have nothing concluded from their length, so
    // each is still a readable row.
    const full = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ number: index + 1, state: 'CLOSED' }))
    const { gh } = clientAnsweringEach([
      REPO,
      page('issues', [
        { ...issueNode, blockedBy: { nodes: full(100) } },
        { ...issueNode, blocking: { nodes: full(100) } },
        { ...issueNode, blockedBy: { nodes: full(99) } },
        { ...issueNode, labels: { nodes: full(100).map(() => ({ name: 'enhancement' })) } },
        { ...issueNode, closedByPullRequestsReferences: { nodes: full(100) } },
      ]),
    ])

    const result = await gh.listIssues()

    expect(result.rows).toHaveLength(3)
    expect(result.unavailable).toBe('2 issues row(s) could not be read')
  })

  it('refuses a whole blocker list when one entry of it cannot be read', async () => {
    // A blocker list with one entry quietly dropped is a blocked issue
    // reported as unblocked, which is the one mistake a sweep must not make.
    const { gh } = clientAnsweringEach([
      REPO,
      page('issues', [
        { ...issueNode, blockedBy: { nodes: [{ number: 127, state: 'CLOSED' }, { number: 129 }] } },
        { ...issueNode, blocking: { nodes: [{ state: 'OPEN' }] } },
      ]),
    ])

    const result = await gh.listIssues()

    expect(result.rows).toEqual([])
    expect(result.unavailable).toBe('2 issues row(s) could not be read')
  })

  it('counts a pull request row that is not the shape the query asked for, one field at a time', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      page('pullRequests', [
        { ...pullNode, number: null },
        { ...pullNode, title: null },
        { ...pullNode, headRefName: null },
        { ...pullNode, baseRefName: null },
        { ...pullNode, isDraft: 'yes' },
        pullNode,
      ]),
    ])

    const result = await gh.listOpenPullRequests()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('5 pullRequests row(s) could not be read')
  })

  it('asks for every open pull request as a link, with the fork flag and no checks', async () => {
    const linkNode = {
      number: 177,
      headRefName: 'wktr-171-audit-split',
      baseRefName: 'main',
      isCrossRepository: true,
    }
    const { gh, calls } = clientAnsweringEach([REPO, page('pullRequests', [linkNode])])

    const result = await gh.listOpenPullRequestLinks()

    expect(calls[1]?.args[7]).toContain(
      'nodes { number headRefName baseRefName isCrossRepository }',
    )
    expect(calls[1]?.args[7]).not.toContain('statusCheckRollup')
    expect(result).toEqual({
      rows: [{ number: 177, head: 'wktr-171-audit-split', base: 'main', crossRepository: true }],
      unavailable: null,
    })
  })

  it('counts a link row that is not the shape the query asked for, one field at a time', async () => {
    const linkNode = {
      number: 177,
      headRefName: 'wktr-171-audit-split',
      baseRefName: 'main',
      isCrossRepository: false,
    }
    const { gh } = clientAnsweringEach([
      REPO,
      page('pullRequests', [
        { ...linkNode, number: null },
        { ...linkNode, headRefName: null },
        { ...linkNode, baseRefName: null },
        { ...linkNode, isCrossRepository: 'no' },
        linkNode,
      ]),
    ])

    const result = await gh.listOpenPullRequestLinks()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('4 pullRequests row(s) could not be read')
  })

  it('reports an answer that is not JSON, without throwing', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { status: 1, stdout: 'gateway timeout', stderr: 'gh: HTTP 504\n' },
    ])

    await expect(gh.listMilestones()).resolves.toEqual({
      rows: [],
      unavailable: 'gh: HTTP 504',
    })
  })

  // The bound outranks a page's own body, even a whole, valid one (ruling
  // 4, #295). `lib/process.ts`'s `close` event fires only once a killed
  // child's stdio has closed, so a page written just before a late kill can
  // still parse. A mutation that drops this check would answer with the
  // parsed page instead, so the `unavailable` field below would read
  // `undefined` or the page's own reason, never the timeout.
  it('reports a page that timed out as itself, before it tries to parse the page', async () => {
    const { gh } = clientAnsweringEach(
      [REPO, { timedOut: true, status: null, signal: 'SIGKILL', ...page('milestones', []) }],
      { boundMs: 5_000 },
    )

    await expect(gh.listMilestones()).resolves.toEqual({
      rows: [],
      unavailable: 'gh did not answer in 5000 ms',
    })
  })

  it('reports a reply with no connection where the query put one', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { status: 1, stdout: '{"data":{"repository":null}}', stderr: 'gh: Not Found\n' },
    ])

    await expect(gh.listIssues()).resolves.toEqual({ rows: [], unavailable: 'gh: Not Found' })
  })

  it('reports a connection whose nodes are not a list', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { stdout: '{"data":{"repository":{"pullRequests":{"nodes":null}}}}' },
    ])

    await expect(gh.listOpenPullRequests()).resolves.toEqual({
      rows: [],
      unavailable: 'gh exited 0',
    })
  })

  it('keeps the rows of a page that also carried an error, and reports the error', async () => {
    // `gh api graphql` exits 1 on a partial body that is still an answer,
    // which is why the body is read through `invoke` and not `succeeded`.
    const { gh } = clientAnsweringEach([
      REPO,
      {
        status: 1,
        ...page('milestones', [milestoneNode], {}, [
          { message: 'Something went wrong while executing your query.' },
          { notAMessage: true },
        ]),
      },
    ])

    const result = await gh.listMilestones()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('Something went wrong while executing your query.')
  })

  it('reports a repository it could not resolve at all, and asks nothing else', async () => {
    const { gh, calls } = clientAnsweringEach([
      { status: 1, stderr: 'gh: could not resolve to a Repository\n' },
    ])

    await expect(gh.listIssues({ milestone: '4' })).resolves.toEqual({
      rows: [],
      unavailable: 'gh: could not resolve to a Repository',
    })
    expect(calls).toHaveLength(1)
  })
})

// --- the plan comments (#376) -----------------------------------------------
//
// A search, not a repository connection: `$q` carries the repository, so
// the argv has no owner or name, and the connection is `data.search`.
describe('the issues that carry a plan comment', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }

  /** One search page as gh prints it. */
  const searchPage = (
    nodes: readonly unknown[],
    info: { hasNextPage?: boolean; endCursor?: string | null } = {},
  ): Reply => ({
    stdout: JSON.stringify({
      data: {
        search: {
          pageInfo: { hasNextPage: info.hasNextPage ?? false, endCursor: info.endCursor ?? null },
          nodes,
        },
      },
    }),
  })

  const planNode = {
    number: 12,
    state: 'OPEN',
    milestone: { number: 4 },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        { createdAt: '2026-10-01T10:00:00Z', body: 'Sweep for milestone 4.\n\nDetails.' },
        {
          createdAt: '2026-10-02T10:00:00Z',
          body: '  Round 3 plan, approved 2026-10-02.  \nLayers.',
        },
      ],
    },
  }

  it('searches the repository for the plan phrase, with no owner or name variable', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, searchPage([planNode])])

    const result = await gh.searchPlanIssues()

    expect(calls[1]?.args.slice(0, 4)).toEqual([
      'api',
      'graphql',
      '-f',
      'q=repo:acme/widgets is:issue is:open "plan, approved" in:comments sort:updated-desc',
    ])
    expect(calls[1]?.args.some((word) => word.startsWith('owner='))).toBe(false)
    expect(calls[1]?.args[5]).toContain('search(query: $q, type: ISSUE')
    expect(calls[1]?.args[5]).toContain('comments(last:')
    expect(result).toEqual({
      rows: [
        {
          number: 12,
          state: 'OPEN',
          milestone: 4,
          comments: [
            { createdAt: '2026-10-01T10:00:00Z', firstLine: 'Sweep for milestone 4.' },
            { createdAt: '2026-10-02T10:00:00Z', firstLine: 'Round 3 plan, approved 2026-10-02.' },
          ],
          truncated: false,
        },
      ],
      unavailable: null,
    })
  })

  it('follows the search cursor to a second page', async () => {
    const { gh, calls } = clientAnsweringEach([
      REPO,
      searchPage([planNode], { hasNextPage: true, endCursor: 'c1' }),
      searchPage([{ ...planNode, number: 13 }]),
    ])

    const result = await gh.searchPlanIssues()

    expect(calls[2]?.args).toContain('cursor=c1')
    expect(result.rows.map((row) => row.number)).toEqual([12, 13])
  })

  it('reads an issue on no milestone, and one with more comments than were read', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      searchPage([
        {
          ...planNode,
          state: 'CLOSED',
          milestone: null,
          comments: { ...planNode.comments, pageInfo: { hasPreviousPage: true } },
        },
      ]),
    ])

    const result = await gh.searchPlanIssues()

    expect(result.rows[0]).toMatchObject({ state: 'CLOSED', milestone: null, truncated: true })
  })

  it('counts each row that is not the shape asked for, and keeps the rest', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      searchPage([
        planNode,
        // A pull request: the `... on Issue` fragment gives it no fields.
        {},
        { ...planNode, number: 20, state: 'DRAFT' },
        { ...planNode, number: 21, milestone: { number: 'four' } },
        { ...planNode, number: 22, milestone: undefined },
        { ...planNode, number: 23, comments: null },
        { ...planNode, number: 24, comments: { nodes: [{ createdAt: 1, body: 'x' }] } },
        { ...planNode, number: 25, comments: { nodes: [{ createdAt: 'now' }] } },
      ]),
    ])

    const result = await gh.searchPlanIssues()

    expect(result.rows.map((row) => row.number)).toEqual([12])
    expect(result.unavailable).toBe('7 planIssues row(s) could not be read')
  })

  it('reads an empty comment body as an empty first line', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      searchPage([
        { ...planNode, comments: { nodes: [{ createdAt: '2026-10-02T10:00:00Z', body: '' }] } },
      ]),
    ])

    const result = await gh.searchPlanIssues()

    expect(result.rows[0]?.comments).toEqual([{ createdAt: '2026-10-02T10:00:00Z', firstLine: '' }])
    expect(result.rows[0]?.truncated).toBe(false)
  })

  /** A direct read's reply: one alias per issue, in the order asked. */
  const directReply = (nodes: readonly unknown[], errors?: readonly unknown[]): Reply => ({
    stdout: JSON.stringify({
      data: {
        repository: Object.fromEntries(nodes.map((node, index) => [`i${index}`, node])),
      },
      ...(errors === undefined ? {} : { errors }),
    }),
  })

  it('reads named issues directly, one alias per number, with owner and name', async () => {
    const { gh, calls } = clientAnsweringEach([
      REPO,
      directReply([planNode, { ...planNode, number: 13, state: 'CLOSED' }]),
    ])

    const result = await gh.readPlanIssues([12, 13])

    expect(calls[1]?.args.slice(0, 6)).toEqual([
      'api',
      'graphql',
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
    ])
    expect(calls[1]?.args[7]).toContain('i0: issue(number: 12)')
    expect(calls[1]?.args[7]).toContain('i1: issue(number: 13)')
    expect(result.rows.map((row) => [row.number, row.state])).toEqual([
      [12, 'OPEN'],
      [13, 'CLOSED'],
    ])
    expect(result.unavailable).toBeNull()
  })

  it('names a number that is not an issue, with the reply’s own error', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      directReply(
        [planNode, null],
        [
          {
            type: 'NOT_FOUND',
            path: ['repository', 'i1'],
            message: 'Could not resolve to an Issue',
          },
        ],
      ),
    ])

    const result = await gh.readPlanIssues([12, 99])

    expect(result.rows.map((row) => row.number)).toEqual([12])
    expect(result.unavailable).toBe(
      'Could not resolve to an Issue; #99 could not be read as an issue',
    )
  })

  it('reads more numbers than one query holds in batches, and keeps a batch that answered', async () => {
    const numbers = Array.from({ length: 26 }, (_, index) => index + 1)
    const { gh, calls } = clientAnsweringEach([
      REPO,
      directReply(numbers.slice(0, 25).map((number) => ({ ...planNode, number }))),
      // Each batch resolves the repository again, the way `queryOnce` does.
      REPO,
      { stdout: 'not json', status: 1, stderr: 'gh: timeout' },
    ])

    const result = await gh.readPlanIssues(numbers)

    expect(calls[3]?.args[7]).toContain('i0: issue(number: 26)')
    expect(result.rows).toHaveLength(25)
    expect(result.unavailable).toContain('timeout')
  })

  it('names each number that is not a positive whole number, and reads only the rest', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, directReply([planNode])])

    const result = await gh.readPlanIssues([0, 1.5, Number.NaN, 12])

    expect(calls[1]?.args[7]).toContain('i0: issue(number: 12)')
    expect(calls[1]?.args[7]).not.toContain('i1:')
    expect(result.rows.map((row) => row.number)).toEqual([12])
    expect(result.unavailable).toBe(
      '0 is not an issue number; 1.5 is not an issue number; NaN is not an issue number',
    )
  })

  it('reads nothing for an empty list', async () => {
    // No reply is registered, so any read would come back short.
    const { gh } = clientAnsweringEach([])

    expect(await gh.readPlanIssues([])).toEqual({ rows: [], unavailable: null })
  })

  it('reads a reply with no search connection as no answer', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { stdout: JSON.stringify({ data: { repository: {} } }), status: 1, stderr: 'gh: bad query' },
    ])

    const result = await gh.searchPlanIssues()

    expect(result.rows).toEqual([])
    expect(result.unavailable).toContain('bad query')
  })
})

describe('the review loop reads', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }

  /** A `pullRequest` node as the detail query answers it. `overrides`
   *  replaces whichever fields a case is about. */
  const prNode = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    number: 178,
    title: 'feat(workstreams): sweep command and skill (primitive 1)',
    state: 'OPEN',
    isDraft: true,
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: 'wktr-130-ws-sweep',
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: '9b13a20',
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [{ name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS' }],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  })

  /** The detail query's reply, with `node` as the pull request. */
  const prReply = (node: unknown, errors?: readonly unknown[]): Reply => ({
    stdout: JSON.stringify({
      data: { repository: { pullRequest: node } },
      ...(errors === undefined ? {} : { errors }),
    }),
  })

  const runRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1000,
    workflow_id: 10,
    created_at: '2026-09-22T06:31:10Z',
    name: 'CI',
    event: 'pull_request',
    head_sha: '9b13a20',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-09-22T06:31:17Z',
    updated_at: '2026-09-22T06:33:14Z',
    ...overrides,
  })

  describe('requiredContexts', () => {
    it('asks the branch rules endpoint and unions every required-status-checks rule', async () => {
      const { gh, calls } = clientAnsweringEach([
        REPO,
        {
          stdout: JSON.stringify([
            { type: 'pull_request' },
            {
              type: 'required_status_checks',
              parameters: {
                required_status_checks: [{ context: 'vitest' }, { context: 'types' }],
              },
            },
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'types' }, { context: 'biome' }] },
            },
          ]),
        },
      ])

      const result = await gh.requiredContexts({ branch: 'main' })

      expect(calls[1]?.args).toEqual(['api', 'repos/acme/widgets/rules/branches/main'])
      // Unioned and deduplicated, in the order the rules name them: two
      // rulesets that name the same context require it once.
      expect(result).toEqual({ contexts: ['vitest', 'types', 'biome'], unavailable: null })
    })

    it('percent-encodes a branch name with a slash into the path', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '[]' }])

      await gh.requiredContexts({ branch: 'spike/context-audit' })

      expect(calls[1]?.args[1]).toBe('repos/acme/widgets/rules/branches/spike%2Fcontext-audit')
    })

    it('answers an empty list for a branch no ruleset covers, which is an answer', async () => {
      // The live case this exists for: a stacked pull request based on a
      // topic branch is required to pass nothing, while the same head based
      // on the default branch is required to pass nine contexts.
      const { gh } = clientAnsweringEach([REPO, { stdout: '[]' }])

      await expect(gh.requiredContexts({ branch: 'wktr-130-ws-sweep' })).resolves.toEqual({
        contexts: [],
        unavailable: null,
      })
    })

    it('reports gh’s own words when the rules could not be read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' },
      ])

      await expect(gh.requiredContexts({ branch: 'gone' })).resolves.toEqual({
        contexts: [],
        unavailable: 'gh: Not Found (HTTP 404)',
      })
    })

    const PLAN_LIMIT =
      'Upgrade to GitHub Pro or make this repository public to enable this feature.'

    // The body gh prints to stdout for a refusal, with a non-zero exit. A
    // real 404 was read from gh on 2026-10-13 and has this shape; the
    // 403 body is the message #414 records.
    const refusal = (body: unknown) => ({
      status: 1,
      stdout: JSON.stringify(body),
      stderr: 'gh: refused\n',
    })

    it('reads the plan-limit 403 as a branch with no rulesets, which is an answer', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        refusal({
          message: PLAN_LIMIT,
          documentation_url: 'https://docs.github.com',
          status: '403',
        }),
      ])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: null,
      })
    })

    it('keeps the plan-limit message unavailable when the body has no status', async () => {
      const { gh } = clientAnsweringEach([REPO, refusal({ message: PLAN_LIMIT })])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: `the rules for main were not a list of rules (${PLAN_LIMIT})`,
      })
    })

    it('reads a numeric 403 status with the plan-limit message the same way', async () => {
      const { gh } = clientAnsweringEach([REPO, refusal({ message: PLAN_LIMIT, status: 403 })])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: null,
      })
    })

    it('keeps any other 403 unavailable, and names its status and message', async () => {
      // A missing token scope or a rate limit is not a plan limit. To read
      // it as "no rulesets" would report green a pull request that a
      // ruleset refuses.
      const { gh } = clientAnsweringEach([
        REPO,
        refusal({ message: 'Resource not accessible by personal access token', status: '403' }),
      ])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable:
          'the rules for main were not a list of rules (403: Resource not accessible by personal access token)',
      })
    })

    it('keeps the plan-limit message unavailable under a status other than 403', async () => {
      const { gh } = clientAnsweringEach([REPO, refusal({ message: PLAN_LIMIT, status: '404' })])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: `the rules for main were not a list of rules (404: ${PLAN_LIMIT})`,
      })
    })

    it('keeps a 404 unavailable, and names its status and message', async () => {
      const { gh } = clientAnsweringEach([REPO, refusal({ message: 'Not Found', status: '404' })])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: 'the rules for main were not a list of rules (404: Not Found)',
      })
    })

    it('names a numeric status with its message', async () => {
      const { gh } = clientAnsweringEach([REPO, refusal({ message: 'Not Found', status: 404 })])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: 'the rules for main were not a list of rules (404: Not Found)',
      })
    })

    for (const [what, body] of [
      ['no message', { status: '403' }],
      ['a message that is not a string', { status: '403', message: 5 }],
    ] as const) {
      it(`keeps a 403 with ${what} unavailable, and does not throw`, async () => {
        const { gh } = clientAnsweringEach([REPO, refusal(body)])

        await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
          contexts: [],
          unavailable: 'the rules for main were not a list of rules',
        })
      })
    }

    it('names a message that has no status', async () => {
      const { gh } = clientAnsweringEach([REPO, { stdout: '{"message":"Not Found"}' }])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: 'the rules for main were not a list of rules (Not Found)',
      })
    })

    for (const [what, stdout] of [
      ['an object with no message', '{"rules":[]}'],
      ['a bare string', '"nope"'],
      ['null', 'null'],
    ] as const) {
      it(`keeps ${what} unavailable, with no status or message to name`, async () => {
        const { gh } = clientAnsweringEach([REPO, { stdout }])

        await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
          contexts: [],
          unavailable: 'the rules for main were not a list of rules',
        })
      })
    }

    for (const [what, rule] of [
      ['whose check list is not a list', { required_status_checks: 'vitest' }],
      ['whose check names a context that is not a string', { required_status_checks: [{}] }],
    ] as const) {
      it(`refuses the whole read for a rule ${what}, never a short list`, async () => {
        // A required context silently dropped is a pull request reported
        // green that the ruleset would refuse.
        const { gh } = clientAnsweringEach([
          REPO,
          {
            stdout: JSON.stringify([
              {
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'vitest' }] },
              },
              { type: 'required_status_checks', parameters: rule },
            ]),
          },
        ])

        await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
          contexts: [],
          unavailable: 'a required-status-checks rule on main could not be read',
        })
      })
    }

    it('reports a repository it could not resolve, and asks nothing else', async () => {
      const { gh, calls } = clientAnsweringEach([
        { status: 1, stderr: 'gh: could not resolve to a Repository\n' },
      ])

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: 'gh: could not resolve to a Repository',
      })
      expect(calls).toHaveLength(1)
    })

    // The bound outranks the body, even a whole, valid one (ruling 4,
    // #295), the same way the paginated reads guard their own pages. A
    // mutation that drops this check would parse `[]` as a genuine "no
    // rules" answer instead of a timeout.
    it('reports a REST read that timed out as itself, before it tries to parse the body', async () => {
      const { gh } = clientAnsweringEach(
        [REPO, { timedOut: true, status: null, signal: 'SIGKILL', stdout: '[]' }],
        { boundMs: 5_000 },
      )

      await expect(gh.requiredContexts({ branch: 'main' })).resolves.toEqual({
        contexts: [],
        unavailable: 'gh did not answer in 5000 ms',
      })
    })
  })

  describe('requiredReviews', () => {
    /** A `pull_request` rule as the endpoint answers it. The other keys are
     *  from a real read of this repository's `main` on 2026-10-19. */
    const pullRule = (
      approvals: unknown,
      codeOwner: unknown,
      threads: unknown = false,
      lastPush: unknown = false,
    ) => ({
      type: 'pull_request',
      parameters: {
        required_approving_review_count: approvals,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: codeOwner,
        require_last_push_approval: lastPush,
        required_review_thread_resolution: threads,
      },
      ruleset_source_type: 'Enterprise',
      ruleset_source: 'bje',
      ruleset_id: 21295778,
    })

    it('asks the branch rules endpoint, with the branch percent-encoded', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '[]' }])

      await gh.requiredReviews({ branch: 'spike/context-audit' })

      expect(calls[1]?.args).toEqual([
        'api',
        'repos/acme/widgets/rules/branches/spike%2Fcontext-audit',
      ])
    })

    it('reads the enterprise rule that requires no approval, as this repository answers it', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        {
          stdout: JSON.stringify([
            { type: 'deletion', ruleset_source_type: 'Enterprise' },
            pullRule(0, false),
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'vitest' }] },
            },
          ]),
        },
      ])

      await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
        reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
        unavailable: null,
      })
    })

    it('takes the highest count and any flag that is true across two rules', async () => {
      // GitHub enforces every ruleset that applies, so the strictest wins.
      const { gh } = clientAnsweringEach([
        REPO,
        {
          stdout: JSON.stringify([pullRule(2, false, true, false), pullRule(1, true, false, true)]),
        },
      ])

      await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
        reviews: { approvals: 2, codeOwner: true, threadResolution: true, lastPush: true },
        unavailable: null,
      })
    })

    it('answers no requirement for rules with no pull_request entry, which is an answer', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { stdout: JSON.stringify([{ type: 'deletion' }, { type: 'non_fast_forward' }]) },
      ])

      await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
        reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
        unavailable: null,
      })
    })

    it('reads the plan-limit 403 as no rule, as requiredContexts does', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: JSON.stringify({
            message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
            status: '403',
          }),
          stderr: 'gh: refused\n',
        },
      ])

      await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
        reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
        unavailable: null,
      })
    })

    it('keeps an answer that is not a list unavailable, with its status and message', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: refused\n' },
      ])

      await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
        reviews: null,
        unavailable: 'the rules for main were not a list of rules (404: Not Found)',
      })
    })

    it('reports gh’s own words when the rules could not be read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' },
      ])

      await expect(gh.requiredReviews({ branch: 'gone' })).resolves.toEqual({
        reviews: null,
        unavailable: 'gh: Not Found (HTTP 404)',
      })
    })

    for (const [what, rule] of [
      ['a count that is not an integer', pullRule('1', false)],
      ['a code owner flag that is not a boolean', pullRule(1, 'true')],
      ['a thread flag that is not a boolean', pullRule(1, false, null)],
      ['a last-push flag that is not a boolean', pullRule(1, false, false, 1)],
      ['no parameters', { type: 'pull_request' }],
    ] as const) {
      it(`refuses the whole read for a rule with ${what}, never a lower count`, async () => {
        // A requirement dropped in silence is a pull request the shepherd
        // works on while the rules refuse it.
        const { gh } = clientAnsweringEach([
          REPO,
          { stdout: JSON.stringify([pullRule(2, true), rule]) },
        ])

        await expect(gh.requiredReviews({ branch: 'main' })).resolves.toEqual({
          reviews: null,
          unavailable: 'a pull-request rule on main could not be read',
        })
      })
    }
  })

  describe('viewPullRequestDetail', () => {
    it('asks for the pull request with its number as an Int variable', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, prReply(prNode())])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(calls[1]?.args.slice(0, 8)).toEqual([
        'api',
        'graphql',
        '-f',
        'owner=acme',
        '-f',
        'name=widgets',
        // `-F` and not `-f`: the query declares `$number: Int!` and gh sends
        // an `-f` value as a string, which GraphQL refuses.
        '-F',
        'number=178',
      ])
      expect(calls[1]?.args[9]).toContain('$number: Int!')
      expect(calls[1]?.args[9]).toContain('commits(last: 1)')
      // The query must ask for `__typename` on a thread's first comment's
      // author. This tells a bot-opened thread from a person's thread.
      // Assert the exact selection, not a bare `__typename` substring. The
      // same query also asks for `__typename` on a check context, for an
      // unrelated reason. A bare `toContain` would still pass with the
      // field gone from the thread's own selection.
      expect(calls[1]?.args[9]).toContain(
        'comments(first: 1) { nodes { author { __typename login } } } }',
      )
      expect(result.unavailable).toBeNull()
      expect(result.pullRequest).toEqual({
        number: 178,
        title: 'feat(workstreams): sweep command and skill (primitive 1)',
        state: 'OPEN',
        draft: true,
        base: 'main',
        head: 'wktr-130-ws-sweep',
        headSha: '9b13a20',
        mergeable: 'MERGEABLE',
        checks: [{ name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null }],
        unresolvedThreads: [],
        commentAuthors: [],
      })
    })

    it('counts only the unresolved review threads, and keeps every comment', async () => {
      // The distinction the loop turns on: the enterprise coverage bot posts
      // a COMMENT on every pull request here, and a loop that counted it as
      // an unresolved review thread would never reach done.
      const { gh } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { isResolved: true, comments: { nodes: [{ author: { login: 'settled' } }] } },
                { isResolved: false, comments: { nodes: [{ author: { login: 'waiting' } }] } },
                // An author GitHub no longer names, and a thread whose
                // comments could not be read: both are one unresolved thread
                // with an author nobody can be told.
                { isResolved: false, comments: { nodes: [{ author: null }] } },
                { isResolved: false, comments: null },
              ],
            },
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [{ author: { login: 'github-code-quality' } }, { author: null }],
            },
          }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      // None of these three is a bot: a person, and two threads whose author
      // GitHub no longer names. An unknown author is read as a person, the
      // safe side, never as a bot.
      expect(result.pullRequest?.unresolvedThreads).toEqual([
        { author: 'waiting', bot: false },
        { author: 'unknown', bot: false },
        { author: 'unknown', bot: false },
      ])
      expect(result.pullRequest?.commentAuthors).toEqual(['github-code-quality', 'unknown'])
    })

    it('names a thread a bot opened, by its first comment’s author `__typename`', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  isResolved: false,
                  comments: {
                    nodes: [{ author: { __typename: 'Bot', login: 'github-actions' } }],
                  },
                },
                {
                  isResolved: false,
                  comments: { nodes: [{ author: { __typename: 'User', login: 'reviewer-a' } }] },
                },
                // A `__typename` gh does not answer at all: read as a
                // person, never silently promoted to a bot.
                {
                  isResolved: false,
                  comments: { nodes: [{ author: { login: 'reviewer-b' } }] },
                },
              ],
            },
          }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.pullRequest?.unresolvedThreads).toEqual([
        { author: 'github-actions', bot: true },
        { author: 'reviewer-a', bot: false },
        { author: 'reviewer-b', bot: false },
      ])
    })

    it('reads a commit status, which has no status of its own, beside a check run', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({
            commits: {
              nodes: [
                {
                  commit: {
                    oid: '9b13a20',
                    statusCheckRollup: {
                      contexts: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          { context: 'vercel/preview', state: 'PENDING' },
                          { name: 'types', status: 'IN_PROGRESS', conclusion: null },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.pullRequest?.checks).toEqual([
        // PENDING is the status that says the check has not concluded, so
        // it is carried as no conclusion, exactly as a check run still in
        // progress is. A reader that matches the conclusion against the set
        // that satisfies a required check would otherwise call a preview
        // still in progress a failure.
        { name: 'vercel/preview', status: null, conclusion: null, startedAt: null },
        { name: 'types', status: 'IN_PROGRESS', conclusion: null, startedAt: null },
      ])
    })

    for (const [state, conclusion] of [
      ['PENDING', null],
      ['EXPECTED', null],
      ['SUCCESS', 'SUCCESS'],
      ['FAILURE', 'FAILURE'],
      ['ERROR', 'ERROR'],
    ] as const) {
      it(`reads a commit status of ${state} as conclusion ${conclusion}`, async () => {
        // The five members of GitHub's StatusState, read by introspection.
        const { gh } = clientAnsweringEach([
          REPO,
          prReply(
            prNode({
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: '9b13a20',
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false },
                          nodes: [{ context: 'vercel/preview', state }],
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ),
        ])

        const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

        expect(result.pullRequest?.checks).toEqual([
          { name: 'vercel/preview', status: null, conclusion, startedAt: null },
        ])
      })
    }

    it('reads the workflow run behind a check run through its check suite (#364)', async () => {
      const suite = (workflowRun: unknown) => ({ conclusion: 'CANCELLED', workflowRun })
      const { gh, calls } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({
            commits: {
              nodes: [
                {
                  commit: {
                    oid: '9b13a20',
                    statusCheckRollup: {
                      contexts: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          {
                            name: 'vitest',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({
                              databaseId: 36975271473,
                              createdAt: '2026-10-01T00:00:00Z',
                              workflow: { databaseId: 350526662, name: 'CI' },
                            }),
                          },
                          // A check run that no workflow made: GitHub
                          // answers a suite with a null `workflowRun`.
                          {
                            name: 'CodeQL',
                            status: 'COMPLETED',
                            conclusion: 'SUCCESS',
                            checkSuite: { conclusion: 'SUCCESS', workflowRun: null },
                          },
                          // A run that lacks a field is read as no run.
                          {
                            name: 'types',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({ databaseId: 1, createdAt: '2026-10-01T00:00:00Z' }),
                          },
                          {
                            name: 'biome',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({
                              createdAt: '2026-10-01T00:00:00Z',
                              workflow: { databaseId: 350526662, name: 'CI' },
                            }),
                          },
                          {
                            name: 'lint',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({
                              databaseId: 1,
                              workflow: { databaseId: 350526662, name: 'CI' },
                            }),
                          },
                          {
                            name: 'ab',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({
                              databaseId: 1,
                              createdAt: '2026-10-01T00:00:00Z',
                              workflow: { name: 'CI' },
                            }),
                          },
                          {
                            name: 'fan-in',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            checkSuite: suite({
                              databaseId: 1,
                              createdAt: '2026-10-01T00:00:00Z',
                              workflow: { databaseId: 350526662 },
                            }),
                          },
                          { context: 'vercel/preview', state: 'SUCCESS' },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(calls[1]?.args.join(' ')).toContain(
        'checkSuite { conclusion workflowRun { databaseId createdAt workflow { databaseId name } } }',
      )
      expect(result.pullRequest?.checks).toStrictEqual([
        {
          name: 'vitest',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          startedAt: null,
          run: {
            id: 36975271473,
            workflowId: 350526662,
            workflow: 'CI',
            createdAt: '2026-10-01T00:00:00Z',
            conclusion: 'CANCELLED',
          },
        },
        { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
        { name: 'types', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
        { name: 'biome', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
        { name: 'ab', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
        { name: 'fan-in', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
        { name: 'vercel/preview', status: null, conclusion: 'SUCCESS', startedAt: null },
      ])
    })

    it('reads a head nothing has reported on as no checks, not as a failed read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({ commits: { nodes: [{ commit: { oid: 'abc1234', statusCheckRollup: null } }] } }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.pullRequest?.checks).toEqual([])
      expect(result.unavailable).toBeNull()
    })

    for (const [what, field, value] of [
      ['threads', 'reviewThreads', { pageInfo: { hasNextPage: true }, nodes: [] }],
      ['comments', 'comments', { pageInfo: { hasNextPage: true }, nodes: [] }],
    ] as const) {
      it(`says so when there are more ${what} than one page`, async () => {
        const { gh } = clientAnsweringEach([REPO, prReply(prNode({ [field]: value }))])

        const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

        expect(result.pullRequest).not.toBeNull()
        expect(result.unavailable).toContain('may be short')
      })
    }

    it('says so when the head reported more checks than one page', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        prReply(
          prNode({
            commits: {
              nodes: [
                {
                  commit: {
                    oid: '9b13a20',
                    statusCheckRollup: {
                      contexts: { pageInfo: { hasNextPage: true }, nodes: [] },
                    },
                  },
                },
              ],
            },
          }),
        ),
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.unavailable).toBe(
        'pull request 178 reported more checks than the 100 this reads',
      )
    })

    for (const [what, overrides] of [
      ['a number that is not one', { number: '178' }],
      ['no title', { title: null }],
      ['a state this does not recognise', { state: 'DRAFTED' }],
      ['a draft flag that is not a boolean', { isDraft: 'yes' }],
      ['no mergeability', { mergeable: null }],
      ['no base ref', { baseRefName: null }],
      ['no head ref', { headRefName: null }],
      ['no commits connection', { commits: null }],
      ['a head commit with no oid', { commits: { nodes: [{ commit: {} }] } }],
      [
        'a rollup whose contexts are not a connection',
        {
          commits: {
            nodes: [{ commit: { oid: 'abc1234', statusCheckRollup: { contexts: null } } }],
          },
        },
      ],
      [
        'a reported check that is neither kind',
        {
          commits: {
            nodes: [
              {
                commit: {
                  oid: 'abc1234',
                  statusCheckRollup: {
                    contexts: { pageInfo: { hasNextPage: false }, nodes: [{ id: 1 }] },
                  },
                },
              },
            ],
          },
        },
      ],
      ['review threads that are not a connection', { reviewThreads: {} }],
      [
        'a review thread with no resolution',
        { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{}] } },
      ],
      ['comments that are not a connection', { comments: [] }],
    ] as const) {
      it(`refuses a pull request with ${what}`, async () => {
        const { gh } = clientAnsweringEach([REPO, prReply(prNode(overrides))])

        await expect(gh.viewPullRequestDetail({ pullRequest: 178 })).resolves.toEqual({
          pullRequest: null,
          unavailable: 'pull request 178 could not be read',
          missing: false,
        })
      })
    }

    it('leads with what GraphQL said about a pull request it did not carry', async () => {
      // "No such pull request" and "this token may not see it" arrive as the
      // same missing node, and only the error tells them apart. Neither
      // carries a NOT_FOUND type here. So missing stays false.
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: prReply(null, [{ message: 'Could not resolve to a PullRequest' }]).stdout,
        },
      ])

      await expect(gh.viewPullRequestDetail({ pullRequest: 999 })).resolves.toEqual({
        pullRequest: null,
        unavailable: 'pull request 999 could not be read: Could not resolve to a PullRequest',
        missing: false,
      })
    })

    // The bound outranks the body, even a whole, valid one (ruling 4,
    // #295). A mutation that drops this check would read the node as a
    // genuine reply instead of a timeout.
    it('reports a detail read that timed out as itself, before it tries to parse the body', async () => {
      const { gh } = clientAnsweringEach(
        [REPO, { timedOut: true, status: null, signal: 'SIGKILL', ...prReply(prNode()) }],
        { boundMs: 5_000 },
      )

      await expect(gh.viewPullRequestDetail({ pullRequest: 178 })).resolves.toEqual({
        pullRequest: null,
        unavailable: 'gh did not answer in 5000 ms',
        missing: false,
      })
    })

    it('marks a pull request missing when GraphQL names it NOT_FOUND', async () => {
      // Verified live against this repository. `gh api graphql` for pull
      // request 99999 answers a null node with a NOT_FOUND error. gh
      // then exits 1.
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: prReply(null, [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'pullRequest'],
              message: 'Could not resolve to a PullRequest with the number of 99999.',
            },
          ]).stdout,
        },
      ])

      await expect(gh.viewPullRequestDetail({ pullRequest: 99999 })).resolves.toEqual({
        pullRequest: null,
        unavailable:
          'pull request 99999 could not be read: Could not resolve to a PullRequest with the number of 99999.',
        missing: true,
      })
    })

    it('leaves missing false for an error of another type, such as FORBIDDEN', async () => {
      // A permissions error or a rate limit is not a report that the number
      // does not exist.
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: prReply(null, [
            { type: 'FORBIDDEN', path: ['repository', 'pullRequest'], message: 'gone' },
          ]).stdout,
        },
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.missing).toBe(false)
    })

    it('leaves missing false for a null node with an empty errors list', async () => {
      const { gh } = clientAnsweringEach([REPO, prReply(null, [])])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.missing).toBe(false)
    })

    it('leaves missing false for a null node with no errors field at all', async () => {
      const { gh } = clientAnsweringEach([REPO, prReply(null)])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.missing).toBe(false)
    })

    it.each([
      ['no path at all', { type: 'NOT_FOUND', message: 'gone' }],
      [
        'a path that is not an array',
        { type: 'NOT_FOUND', path: 'repository.pullRequest', message: 'gone' },
      ],
      ['an empty path', { type: 'NOT_FOUND', path: [], message: 'gone' }],
      [
        'a path whose last entry is not a string',
        { type: 'NOT_FOUND', path: ['repository', 0], message: 'gone' },
      ],
    ])(
      // `notFoundAlias` (above) proves the same four shapes leave an alias
      // unnamed. This proves `queryOnce`'s own check, a separate piece of
      // code for a single, plain field name, reads each shape the same way.
      'leaves missing false for a NOT_FOUND error with %s',
      async (_case, error) => {
        const { gh } = clientAnsweringEach([REPO, prReply(null, [error])])

        const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

        expect(result.missing).toBe(false)
      },
    )

    it('marks missing true for a NOT_FOUND on the pull request, read past an unrelated error', async () => {
      // Two errors, and the NOT_FOUND for the pull request itself is
      // second. A check that read only the first entry would miss it.
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: prReply(null, [
            { type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'comments'], message: 'no' },
            {
              type: 'NOT_FOUND',
              path: ['repository', 'pullRequest'],
              message: 'Could not resolve to a PullRequest with the number of 99999.',
            },
          ]).stdout,
        },
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 99999 })

      expect(result.missing).toBe(true)
    })

    it('leaves missing false for a NOT_FOUND on a field nested under the pull request', async () => {
      // The pull request node itself came back. A nested field under it
      // failed to resolve, and GraphQL nulled that field and named it
      // NOT_FOUND. That is a different fact: the pull request exists, and
      // this read only fell short of one of its facts.
      const node = prNode({ commits: { nodes: [{ commit: null }] } })
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: prReply(node, [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit'],
              message: 'Could not resolve to a Commit',
            },
          ]).stdout,
        },
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.missing).toBe(false)
    })

    it('keeps the pull request AND the error when a query partly succeeded', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: prReply(prNode(), [{ message: 'Something went wrong' }]).stdout },
      ])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.pullRequest?.number).toBe(178)
      expect(result.unavailable).toBe('Something went wrong')
    })

    it('reports gh’s own words when the reply is not JSON at all, and leaves missing false', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: 'gateway timeout', stderr: 'gh: HTTP 504\n' },
      ])

      await expect(gh.viewPullRequestDetail({ pullRequest: 178 })).resolves.toEqual({
        pullRequest: null,
        unavailable: 'gh: HTTP 504',
        missing: false,
      })
    })

    it('reports a reply with no repository in it', async () => {
      const { gh } = clientAnsweringEach([REPO, { status: 1, stdout: '{"data":{}}', stderr: '' }])

      const result = await gh.viewPullRequestDetail({ pullRequest: 178 })

      expect(result.pullRequest).toBeNull()
      expect(result.unavailable).toBe('gh exited 1')
      expect(result.missing).toBe(false)
    })

    it('reports a repository it could not resolve, and asks nothing else', async () => {
      const { gh, calls } = clientAnsweringEach([
        { status: 1, stderr: 'gh: could not resolve to a Repository\n' },
      ])

      await expect(gh.viewPullRequestDetail({ pullRequest: 178 })).resolves.toEqual({
        pullRequest: null,
        unavailable: 'gh: could not resolve to a Repository',
        missing: false,
      })
      expect(calls).toHaveLength(1)
    })
  })

  describe('listWorkflowRuns', () => {
    it('filters by branch server-side, never by head sha, and reads every field', async () => {
      // Round 7 finding 6: `?head_sha=` answered nothing for a head whose
      // runs existed, and the agent closed and reopened a pull request over
      // it. `?branch=` answered.
      const { gh, calls } = clientAnsweringEach([
        REPO,
        { stdout: JSON.stringify({ workflow_runs: [runRow()] }) },
      ])

      const result = await gh.listWorkflowRuns({ branch: 'wktr-130-ws-sweep', perPage: 10 })

      expect(calls[1]?.args).toEqual([
        'api',
        'repos/acme/widgets/actions/runs?per_page=10&branch=wktr-130-ws-sweep',
      ])
      expect(calls[1]?.args[1]).not.toContain('head_sha')
      expect(result).toEqual({
        rows: [
          {
            id: 1000,
            workflowId: 10,
            createdAt: '2026-09-22T06:31:10Z',
            name: 'CI',
            event: 'pull_request',
            headSha: '9b13a20',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2026-09-22T06:31:17Z',
            updatedAt: '2026-09-22T06:33:14Z',
          },
        ],
        unavailable: null,
      })
    })

    it('asks for one page of 30 and no branch filter when given neither', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '{"workflow_runs":[]}' }])

      await gh.listWorkflowRuns()

      expect(calls[1]?.args).toEqual(['api', 'repos/acme/widgets/actions/runs?per_page=30'])
    })

    it('percent-encodes a branch name with a slash into the query', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '{"workflow_runs":[]}' }])

      await gh.listWorkflowRuns({ branch: 'spike/context-audit' })

      expect(calls[1]?.args[1]).toContain('branch=spike%2Fcontext-audit')
    })

    it('carries a run that has not concluded as a null conclusion', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        {
          stdout: JSON.stringify({
            workflow_runs: [runRow({ status: 'in_progress', conclusion: null })],
          }),
        },
      ])

      const result = await gh.listWorkflowRuns({ branch: 'main' })

      expect(result.rows[0]?.status).toBe('in_progress')
      expect(result.rows[0]?.conclusion).toBeNull()
    })

    for (const field of [
      'name',
      'event',
      'head_sha',
      'status',
      'run_started_at',
      'updated_at',
      'id',
      'workflow_id',
      'created_at',
    ]) {
      it(`counts a row with no ${field} as unreadable rather than dropping it in silence`, async () => {
        // A dropped row is a caller that reads "no run for this head", and
        // then closes and reopens a pull request over it.
        const { gh } = clientAnsweringEach([
          REPO,
          {
            stdout: JSON.stringify({
              workflow_runs: [runRow(), runRow({ [field]: null })],
            }),
          },
        ])

        const result = await gh.listWorkflowRuns({ branch: 'main' })

        expect(result.rows).toHaveLength(1)
        expect(result.unavailable).toBe('1 workflow run row(s) could not be read')
      })
    }

    it('reports a reply carrying no workflow_runs list', async () => {
      const { gh } = clientAnsweringEach([REPO, { stdout: '{"message":"Not Found"}' }])

      await expect(gh.listWorkflowRuns({ branch: 'main' })).resolves.toEqual({
        rows: [],
        unavailable: 'the runs reply carried no workflow_runs list',
      })
    })

    it('reports gh’s own words when the runs could not be read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
      ])

      await expect(gh.listWorkflowRuns({ branch: 'main' })).resolves.toEqual({
        rows: [],
        unavailable: 'gh: API rate limit exceeded',
      })
    })

    it('reports a repository it could not resolve, and asks nothing else', async () => {
      const { gh, calls } = clientAnsweringEach([
        { status: 1, stderr: 'gh: could not resolve to a Repository\n' },
      ])

      await expect(gh.listWorkflowRuns()).resolves.toEqual({
        rows: [],
        unavailable: 'gh: could not resolve to a Repository',
      })
      expect(calls).toHaveLength(1)
    })
  })

  describe('compareCommits', () => {
    const file = (filename: string, extra: Record<string, unknown> = {}) => ({
      filename,
      status: 'modified',
      ...extra,
    })
    const compareReply = (fields: Record<string, unknown>): Reply => ({
      stdout: JSON.stringify({ status: 'ahead', ahead_by: 1, files: [], ...fields }),
    })

    it('asks for base...head with one commit per page, and reads status and file names', async () => {
      const { gh, calls } = clientAnsweringEach([
        REPO,
        compareReply({ files: [file('lib/gh.ts'), file('README.md')] }),
      ])

      const result = await gh.compareCommits({ base: 'dda20bc', head: 'a51ef71' })

      expect(calls[1]?.args).toEqual([
        'api',
        'repos/acme/widgets/compare/dda20bc...a51ef71?per_page=1',
      ])
      expect(result).toEqual({
        comparison: { status: 'ahead', files: ['lib/gh.ts', 'README.md'], filesAtLimit: false },
        unavailable: null,
      })
    })

    it('percent-encodes each side of the range', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, compareReply({})])

      await gh.compareCommits({ base: 'spike/a', head: 'b' })

      expect(calls[1]?.args[1]).toBe('repos/acme/widgets/compare/spike%2Fa...b?per_page=1')
    })

    for (const status of ['ahead', 'behind', 'diverged', 'identical'] as const) {
      it(`reads the documented status ${status}`, async () => {
        const { gh } = clientAnsweringEach([REPO, compareReply({ status })])

        const result = await gh.compareCommits({ base: 'a', head: 'b' })

        expect(result.comparison?.status).toBe(status)
      })
    }

    it('gives the old path of a renamed file too, so a move out of a directory is seen', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        compareReply({
          files: [file('docs/gh.md', { status: 'renamed', previous_filename: 'lib/gh.ts' })],
        }),
      ])

      const result = await gh.compareCommits({ base: 'a', head: 'b' })

      expect(result.comparison?.files).toEqual(['docs/gh.md', 'lib/gh.ts'])
    })

    it('sets filesAtLimit at 300 entries, and not at 299', async () => {
      const entries = (count: number) =>
        Array.from({ length: count }, (_, i) => file(`docs/${i}.md`))
      const at = clientAnsweringEach([REPO, compareReply({ files: entries(300) })])
      const below = clientAnsweringEach([REPO, compareReply({ files: entries(299) })])

      expect((await at.gh.compareCommits({ base: 'a', head: 'b' })).comparison?.filesAtLimit).toBe(
        true,
      )
      expect(
        (await below.gh.compareCommits({ base: 'a', head: 'b' })).comparison?.filesAtLimit,
      ).toBe(false)
    })

    it('counts entries for the limit, not names: renames do not reach it', async () => {
      const renamed = Array.from({ length: 150 }, (_, i) =>
        file(`docs/${i}.md`, { previous_filename: `old/${i}.md` }),
      )
      const { gh } = clientAnsweringEach([REPO, compareReply({ files: renamed })])

      const result = await gh.compareCommits({ base: 'a', head: 'b' })

      expect(result.comparison?.files).toHaveLength(300)
      expect(result.comparison?.filesAtLimit).toBe(false)
    })

    for (const [what, fields, reason] of [
      ['no status', { status: undefined }, 'the compare of a...b carried no status'],
      [
        'a status GitHub does not document',
        { status: 'unrelated' },
        'the compare of a...b carried no status',
      ],
      ['no files list', { files: undefined }, 'the compare of a...b carried no files list'],
      [
        'a files value that is not a list',
        { files: {} },
        'the compare of a...b carried no files list',
      ],
      [
        'a file with no filename',
        { files: [file('lib/gh.ts'), { status: 'modified' }] },
        'a changed file in the compare of a...b carried no filename',
      ],
      [
        'a file that is not an object',
        { files: ['lib/gh.ts'] },
        'a changed file in the compare of a...b carried no filename',
      ],
    ] as const) {
      it(`reports a reply with ${what}, never a short answer`, async () => {
        const { gh } = clientAnsweringEach([REPO, compareReply(fields)])

        await expect(gh.compareCommits({ base: 'a', head: 'b' })).resolves.toEqual({
          comparison: null,
          unavailable: reason,
        })
      })
    }

    it('reports a reply that is not an object', async () => {
      const { gh } = clientAnsweringEach([REPO, { stdout: '[]' }])

      await expect(gh.compareCommits({ base: 'a', head: 'b' })).resolves.toEqual({
        comparison: null,
        unavailable: 'the compare of a...b carried no status',
      })
    })

    it('quotes GitHub’s message for a compare it refused, such as an unknown commit', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '{"message":"No commit found for SHA: a","status":"404"}' },
      ])

      await expect(gh.compareCommits({ base: 'a', head: 'b' })).resolves.toEqual({
        comparison: null,
        unavailable: 'the compare of a...b carried no status: No commit found for SHA: a',
      })
    })

    it('reports gh’s own words when the compare could not be read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
      ])

      await expect(gh.compareCommits({ base: 'a', head: 'b' })).resolves.toEqual({
        comparison: null,
        unavailable: 'gh: API rate limit exceeded',
      })
    })

    it('reports a compare that timed out as itself, before it reads the body', async () => {
      const { gh } = clientAnsweringEach(
        [
          REPO,
          {
            timedOut: true,
            status: null,
            signal: 'SIGKILL',
            stdout: '{"status":"ahead","files":[]}',
          },
        ],
        { boundMs: 5_000 },
      )

      await expect(gh.compareCommits({ base: 'a', head: 'b' })).resolves.toEqual({
        comparison: null,
        unavailable: 'gh did not answer in 5000 ms',
      })
    })
  })
})

// --- the ref of one branch (#467) ---------------------------------------------
//
// One repository resolution, then one REST read of the ref.
describe('branchRef', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }
  /** The ref as GitHub answered it for this repository's own branch, on
   *  2026-10-20. */
  const refReply = (branch: string, sha: string): Reply => ({
    stdout: JSON.stringify({
      ref: `refs/heads/${branch}`,
      node_id: 'REF_kwDOUJSlNNoAJnJlZnMvaGVhZHMvd2t0ci00NjEtZGVsZXRlLXdhdGNoY2hlY2tz',
      url: `https://api.github.com/repos/acme/widgets/git/refs/heads/${branch}`,
      object: {
        sha,
        type: 'commit',
        url: `https://api.github.com/repos/acme/widgets/git/commits/${sha}`,
      },
    }),
  })
  const SHA = 'af8689cbace9f69b009df29d84a76e6b39c25284'

  it('reads the ref of the branch and answers its commit', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, refReply('wktr-461-delete-watchchecks', SHA)])

    const result = await gh.branchRef({ branch: 'wktr-461-delete-watchchecks' })

    expect(calls[1]?.args).toEqual([
      'api',
      'repos/acme/widgets/git/ref/heads/wktr-461-delete-watchchecks',
    ])
    expect(result).toEqual({ sha: SHA, unavailable: null })
  })

  it('reads a branch whose name holds a slash as one name', async () => {
    const branch = 'copilot/backport-2518-releases-v2'
    const { gh, calls } = clientAnsweringEach([REPO, refReply(branch, SHA)])

    const result = await gh.branchRef({ branch })

    expect(calls[1]?.args[1]).toBe(
      'repos/acme/widgets/git/ref/heads/copilot%2Fbackport-2518-releases-v2',
    )
    expect(result).toEqual({ sha: SHA, unavailable: null })
  })

  it('quotes GitHub’s 404 for a branch that does not exist', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      {
        status: 1,
        stdout:
          '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}',
        stderr: 'gh: Not Found (HTTP 404)\n',
      },
    ])

    await expect(gh.branchRef({ branch: 'gone' })).resolves.toEqual({
      sha: null,
      unavailable: 'the ref of gone carried no commit (404: Not Found)',
    })
  })

  for (const [what, stdout] of [
    ['an answer that is not an object', '[]'],
    ['a ref with no object', '{"ref":"refs/heads/a"}'],
    ['a ref whose object is not an object', '{"ref":"refs/heads/a","object":"af8689c"}'],
    ['a ref whose sha is not text', '{"ref":"refs/heads/a","object":{"sha":7}}'],
    ['a ref whose sha is empty', '{"ref":"refs/heads/a","object":{"sha":""}}'],
  ] as const) {
    it(`reports ${what}, never a commit`, async () => {
      const { gh } = clientAnsweringEach([REPO, { stdout }])

      await expect(gh.branchRef({ branch: 'a' })).resolves.toEqual({
        sha: null,
        unavailable: 'the ref of a carried no commit',
      })
    })
  }

  it('reports gh’s own words when the ref could not be read', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
    ])

    await expect(gh.branchRef({ branch: 'a' })).resolves.toEqual({
      sha: null,
      unavailable: 'gh: API rate limit exceeded',
    })
  })

  it('reports a repository it could not resolve, before it reads the ref', async () => {
    const { gh } = clientAnsweringEach([
      { status: 1, stdout: '', stderr: 'gh: Could not resolve to a Repository\n' },
    ])

    await expect(gh.branchRef({ branch: 'a' })).resolves.toEqual({
      sha: null,
      unavailable: 'gh: Could not resolve to a Repository',
    })
  })
})

// --- the jobs of a run, and the date of a commit (#466) ---------------------
//
// One repository resolution, then one REST read.
describe('listRunJobs and commitDate', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }
  /** A job as `actions/runs/{id}/jobs` answered for #471 on 2026-10-20,
   *  cut to the fields this reads. */
  const job = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'in_progress',
    started_at: '2026-10-20T22:31:04Z',
    completed_at: null,
    steps: [
      {
        status: 'completed',
        started_at: '2026-10-20T22:31:05Z',
        completed_at: '2026-10-20T22:31:06Z',
      },
      { status: 'in_progress', started_at: '2026-10-20T22:31:06Z', completed_at: null },
      { status: 'queued', started_at: null, completed_at: null },
    ],
    ...extra,
  })
  const jobsReply = (jobs: unknown, extra: Record<string, unknown> = {}): Reply => ({
    stdout: JSON.stringify({ total_count: Array.isArray(jobs) ? jobs.length : 0, jobs, ...extra }),
  })

  it('reads one page of the jobs of a run, with the stamps of each step', async () => {
    const { gh, calls } = clientAnsweringEach([REPO, jobsReply([job(118923958213)])])

    const result = await gh.listRunJobs({ run: '39508680057' })

    expect(calls[1]?.args).toEqual([
      'api',
      'repos/acme/widgets/actions/runs/39508680057/jobs?per_page=100',
    ])
    expect(result).toEqual({
      rows: [
        {
          id: 118923958213,
          startedAt: '2026-10-20T22:31:04Z',
          completedAt: null,
          steps: [
            { startedAt: '2026-10-20T22:31:05Z', completedAt: '2026-10-20T22:31:06Z' },
            { startedAt: '2026-10-20T22:31:06Z', completedAt: null },
            { startedAt: null, completedAt: null },
          ],
        },
      ],
      unavailable: null,
    })
  })

  it('names a job it could not read, and keeps the rest', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      jobsReply([job(1), { id: 'two', steps: [] }, job(3, { steps: 'none' }), null]),
    ])

    const result = await gh.listRunJobs({ run: '7' })

    expect(result.rows.map((row) => row.id)).toEqual([1])
    expect(result.unavailable).toBe('3 job(s) of run 7 could not be read')
  })

  it('names the jobs past the first page', async () => {
    const { gh } = clientAnsweringEach([REPO, jobsReply([job(1)], { total_count: 120 })])

    const result = await gh.listRunJobs({ run: '7' })

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('run 7 has 120 jobs; 1 were read')
  })

  it('reads a reply with no total_count by its own list', async () => {
    const { gh } = clientAnsweringEach([REPO, { stdout: JSON.stringify({ jobs: [job(1)] }) }])

    await expect(gh.listRunJobs({ run: '7' })).resolves.toMatchObject({ unavailable: null })
  })

  it('quotes GitHub’s 404 for a run that does not exist', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      {
        status: 1,
        stdout:
          '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run","status":"404"}',
        stderr: 'gh: Not Found (HTTP 404)\n',
      },
    ])

    await expect(gh.listRunJobs({ run: '1' })).resolves.toEqual({
      rows: [],
      unavailable: 'the jobs of run 1 were not a list (404: Not Found)',
    })
  })

  it('reports gh’s own words when the jobs could not be read', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
    ])

    await expect(gh.listRunJobs({ run: '1' })).resolves.toEqual({
      rows: [],
      unavailable: 'gh: API rate limit exceeded',
    })
  })

  it('reads the committer date of a commit', async () => {
    const { gh, calls } = clientAnsweringEach([
      REPO,
      {
        stdout: JSON.stringify({
          sha: 'eb0ee17',
          commit: {
            author: { date: '2026-10-20T22:40:00Z' },
            committer: { date: '2026-10-20T22:47:46Z' },
          },
        }),
      },
    ])

    const result = await gh.commitDate({ sha: 'eb0ee17' })

    expect(calls[1]?.args).toEqual(['api', 'repos/acme/widgets/commits/eb0ee17'])
    expect(result).toEqual({ date: '2026-10-20T22:47:46Z', unavailable: null })
  })

  it('reports a commit with no committer date, and quotes a 404', async () => {
    const shapes = clientAnsweringEach([REPO, { stdout: '{"commit":{}}' }])
    await expect(shapes.gh.commitDate({ sha: 'a' })).resolves.toEqual({
      date: null,
      unavailable: 'the commit a carried no committer date',
    })

    const gone = clientAnsweringEach([
      REPO,
      { status: 1, stdout: '{"message":"No commit found for SHA: a","status":"422"}' },
    ])
    await expect(gone.gh.commitDate({ sha: 'a' })).resolves.toEqual({
      date: null,
      unavailable: 'the commit a carried no committer date (422: No commit found for SHA: a)',
    })
  })

  it('reports gh’s own words when the commit could not be read', async () => {
    const { gh } = clientAnsweringEach([
      REPO,
      { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
    ])

    await expect(gh.commitDate({ sha: 'a' })).resolves.toEqual({
      date: null,
      unavailable: 'gh: API rate limit exceeded',
    })
  })
})

// --- the review statuses (#377) ----------------------------------------------
//
// One repository resolution, then one call: a GraphQL read of the statuses on
// a pull request's commits, or a REST write of one status.
describe('the review statuses', () => {
  const REPO: Reply = { stdout: '{"nameWithOwner":"acme/widgets"}' }
  const SHA = '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe'

  /** One status as `Status.contexts` answers it. */
  const status = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    context: 'workstreams/review-1',
    state: 'SUCCESS',
    description: 'minor',
    createdAt: '2026-10-13T10:00:00Z',
    ...overrides,
  })

  /** One commit node, with `status` as its status field. */
  const commit = (oid: string, contexts: unknown): Record<string, unknown> => ({
    commit: { oid, status: contexts === null ? null : { contexts } },
  })

  /** One force-push event, with `before` as the head it replaced. */
  const pushed = (before: Record<string, unknown>): Record<string, unknown> => ({
    beforeCommit: before.commit,
  })

  /** The status query's reply, with `nodes` as the commits and `events` as
   *  the force-pushes. `timeline` replaces the whole timeline field. */
  const statusReply = (
    nodes: readonly unknown[],
    more = false,
    errors?: readonly unknown[],
    events: readonly unknown[] = [],
    timeline: unknown = { pageInfo: { hasNextPage: false }, nodes: events },
  ): Reply => ({
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            commits: { pageInfo: { hasNextPage: more }, nodes },
            timelineItems: timeline,
          },
        },
      },
      ...(errors === undefined ? {} : { errors }),
    }),
  })

  describe('listPullRequestStatuses', () => {
    it('asks for the statuses on the first 100 commits, with the number as an Int', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, statusReply([])])

      await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(calls[1]?.args.slice(0, 8)).toEqual([
        'api',
        'graphql',
        '-f',
        'owner=acme',
        '-f',
        'name=widgets',
        '-F',
        'number=178',
      ])
      const query = calls[1]?.args[9] ?? ''
      expect(query).toContain('pullRequest(number: $number)')
      expect(query).toContain('commits(first: 100)')
      expect(query).toContain(
        'nodes { commit { oid status { contexts { context state description createdAt } } } }',
      )
      expect(query).toContain('timelineItems(first: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT])')
      expect(query).toContain(
        'nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid status { contexts { context state description createdAt } } } } }',
      )
      // The read carries only what the caller needs: no check rollup.
      expect(query).not.toContain('statusCheckRollup')
    })

    it('reads each status of the prefix, with its commit, oldest commit first', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([
          commit('a'.repeat(40), [
            status(),
            status({ context: 'Vercel', description: 'Deployed' }),
          ]),
          commit('b'.repeat(40), null),
          commit('c'.repeat(40), [status({ context: 'workstreams/rot-check', description: null })]),
        ]),
      ])

      await expect(
        gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' }),
      ).resolves.toEqual({
        rows: [
          {
            commit: 'a'.repeat(40),
            context: 'workstreams/review-1',
            state: 'success',
            description: 'minor',
            createdAt: '2026-10-13T10:00:00Z',
          },
          {
            commit: 'c'.repeat(40),
            context: 'workstreams/rot-check',
            state: 'success',
            description: null,
            createdAt: '2026-10-13T10:00:00Z',
          },
        ],
        unavailable: null,
      })
    })

    it('reads the head a force-push replaced, before the commits (#377)', async () => {
      // A restack takes the reviewed head out of the commits. Its status is
      // still on it, and the force-push event still names it.
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply(
          [commit('c'.repeat(40), [status({ context: 'workstreams/rot-check' })])],
          false,
          undefined,
          [pushed(commit('a'.repeat(40), [status()]))],
        ),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows.map((row) => [row.commit, row.context])).toEqual([
        ['a'.repeat(40), 'workstreams/review-1'],
        ['c'.repeat(40), 'workstreams/rot-check'],
      ])
      expect(result.unavailable).toBeNull()
    })

    it('reads a commit that is both a replaced head and a commit once', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, [status()])], false, undefined, [pushed(commit(SHA, [status()]))]),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBeNull()
    })

    it('counts an unreadable commit that is both a replaced head and a commit once', async () => {
      const short = [status({ createdAt: null })]
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, short)], false, undefined, [pushed(commit(SHA, short))]),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toEqual([])
      expect(result.unavailable).toBe(
        'the statuses of 1 commit(s) of pull request 178 could not be read',
      )
    })

    it('counts a replaced head that GitHub no longer gives as unreadable', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, [status()])], false, undefined, [{ beforeCommit: null }]),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBe(
        'the statuses of 1 commit(s) of pull request 178 could not be read',
      )
    })

    it('says so when the force-pushes could not be read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, [status()])], false, undefined, [], null),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBe('the force-pushes of pull request 178 could not be read')
    })

    it('keeps the replaced heads read, and says a later force-push is not read', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([], false, undefined, [], {
          pageInfo: { hasNextPage: true },
          nodes: [pushed(commit(SHA, [status()]))],
        }),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBe(
        'pull request 178 has more than the 100 force-pushes this reads, so a status on a head a later one replaced is not read',
      )
    })

    for (const state of ['ERROR', 'EXPECTED', 'FAILURE', 'PENDING'] as const) {
      it(`reads the state ${state} in lower case`, async () => {
        const { gh } = clientAnsweringEach([REPO, statusReply([commit(SHA, [status({ state })])])])

        const result = await gh.listPullRequestStatuses({
          pullRequest: 178,
          prefix: 'workstreams/',
        })

        expect(result.rows.map((row) => row.state)).toEqual([state.toLowerCase()])
      })
    }

    it('does not read a status of another prefix past its context', async () => {
      // Another system's status of a shape this read does not know must not
      // cost the review statuses.
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, [status({ context: 'Vercel', createdAt: 5, description: 5 })])]),
      ])

      await expect(
        gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' }),
      ).resolves.toEqual({ rows: [], unavailable: null })
    })

    for (const [what, node] of [
      ['no oid', { commit: { status: null } }],
      ['no commit', {}],
      ['a status with no contexts list', { commit: { oid: SHA, status: {} } }],
      ['a context that is not text', commit(SHA, [status({ context: 5 })])],
      ['a status of the prefix with no createdAt', commit(SHA, [status({ createdAt: null })])],
      ['a description that is not text', commit(SHA, [status({ description: 5 })])],
      ['a state GraphQL does not name', commit(SHA, [status({ state: 'DONE' })])],
      ['a state in lower case', commit(SHA, [status({ state: 'success' })])],
      ['no state', commit(SHA, [status({ state: null })])],
    ] as const) {
      it(`counts a commit with ${what} as unreadable, and keeps the other commits`, async () => {
        const { gh } = clientAnsweringEach([
          REPO,
          statusReply([node, commit('c'.repeat(40), [status()])]),
        ])

        const result = await gh.listPullRequestStatuses({
          pullRequest: 178,
          prefix: 'workstreams/',
        })

        expect(result.rows.map((row) => row.commit)).toEqual(['c'.repeat(40)])
        expect(result.unavailable).toBe(
          'the statuses of 1 commit(s) of pull request 178 could not be read',
        )
      })
    }

    it('keeps the rows of the first 100 commits, and says a later commit is not read', async () => {
      const { gh } = clientAnsweringEach([REPO, statusReply([commit(SHA, [status()])], true)])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBe(
        'pull request 178 has more than the 100 commits this reads, so a status on a later commit is not read',
      )
    })

    it('reports a pull request with no commits list, with what GraphQL said', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        {
          status: 1,
          stdout: JSON.stringify({
            data: { repository: { pullRequest: null } },
            errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'gone' }],
          }),
        },
      ])

      await expect(
        gh.listPullRequestStatuses({ pullRequest: 99999, prefix: 'workstreams/' }),
      ).resolves.toEqual({
        rows: [],
        unavailable:
          'the commits of pull request 99999 could not be read; ' +
          'the force-pushes of pull request 99999 could not be read; gone',
      })
    })

    it('keeps the rows of a reply that also carried an error, and reports the error', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        statusReply([commit(SHA, [status()])], false, [{ message: 'something partial' }]),
      ])

      const result = await gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' })

      expect(result.rows).toHaveLength(1)
      expect(result.unavailable).toBe('something partial')
    })

    it('reports a reply that could not be read at all, and does not throw', async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded\n' },
      ])

      await expect(
        gh.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' }),
      ).resolves.toEqual({ rows: [], unavailable: 'gh: API rate limit exceeded' })
    })
  })

  describe('createCommitStatus', () => {
    it('posts one status on the sha, with each field as a string', async () => {
      const { gh, calls } = clientAnsweringEach([
        REPO,
        { stdout: '{"id":1,"context":"workstreams/review-1","state":"success"}' },
      ])

      const created = await gh.createCommitStatus({
        sha: SHA,
        context: 'workstreams/review-1',
        state: 'success',
        description: 'substantial',
      })

      expect(calls[1]?.args).toEqual([
        'api',
        '--method',
        'POST',
        `repos/acme/widgets/statuses/${SHA}`,
        '-f',
        'state=success',
        '-f',
        'context=workstreams/review-1',
        '-f',
        'description=substantial',
      ])
      expect(created).toEqual({ id: 1, context: 'workstreams/review-1', state: 'success' })
    })

    it('sends no description when it was given none', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '{"id":1}' }])

      await gh.createCommitStatus({ sha: SHA, context: 'workstreams/rot-check', state: 'success' })

      expect(calls[1]?.args.slice(4)).toEqual([
        '-f',
        'state=success',
        '-f',
        'context=workstreams/rot-check',
      ])
    })

    it('keeps a sha with a path character inside its own path segment', async () => {
      const { gh, calls } = clientAnsweringEach([REPO, { stdout: '{"id":1}' }])

      await gh.createCommitStatus({ sha: 'a/../b', context: 'workstreams/layer', state: 'success' })

      expect(calls[1]?.args[3]).toBe('repos/acme/widgets/statuses/a%2F..%2Fb')
    })

    it("throws gh's own words and its status when the write failed", async () => {
      const { gh } = clientAnsweringEach([
        REPO,
        { status: 1, stderr: 'gh: No commit found for SHA: 9b13a20 (HTTP 422)\n' },
      ])

      const error = await gh
        .createCommitStatus({ sha: '9b13a20', context: 'workstreams/layer', state: 'success' })
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(GhError)
      expect((error as GhError).status).toBe(1)
      expect((error as GhError).detail).toBe('gh: No commit found for SHA: 9b13a20 (HTTP 422)')
    })

    it('throws when the repository could not be read', async () => {
      const { gh } = clientAnsweringEach([{ status: 1, stderr: 'gh: not a git repository\n' }])

      await expect(
        gh.createCommitStatus({ sha: SHA, context: 'workstreams/layer', state: 'success' }),
      ).rejects.toThrow('gh: not a git repository')
    })
  })
})
