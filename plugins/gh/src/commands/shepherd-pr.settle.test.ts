// shepherd-pr, part of its tests: settle, skip, a reader that walked away, the overrides and an internal error.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { type GhClient, ghFails } from '../../../../harness/gh.ts'
import { createGitFixtures } from '../../../../harness/git.ts'
import { createGhServer, depPr } from '../../../../harness/pulls.ts'
import { createSandbox } from '../../../../harness/sandbox.ts'
import {
  CAPTURE,
  COMMENT_URL,
  capture,
  clients,
  closedPipe,
  divergence,
  drive,
  PATHS,
  REPOSITORY,
  recording,
  settleEnv,
  UPDATED,
} from './shepherd-pr.test-support.ts'
import { runShepherdPr } from './shepherd-pr.ts'

it('reports merged when auto-merge lands after the first read', async () => {
  // The field-test race itself: OPEN and CLEAN on the first read, MERGED one
  // poll later.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.result).toBe('merged')
  expect(result.document.mergeCommit).toBe('abc')
  expect(result.document.waited).toBe(1)
})

it('does not block on a single read of BLOCKED', async () => {
  // GitHub reports BLOCKED while it reconciles a check that just went green.
  // So one sample of it is the same race this action exists to close.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'BLOCKED' }),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.result).toBe('merged')
  // The merge it read is the one reported. An uncorroborated BLOCKED sample
  // must not take the answer with it (`test_shepherd_pr.py:731`).
  expect(result.document.mergeCommit).toBe('abc')
})

it('blocks on a merge state that turned BLOCKED mid-poll', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '8'),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [depPr(1), depPr(1, { merge: 'BLOCKED' }), depPr(1, { merge: 'BLOCKED' })],
      },
    }),
  }))

  expect(result.document.result).toBe('blocked')
  expect(result.document.reason).toBe('auto-merge cannot fire: mergeStateStatus is BLOCKED')
  // The snapshot reported is the BLOCKED one, not the clean read the poll
  // opened with (`test_shepherd_pr.py:800`).
  expect((result.document.pr as Record<string, unknown>).mergeStateStatus).toBe('BLOCKED')
})

it('blocks rather than rechecks when a review is required on a base that moved', async () => {
  // This tests precedence, which nothing else asserts. A RECHECK merge state
  // and a required review together must answer `blocked`. If the code
  // reported `changed` instead, it would send the caller off to rebase. That
  // buys a CI run and leaves the pull request exactly as unmergeable as it
  // was (`test_shepherd_pr.py:765`).
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      prs: [depPr(1, { merge: 'BEHIND', checks: 'passed', review: 'REVIEW_REQUIRED' })],
      replies: { viewRepository: REPOSITORY },
    }),
  }))

  expect(result.document.result).toBe('blocked')
  expect(result.document.reason).toBe('auto-merge cannot fire: reviewDecision is REVIEW_REQUIRED')
})

it('reports closed when the pull request is closed while it waits', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), depPr(1, { state: 'CLOSED' })] },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('closed')
  expect(result.document.waited).toBe(1)
})

it('keeps polling when one read fails and reports the answer that followed', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '8'),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1),
          ghFails('HTTP 502: Bad gateway'),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('merged')
  expect(result.document.read_failures).toBe(1)
  // The read that recovered cleared the account of the one that failed. The
  // Python does the same thing. Every read attempt overwrites `read_err`, so
  // the field describes the LAST read, and the count describes the whole run.
  expect(result.document.read_error).toBe('')
})

it('refuses when the bound arrives on a read that failed', async () => {
  // A report with nothing against it would describe a silence, not the
  // failure that happened.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), ghFails('HTTP 502: Bad gateway')] },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe(
    'settle waited 3s but could not re-read the pull request (3 of 4 reads failed, the last ' +
      'among them): HTTP 502: Bad gateway',
  )
  expect(result.document).not.toHaveProperty('result')
  expect(result.document.read_error).toBe('HTTP 502: Bad gateway')
})

it('polls at least once when the bound is shorter than the interval', async () => {
  // A bound below one interval must still buy a read, not answer from the
  // first one.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '1', '2'),
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.waited).toBe(2)
  expect(result.document.reads_ok).toBe(2)
})

