// The watch command. `gh` is the injected double. The clock and the sleep
// are fakes, so many polls take no real time. Each example states
// what gh answers on each poll, and asserts the lines the watch wrote. git is
// real: the watch asks git once whether it stands in a checkout.
import { describe, expect, it } from 'vitest'

import {
  createGhMock,
  type GhClient,
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

const done = (name: string, conclusion = 'SUCCESS') => ({
  name,
  status: 'COMPLETED',
  conclusion,
})

/** What gh answers on one poll. `required` is by branch; a branch it does
 *  not name has no ruleset. */
interface Poll {
  readonly heads?: GhReplies['listOpenPullRequestHeads'] | Error
  readonly required?: Readonly<Record<string, readonly string[]>> | Error
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
      return { contexts: byBranch[branch] ?? [], unavailable: null }
    },
    viewPullRequestDetail: async () => reply(current().detail, 'viewPullRequestDetail'),
  }
  const context: WatchContext = {
    gh,
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
  return { context, lines, elapsed: () => clock - 1_000_000 }
}

const heads = (...rows: PullRequestHead[]) => ({ rows, unavailable: null })

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
    const running = { name: 'biome', status: 'IN_PROGRESS', conclusion: null }
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

  it('reports a context that a re-run concluded differently, and concludes once', async () => {
    const { context, lines } = watchOver([
      { heads: heads(head({ checks: [done('vitest', 'FAILURE'), done('types'), done('biome')] })) },
      {
        heads: heads(
          head({ checks: [{ name: 'vitest', status: 'QUEUED', conclusion: null }, done('types')] }),
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
    const { context, lines } = watchOver([{ heads: heads(head()) }])
    const failing: GhClient = {
      ...context.gh,
      requiredContexts: async () => ({ contexts: [], unavailable: 'gh: HTTP 404' }),
    }

    await runWatch(['--ticks', '1'], { ...context, gh: failing })

    expect(lines).toEqual(['poll failed: gh: HTTP 404'])
  })

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

    const answer = await runWatch([], { ...context, gh: createGhMock(), cwd: outside.path })

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
