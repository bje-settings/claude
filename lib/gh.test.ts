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
import { describe, expect, it } from 'vitest'

import { createGhClient, type GhClient, GhError } from './gh.ts'
import type { Runner, RunResult } from './process.ts'

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
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
})

/** A runner that answers with `reply` and records the call. */
const answering =
  (reply: Reply, calls: Call[]): Runner =>
  async (command, args, options) => {
    calls.push({ command, args: args ?? [], cwd: options?.cwd, timeoutMs: options?.timeoutMs })
    return asResult(reply)
  }

interface Harness {
  readonly gh: GhClient
  readonly calls: Call[]
}

const clientAnswering = (
  reply: Reply,
  options: { cwd?: string; repository?: string } = {},
): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ ...options, run: answering(reply, calls) }), calls }
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
    await gh.listPullRequests({ state: 'open', label: 'dependencies', limit: 100 })
    expect(calls[0]?.args.slice(0, 8)).toEqual([
      'pr',
      'list',
      '--state',
      'open',
      '--label',
      'dependencies',
      '--limit',
      '100',
    ])
    expect(calls[0]?.args).not.toContain('--head')
    expect(calls[0]?.args).not.toContain('--base')
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
    // that saturated.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listMergedPullRequests({ base: 'main', head: 'feature-a' })
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      'pr',
      'list',
      '--state',
      'merged',
      '--base',
      'main',
    ])
    expect(calls[0]?.args).toContain('--head')
    expect(calls[0]?.args).not.toContain('--limit')
  })

  it('asks gh pr view for one pull request, with the shepherd field list', async () => {
    // `gh-shepherd-pr.py:399`, the read every subcommand there begins with.
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewPullRequest({ pullRequest: 7 })
    expect(calls[0]?.args.slice(0, 4)).toEqual(['pr', 'view', '7', '--json'])
    // The same list `shepherd.py`'s PR_FIELDS holds: `summary` shapes
    // whatever it is given, so a missing field comes back as a pull request
    // whose checks are `none`, which `wait` reads as passed.
    expect(calls[0]?.args[4]).toContain('statusCheckRollup')
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
  })

  it('watches the checks under a bound, with the flags it was given', async () => {
    // gh 2.98.0 refuses `--watch` with `--json` and refuses `--interval`
    // without `--watch`, so this call carries no `--json` at all; the caller
    // reads the rollup afterwards with `viewPullRequest`, as
    // `gh-shepherd-pr.py:668` does. `--fail-fast` is what that script passes.
    const { gh, calls } = clientAnswering({ stdout: '' })
    await gh.watchChecks({ pullRequest: 7, interval: 30, failFast: true, boundMs: 90_000 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'checks',
      '7',
      '--watch',
      '--fail-fast',
      '--interval',
      '30',
    ])
    expect(calls[0]?.timeoutMs).toBe(90_000)
    expect(calls).toHaveLength(1)
  })

  it('watches unbounded and without flags when it was given none', async () => {
    const { gh, calls } = clientAnswering({ stdout: '' })
    await gh.watchChecks({ pullRequest: 7, failFast: false })
    expect(calls[0]?.args).toEqual(['pr', 'checks', '7', '--watch'])
    expect(calls[0]?.timeoutMs).toBeUndefined()
  })

  it('names the repository on every call when it was given one', async () => {
    // Round 5's handoff fact 4: the shepherd scripts run from wherever the
    // agent started, not from the checkout, so they pass `--repo` on every
    // call they make.
    const { gh, calls } = clientAnswering({ stdout: '{}' }, { repository: 'acme/widgets' })
    await gh.viewRepository()
    await gh.viewPullRequest({ pullRequest: 7 })
    expect(calls[0]?.args.slice(0, 4)).toEqual(['repo', 'view', '--repo', 'acme/widgets'])
    expect(calls[1]?.args.slice(0, 5)).toEqual(['pr', 'view', '7', '--repo', 'acme/widgets'])
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
    await expect(gh.listMergedPullRequests({ base: 'main' })).resolves.toHaveLength(2)
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
    await expect(updated.gh.updateBranch({ pullRequest: 7 })).resolves.toBe('Updated branch main\n')
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
    await expect(gh.listRuns()).rejects.toThrow(/failed: gh exited 1$/)
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
    expect((error as GhError).status).toBe(127)
  })

  it('throws when gh answered with something that is not JSON', async () => {
    const { gh } = clientAnswering({ stdout: 'not json at all' })
    await expect(gh.listPullRequests()).rejects.toThrow(
      'gh answered gh pr list with something that is not JSON',
    )
  })

  it('throws when a list endpoint answered with something else', async () => {
    // Never defaulted to an empty list: "nothing matched" and "the answer was
    // not a list" are different facts, and folding them together is how a
    // caller acts on a repository it could not read.
    const { gh } = clientAnswering({ stdout: '{"message":"Not Found"}' })
    await expect(gh.listRuns()).rejects.toThrow(
      'gh answered gh run list with something that is not a list',
    )
  })

  it.each([
    ['a string', '"acme/widgets"'],
    ['null', 'null'],
    ['a list', '[{"nameWithOwner":"acme/widgets"}]'],
  ])('throws when the repository answer is %s', async (_shape, stdout) => {
    const { gh } = clientAnswering({ stdout })
    await expect(gh.viewRepository()).rejects.toThrow(
      'gh answered gh repo view with something that is not an object',
    )
  })
})

describe('the checks watch', () => {
  it('answers with the status when a check failed, rather than throwing', async () => {
    // `gh pr checks --watch` reports through its exit status: 1 a check
    // failed, 8 still pending. Reading those as transport failures is how a
    // red rollup arrives as a broken token.
    const { gh } = clientAnswering({ status: 1, stderr: 'Some checks were not successful\n' })
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toEqual({
      status: 1,
      timedOut: false,
      waitedMs: 0,
      problem: 'Some checks were not successful\n',
    })
  })

  it('answers with the status when the checks are still pending', async () => {
    const { gh } = clientAnswering({ status: 8, elapsedMs: 12_000 })
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toMatchObject({
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

  it('reports a gh that could not be started at all, without throwing', async () => {
    // `run_bounded` answers 127 here rather than raising, because its caller
    // reports it as a refusal carrying what gh printed
    // (`gh-shepherd-pr.py:279` to `284`). Handing some outcomes back as
    // values and the rest as exceptions is what that caller cannot use.
    const { gh } = clientAnswering({
      status: 127,
      startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' },
    })
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toMatchObject({
      status: 127,
      problem: 'cannot run gh: spawn gh ENOENT',
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
    'listMergedPullRequests',
    'listPullRequests',
    'listRuns',
    'readFailedRunLog',
    'updateBranch',
    'viewPullRequest',
    'viewRepository',
    'watchChecks',
  ])
})
