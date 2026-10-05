// The watch command. `gh` is the injected double. The clock and the sleep
// are fakes, so many polls take no real time. Each example states
// what gh answers on each poll, and asserts the lines the watch wrote. git is
// real: the watch asks git once whether it stands in a checkout.
import { describe, expect, it } from 'vitest'

import {
  type CheckContext,
  createGhMock,
  type GhClient,
  GhError,
  type GhReplies,
  ghFails,
  type PullRequestHead,
} from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'
import {
  HEARTBEAT_MS,
  parseSeeds,
  runWatch,
  type WatchContext,
} from '#workstreams/subcommands/watch.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const REQUIRED = ['vitest', 'types', 'biome']

const head = (overrides: Partial<PullRequestHead> = {}): PullRequestHead => ({
  number: 259,
  title: 'feat(workstreams): pr-state and sweep',
  head: 'wktr-219-pr-sweep',
  headSha: SHA_A,
  base: 'main',
  draft: true,
  crossRepository: false,
  checks: [],
  ...overrides,
})

const done = (name: string, conclusion = 'SUCCESS', startedAt: string | null = null) => ({
  name,
  status: 'COMPLETED',
  conclusion,
  startedAt,
})

/** What gh answers on one poll. `required` is by branch; a branch it does
 *  not name has no ruleset. A branch's own entry can fail on its own. That
 *  is distinct from a poll where every branch fails at once (#265). */
interface Poll {
  readonly heads?: GhReplies['listOpenPullRequestHeads'] | Error
  readonly required?: Readonly<Record<string, readonly string[] | Error>> | Error
  readonly repository?: GhReplies['viewRepository'] | Error
  readonly detail?: GhReplies['viewPullRequestDetail']
}

const REPOSITORY = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }

/**
 * A watch over `polls`, one entry per poll; the last entry repeats. The
 * double answers from the entry of the current poll. The fake sleep moves
 * the clock and the entry on.
 */
const watchOver = (polls: readonly Poll[], overrides: Partial<WatchContext> = {}) => {
  // A sandbox per example: `createSandbox` removes its directory when the
  // example ends. The checkout is there for the one question the watch
  // asks git, whether it stands in a checkout at all.
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('repo'))
  let index = 0
  let clock = 1_000_000
  const lines: string[] = []
  const current = (): Poll => polls[Math.min(index, polls.length - 1)] as Poll
  const base = createGhMock()
  const reply = <T>(value: T | Error | undefined, name: string): T => {
    if (value === undefined) throw new Error(`gh mock: no reply registered for ${name}`)
    if (value instanceof Error) throw value
    return value
  }
  const gh: GhClient = {
    ...base,
    viewRepository: async () => reply(current().repository ?? REPOSITORY, 'viewRepository'),
    listOpenPullRequestHeads: async () => reply(current().heads, 'listOpenPullRequestHeads'),
    // The real endpoint never throws. A read that fell short comes back
    // with its reason, and a registered failure here does the same.
    requiredContexts: async ({ branch }) => {
      const byBranch = current().required ?? { main: REQUIRED }
      if (byBranch instanceof Error) return { contexts: [], unavailable: byBranch.message }
      const answer = byBranch[branch] ?? []
      if (answer instanceof Error) return { contexts: [], unavailable: answer.message }
      return { contexts: answer, unavailable: null }
    },
    viewPullRequestDetail: async () => reply(current().detail, 'viewPullRequestDetail'),
  }
  const context: WatchContext = {
    createGh: () => gh,
    cwd: repo,
    env: sandbox.env,
    write: (line) => {
      lines.push(line)
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      index += 1
    },
    stopped: () => false,
    ...overrides,
  }
  return { context, lines, gh, elapsed: () => clock - 1_000_000 }
}

const heads = (...rows: PullRequestHead[]) => ({ rows, unavailable: null })

