// The real `gh` client. Nothing here spawns anything: the client takes node's
// `execFile` as a parameter, so the adapter that would start `gh` is driven
// by a stand-in and every endpoint is exercised against the argv it builds
// and the output shape gh answers with. A suite that spawned `gh` would be
// asserting against a machine's login rather than against this code.
//
// The argv rows are written out one endpoint at a time rather than derived
// from the client, because a table built from the implementation would go on
// passing after the implementation changed.
import { describe, expect, it } from 'vitest'

import { createGhClient, type ExecFile, type GhClient } from './gh.ts'

interface Call {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly maxBuffer: number
}

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: Error
}

/** A stand-in for node's `execFile` that answers with `reply` and records the call. */
const answering =
  (reply: Reply, calls: Call[]): ExecFile =>
  (file, args, options, callback) => {
    calls.push({ file, args, cwd: options.cwd, maxBuffer: options.maxBuffer })
    callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
  }

interface Harness {
  readonly gh: GhClient
  readonly calls: Call[]
}

const clientAnswering = (reply: Reply, cwd?: string): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ execFile: answering(reply, calls), cwd }), calls }
}

describe('argv', () => {
  it('asks gh pr list for the fields the shepherd reads, with no filters by default', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listPullRequests()
    expect(calls[0]?.file).toBe('gh')
    expect(calls[0]?.args).toEqual([
      'pr',
      'list',
      '--json',
      'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
        'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision',
    ])
  })

  it('passes each pull-request filter it was given, and omits the ones it was not', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listPullRequests({ state: 'merged', base: 'main', limit: 100 })
    expect(calls[0]?.args.slice(0, 8)).toEqual([
      'pr',
      'list',
      '--state',
      'merged',
      '--base',
      'main',
      '--limit',
      '100',
    ])
    expect(calls[0]?.args).not.toContain('--head')
  })

  it('asks gh pr list for a head branch', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listPullRequests({ head: 'feature-a' })
    expect(calls[0]?.args.slice(0, 4)).toEqual(['pr', 'list', '--head', 'feature-a'])
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

  it('asks gh run view for the failed steps of a run named either way', async () => {
    const { gh, calls } = clientAnswering({ stdout: 'FAIL tests/thing\n' })
    await gh.readFailedRunLog({ run: 1234 })
    await gh.readFailedRunLog({ run: '5678' })
    expect(calls[0]?.args).toEqual(['run', 'view', '1234', '--log-failed'])
    expect(calls[1]?.args).toEqual(['run', 'view', '5678', '--log-failed'])
  })

  it('asks gh to update a branch, rebasing only when asked', async () => {
    const { gh, calls } = clientAnswering({ stdout: 'Updated branch\n' })
    await gh.updateBranch({ pullRequest: 7, rebase: true })
    await gh.updateBranch({ pullRequest: 7 })
    expect(calls[0]?.args).toEqual(['pr', 'update-branch', '7', '--rebase'])
    expect(calls[1]?.args).toEqual(['pr', 'update-branch', '7'])
  })

  it('passes a comment body as one argument', async () => {
    // As an argument and never through a shell: a body carrying backticks or
    // a semicolon is text, not something a shell gets to re-read.
    const { gh, calls } = clientAnswering({ stdout: 'https://github.com/a/b/pull/7#issue-1\n' })
    await gh.addComment({ pullRequest: 7, body: 'done; `rm -rf /`' })
    expect(calls[0]?.args).toEqual(['pr', 'comment', '7', '--body', 'done; `rm -rf /`'])
  })

  it('watches checks, passing an interval only when it was given one', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.watchChecks({ pullRequest: 7, interval: 30 })
    await gh.watchChecks({ pullRequest: 7 })
    expect(calls[0]?.args).toEqual([
      'pr',
      'checks',
      '7',
      '--watch',
      '--interval',
      '30',
      '--json',
      'name,state,bucket,link,workflow',
    ])
    expect(calls[1]?.args).toEqual([
      'pr',
      'checks',
      '7',
      '--watch',
      '--json',
      'name,state,bucket,link,workflow',
    ])
  })

  it('runs gh where it was told to, and in the current directory otherwise', async () => {
    // None of the endpoints carries a repository, so the working directory is
    // how a caller addresses one it did not start in.
    const here = clientAnswering({ stdout: '{}' }, '/tmp/acme-widgets')
    await here.gh.viewRepository()
    expect(here.calls[0]?.cwd).toBe('/tmp/acme-widgets')

    const anywhere = clientAnswering({ stdout: '{}' })
    await anywhere.gh.viewRepository()
    expect(anywhere.calls[0]?.cwd).toBeUndefined()
  })

  it('reads more than node would by default', async () => {
    // One `gh pr list --limit 100` carrying `statusCheckRollup` per row
    // passes node's 1 MiB default, and the failure that produces is a
    // truncated answer read as a complete one.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.listPullRequests()
    expect(calls[0]?.maxBuffer).toBe(64 * 1024 * 1024)
  })
})

