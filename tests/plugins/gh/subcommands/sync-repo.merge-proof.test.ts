// sync-repo, part of its tests: advancing, merge proof and the per-branch fallback.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync-repo.test-support.ts` holds the helpers and the header that says what the tests prove.
import { describe, expect, it } from 'vitest'
import { createGhMock, GhError } from '#harness/gh.ts'
import { manyPrs, pr } from '#harness/pulls.ts'
import {
  DIVERGENCES,
  fixture,
  ghDouble,
  run,
  SCENARIOS,
  shimmed,
} from './sync-repo.test-support.ts'

// --- advancing the default branch ---------------------------------------------

describe('advancing', () => {
  it('fast-forwards a default branch that is behind', async () => {
    const f = fixture()
    SCENARIOS.fast_forward?.(f)
    const before = f.git.headSha(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('fast-forwarded')
    expect(f.git.headSha(f.repo)).not.toBe(before)
  })

  it('switches to the default branch from a feature branch', async () => {
    const f = fixture()
    SCENARIOS.switch_to_the_default_branch?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('switched from side to main')
    expect(f.git.currentBranch(f.repo)).toBe('main')
  })

  it('refuses to merge a diverged default branch and keeps the local commit', async () => {
    const f = fixture()
    SCENARIOS.diverged?.(f)
    const local = f.git.headSha(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('has diverged')
    expect(f.git.headSha(f.repo)).toBe(local)
  })

  it('reports a failed fetch and changes nothing', async () => {
    const f = fixture()
    SCENARIOS.fetch_failed?.(f)
    const before = f.git.branches(f.repo)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('fetch failed; nothing changed')
    expect(f.git.branches(f.repo)).toEqual(before)
  })

  it('names HEAD rather than printing a null branch name', async () => {
    // "HEAD" is what git itself echoes for an unborn or unreadable HEAD, and
    // what the shell version printed.
    const f = fixture()

    const result = await run(f, ['--dry-run', f.repo], {
      env: shimmed(f, 'rev-parse --abbrev-ref'),
    })

    expect(result.stdout).toContain('would switch from HEAD to main')
    expect(result.stdout).not.toContain('null')
  })

  it('falls back to the full sha when an abbreviation cannot be read', async () => {
    // The commit is the recoverable part of "deleted <branch> (<sha>)".
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    const sha = f.git.sha(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')

    const result = await run(f, [f.repo], { env: shimmed(f, 'rev-parse --short') })

    expect(result.stdout).toContain(`deleted landed (${sha}, merged into main)`)
    expect(result.stdout).not.toContain('null')
  })

  it('reports a default branch tip it could not read, and still advances', async () => {
    // With no left end, there is no range to print, and nothing to diff a
    // lock file over. So the code must skip the install. A silent skip would
    // leave the checkout on new code with possibly stale dependencies.
    const f = fixture()
    f.git.lockfile(f.repo, 'pnpm-lock.yaml')
    f.git.remoteAdvance(f.repo, 'pnpm-lock.yaml')

    const result = await run(f, [f.repo], {
      env: shimmed(f, 'rev-parse --short', 'rev-parse main'),
    })

    expect(result.stdout).toContain(
      'could not read the tip of main; install by hand if a lock file changed',
    )
    expect(result.stdout).toContain('fast-forwarded main to')
    expect(result.stdout).not.toContain('null')
    expect(result.stdout).not.toContain('dependencies installed')
    expect(f.git.sha(f.repo, 'main')).toBe(f.git.sha(f.repo, 'refs/remotes/origin/main'))
  })
})

// --- proving a branch has merged ----------------------------------------------

describe('merge proof', () => {
  it('deletes a branch merged with a merge commit, on ancestry alone', async () => {
    const f = fixture()
    SCENARIOS.delete_on_ancestry?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('deleted ff-done')
    expect(f.git.branches(f.repo)).not.toContain('ff-done')
  })

  it('deletes a squash-merged branch on pull-request proof', async () => {
    // Ancestry cannot see a squash merge at all.
    const f = fixture()
    const built = SCENARIOS.delete_on_pull_request_proof?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('deleted squashed')
    expect(result.stdout).toContain('merged PR')
    expect(f.git.branches(f.repo)).not.toContain('squashed')
  })

  it('KEEPS a branch whose name matches a merged PR but whose tip has moved', async () => {
    // This is the regression that mattered. A name match alone force-deleted
    // a branch, even a reused name, or one with work committed after the PR
    // merged.
    const f = fixture()
    const built = SCENARIOS.keep_a_branch_whose_tip_has_moved?.(f)
    const danger = f.git.sha(f.repo, 'reused')

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept reused (merged PRs used this name; none at this commit)')
    expect(f.git.branches(f.repo)).toContain('reused')
    expect(f.git.sha(f.repo, 'reused')).toBe(danger)
  })

  it('ignores a merged pull request that came from a fork', async () => {
    // A fork PR's head ref is just a name like patch-1, which collides with
    // local branches trivially.
    const f = fixture()
    const built = SCENARIOS.ignore_a_fork_pull_request?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept patch-1 (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('patch-1')
  })

  it('ignores a pull request merged into another base', async () => {
    const f = fixture()
    const built = SCENARIOS.ignore_another_base?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept for-release (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('for-release')
  })

  it('keeps a branch sitting on the default branch tip', async () => {
    const f = fixture()
    SCENARIOS.keep_a_branch_on_the_tip?.(f)

    const result = await run(f, [f.repo])

    expect(result.stdout).toContain('kept fresh (already at origin/main')
    expect(f.git.branches(f.repo)).toContain('fresh')
  })

  it('falls back to ancestry and says why when the pull request lookup fails', async () => {
    const f = fixture()
    const built = SCENARIOS.pull_request_lookup_failed?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh: simulated failure); using ancestry alone',
    )
    expect(result.stdout).toContain('deleted ff-done')
  })

  it('names a gh that is not on PATH in the words the Python used', async () => {
    // 127 is the runner's answer for a command that is not there. This is the
    // one gh failure whose sentence the port spells itself.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = {
      ...ghDouble(),
      listMergedPullRequests: async () => {
        throw new GhError('gh pr list failed: cannot run gh: spawn gh ENOENT', 127, {
          cause: 'test',
          detail: 'cannot run gh: spawn gh ENOENT',
        })
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh is not on PATH); using ancestry alone',
    )
    expect(result.stdout).toContain('deleted landed')
  })

  it("carries gh's own last line into the report, and never the argv with it", async () => {
    // gh's last line is the useful half of a failure. It may be an auth
    // prompt, a rate limit, or a repository it cannot see.
    //
    // The error is the REAL client's shape. Round 1 could not assert this.
    // `lib/gh.ts` puts `gh <argv> failed: ` in front of gh's account in the
    // message. It carries the account alone as `detail`. A rate limit is ONE
    // line of stderr, the usual shape. So a report that tailed the message
    // would quote forty characters of `--json` fields at the reader.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const argv =
      'gh pr list --state merged --base main --limit 200 --json ' +
      'headRefName,headRefOid,isCrossRepository'
    const gh = {
      ...ghDouble(),
      listMergedPullRequests: async () => {
        throw new GhError(`${argv} failed: gh: API rate limit exceeded`, 1, {
          cause: 'test',
          detail: 'gh: API rate limit exceeded',
        })
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh: API rate limit exceeded); using ancestry alone',
    )
    expect(result.stdout).not.toContain('--json')
  })

  it('tails a multi-line account, the way the Python tails a multi-line stderr', async () => {
    // `gh_json` prints `last_line(stderr)`, so a warning gh wrote before the
    // real complaint does not become the reason. `accountOf` hands the whole
    // trimmed stderr over as `detail`, and this test checks that trim.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = {
      ...ghDouble(),
      listMergedPullRequests: async () => {
        throw new GhError('gh pr list failed: gh: warming up\ngh: HTTP 502', 1, {
          cause: 'test',
          detail: 'gh: warming up\ngh: HTTP 502',
        })
      },
    }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain('could not read merged pull requests (gh: HTTP 502)')
    expect(result.stdout).not.toContain('warming up')
  })

  it('names every other way gh can fail, in the words the failure arrived with', async () => {
    // The Python spells its own sentence for each of four states. A gh can be
    // there but refuse to run. An answer can fail to be JSON. It can be JSON
    // but not a list. Or a signal can end gh, which it then reports as a
    // negative exit status.
    //
    // `lib/gh.ts` owns that vocabulary now. It puts the vocabulary in the
    // error's message. So the port reports the last line of whatever
    // arrived, rather than deciding it again. Each failure still reaches the
    // reader as its own sentence. That is what the Python's `gh_json`
    // comment asks for: three failures that send the reader to three
    // different places.
    //
    // This reads from `fixtures/divergences.json` rather than restating it
    // here. Each line is what the report says, instead of what the Python
    // said for the same state. A divergence asserted only in a test does not
    // count. Anyone who adds or changes one must record it there before this
    // test goes green.
    const lines = DIVERGENCES.ghVocabulary.lines
    expect(lines).toHaveLength(4)
    for (const { account, message } of lines) {
      const f = fixture()
      f.git.branchWithWork(f.repo, 'landed')
      f.git.mergeCommit(f.repo, 'landed')
      const gh = {
        ...ghDouble(),
        listMergedPullRequests: async () => {
          // Both halves come from the table. `message` is what the real
          // client's error says. `account` is the part of it a report may
          // quote. They are the same string where there is no argv prefix to
          // strip, and different where there is.
          throw new GhError(message, 1, { cause: 'test', detail: account })
        },
      }

      const result = await run(f, [f.repo], { gh })

      expect(result.stdout).toContain(`could not read merged pull requests (${account});`)
      // The degraded path is the point: ancestry still proves this branch.
      expect(result.stdout).toContain('deleted landed')
    }
  })

  it("reads the two closed divergences in the Python's own words, not in lib/gh.ts's", async () => {
    // `ghVocabulary.closed` records the lines that no longer diverge, since
    // `lib/gh.ts` gave `GhError` a `detail` field. It was prose before, and
    // prose is not a check. The table claimed these lines could not quietly
    // return, but nothing enforced that. This test now drives the check from
    // the table itself. So a `reasonFor` that tailed `message` again would
    // put `was` back in the report and turn this test red. If someone
    // removes a line from `lines` without earning that, this test fails
    // here, not silently.
    for (const { was, account, message } of DIVERGENCES.ghVocabulary.closed.lines) {
      const f = fixture()
      f.git.branchWithWork(f.repo, 'landed')
      f.git.mergeCommit(f.repo, 'landed')
      const gh = {
        ...ghDouble(),
        listMergedPullRequests: async () => {
          throw new GhError(message, 1, { cause: 'test', detail: account })
        },
      }

      const result = await run(f, [f.repo], { gh })

      expect(result.stdout).toContain(`could not read merged pull requests (${account});`)
      expect(result.stdout).not.toContain(was)
      // The degraded path is the point: ancestry still proves this branch.
      expect(result.stdout).toContain('deleted landed')
    }
  })

  it('treats a list of things that are not pull requests as unreadable', async () => {
    // Every reader asks a row for a field. So this case must route to the
    // same degraded path a failed query takes. The code must not read it as
    // an empty window instead.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    f.git.mergeCommit(f.repo, 'landed')
    const gh = { ...ghDouble(), listMergedPullRequests: async () => [1, 2, 3] }

    const result = await run(f, [f.repo], { gh })

    expect(result.stdout).toContain(
      'could not read merged pull requests (gh returned rows that are not pull requests); ' +
        'using ancestry alone',
    )
    expect(result.stdout).toContain('deleted landed')
  })

  it('lets a failure that is not gh out, rather than reading it as an empty window', async () => {
    // `createGhMock` throws a plain Error for an endpoint nobody registered.
    // This is the property a stub binary cannot give. Suppose this test
    // swallowed that error instead. Then a command that made an unexpected
    // call would look like a repository with no merged pull requests.
    const f = fixture()

    await expect(run(f, [f.repo], { gh: createGhMock({}) })).rejects.toThrow(
      /no reply registered for listMergedPullRequests/,
    )
  })

  it('uses pull requests alone when ancestry cannot be read', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'squashed')
    const sha = f.git.sha(f.repo, 'squashed')
    f.git.mergeSquash(f.repo, 'squashed')

    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const result = await run(f, [f.repo], {
      gh: ghDouble({ prs: [pr('squashed', sha, 'main', false, landed)] }),
      env: shimmed(f, 'branch --merged'),
    })

    expect(result.stdout).toContain('could not read merged branches; using pull requests alone')
    expect(result.stdout).toContain('deleted squashed')
  })

  it('skips pruning entirely when neither signal can be read', async () => {
    // A prune with no proof is exactly the force delete every guard here
    // prevents.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'wip')

    const result = await run(f, [f.repo], {
      gh: ghDouble({ fail: 'all' }),
      env: shimmed(f, 'branch --merged'),
    })

    expect(result.stdout).toContain('no way to prove what has merged; skipped pruning entirely')
    expect(f.git.branches(f.repo)).toContain('wip')
  })
})