describe('a watch over one round’s heads (#376)', () => {
  const ours = head({ number: 300, head: 'wktr-12-ours', headSha: SHA_B })
  const theirs = head({ number: 301, head: 'wktr-20-theirs', headSha: SHA_C })
  const fork = head({ number: 302, head: 'wktr-12-ours', headSha: SHA_A, crossRepository: true })

  it('writes nothing about a pull request whose head branch is not named', async () => {
    const { context, lines } = watchOver([{ heads: heads(ours, theirs, fork) }])

    await runWatch(['--ticks', '1', '--heads', ' wktr-12-ours , ,wktr-99-none'], context)

    expect(lines).toEqual([
      'heads with no open pull request from this repository: wktr-99-none',
      `#300 open: wktr-12-ours -> main, head ${SHA_B}, draft, required 0/3 reported`,
    ])
  })

  it('names a head with no open pull request once for each new set of such names', async () => {
    const { context, lines } = watchOver([
      { heads: heads() },
      { heads: heads() },
      { heads: heads(ours) },
    ])

    await runWatch(['--ticks', '3', '--heads', 'wktr-12-ours,wktr-13-next'], context)

    expect(lines.filter((line) => line.startsWith('heads with'))).toEqual([
      'heads with no open pull request from this repository: wktr-12-ours, wktr-13-next',
      'heads with no open pull request from this repository: wktr-13-next',
    ])
  })

  it('says nothing about absent heads on a poll whose list fell short', async () => {
    const { context, lines } = watchOver([
      { heads: { rows: [theirs], unavailable: 'gh: one page short' } },
    ])

    await runWatch(['--ticks', '1', '--heads', 'wktr-12-ours'], context)

    expect(lines.some((line) => line.startsWith('heads with'))).toBe(false)
  })

  it('reports a named pull request that merged, and nothing for another round’s', async () => {
    const merged = { pullRequest: null, unavailable: null, missing: false }
    const { context, lines } = watchOver([
      { heads: heads(ours, theirs) },
      {
        heads: heads(),
        detail: { ...merged, pullRequest: { ...detailOf(300), state: 'MERGED' } },
      },
    ])

    await runWatch(['--ticks', '2', '--heads', 'wktr-12-ours'], context)

    expect(lines.slice(1)).toEqual([
      'heads with no open pull request from this repository: wktr-12-ours',
      '#300 merged',
    ])
  })

  it('stays silent about a base that only another round’s pull request needs', async () => {
    const stacked = head({ number: 303, head: 'wktr-21-up', headSha: SHA_C, base: 'wktr-20-x' })
    const { context, lines } = watchOver([
      { heads: heads(ours, stacked), required: { main: REQUIRED, 'wktr-20-x': new Error('down') } },
    ])

    await runWatch(['--ticks', '1', '--heads', 'wktr-12-ours'], context)

    expect(lines).toEqual([
      `#300 open: wktr-12-ours -> main, head ${SHA_B}, draft, required 0/3 reported`,
    ])
  })

  it.each([[['--heads', ' , ']], [['--heads=']]])(
    'refuses %j, which names no branch',
    async (argv) => {
      const { context } = watchOver([{ heads: heads(ours) }])

      expect(await runWatch(argv, context)).toEqual({
        outcome: 'refused',
        error: '--heads takes one or more branch names',
      })
    },
  )

  it('watches every open pull request when no head is named', async () => {
    const { context, lines } = watchOver([{ heads: heads(ours, theirs) }])

    await runWatch(['--ticks', '1'], context)

    expect(lines.map((line) => line.split(':')[0])).toEqual(['#300 open', '#301 open'])
  })

  it('refuses a repeated --heads', async () => {
    const { context } = watchOver([{ heads: heads(ours) }])

    expect(await runWatch(['--heads', 'a', '--heads', 'b'], context)).toEqual({
      outcome: 'refused',
      error: '--heads is not repeatable; pass one comma-separated list',
    })
  })
})

