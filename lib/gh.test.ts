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

import { createGhClient, type ExecFile, type ExecFileFailure, type GhClient } from './gh.ts'

interface Call {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly maxBuffer: number
}

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: ExecFileFailure
}

/**
 * node's own failure shape: an `Error` carrying `code`, which is gh's exit
 * status when gh ran and an error name when it never did.
 */
const failing = (code: string | number, message: string): ExecFileFailure =>
  Object.assign(new Error(message), { code })

/**
 * A stand-in for node's `execFile` that answers with `reply` and records the
 * call.
 *
 * It is freer than the real thing in one way the type cannot express: it
 * calls back synchronously, where node never does. Nothing in the adapter
 * depends on when the callback arrives, since it settles a promise either
 * way, and that latitude is what buys the whole file a spawn-free suite.
 */
const answering =
  (reply: Reply, calls: Call[]): ExecFile =>
  (file, args, options, callback) => {
    calls.push({ file, args, cwd: options.cwd, maxBuffer: options.maxBuffer })
    callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
  }

/**
 * The same, answering each call from `replies` in turn and repeating the
 * last. `watchChecks` is the one endpoint that runs `gh` twice, so it is the
 * one that needs a different answer per call.
 */
const answeringInTurn = (replies: readonly Reply[], calls: Call[]): ExecFile => {
  let seen = 0
  return (file, args, options, callback) => {
    calls.push({ file, args, cwd: options.cwd, maxBuffer: options.maxBuffer })
    // Clamped rather than guarded: a call past the end repeats the last
    // reply, which is one expression instead of an arm no test reaches.
    const reply = replies[Math.min(seen, replies.length - 1)] as Reply
    seen += 1
    callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
  }
}

interface Harness {
  readonly gh: GhClient
  readonly calls: Call[]
}

const clientAnswering = (reply: Reply, cwd?: string): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ execFile: answering(reply, calls), cwd }), calls }
}