// --- the per-branch fallback ---------------------------------------------------

describe('the per-branch fallback', () => {
  it('proves a branch whose pull request falls outside the bulk lookup window', async () => {
    // Found in the field: a repository with more merged pull requests than
    // the bulk limit drops the oldest ones. Branches merged before that
    // window looked unproven, and the old code kept them forever.
    const f = fixture()
    const built = SCENARIOS.past_the_bulk_window?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('deleted landed')
    expect(result.stdout).toContain('merged PR')
    expect(f.git.branches(f.repo)).not.toContain('landed')
  })

  it('does not ask about a branch the bulk lookup already proved', async () => {
    // This test guards the call volume: the per-branch query is a fallback,
    // not a second opinion. If it asked unconditionally, a repository with
    // many branches would need an API call for each one. This test proves
    // that by making the per-branch query fail. A run that asked would report
    // the failure, but this one does not.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'landed')
    const sha = f.git.sha(f.repo, 'landed')
    // Any commit on main passes the merge-commit guard; the row's head is
    // this very tip.
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const prs = manyPrs(199, pr('landed', sha, 'main', false, landed), pr('spare', 'zzz'))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('deleted landed')
    expect(result.stdout).not.toContain('could not ask about this branch')
  })

  it('stops asking after the first failure, and says the run was incomplete', async () => {
    const f = fixture()
    const built = SCENARIOS.per_branch_query_failed?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept first (could not ask about this branch')
    expect(result.stdout).toContain('kept second (could not ask about this branch')
    expect(result.stdout).toContain('2 branch(es) were never checked')
  })

  it('refuses to conclude when one name fills the per-branch window', async () => {
    const f = fixture()
    const built = SCENARIOS.per_branch_window_crowded?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('too many merged PRs used this name to tell')
    expect(f.git.branches(f.repo)).toContain('busy')
  })

  it('ignores another base in the per-branch query', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'for-release-2')
    const sha = f.git.sha(f.repo, 'for-release-2')
    // The merge commit is on `release`, not on main, so the guard refuses it.
    const merged = { number: 1, mergeCommit: sha }
    const prs = manyPrs(200, pr('for-release-2', sha, 'release', false, merged))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept for-release-2 (no merge proof)')
  })

  it('still requires the commit to match in the fallback', async () => {
    // The fallback must not be a weaker signal than the bulk lookup.
    const f = fixture()
    const built = SCENARIOS.per_branch_tip_moved?.(f)

    const result = await run(f, [f.repo], { gh: built?.gh })

    expect(result.stdout).toContain('kept moved (merged PRs used this name; none at this commit)')
    expect(f.git.branches(f.repo)).toContain('moved')
  })

  it('ignores a fork pull request in the fallback too', async () => {
    const f = fixture()
    f.git.branchWithWork(f.repo, 'patch-2')
    const sha = f.git.sha(f.repo, 'patch-2')
    const prs = manyPrs(200, pr('patch-2', sha, 'main', true))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs }) })

    expect(result.stdout).toContain('kept patch-2 (no merge proof)')
    expect(f.git.branches(f.repo)).toContain('patch-2')
  })

  it('keeps a moved verdict when the per-branch query fails', async () => {
    // The bulk window already proved that merged pull requests used this
    // name. A later failed call does not undo that fact. A report of "never
    // checked" would throw away a real answer.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'reused')
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const prs = manyPrs(199, pr('reused', 'othersha', 'main', false, landed))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('kept reused (merged PRs used this name; none at this commit)')
    expect(result.stdout).not.toContain('never checked')
    expect(f.git.branches(f.repo)).toContain('reused')
  })

  it('keeps a moved verdict once the fallback is switched off', async () => {
    // `aaa` sorts first. No pull request names it, and its query fails,
    // which turns the fallback off. `zzz-reused` then reaches the no-call arm
    // with a "moved" verdict already in hand. That verdict has to survive
    // there too.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'aaa')
    f.git.branchWithWork(f.repo, 'zzz-reused')
    const landed = { number: 1, mergeCommit: f.git.sha(f.repo, 'main') }
    const prs = manyPrs(199, pr('zzz-reused', 'othersha', 'main', false, landed))

    const result = await run(f, [f.repo], { gh: ghDouble({ prs, fail: 'head' }) })

    expect(result.stdout).toContain('kept aaa (could not ask about this branch')
    expect(result.stdout).toContain(
      'kept zzz-reused (merged PRs used this name; none at this commit)',
    )
    expect(result.stdout).toContain('1 branch(es) were never checked')
  })

  it('says it could not check when the per-branch query fails', async () => {
    // This differs from "no merge proof": the code settled nothing either
    // way. A report of an absence it never checked is the defect this fixes.
    const f = fixture()
    f.git.branchWithWork(f.repo, 'unchecked')

    const result = await run(f, [f.repo], { gh: ghDouble({ prs: manyPrs(200), fail: 'head' }) })

    expect(result.stdout).toContain('could not ask about this branch')
    expect(f.git.branches(f.repo)).toContain('unchecked')
  })
})