describe('a watch over the open pull requests', () => {
  it('reports a pull request it has not seen, with its head in full', async () => {
    const { context, lines } = watchOver([{ heads: heads(head()) }])

    const answer = await runWatch(['--ticks', '1'], context)

    expect(answer).toEqual({ outcome: 'ok', value: '' })
    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
    ])
  })

  it('reports each required context as it reports, and concludes only when all three have', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ checks: [done('vitest')] })) },
      { heads: heads(head({ checks: [done('vitest'), done('types')] })) },
      {
        heads: heads(head({ checks: [done('vitest'), done('types'), done('biome')] })),
      },
      {
        heads: heads(head({ checks: [done('vitest'), done('types'), done('biome')] })),
      },
    ])

    await runWatch(['--ticks', '5'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      '#259 aaaaaaa vitest: SUCCESS',
      '#259 aaaaaaa types: SUCCESS',
      '#259 aaaaaaa biome: SUCCESS',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, all passed',
    ])
  })

  it('does not conclude on seven checks that no ruleset requires (round 5)', async () => {
    const codeql = Array.from({ length: 7 }, (_, index) => done(`CodeQL ${index}`))
    const { context, lines } = watchOver([{ heads: heads(head({ checks: codeql })) }])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
    ])
  })

  it('does not conclude while one required context is still running', async () => {
    const running = { name: 'biome', status: 'IN_PROGRESS', conclusion: null, startedAt: null }
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: [done('vitest'), done('types'), running] })) },
    ])

    await runWatch(['--ticks', '2'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 2/3 reported`,
    ])
  })

  it('names each failure on the concluded line and on the first line', async () => {
    const checks = [done('vitest', 'FAILURE'), done('types', 'SKIPPED'), done('biome', 'CANCELLED')]
    const { context, lines } = watchOver([{ heads: heads(head({ checks })) }])

    await runWatch(['--ticks', '1'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 3/3 reported, ` +
        'failed: vitest (FAILURE), biome (CANCELLED)',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, failed: vitest (FAILURE), biome (CANCELLED)',
    ])
  })

  it('waits for the default branch list on a stacked layer whose base no ruleset covers (P9)', async () => {
    const stacked = head({ base: 'wktr-244-ws-hook', draft: false })
    const { context, lines } = watchOver([
      { heads: heads({ ...stacked, checks: [done('CodeQL')] }) },
      { heads: heads({ ...stacked, checks: [done('CodeQL'), ...REQUIRED.map((n) => done(n))] }) },
    ])

    await runWatch(['--ticks', '2'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> wktr-244-ws-hook, head ${SHA_A}, ready, required 0/3 reported`,
      '#259 aaaaaaa vitest: SUCCESS',
      '#259 aaaaaaa types: SUCCESS',
      '#259 aaaaaaa biome: SUCCESS',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, all passed',
    ])
  })

  it('uses a base branch list of its own when a ruleset covers the base', async () => {
    const release = head({ base: 'release', checks: [done('release-check')] })
    const { context, lines } = watchOver([
      { heads: heads(release), required: { main: REQUIRED, release: ['release-check'] } },
    ])

    await runWatch(['--ticks', '1'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> release, head ${SHA_A}, draft, required 1/1 reported`,
      '#259 aaaaaaa CONCLUDED: 1/1 required reported, all passed',
    ])
  })

  it('says once that nothing is required, and concludes nothing', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: [done('vitest')] })), required: {} },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      'no ruleset requires a status check of main, so no head that falls back to it is CONCLUDED',
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/0 reported`,
    ])
  })

  it('reports a new head in full, and its contexts afresh', async () => {
    const all = REQUIRED.map((name) => done(name))
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: all })) },
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head({ headSha: SHA_B, checks: all })) },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 3/3 reported`,
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, all passed',
      `#259 new head ${SHA_B}, required 0/3 reported`,
      '#259 bbbbbbb vitest: SUCCESS',
      '#259 bbbbbbb types: SUCCESS',
      '#259 bbbbbbb biome: SUCCESS',
      '#259 bbbbbbb CONCLUDED: 3/3 required reported, all passed',
    ])
  })

  it('writes one new-head line over old, new, old, new heads, names the newest on CONCLUDED (#264)', async () => {
    const all = REQUIRED.map((name) => done(name))
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head()) },
      { heads: heads(head({ headSha: SHA_B, checks: all })) },
    ])

    await runWatch(['--ticks', '4'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      `#259 new head ${SHA_B}, required 0/3 reported`,
      '#259 bbbbbbb vitest: SUCCESS',
      '#259 bbbbbbb types: SUCCESS',
      '#259 bbbbbbb biome: SUCCESS',
      '#259 bbbbbbb CONCLUDED: 3/3 required reported, all passed',
    ])
  })

  it('writes nothing when a head first seen as a new head, not the original, returns (#264)', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head({ headSha: SHA_C })) },
      { heads: heads(head({ headSha: SHA_B })) },
    ])

    await runWatch(['--ticks', '4'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      `#259 new head ${SHA_B}, required 0/3 reported`,
      `#259 new head ${SHA_C}, required 0/3 reported`,
    ])
  })

  it('reports a context that a re-run concluded differently, and concludes once', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: [done('vitest', 'FAILURE'), done('types'), done('biome')] })) },
      {
        heads: heads(
          head({
            checks: [
              { name: 'vitest', status: 'QUEUED', conclusion: null, startedAt: null },
              done('types'),
            ],
          }),
        ),
      },
      { heads: heads(head({ checks: [done('vitest'), done('types'), done('biome')] })) },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 3/3 reported, ` +
        'failed: vitest (FAILURE)',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, failed: vitest (FAILURE)',
      '#259 aaaaaaa vitest: SUCCESS',
    ])
  })

  it('reports a pull request that merged, and one that closed, once each', async () => {
    const other = head({ number: 257, head: 'wktr-244-ws-hook', headSha: SHA_B })
    const merged = { pullRequest: null, unavailable: null, missing: false }
    const { context, lines } = watchOver([
      { heads: heads(head(), other) },
      {
        heads: heads(other),
        detail: { ...merged, pullRequest: { ...detailOf(259), state: 'MERGED' } },
      },
      { heads: heads(), detail: { ...merged, pullRequest: { ...detailOf(257), state: 'CLOSED' } } },
      { heads: heads() },
    ])

    await runWatch(['--ticks', '4'], context)

    expect(lines.slice(2)).toEqual(['#259 merged', '#257 closed'])
  })

  it('reports a state it could not read as itself, and asks again', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      {
        heads: heads(),
        detail: { pullRequest: null, unavailable: 'gh: HTTP 502', missing: false },
      },
      { heads: heads(), detail: { pullRequest: detailOf(259), unavailable: null, missing: false } },
      {
        heads: heads(),
        detail: {
          pullRequest: { ...detailOf(259), state: 'MERGED' },
          unavailable: null,
          missing: false,
        },
      },
    ])

    await runWatch(['--ticks', '4'], context)

    expect(lines.slice(1)).toEqual([
      '#259 left the open list; its state could not be read: gh: HTTP 502',
      '#259 merged',
    ])
  })

  it('writes a heartbeat after ten minutes with no change, and not before', async () => {
    const all = REQUIRED.map((name) => done(name))
    const { context, lines } = watchOver([{ heads: heads(head({ checks: all })) }])

    await runWatch(['--ticks', '22'], context)

    expect(lines.slice(2)).toEqual([
      'heartbeat: 1 open pull request, 1 concluded, no change in 10 minutes',
      'heartbeat: 1 open pull request, 1 concluded, no change in 10 minutes',
    ])
    expect(HEARTBEAT_MS).toBe(600_000)
  })

  it('counts the ten minutes from the last line it wrote, not from the start', async () => {
    const first = { heads: heads(head()) }
    // One context reports five minutes in, on the sixth poll.
    const later = { heads: heads(head({ checks: [done('vitest')] })) }
    const { context, lines } = watchOver([first, first, first, first, first, later])

    // Fifteen polls reach fourteen minutes: ten minutes after the start,
    // and only nine after the last line.
    await runWatch(['--ticks', '15'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      '#259 aaaaaaa vitest: SUCCESS',
    ])
  })

  it('writes a heartbeat over no pull requests at all', async () => {
    const { context, lines } = watchOver([{ heads: heads() }])

    await runWatch(['--ticks', '11'], context)

    expect(lines).toEqual(['heartbeat: 0 open pull requests, 0 concluded, no change in 10 minutes'])
  })

  it('reports a poll that failed as one line, keeps polling, and closes nothing', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: { rows: [], unavailable: 'gh: HTTP 502' } },
      { heads: heads(head()), required: ghFails('rate limited') },
      { heads: heads(head()), repository: ghFails('could not resolve host') },
      { heads: heads(head()), repository: { nameWithOwner: 'acme/widgets' } },
      { heads: heads(head()), required: { main: REQUIRED } },
    ])

    await runWatch(['--ticks', '6'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      'poll failed: gh: HTTP 502',
      'poll failed: rate limited',
      'poll failed: could not resolve host',
      'poll failed: the repository reply named no default branch',
      'poll read again after 4 failed polls',
    ])
  })

  it('writes a reason that stays the same once, and says when a poll reads again', async () => {
    const down = { heads: { rows: [], unavailable: 'gh: HTTP 502' } }
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      down,
      down,
      down,
      { heads: heads(head()) },
    ])

    await runWatch(['--ticks', '5'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      'poll failed: gh: HTTP 502',
      'poll read again after 3 failed polls',
    ])
  })

  it('counts each outage from its own start, and writes its reason again', async () => {
    const down = { heads: { rows: [], unavailable: 'gh: HTTP 502' } }
    const up = { heads: heads(head()) }
    const { context, lines } = watchOver([up, down, up, down, up])

    await runWatch(['--ticks', '5'], context)

    expect(lines.slice(1)).toEqual([
      'poll failed: gh: HTTP 502',
      'poll read again after 1 failed poll',
      'poll failed: gh: HTTP 502',
      'poll read again after 1 failed poll',
    ])
  })

  it('writes a heartbeat that names the failure, not "no change", while polls fail', async () => {
    const { context, lines } = watchOver([
      { heads: { rows: [], unavailable: 'gh: HTTP 502\nretry' } },
    ])

    await runWatch(['--ticks', '12'], context)

    expect(lines).toEqual([
      'poll failed: gh: HTTP 502 retry',
      'heartbeat: 11 failed polls in a row, the last: gh: HTTP 502 retry',
    ])
  })

  it(
    'writes a heartbeat that names a base still unread, not "no change", while the ' +
      'rest of the poll keeps reading (#265)',
    async () => {
      const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
      const { context, lines } = watchOver([
        { heads: heads(flaky), required: { main: REQUIRED, flaky: ghFails('gh: HTTP 404') } },
      ])

      await runWatch(['--ticks', '12'], context)

      expect(lines).toEqual([
        'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
        'heartbeat: required contexts for flaky still unread, the last: gh: HTTP 404',
      ])
    },
  )

  it(
    'writes one failure line for each of two bases down at once, and names both, ' +
      'sorted, on the heartbeat (#265)',
    async () => {
      const release = head({ base: 'release2', checks: [done('release-check')] })
      const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
      const { context, lines } = watchOver([
        {
          heads: heads(release, flaky),
          required: {
            main: REQUIRED,
            release2: ghFails('gh: HTTP 500'),
            flaky: ghFails('gh: HTTP 404'),
          },
        },
      ])

      await runWatch(['--ticks', '12'], context)

      expect(lines).toEqual([
        'required contexts for release2 could not be read: gh: HTTP 500; its pull requests are unread',
        'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
        'heartbeat: required contexts for flaky, release2 still unread, the last: gh: HTTP 404',
      ])
    },
  )

  it(
    'reports a pull request that merged while its own base stayed unread, and ' +
      'writes no false recovery for that base (#265)',
    async () => {
      const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
      const merged = { pullRequest: null, unavailable: null, missing: false }
      const down = ghFails('gh: HTTP 404')
      const { context, lines } = watchOver([
        { heads: heads(flaky), required: { main: REQUIRED, flaky: down } },
        {
          heads: heads(),
          detail: { ...merged, pullRequest: { ...detailOf(260), state: 'MERGED' } },
        },
      ])

      await runWatch(['--ticks', '2'], context)

      expect(lines).toEqual([
        'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
        '#260 merged',
      ])
    },
  )

  it('writes a reason gh gave on two lines as one line', async () => {
    const { context, lines } = watchOver([
      { heads: heads() },
      { heads: { rows: [], unavailable: 'gh: HTTP 502\n  try again later\n' } },
      { heads: heads() },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      'poll failed: gh: HTTP 502 try again later',
      'poll read again after 1 failed poll',
    ])
  })

  it('watches the rows that arrived when the list fell short, and says so once per reason', async () => {
    const short = (reason: string, ...rows: ReturnType<typeof head>[]) => ({
      rows,
      unavailable: reason,
    })
    const one = '1 pullRequests row(s) could not be read'
    const { context, lines } = watchOver([
      { heads: short(one, head()) },
      { heads: short(one, head({ checks: [done('vitest')] })) },
      { heads: heads(head({ checks: [done('vitest')] })) },
      { heads: short(one, head({ checks: [done('vitest')] })) },
      {
        heads: short('2 pullRequests row(s) could not be read', head({ checks: [done('vitest')] })),
      },
    ])

    await runWatch(['--ticks', '5'], context)

    expect(lines).toEqual([
      `poll incomplete: ${one}; the pull requests it read are still watched`,
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      '#259 aaaaaaa vitest: SUCCESS',
      `poll incomplete: ${one}; the pull requests it read are still watched`,
      'poll incomplete: 2 pullRequests row(s) could not be read; the pull requests it read are still watched',
    ])
  })

  it('does not call a pull request closed when a short list leaves it out', async () => {
    const other = head({ number: 257, head: 'wktr-244-ws-hook', headSha: SHA_B })
    const { context, lines } = watchOver([
      { heads: heads(head(), other) },
      {
        heads: {
          rows: [head()],
          unavailable: 'pullRequests has more pages than the 10 this reads',
        },
        detail: { pullRequest: detailOf(257), unavailable: null, missing: false },
      },
    ])

    await runWatch(['--ticks', '2'], context)

    expect(lines.slice(2)).toEqual([
      'poll incomplete: pullRequests has more pages than the 10 this reads; the pull requests it read are still watched',
    ])
  })

  it('reports a ruleset read that fell short as a failed poll', async () => {
    const { context, lines, gh } = watchOver([{ heads: heads(head()) }])
    const failing: GhClient = {
      ...gh,
      requiredContexts: async () => ({ contexts: [], unavailable: 'gh: HTTP 404' }),
    }

    await runWatch(['--ticks', '1'], { ...context, createGh: () => failing })

    expect(lines).toEqual(['poll failed: gh: HTTP 404'])
  })

  it(
    "reads each base on its own: one base's failed read leaves the other base free " +
      'to conclude, and the failure and its recovery each write once (#265)',
    async () => {
      const release = head({ base: 'release', checks: [done('release-check')] })
      const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
      const down = ghFails('gh: HTTP 404')
      const { context, lines } = watchOver([
        {
          heads: heads(release, flaky),
          required: { main: REQUIRED, release: ['release-check'], flaky: down },
        },
        {
          heads: heads(release, flaky),
          required: { main: REQUIRED, release: ['release-check'], flaky: down },
        },
        {
          heads: heads(release, flaky),
          required: { main: REQUIRED, release: ['release-check'], flaky: [] },
        },
      ])

      await runWatch(['--ticks', '3'], context)

      expect(lines).toEqual([
        'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
        `#259 open: wktr-219-pr-sweep -> release, head ${SHA_A}, draft, required 1/1 reported`,
        '#259 aaaaaaa CONCLUDED: 1/1 required reported, all passed',
        'required contexts for flaky read again',
        `#260 open: wktr-260-flaky -> flaky, head ${SHA_A}, draft, required 0/3 reported`,
      ])
    },
  )

  it(
    'unreads every pull request that falls back to a failed default branch, ' +
      'then reads them once it reads again (P9, #265)',
    async () => {
      const stacked = head({ base: 'wktr-244-ws-hook' })
      const down = ghFails('gh: HTTP 500')
      const { context, lines } = watchOver([
        { heads: heads(stacked), required: { main: down, 'wktr-244-ws-hook': [] } },
        { heads: heads(stacked), required: { main: REQUIRED, 'wktr-244-ws-hook': [] } },
      ])

      await runWatch(['--ticks', '2'], context)

      expect(lines).toEqual([
        'required contexts for the default branch main could not be read: gh: HTTP 500; ' +
          'every pull request that falls back to it is unread',
        'required contexts for main read again',
        `#259 open: wktr-219-pr-sweep -> wktr-244-ws-hook, head ${SHA_A}, draft, required 0/3 reported`,
      ])
    },
  )

  it(
    'concludes a pull request whose own base has a ruleset, even while the default ' +
      "branch's read fails (#265)",
    async () => {
      const release = head({ base: 'release', checks: [done('release-check')] })
      const { context, lines } = watchOver([
        {
          heads: heads(release),
          required: { main: ghFails('gh: HTTP 500'), release: ['release-check'] },
        },
      ])

      await runWatch(['--ticks', '1'], context)

      expect(lines).toEqual([
        'required contexts for the default branch main could not be read: gh: HTTP 500; ' +
          'every pull request that falls back to it is unread',
        `#259 open: wktr-219-pr-sweep -> release, head ${SHA_A}, draft, required 1/1 reported`,
        '#259 aaaaaaa CONCLUDED: 1/1 required reported, all passed',
      ])
    },
  )

  it('writes a new failure line for a still-down base whose reason changes (#265)', async () => {
    const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
    const { context, lines } = watchOver([
      { heads: heads(flaky), required: { main: REQUIRED, flaky: ghFails('gh: HTTP 404') } },
      { heads: heads(flaky), required: { main: REQUIRED, flaky: ghFails('gh: HTTP 404') } },
      { heads: heads(flaky), required: { main: REQUIRED, flaky: ghFails('gh: HTTP 500') } },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
      'required contexts for flaky could not be read: gh: HTTP 500; its pull requests are unread',
    ])
  })

  it('writes the recovery line once, not on every later poll that still reads (#265)', async () => {
    const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
    const down = ghFails('gh: HTTP 404')
    const { context, lines } = watchOver([
      { heads: heads(flaky), required: { main: REQUIRED, flaky: down } },
      { heads: heads(flaky), required: { main: REQUIRED, flaky: [] } },
      { heads: heads(flaky), required: { main: REQUIRED, flaky: [] } },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
      'required contexts for flaky read again',
      `#260 open: wktr-260-flaky -> flaky, head ${SHA_A}, draft, required 0/3 reported`,
    ])
  })

  it(
    'joins every reason when every base fails in the same poll, and attributes a ' +
      'base that stays down once the rest of the poll reads again, one poll late (#265)',
    async () => {
      const release = head({ base: 'release' })
      const { context, lines } = watchOver([
        {
          heads: heads(release),
          required: { main: ghFails('gh: HTTP 500'), release: ghFails('gh: HTTP 404') },
        },
        { heads: heads(release), required: { main: REQUIRED, release: ghFails('gh: HTTP 404') } },
      ])

      await runWatch(['--ticks', '2'], context)

      expect(lines).toEqual([
        'poll failed: gh: HTTP 500; gh: HTTP 404',
        'poll read again after 1 failed poll',
        'required contexts for release could not be read: gh: HTTP 404; its pull requests are unread',
      ])
    },
  )

  it(
    'reports a head that moved while its base was unread, once the base reads ' +
      'again (#264 and #265 together)',
    async () => {
      const flaky = head({ number: 260, head: 'wktr-260-flaky', base: 'flaky' })
      const down = ghFails('gh: HTTP 404')
      const { context, lines } = watchOver([
        { heads: heads(flaky), required: { main: REQUIRED, flaky: [] } },
        { heads: heads({ ...flaky, headSha: SHA_B }), required: { main: REQUIRED, flaky: down } },
        { heads: heads({ ...flaky, headSha: SHA_B }), required: { main: REQUIRED, flaky: [] } },
      ])

      await runWatch(['--ticks', '3'], context)

      expect(lines).toEqual([
        `#260 open: wktr-260-flaky -> flaky, head ${SHA_A}, draft, required 0/3 reported`,
        'required contexts for flaky could not be read: gh: HTTP 404; its pull requests are unread',
        'required contexts for flaky read again',
        `#260 new head ${SHA_B}, required 0/3 reported`,
      ])
    },
  )

  it('reports a failure that is not a gh error in its own words', async () => {
    const { context, lines } = watchOver([{ heads: heads(head()), repository: new Error('boom') }])

    await runWatch(['--ticks', '1'], context)

    expect(lines).toEqual(['poll failed: Error: boom'])
  })

  it('waits the interval it was given between polls', async () => {
    const { context, elapsed } = watchOver([{ heads: heads() }])

    await runWatch(['--ticks', '3', '--interval', '30'], context)

    expect(elapsed()).toBe(60_000)
  })

  it('ends at the next poll once it is stopped, with exit 0', async () => {
    let polls = 0
    const { context } = watchOver([{ heads: heads() }])
    const counting: WatchContext = {
      ...context,
      stopped: () => polls >= 2,
      sleep: async () => {
        polls += 1
      },
    }

    await expect(runWatch([], counting)).resolves.toEqual({ outcome: 'ok', value: '' })
    expect(polls).toBe(2)
  })

  it(
    'moves a seen head to current once it answers twice in a row, with its own line ' +
      '(ruling 5, #296)',
    async () => {
      const { context, lines } = watchOver([
        { heads: heads(head()) },
        { heads: heads(head({ headSha: SHA_B })) },
        { heads: heads(head()) },
        { heads: heads(head()) },
      ])

      await runWatch(['--ticks', '4'], context)

      expect(lines).toEqual([
        `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
        `#259 new head ${SHA_B}, required 0/3 reported`,
        `#259 new head ${SHA_A}, required 0/3 reported`,
      ])
    },
  )

  it('leaves a seen head silent when it does not answer again on the very next poll (ruling 5, #296)', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head()) },
      { heads: heads(head({ headSha: SHA_B })) },
    ])

    await runWatch(['--ticks', '4'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      `#259 new head ${SHA_B}, required 0/3 reported`,
    ])
  })

  it(
    'needs a fresh pair of consecutive answers, not a stale one, after the current head ' +
      'repeats in between (ruling 5, #296)',
    async () => {
      // A: open. B: new, current. A: seen, pending. B: repeats as current,
      // clears the pending mark. A: seen again - this is only the FIRST of
      // a fresh pair, so it must stay silent too. A mutation that reuses
      // the stale mark from the third poll would confirm here instead, one
      // poll early.
      const { context, lines } = watchOver([
        { heads: heads(head()) },
        { heads: heads(head({ headSha: SHA_B })) },
        { heads: heads(head()) },
        { heads: heads(head({ headSha: SHA_B })) },
        { heads: heads(head()) },
      ])

      await runWatch(['--ticks', '5'], context)

      expect(lines).toEqual([
        `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
        `#259 new head ${SHA_B}, required 0/3 reported`,
      ])
    },
  )
})