it('measures the time it waited rather than adding up its sleeps', async () => {
  // Each read takes time of its own on a slow gh. The agent copies `waited`
  // into its report. This shows how long the caller gave GitHub to answer.
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const writers = capture()
  let elapsed = 0
  const server = createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } })
  const gh: GhClient = {
    ...server,
    viewPullRequest: async (pull) => {
      // A read that costs a second of the clock, though nobody calls sleep.
      elapsed += 1000
      return server.viewPullRequest(pull)
    },
  }
  const status = await runShepherdPr([repo, '1', 'settle'], {
    cwd: repo,
    env: settleEnv(sandbox, '4', '1'),
    output: writers.output,
    createGh: () => gh,
    now: () => elapsed,
    sleep: async (milliseconds) => {
      elapsed += milliseconds
    },
  })
  const document = JSON.parse(writers.stdout())

  expect(status).toBe(0)
  expect(document.result).toBe('open')
  // There is one sleep of a second per poll. So a settle that added up its
  // own sleeps would report exactly the number of polls it made.
  expect(document.waited).toBeGreaterThan(document.reads_ok - 1)
})

it('refuses a settle whose checks are neither passed nor absent, without watching', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: { viewRepository: REPOSITORY },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe(
    'refused: checks are pending; settle acts on passed or none, and `wait` is what watches a run',
  )
})

it('reads a merge state gh answered as null as no merge state at all', async () => {
  // `mergeStateStatus` is not a field `missingField` requires, so null is a
  // real answer: GitHub has not computed one yet. Truthiness folds it to "",
  // which is neither BLOCKED nor a recheck trigger. So settle continues to
  // poll.
  const unknownState = { ...depPr(1), mergeStateStatus: null }
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({ prs: [unknownState], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.result).toBe('open')
  expect(result.document.waited).toBe(3)
})

it('reports open with the count when a read failed and a later one recovered', async () => {
  // The report counts the failure. The snapshot is fresh. The account of the
  // failure is gone, because the read that followed it answered.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), ghFails('HTTP 502: Bad gateway'), depPr(1)] },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('open')
  expect(result.document.read_failures).toBe(1)
  expect(result.document.reads_ok).toBe(3)
  expect(result.document.read_error).toBe('')
})

// --- skip -----------------------------------------------------------------------------

it('refuses a reason file that is not there at all', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', sandbox.join('nothing.md')],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('reason file is missing or empty')
})

it('refuses a reason file that is a directory', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', sandbox.path],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('reason file is missing or empty')
})

it('posts the reason file it was given, as the body of the comment', async () => {
  // This uses `--body-file`, never `--body`. The reason is a file the caller
  // wrote. A literal here would post something nobody reviewed
  // (`gh-shepherd-pr.py:928`). The number is the one the caller named.
  const record = recording({
    prs: [depPr(4)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let reason = ''
  let target = ''

  const result = await drive((sandbox, repo) => {
    reason = PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''
    target = repo
    return { argv: [repo, '4', 'skip', reason], gh: record.gh }
  })

  expect(record.comments).toEqual([{ pullRequest: 4, bodyFile: reason }])
  expect(result.ghOptions).toEqual(clients(target))
})

it('vets the reason file gh will read, not one beside this process', async () => {
  // The Python changed directory (`os.chdir`) to the target before both the
  // check and the comment (`gh-shepherd-pr.py:1007`, `:920`, `:928`). So a
  // relative path named one file to both. This port does not change
  // directory, and gh runs with the target as its own working directory. So
  // the path must resolve against the target. Otherwise, the file this test
  // vets is not the file it posts.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let expected = ''

  const result = await drive((_sandbox, repo) => {
    writeFileSync(path.join(repo, 'why.md'), 'not a mechanical fix\n')
    expected = path.join(realpathSync(repo), 'why.md')
    return { argv: [repo, '1', 'skip', 'why.md'], gh: record.gh }
  })

  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe('skip comment posted')
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: expected }])
})

it('posts the file it vetted, even when the target is a symbolic link', async () => {
  // The two derivations of the path must be one value. `chdir` resolved
  // symbolic links for the Python. `path.resolve` does not, and gh runs with
  // the target as its own working directory. The example takes a target that
  // is a link, with a reason file that climbs out of it with `..`. That
  // names `<link>/../why.md` to the guard, and `<real>/../why.md` to gh: two
  // different files. The guard checks one, but gh could post the other,
  // unchecked, on someone else's pull request.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let posted = ''
  let vetted = ''

  const result = await drive((sandbox, repo) => {
    // The file gh reaches through the link, and the one a lexical resolution
    // would reach instead. Only the first is ever stat'd.
    vetted = path.join(realpathSync(repo), '..', 'why.md')
    writeFileSync(vetted, 'the reason that was vetted\n')
    mkdirSync(sandbox.join('elsewhere'), { recursive: true })
    posted = sandbox.join('elsewhere', 'link')
    symlinkSync(repo, posted)
    // This is the decoy, so the lexical answer is a file that EXISTS.
    // Without it, the guard simply refuses. This case matters when both files
    // exist and the wrong one goes out.
    writeFileSync(sandbox.join('elsewhere', 'why.md'), 'never looked at\n')
    return { argv: [posted, '1', 'skip', path.join('..', 'why.md')], gh: record.gh }
  })

  expect(result.document.ok).toBe(true)
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: path.resolve(vetted) }])
})

