// The real `gh` client. Nothing here spawns anything: the client takes the
// root lib's process runner as a parameter, so the one thing that would start
// `gh` is driven by a stand-in and every endpoint is exercised against the
// argv it builds and the output shape gh answers with. A suite that spawned
// `gh` would be asserting against a machine's login rather than against this
// code. The runner itself is the file tested against real children
// (`process.test.ts`).
//
// The argv rows are written out one endpoint at a time rather than derived
// from the client, because a table built from the implementation would go on
// passing after the implementation changed.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree; the
// file and line references below are to what they held at `cd0d515`, kept
// because each says where a rule came from. Nothing here changed with the
// deletion.
import { describe, expect, it } from 'vitest'

import { createGhClient, type GhClient, GhError } from './gh.ts'
import type { Runner, RunResult } from './process.ts'

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
  options: { cwd?: string; repository?: string; env?: NodeJS.ProcessEnv } = {},
): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ ...options, run: answering(reply, calls) }), calls }
}

/** A runner that answers each call from `replies` in order, repeating the
 *  last reply once the list runs out, and records every call. `issueStates`
 *  is the one endpoint that makes more than one call on its own (`repo view`
 *  for the owner and name, then one `api graphql` call per chunk), so its
 *  tests need a runner that can tell those calls apart. */
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