describe('a watch over a cancelled run that a newer run supersedes (#364)', () => {
  const OLD = '2026-10-01T00:00:00Z'
  const NEW = '2026-10-01T00:01:00Z'
  /** A check that run `id` of CI made. Run 1 is the older run. */
  const fromRun = (
    name: string,
    conclusion: string | null,
    id: number,
    runConclusion: string | null,
  ): CheckContext => ({
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    startedAt: id === 1 ? OLD : NEW,
    run: {
      id,
      workflowId: 1,
      workflow: 'CI',
      createdAt: id === 1 ? OLD : NEW,
      conclusion: runConclusion,
    },
  })
  /** The cancelled run's checks: its fan-in jobs fail, its legs cancel. */
  const CANCELLED_RUN = [
    fromRun('vitest', 'FAILURE', 1, 'CANCELLED'),
    fromRun('types', 'CANCELLED', 1, 'CANCELLED'),
    fromRun('biome', 'CANCELLED', 1, 'CANCELLED'),
  ]

  it('writes no failure and no CONCLUDED until the newer run reports, then concludes on it', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ checks: [...CANCELLED_RUN, fromRun('lint', null, 2, null)] })) },
      {
        heads: heads(
          head({
            checks: [
              ...CANCELLED_RUN,
              fromRun('vitest', 'SUCCESS', 2, null),
              fromRun('types', 'SUCCESS', 2, null),
              fromRun('biome', 'SUCCESS', 2, null),
            ],
          }),
        ),
      },
    ])

    await runWatch(['--ticks', '3'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      '#259 aaaaaaa vitest: SUCCESS',
      '#259 aaaaaaa types: SUCCESS',
      '#259 aaaaaaa biome: SUCCESS',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, all passed',
    ])
  })

  it('still reports a cancelled run that no newer run follows, and concludes on it', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head()) },
      { heads: heads(head({ checks: CANCELLED_RUN })) },
    ])

    await runWatch(['--ticks', '2'], context)

    expect(lines).toEqual([
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
      '#259 aaaaaaa vitest: FAILURE',
      '#259 aaaaaaa types: CANCELLED',
      '#259 aaaaaaa biome: CANCELLED',
      '#259 aaaaaaa CONCLUDED: 3/3 required reported, ' +
        'failed: vitest (FAILURE), types (CANCELLED), biome (CANCELLED)',
    ])
  })
})