it('reports no comment url when gh printed none', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''],
    gh: createGhServer({
      prs: [depPr(1)],
      replies: { viewRepository: REPOSITORY, addComment: 'nothing that looks like a link\n' },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.comment_url).toBe('')
})

it('reports the last url gh printed as the comment url', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''],
    gh: createGhServer({
      prs: [depPr(1)],
      replies: {
        viewRepository: REPOSITORY,
        addComment:
          'https://github.com/acme/widgets/pull/1 https://github.com/last#issuecomment-2\n',
      },
    }),
  }))

  expect(result.document.comment_url).toBe('https://github.com/last#issuecomment-2')
})

it('lets a reader that left stop the report, never the rebase', async () => {
  // `test_shepherd_pr.py:1135` asserted the composite: the reader is gone,
  // the branch was still updated, and the status is 0. Two other tests pin
  // the halves apart. `lib/streams.test.ts` pins the writer's EPIPE guard.
  // `reports an update that worked and a read that did not` pins the update.
  // This test proves the composite itself, in process.
  const record = recording({
    replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
    sequences: {
      viewPullRequest: [depPr(1, { merge: 'BEHIND' }), depPr(1, { head: 'rebased' })],
    },
  })

  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: record.gh,
    reader: closedPipe,
  }))

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(record.updates).toEqual([{ pullRequest: 1, rebase: true }])
})

it('lets a reader that left stop the report, never the skip comment', async () => {
  // `test_shepherd_pr.py:1149` is the same composite, for the other write.
  // The command posts the comment before it writes the report. So a reader
  // that goes away cannot take the comment with it.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let reason = ''

  const result = await drive((sandbox, repo) => {
    reason = PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''
    return { argv: [repo, '1', 'skip', reason], gh: record.gh, reader: closedPipe }
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: reason }])
})

// --- the environment overrides that were not used ----------------------------------------

it('says nothing when no override was given', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it('reads an override set to nothing as an override nobody set', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_LOG_LINES: '' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it('refuses a log line count of zero, which would keep no log at all', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_LOG_LINES: '0' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('SHEPHERD_LOG_LINES=0 ignored; using 60\n')
})

it('accepts a CI estimate of zero, which is a number even though it is not positive', async () => {
  // This code reads `SHEPHERD_CI_SECONDS` with the digits pattern, not the
  // positive one. That is what makes the "polls at least once" arm reachable
  // at all.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '0' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it.each([
  ['answered without one at all', { defaultBranchRef: { name: 'main' } }],
  // `view.get("nameWithOwner") or None` (`gh-shepherd-pr.py:973`): a
  // repository named `""` means gh answered nothing. A null guard takes it,
  // and every later call then carries `--repo ""`.
  ['named the empty string', { nameWithOwner: '', defaultBranchRef: { name: 'main' } }],
])('refuses a repository gh %s', async (_name, view) => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({ replies: { viewRepository: view } }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'could not resolve the repository with gh: gh answered without nameWithOwner\n',
  )
  expect(result.stdout).toBe('')
})

it('refuses a path that is a file rather than a directory', async () => {
  const result = await drive((sandbox, _repo) => {
    const file = sandbox.join('a-file')
    writeFileSync(file, 'not a directory\n')
    return { argv: [file, '1', 'state'], gh: createGhServer({ prs: [depPr(1)] }) }
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toMatch(/^not a directory: /)
})

// --- an internal error --------------------------------------------------------------------

it('reports an internal error rather than a stack trace, and exits 3', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({}),
      viewRepository: async () => {
        throw new RangeError('boom')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(`${divergence('internalError').now}RangeError: boom\n`)
  // The status and the silence on stdout are the Python's, unchanged: only
  // the name in front of `internal error` differs.
  expect(result.status).toBe(CAPTURE.an_internal_error?.status)
  expect(result.stdout).toBe(CAPTURE.an_internal_error?.stdout)
  expect(CAPTURE.an_internal_error?.stderr).toContain(divergence('internalError').was)
})

it('reports something that is not an Error at all as an internal error too', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({}),
      viewRepository: async () => {
        throw 'a string nobody should throw'
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(
    `${divergence('internalError').now}string: a string nobody should throw\n`,
  )
})

it('lets a failure that is not gh’s out of a read, rather than reporting it as one', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({ replies: { viewRepository: REPOSITORY } }),
      viewPullRequest: async () => {
        throw new TypeError('not an object')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('internal error: TypeError: not an object')
})

it('lets a failure that is not gh’s out of a mutating call', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: {
      ...createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
      updateBranch: async () => {
        throw new TypeError('not a string')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('internal error: TypeError: not a string')
})