const clientAnsweringInTurn = (replies: readonly Reply[]): Harness => {
  const calls: Call[] = []
  return { gh: createGhClient({ execFile: answeringInTurn(replies, calls) }), calls }
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

  it('watches the checks and then reads them, because gh has no one call that does both', async () => {
    // gh 2.98.0 refuses `--watch` with `--json`, and refuses `--interval`
    // without `--watch`, so a single call carrying all three is argv gh never
    // accepts. Spelled out here rather than derived, because this is exactly
    // the mistake a stand-in that answers any argv cannot notice.
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.watchChecks({ pullRequest: 7, interval: 30 })
    expect(calls[0]?.args).toEqual(['pr', 'checks', '7', '--watch', '--interval', '30'])
    expect(calls[1]?.args).toEqual([
      'pr',
      'checks',
      '7',
      '--json',
      'name,state,bucket,link,workflow',
    ])
  })

  it('watches without an interval when it was given none', async () => {
    const { gh, calls } = clientAnswering({ stdout: '[]' })
    await gh.watchChecks({ pullRequest: 7 })
    expect(calls[0]?.args).toEqual(['pr', 'checks', '7', '--watch'])
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
    // expired token from a repository that does not exist without it. A
    // numeric code is how the adapter knows gh ran far enough to say so.
    const { gh } = clientAnswering({
      error: failing(1, 'Command failed'),
      stderr: 'gh: could not resolve to a Repository\n',
    })
    await expect(gh.viewRepository()).rejects.toThrow(
      'gh repo view --json nameWithOwner,defaultBranchRef failed: ' +
        'gh: could not resolve to a Repository',
    )
  })

  it("throws node's message when gh exited non-zero and said nothing", async () => {
    const { gh } = clientAnswering({ error: failing(1, 'Command failed: gh run list') })
    await expect(gh.listRuns()).rejects.toThrow(/failed: Command failed: gh run list$/)
  })

  it("throws node's message when gh never started at all", async () => {
    // Not on PATH, or a working directory that is gone: there is no stderr to
    // quote, and an empty quote would read as a failure with no account of
    // itself.
    const { gh } = clientAnswering({ error: failing('ENOENT', 'spawn gh ENOENT') })
    await expect(gh.listRuns()).rejects.toThrow(/failed: spawn gh ENOENT$/)
  })

  it('reports an overrun reply as the overrun, not as whatever gh last warned about', async () => {
    // The failure the 64 MiB ceiling exists to turn into an error rather than
    // a truncated answer. gh had written an unrelated notice to stderr first,
    // and letting that stand in for node's account is how a truncation gets
    // reported as a release announcement.
    const { gh } = clientAnswering({
      error: failing('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'stdout maxBuffer length exceeded'),
      stderr: 'gh: a new release of gh is available\n',
    })
    await expect(gh.listPullRequests()).rejects.toThrow(
      /failed: stdout maxBuffer length exceeded: gh: a new release of gh is available$/,
    )
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
  it('answers with the rows even when the watch exited on a failed check', async () => {
    // `gh pr checks --watch` reports through its exit status: 1 a check
    // failed, 8 still pending. Those are answers about the checks, so the
    // read that follows still runs and its rows are what the caller wanted.
    // Reading them as transport failures is how a red rollup arrives as a
    // broken token.
    const { gh } = clientAnsweringInTurn([
      { error: failing(1, 'Command failed'), stderr: 'Some checks were not successful\n' },
      { stdout: '[{"name":"vitest","bucket":"fail"}]' },
    ])
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toEqual([
      { name: 'vitest', bucket: 'fail' },
    ])
  })

  it('answers with the rows when the watch exited still pending', async () => {
    const { gh } = clientAnsweringInTurn([
      { error: failing(8, 'Command failed') },
      { stdout: '[{"name":"vitest","bucket":"pending"}]' },
    ])
    await expect(gh.watchChecks({ pullRequest: 7 })).resolves.toEqual([
      { name: 'vitest', bucket: 'pending' },
    ])
  })

  it('still throws when the watch failed to answer at all', async () => {
    // Exit 4 is gh asking to be authenticated, which is not a fact about the
    // checks, so it fails like every other endpoint rather than being read as
    // a rollup nobody looked at. Answered in turn, with the read left able to
    // succeed, so the failure that surfaces names `--watch`: given to both
    // calls it would surface from the parser instead and point a reader at
    // the wrong half of the endpoint.
    const { gh } = clientAnsweringInTurn([
      {
        error: failing(4, 'Command failed'),
        stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n',
      },
      { stdout: '[]' },
    ])
    await expect(gh.watchChecks({ pullRequest: 7 })).rejects.toThrow(
      /^gh pr checks 7 --watch failed: .*gh auth login$/,
    )
  })

  it('throws when the read that follows the watch failed', async () => {
    // The read is the call whose rows become the answer, so its statuses are
    // not the watch's: none of them is a fact about the checks. A read that
    // fails while the watch succeeded has to fail here, because the
    // alternative is an empty rollup that a caller reads as "nothing is
    // wrong", which is the found-nothing-is-a-pass shape `rows` refuses.
    const { gh } = clientAnsweringInTurn([
      { stdout: '' },
      {
        error: failing(4, 'Command failed'),
        stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n',
      },
    ])
    await expect(gh.watchChecks({ pullRequest: 7 })).rejects.toThrow(
      /^gh pr checks 7 --json name,state,bucket,link,workflow failed: .*gh auth login$/,
    )
  })

  it('reads the checks only once the watch has returned', async () => {
    // The ordering assertions above are made by a stand-in that calls back
    // synchronously, so they hold the order the calls are issued in and not
    // the waiting, which is the whole of what makes this endpoint a watch.
    // Here the watch answers on a later turn and the read records whether it
    // had settled, so a version that started both calls together and awaited
    // them afterwards is red: against the real gh that one reads the rollup
    // at the moment the watch begins, which is the stale answer the two
    // invocations exist to avoid.
    let watchSettled = false
    const when: string[] = []
    const execFile: ExecFile = (_file, args, _options, callback) => {
      if (args.includes('--watch')) {
        setTimeout(() => {
          watchSettled = true
          callback(null, '', '')
        }, 5)
        return
      }
      when.push(watchSettled ? 'after the watch' : 'before the watch')
      callback(null, '[]', '')
    }
    await createGhClient({ execFile }).watchChecks({ pullRequest: 7 })
    expect(when).toEqual(['after the watch'])
  })
})

it("defaults to node's own execFile", () => {
  // Constructed, not called: calling it would start the real `gh`, which is
  // what every other example here avoids. What this pins is that a client
  // built with no options is a whole client, every endpoint present. That the
  // transport it falls back to is node's own `execFile` is held by the
  // compiler rather than by an assertion: driving it would spawn, and
  // exporting the fallback so a test could compare identities would add a
  // shipped export whose only caller is this file.
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