describe('a watch bounds every gh call to its poll interval (ruling 4, #295)', () => {
  it('gives the client a bound equal to the poll interval in milliseconds', async () => {
    const seenBoundMs: number[] = []
    const { context } = watchOver([{ heads: heads() }], {
      createGh: (boundMs) => {
        seenBoundMs.push(boundMs)
        return createGhMock({
          viewRepository: REPOSITORY,
          listOpenPullRequestHeads: heads(),
          requiredContexts: { contexts: REQUIRED, unavailable: null },
        })
      },
    })

    await runWatch(['--ticks', '1', '--interval', '5'], context)

    expect(seenBoundMs).toEqual([5_000])
  })

  it('reports a call that never answers as a failed poll, and reads again next poll', async () => {
    let calls = 0
    const { context, lines } = watchOver([{ heads: heads(head()) }], {
      createGh: (boundMs) => {
        const base = createGhMock()
        return {
          ...base,
          viewRepository: async () => {
            calls += 1
            if (calls === 1) {
              const said = `gh did not answer in ${boundMs} ms`
              throw new GhError(said, null, { cause: null, detail: said })
            }
            return REPOSITORY
          },
          listOpenPullRequestHeads: async () => heads(head()),
          requiredContexts: async () => ({ contexts: REQUIRED, unavailable: null }),
        }
      },
    })

    await runWatch(['--interval', '5', '--ticks', '2'], context)

    expect(lines).toEqual([
      'poll failed: gh did not answer in 5000 ms',
      'poll read again after 1 failed poll',
      `#259 open: wktr-219-pr-sweep -> main, head ${SHA_A}, draft, required 0/3 reported`,
    ])
  })
})