describe('answers', () => {
  it('hands back the rows gh printed', async () => {
    const { gh } = clientAnswering({ stdout: '[{"number":1},{"number":2}]' })
    await expect(gh.listPullRequests()).resolves.toEqual([{ number: 1 }, { number: 2 }])
  })

  it('hands back the repository object gh printed', async () => {
    const { gh } = clientAnswering({ stdout: '{"nameWithOwner":"acme/widgets"}' })
    await expect(gh.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
  })

  it('hands back a log as the text it is', async () => {
    // `--log-failed` is a log, so it is not parsed: a caller reads the lines a
    // human would.
    const { gh } = clientAnswering({ stdout: 'FAIL tests/thing\n  expected 1\n' })
    await expect(gh.readFailedRunLog({ run: 1 })).resolves.toBe('FAIL tests/thing\n  expected 1\n')
  })

  it('hands back what a mutating call printed', async () => {
    const { gh } = clientAnswering({ stdout: 'Updated branch main\n' })
    await expect(gh.updateBranch({ pullRequest: 7 })).resolves.toBe('Updated branch main\n')
    await expect(gh.addComment({ pullRequest: 7, body: 'hi' })).resolves.toBe(
      'Updated branch main\n',
    )
  })

  it('hands back the checks as rows', async () => {
    const { gh } = clientAnswering({ stdout: '[{"name":"vitest","state":"SUCCESS"}]' })
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toEqual([
      { name: 'vitest', state: 'SUCCESS' },
    ])
  })
})

describe('refusals', () => {
  it("throws gh's own words when gh exits non-zero", async () => {
    // gh's wording travels with the failure because a caller cannot tell an
    // expired token from a repository that does not exist without it.
    const { gh } = clientAnswering({
      error: new Error('Command failed'),
      stderr: 'gh: could not resolve to a Repository\n',
    })
    await expect(gh.viewRepository()).rejects.toThrow(
      'gh repo view --json nameWithOwner,defaultBranchRef failed: ' +
        'gh: could not resolve to a Repository',
    )
  })

  it("throws node's message when gh never started at all", async () => {
    // Not on PATH, or a working directory that is gone: there is no stderr to
    // quote, and an empty quote would read as a failure with no account of
    // itself.
    const { gh } = clientAnswering({ error: new Error('spawn gh ENOENT') })
    await expect(gh.listRuns()).rejects.toThrow(/failed: spawn gh ENOENT$/)
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

it("defaults to node's own execFile", () => {
  // Constructed, not called: calling it would start the real `gh`, which is
  // what every other example here avoids. What this pins is the wiring, that
  // a client built with no options is a complete client rather than one
  // missing its transport.
  const gh = createGhClient()
  const endpoints = Object.keys(gh).sort()
  expect(endpoints).toEqual([
    'addComment',
    'listPullRequests',
    'listRuns',
    'readFailedRunLog',
    'updateBranch',
    'viewRepository',
    'watchChecks',
  ])
})