const clientAnsweringEach = (replies: Reply[]): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ run: answeringEach(replies, calls) }), calls }
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
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision',
    ])
  })

  it('passes each pull-request filter it was given, and omits the ones it was not', async () => {
    // `gh-shepherd-status.py:166` to `178` is this call: open, labelled
    // `dependencies`, one window of 100.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    // The whole list, not a prefix: a slice pins the filters that were passed
    // and leaves a stray trailing flag free to appear, which is the defect the
    // `pr view` assertion was changed for. `--head` and `--base` being absent
    // is now part of the same expectation rather than two notes beside it.
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
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision',
    ])
  })

  it('asks gh pr list for the merged window with the fields prs.py reads', async () => {
    // `gh-sync-repo.py:292`. The base is filtered server-side because a pull
    // request that merged into another branch is not proof that a local
    // branch landed on the default one.
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
      'headRefName,headRefOid,isCrossRepository',
    ])
  })

  it('narrows the merged window to one branch when asked', async () => {
    // The single-branch fallback at `gh-sync-repo.py:493`, for a bulk window
    // that saturated. 100 is that script's own `PR_BRANCH_LIMIT`, and it is
    // passed rather than omitted because the caller compares the row count
    // against it to find out whether this window saturated too.
    //
    // The whole list, not a prefix: a slice leaves a stray trailing flag free
    // to appear, which is the defect the `pr view` assertion was changed for.
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
      'headRefName,headRefOid,isCrossRepository',
    ])
  })

  it('asks gh pr view for one pull request, with the shepherd field list', async () => {
    // `gh-shepherd-pr.py:399`, the read every subcommand there begins with.
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewPullRequest({ pullRequest: 7 })
    // The whole argv, not a prefix: a slice leaves a stray trailing flag
    // free to appear. The field list is the same one `shepherd.py`'s
    // PR_FIELDS holds, and it is spelled out because `summary` shapes
    // whatever it is given, so a missing field comes back as a pull request
    // whose checks are `none`, which `wait` reads as passed.
    expect(calls[0]?.args).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision',
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
    // `gh-shepherd-pr.py:726` has followed a check's link to a run and a job,
    // so the whole run's failed steps would be a different question.
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

  it('passes a comment body as one argument, or names the file holding it', async () => {
    // As an argument and never through a shell: a body carrying backticks or
    // a semicolon is text, not something a shell gets to re-read. The file
    // form is `gh-shepherd-pr.py:928`, where the reason is a file the agent
    // wrote and the body would otherwise be a command line of its own.
    const { gh, calls } = clientAnswering({ stdout: 'https://github.com/a/b/pull/7#issue-1\n' })
    await gh.addComment({ pullRequest: 7, body: 'done; `rm -rf /`' })
    await gh.addComment({ pullRequest: 7, bodyFile: '/tmp/reason.md' })
    expect(calls[0]?.args).toEqual(['pr', 'comment', '7', '--body', 'done; `rm -rf /`'])
    expect(calls[1]?.args).toEqual(['pr', 'comment', '7', '--body-file', '/tmp/reason.md'])

    // Round 5's handoff fact 5 is that this is exactly one of the two, and
    // the enforcement is the type rather than a runtime check, so the two
    // refusals are pinned the way `args.test.ts` pins its own: by compiling.
    // Without these, `CommentText` could be loosened to a bare optional-both
    // shape and nothing in the suite would go red, while `gh` itself refuses
    // `--body` with `--body-file` and a call carrying neither would reach gh
    // with no body at all.
    // @ts-expect-error a comment carrying both a body and a body file
    await gh.addComment({ pullRequest: 7, body: 'both', bodyFile: '/tmp/reason.md' })
    // @ts-expect-error a comment carrying neither
    await gh.addComment({ pullRequest: 7 })
  })

  it('watches the checks under a bound, with the flags it was given', async () => {
    // gh 2.98.0 refuses `--watch` with `--json` and refuses `--interval`
    // without `--watch`, so this call carries no `--json` at all; the caller
    // reads the rollup afterwards with `viewPullRequest`, as
    // `gh-shepherd-pr.py:668` does. `--fail-fast` is what that script passes.
    // Asserted over EVERY call rather than over the first one plus a count:
    // the contract is that the watch is the only round trip this endpoint
    // makes (no second `gh pr checks --json` read, which the one consumer
    // never looks at and which fails outright on a pull request with no
    // checks), and an assertion over the whole list pins the argv and the
    // absence of a second call together. A count would pin a number and name
    // nothing when it broke, which is the call counting `harness/README.md`
    // refuses.
    const { gh, calls } = clientAnswering({ stdout: '' })
    await gh.watchChecks({ pullRequest: 7, interval: 30, failFast: true, boundMs: 90_000 })
    expect(calls.map((call) => call.args)).toEqual([
      ['pr', 'checks', '7', '--watch', '--fail-fast', '--interval', '30'],
    ])
    expect(calls[0]?.timeoutMs).toBe(90_000)
  })

  it('watches with only the bound when it was given no flags', async () => {
    // The bound is the one thing that is not optional: round 5's handoff
    // fact 1 is that #154 left this call unbounded, and `process.ts` detaches
    // only a bounded child, so an unbounded watch could not be group-killed
    // either. The type refuses the call that omits it, which is why there is
    // no unbounded example here to assert against.
    const { gh, calls } = clientAnswering({ stdout: '' })
    await gh.watchChecks({ pullRequest: 7, failFast: false, boundMs: 45_000 })
    expect(calls[0]?.args).toEqual(['pr', 'checks', '7', '--watch'])
    expect(calls[0]?.timeoutMs).toBe(45_000)
  })

  it('names the repository on every call when it was given one', async () => {
    // Round 5's handoff fact 4: the shepherd scripts run from wherever the
    // agent started, not from the checkout, so they name the repository on
    // every call they make. Every endpoint is driven here rather than a
    // sample of two, because an endpoint that dropped the name would resolve
    // against the agent's own directory and act on the wrong repository, and
    // the argv is the only place that is visible.
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
    await log.gh.watchChecks({ pullRequest: 7, boundMs: 1_000 })

    const fields =
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision'
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
        'headRefName,headRefOid,isCrossRepository',
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
      ['pr', 'checks', '7', '--repo', 'acme/widgets', '--watch'],
    ])
  })

  it('hands gh the environment it was built with, and nothing when it was built with none', async () => {
    // `GH_REPO` displaces `cwd` the way `GIT_DIR` does (`gh help
    // environment`), so a client that has an environment to pin must be able
    // to, and one that does not must leave the child inheriting this
    // process's, which is what every ported call site gets today.
    const pinned = clientAnswering({ stdout: '[]' }, { env: { PATH: '/usr/bin' } })
    await pinned.gh.listPullRequests()
    expect(pinned.calls[0]?.env).toEqual({ PATH: '/usr/bin' })

    const ambient = clientAnswering({ stdout: '[]' })
    await ambient.gh.listPullRequests()
    expect(ambient.calls[0]?.env).toBeUndefined()
  })

  it('names the repository to gh repo view positionally, because it has no --repo flag', async () => {
    // `gh repo view` is the one command in this client with no `-R, --repo`:
    // its inherited flags are `--help` alone and the repository is the
    // positional argument (`gh repo view [<repository>]`). gh 2.98.0 refuses
    // the flag form outright with "unknown flag: --repo", so building it
    // would make every `viewRepository` call on a client that names a
    // repository fail, which is the first call the shepherd path makes. The
    // Python never had it either: `gh-shepherd-pr.py:959` and
    // `gh-shepherd-status.py:104` are the only two of its ten gh calls that
    // pass no `--repo`.
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
    // A reply each, rather than one shared between them: an assertion that
    // matches because the stand-in answers every call the same way says
    // nothing about the endpoint it names.
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
    // gh writes deprecation and auth notices to stderr while exiting zero.
    // Folding those into the answer would put prose inside a JSON payload,
    // and inside a log a caller reads as the lines a human would.
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
    // The field a report quotes. The Python prints `last_line(stderr)` and the
    // ordinary refusal is ONE line, so tailing the message would hand a
    // reader the whole argv: `plugins/gh/src/commands/sync-repo.ts` put forty
    // characters of `--json` fields inside a rate-limit line before this
    // existed.
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
    // Not on PATH, or a working directory that is gone. Whatever gh had
    // written to stderr before is not an account of that, and 127 is the
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
    // gh exits happily on the bytes it wrote; the bytes that arrived here are
    // the ones that got through. Parsing a short answer would read a truncated
    // list as a complete one, which is the fact `rows` refuses to default.
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
    // One shape for everything that goes wrong: the four throw sites in this
    // file report the same `cause`, so a caller reading `cause.stderr` gets
    // gh's own words whichever of them it caught. The offending value goes in
    // the message, where it is read, rather than in the cause, where it would
    // displace the run. `status` is 0 here on purpose: gh succeeded and its
    // answer could not be read, which is a different fact from gh failing.
    const { gh } = clientAnswering({ stdout: 'not json at all', stderr: 'a note\n' })
    const error = await gh.listPullRequests().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(GhError)
    expect((error as GhError).status).toBe(0)
    expect((error as GhError).cause).toMatchObject({
      stdout: 'not json at all',
      stderr: 'a note\n',
    })
    // An answer that could not be read has no argv prefix to strip, so the
    // account and the message are the same string. A caller reading `detail`
    // gets a whole sentence whichever throw site it caught.
    expect((error as GhError).detail).toBe((error as GhError).message)
  })

  it('throws when a list endpoint answered with something else', async () => {
    // Never defaulted to an empty list: "nothing matched" and "the answer was
    // not a list" are different facts, and folding them together is how a
    // caller acts on a repository it could not read.
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

describe('the checks watch', () => {
  it('answers with the status when a check failed, rather than throwing', async () => {
    // `gh pr checks --watch` reports through its exit status: 1 a check
    // failed, 8 still pending. Reading those as transport failures is how a
    // red rollup arrives as a broken token.
    const { gh } = clientAnswering({ status: 1, stderr: 'Some checks were not successful\n' })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toEqual({
      status: 1,
      timedOut: false,
      waitedMs: 0,
      problem: 'Some checks were not successful\n',
    })
  })

  it('answers with the status when the checks are still pending', async () => {
    const { gh } = clientAnswering({ status: 8, elapsedMs: 12_000 })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toMatchObject({
      status: 8,
      waitedMs: 12_000,
      problem: '',
    })
  })

  it('says the bound fired, and how long it actually waited', async () => {
    // Round 5's handoff fact 1. The Python publishes this as 124, the way
    // coreutils `timeout` does, and that translation is the caller's.
    const { gh } = clientAnswering({
      status: null,
      signal: 'SIGKILL',
      timedOut: true,
      elapsedMs: 90_012,
    })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toEqual({
      status: null,
      timedOut: true,
      waitedMs: 90_012,
      problem: '',
    })
  })

  it('names the signal when something other than the bound killed the watch', async () => {
    // The OOM killer, a SIGHUP when the terminal went away, a supervisor's
    // SIGTERM. `status` is null, so it is not one of WATCHER_CODES, and
    // `timedOut` is false, so the caller is told it did not time out either.
    // With `problem` empty as well the shepherd would print a blank reason
    // for a watch that died, which is the silence the field exists to
    // prevent. The Python never has it: `run_bounded` drains stderr a second
    // time after the kill (`gh-shepherd-pr.py:286` to `291`).
    const { gh } = clientAnswering({ status: null, signal: 'SIGKILL', elapsedMs: 340 })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toEqual({
      status: null,
      timedOut: false,
      waitedMs: 340,
      problem: 'gh was killed by SIGKILL',
    })
  })

  it("keeps gh's own words when a signal ended a watch that had already said something", async () => {
    const { gh } = clientAnswering({
      status: null,
      signal: 'SIGTERM',
      stderr: 'could not reach api.github.com\n',
    })
    // Whole, with its newline: `problem` is documented as what the watch said
    // on stderr entire, and the caller does the tailing. Before this the
    // signal arm alone went through `accountOf`, which trims, so the same
    // field came back with a trailing newline or without one depending on
    // whether a signal happened to arrive.
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toMatchObject({
      problem: 'could not reach api.github.com\n',
    })
  })

  it('reports a pipe that failed rather than the words that got through', async () => {
    // A watch must not throw, so the account of the broken pipe goes where
    // gh's own words would have gone. Answering with the partial stderr would
    // hand the caller a confident half-sentence.
    const { gh } = clientAnswering({
      status: 1,
      stderr: 'Some checks were not su',
      streamErrors: [{ code: 'EIO', message: 'read EIO' }],
    })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toMatchObject({
      status: 1,
      problem: "gh's output could not be read: EIO, read EIO",
    })
  })

  it('reports a gh that could not be started at all, without throwing', async () => {
    // `run_bounded` answers 127 here rather than raising, because its caller
    // reports it as a refusal carrying what gh printed
    // (`gh-shepherd-pr.py:279` to `284`). Handing some outcomes back as
    // values and the rest as exceptions is what that caller cannot use.
    const { gh } = clientAnswering({
      status: 127,
      startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' },
    })
    await expect(gh.watchChecks({ pullRequest: 7, boundMs: 90_000 })).resolves.toMatchObject({
      status: 127,
      problem: 'cannot run gh: spawn gh ENOENT',
    })
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
    // `accountOf(result)` as the reason" (#170): unlike the spike, this does
    // not read the GraphQL error message for the reason, it reads what the
    // transport says about the call, exactly as every other endpoint here
    // does for a failure.
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

  it('chunks 101 numbers into two calls of 100 and 1, each aliased from i0', async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1)
    const { gh, calls } = clientAnsweringEach([
      { stdout: '{"nameWithOwner":"acme/widgets"}' },
      { stdout: '{"data":{"repository":{}}}' },
      { stdout: '{"data":{"repository":{"i0":{"state":"OPEN"}}}}' },
    ])

    const result = await gh.issueStates({ numbers })

    // Each `api graphql` call aliases from i0 again: the batch is what resets,
    // not a running count, so the second call's one number is still i0. Only
    // the two ends of the first chunk are asserted as literals, rather than
    // reconstructing the whole 100-alias query from the numbers array, which
    // would only prove the query builder against a copy of itself.
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
    // `Object.assign` promise and a `reasons[0]` or a clobbering assignment
    // would not.
    expect(result).toEqual({ states: { '1': 'OPEN' }, unavailable: 'first reason; second reason' })
  })

  it('reports a repository whose name has no owner prefix as unavailable, via the graphql call it still makes', async () => {
    // `nameWithOwner` with no `/` is not a shape any real gh answers with,
    // but the code makes no branch for it either (the comment above the
    // split in `lib/gh.ts`): `parts[1]` is `undefined`, `String(undefined)`
    // embeds the four characters `undefined` as the query's `name` argument,
    // and the resulting query fails downstream exactly as any other query
    // naming a repository that does not exist would, reported through
    // `accountOf` like every other chunk failure in this file.
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
  // Constructed, not called: calling it would start the real `gh`, which is
  // what every other example here avoids. What this pins is that a client
  // built with no options is a whole client, every endpoint present. That the
  // transport it falls back to is `process.ts`'s `run` is held by the
  // compiler rather than by an assertion: driving it would spawn, and
  // exporting the fallback so a test could compare identities would add a
  // shipped export whose only caller is this file.
  const gh = createGhClient()
  const endpoints = Object.keys(gh).sort()
  expect(endpoints).toEqual([
    'addComment',
    'issueStates',
    'listIssues',
    'listMergedPullRequests',
    'listMilestones',
    'listOpenPullRequests',
    'listPullRequests',
    'listRuns',
    'readFailedRunLog',
    'updateBranch',
    'viewPullRequest',
    'viewRepository',
    'watchChecks',
  ])
})

// --- the paginated sweep reads -----------------------------------------------
//
// One repository resolution then one `api graphql` call per page, so every
// example here answers the `repo view` first. What is asserted is the argv
// built for each endpoint, the rows read back, and every way an answer can be
// short: a reply that cannot be read at all, a row that is not the shape the
// query asked for, an error beside a good page, a cursor that does not
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
    // Which is the query that answers for the issues on NO milestone: the
    // variable is then null and GitHub filters on nothing, and the caller
    // reads `milestone === null` off the rows.
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
    // Asking again with the cursor already used would ask the same question
    // forever. The rows already read are still an answer, and the reason the
    // answer is short is reported: without it a truncated set is handed over
    // as a complete one.
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
    // A `hasNextPage` that never goes false is a loop this process would not
    // leave. The ceiling is reported rather than silently truncating. Each
    // page's cursor advances so the repeated-cursor guard does not trip
    // first: `CUR${n}` is a fresh value every time.
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
        issueNode,
      ]),
    ])

    const result = await gh.listIssues()

    expect(result.rows).toHaveLength(1)
    expect(result.unavailable).toBe('9 issues row(s) could not be read')
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