describe('a watch that was told what it already knows', () => {
  const all = REQUIRED.map((name) => done(name))

  it('stays silent about a known head and its contexts', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: [done('vitest')] })) },
      { heads: heads(head({ checks: [done('vitest'), done('types')] })) },
    ])

    await runWatch(['--ticks', '2', '--since-head', `259=${SHA_A}`], context)

    expect(lines).toEqual(['#259 aaaaaaa types: SUCCESS'])
  })

  it('still concludes a known head, unless it was told the head concluded', async () => {
    const first = watchOver([{ heads: heads(head({ checks: all })) }])
    await runWatch(['--ticks', '1', '--since-head', `259=${SHA_A}`], first.context)
    expect(first.lines).toEqual(['#259 aaaaaaa CONCLUDED: 3/3 required reported, all passed'])

    const second = watchOver([{ heads: heads(head({ checks: all })) }])
    await runWatch(['--ticks', '1', '--concluded', `259=${SHA_A}`], second.context)
    expect(second.lines).toEqual([])
  })

  it('takes --concluded over --since-head for a head that both name', async () => {
    const { context, lines } = watchOver([{ heads: heads(head({ checks: all })) }])

    await runWatch(
      ['--ticks', '1', '--since-head', `259=${SHA_A}`, '--concluded', `259=${SHA_A}`],
      context,
    )

    expect(lines).toEqual([])
  })

  it('reports a head that moved since, as a new head', async () => {
    const { context, lines } = watchOver([{ heads: heads(head({ headSha: SHA_B })) }])

    await runWatch(['--ticks', '1', '--concluded', `259=${SHA_A}`], context)

    expect(lines).toEqual([`#259 new head ${SHA_B}, required 0/3 reported`])
  })

  it('writes nothing when a seeded head comes back after a later one (#264)', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head()) },
    ])

    await runWatch(['--ticks', '2', '--since-head', `259=${SHA_A}`], context)

    expect(lines).toEqual([`#259 new head ${SHA_B}, required 0/3 reported`])
  })

  it('writes nothing when a head concluded by --concluded comes back after a later one (#264)', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ headSha: SHA_B })) },
      { heads: heads(head()) },
    ])

    await runWatch(['--ticks', '2', '--concluded', `259=${SHA_A}`], context)

    expect(lines).toEqual([`#259 new head ${SHA_B}, required 0/3 reported`])
  })

  it('reports a known pull request that is no longer open', async () => {
    const { context, lines } = watchOver([
      {
        heads: heads(),
        detail: {
          pullRequest: { ...detailOf(257), state: 'MERGED' },
          unavailable: null,
          missing: false,
        },
      },
    ])

    await runWatch(['--ticks', '1', '--since-head', `257=${SHA_B}`], context)

    expect(lines).toEqual(['#257 merged'])
  })
})

describe('a watch with nothing to watch', () => {
  it('says so in one line outside a git checkout, and asks gh nothing', async () => {
    const outside = createSandbox()
    const { context } = watchOver([{}])

    const answer = await runWatch([], {
      ...context,
      createGh: () => createGhMock(),
      cwd: outside.path,
    })

    expect(answer).toEqual({
      outcome: 'ok',
      value: `watch: ${outside.path} is not inside a git checkout, so there is nothing to watch`,
    })
  })

  it('says so in one line when gh is not on PATH', async () => {
    const { context, lines } = watchOver([
      { repository: ghFails('cannot run gh: spawn gh ENOENT', 127) },
    ])

    const answer = await runWatch([], context)

    expect(answer).toEqual({
      outcome: 'ok',
      value: 'watch: cannot run gh: spawn gh ENOENT, so there is nothing to watch',
    })
    expect(lines).toEqual([])
  })
})

describe('the command line', () => {
  it('prints its own usage for --help', async () => {
    const { context } = watchOver([{}])

    const answer = await runWatch(['--help'], context)

    expect(answer.outcome).toBe('ok')
    expect(answer.outcome === 'ok' && answer.value).toMatch(/^Every open pull request's head/)
  })

  for (const [argv, error] of [
    [['--interval', '0'], '--interval takes a whole number of seconds, not "0"'],
    [['--interval', '1.5'], '--interval takes a whole number of seconds, not "1.5"'],
    [['--ticks', 'x'], '--ticks takes a whole number of polls, not "x"'],
    [['--since-head', '259'], '--since-head takes <number>=<full head sha> pairs, not "259"'],
    [
      ['--since-head', '259=aaaaaaa'],
      '--since-head takes <number>=<full head sha> pairs, not "259=aaaaaaa"',
    ],
    [
      ['--since-head', `259=${SHA_A}`, '--since-head', `257=${SHA_B}`],
      '--since-head is not repeatable; pass one comma-separated list',
    ],
    [
      ['--concluded', `259=${SHA_A}`, `--concluded=257=${SHA_B}`],
      '--concluded is not repeatable; pass one comma-separated list',
    ],
    [['--concluded', `259=${SHA_A},259=${SHA_B}`], '--concluded names #259 twice'],
  ] as const) {
    it(`refuses ${argv.join(' ')}`, async () => {
      const { context } = watchOver([{}])

      await expect(runWatch(argv, context)).resolves.toEqual({ outcome: 'refused', error })
    })
  }

  it('refuses a flag it does not know', async () => {
    const { context } = watchOver([{}])

    const answer = await runWatch(['--nope'], context)

    expect(answer.outcome).toBe('refused')
  })
})

describe('parseSeeds', () => {
  it('reads a comma-separated list of full head shas by number', () => {
    expect(parseSeeds(`259=${SHA_A}, 257=${SHA_B.toUpperCase()}`, '--since-head')).toEqual({
      outcome: 'ok',
      value: new Map([
        [259, SHA_A],
        [257, SHA_B],
      ]),
    })
    expect(parseSeeds('', '--since-head')).toEqual({ outcome: 'ok', value: new Map() })
  })
})

/** A pull request detail for a number, for the reads of one that left the
 *  open list. */
function detailOf(number: number) {
  return {
    number,
    title: 'a pull request',
    state: 'OPEN' as const,
    draft: false,
    base: 'main',
    head: `branch-${number}`,
    headSha: SHA_A,
    mergeable: 'MERGEABLE',
    checks: [],
    unresolvedThreads: [],
    commentAuthors: [],
  }
}
