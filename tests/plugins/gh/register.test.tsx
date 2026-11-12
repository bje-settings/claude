// The gh hooks module (`plugins/gh/hooks/register.ts`), under
// `claude plugin test` (ADR 007, ruling 3). `scripts/plugin-test.ts` copies
// this file into the plugin's `tests/` folder, so the plugin is one folder
// up from here at run time.
//
// Each hook the test adds with `on` stands for the engine. Every engine
// call the module makes has a stub in result form: `process.run`,
// `ui.status`, `ui.log`, `session.cwd`, the clock, `session.start`,
// `tool.call` and the engine's own `PromptHint` drawing. A call with no stub
// would reach nothing. The kit itself answers `$.ui.invalidate`.
import type { On, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/** The session's directory, as the stubs answer it. */
const CWD = '/work/repo'

/** A report of `hook-io.ts status --json` for one repository, with
 *  `counts` over zero. */
const report = (
  counts: Record<string, number> = {},
  more: Record<string, unknown> = {},
): string =>
  `${JSON.stringify({
    counts: { behind: 0, prune: 0, pullRequests: 0, dependencies: 0, alerts: 0, ...counts },
    repos: 1,
    repository: 'acme/widgets',
    problems: [],
    ...more,
  })}\n`

/** A run of `hook-io.ts status --json` that exits `exitCode` with `stdout`. */
const ran = (stdout: string, exitCode = 0, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** What the module did, as the stubs saw it. */
interface Seen {
  /** The argv of each `process.run` call. */
  readonly runs: (readonly string[])[]
  /** The options of each `process.run` call. */
  readonly inits: (ProcessRunInit | undefined)[]
  /** The text of each `ui.status` call, `undefined` for a clear. */
  readonly statuses: (string | undefined)[]
  /** The text of each `ui.log` call. */
  readonly logs: string[]
}

/** How the stubs answer, past the result of each run. */
interface Stubs {
  /** Holds each run on the mocked clock for this long. */
  readonly delayMs?: number
  /** Each tool call is refused with this text. */
  readonly deny?: string
  /** The answer of each `session.cwd` call in turn. A thrown error makes
   *  that call reject. The last answer repeats. */
  readonly cwd?: (index: number) => string
}

/**
 * Stub every engine call the module makes. `answer` gives the result of
 * each `process.run` call in turn, or throws for a run that rejects.
 */
const stub = (
  on: On,
  answer: (index: number) => ProcessRunResult,
  { delayMs = 0, deny, cwd = () => CWD }: Stubs = {},
): { seen: Seen; clock: ReturnType<typeof mock.clock> } => {
  const clock = mock.clock(on)
  const seen: Seen = { runs: [], inits: [], statuses: [], logs: [] }
  let cwdCalls = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd(cwdCalls++) }))
  on('tool.call', () => (deny === undefined ? { result: {} } : { deny }))
  on('process.run', async (_, e) => {
    const index = seen.runs.length
    seen.runs.push(e.argv)
    seen.inits.push(e.init)
    if (delayMs > 0) await clock.sleep(delayMs)
    return { value: answer(index) }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  // The engine's own hint line, under the module's row.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>? for shortcuts</Text>
  })
  return { seen, clock }
}

/** The prompt hint, as a surface that draws it mounts it. */
const HINT = {
  plugin: 'gh',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

test('a session start runs the JSON status check, and pins its plain text', async ($, on) => {
  const { seen, clock } = stub(on, () =>
    ran(report({ behind: 1, dependencies: 2 }, { problems: ['fetch failed: Invalid username or token'] })),
  )

  await $.session.start(START)
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  const [argv] = seen.runs
  expect(argv?.[0]).toBe('node')
  expect(String(argv?.[1]).endsWith('/hooks/hook-io.ts')).toBe(true)
  expect(argv?.slice(2)).toEqual(['status', '--json', CWD])
  expect(seen.inits).toEqual([{ cwd: CWD, timeoutMs: 15_000 }])
  expect(seen.statuses).toEqual(['[behind] [🤖 2] ⚠️ fetch failed: Invalid username or token'])
  expect(seen.logs).toEqual(['gh: fetch failed: Invalid username or token'])
})

test('a report with problems logs them once for each run of problems', async ($, on) => {
  const { seen, clock } = stub(on, (index) =>
    index === 2 ? ran(report({ behind: 1 })) : ran(report({ behind: 1 }, { problems: ['a', 'b'] })),
  )

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  expect(seen.logs).toEqual(['gh: a; b'])

  // A clean report resets the log, so the next problems log again.
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  expect(seen.logs).toEqual(['gh: a; b', 'gh: a; b'])
})

test('a failed run does not hide the problems of a report, and they do not hide it', async ($, on) => {
  const { seen, clock } = stub(on, (index) =>
    index % 2 === 0 ? ran('', 2, 'usage\n') : ran(report({ behind: 1 }, { problems: ['a'] })),
  )

  await $.session.start(START)
  await clock.settle()
  for (let run = 1; run < 4; run++) {
    await $.tool.call({ tool: 'Bash', command: 'git pull' })
    await clock.settle()
  }

  // The problems stay the same run of problems, so they log once.
  const failed = 'gh: the status check failed with exit 2: usage'
  expect(seen.logs).toEqual([failed, 'gh: a', failed])
})

test('a session start does not wait for the status run', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })), { delayMs: 1_000 })

  await $.session.start(START)

  // The start has resolved, and the run is still held on the clock.
  expect(seen.statuses).toEqual([])
  await clock.advance(1_000)
  expect(seen.statuses).toEqual(['[behind]'])
})

test('a report with nothing to show clears the pin', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(index === 0 ? report({ behind: 1 }) : report()))

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.statuses).toEqual(['[behind]', undefined])
})

test('a failed run keeps the last pin, and logs why once', async ($, on) => {
  const { seen, clock } = stub(on, (index) => {
    if (index === 0) return ran(report({ prune: 1 }))
    if (index === 1) throw new Error('spawn node ENOENT')
    return ran('', 2, 'usage: hook-io.ts {session-start|status [--json] [dir]}\n')
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git fetch' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
  await clock.settle()

  expect(seen.runs.length).toBe(3)
  // No clear and no second pin: the text from the first run stays.
  expect(seen.statuses).toEqual(['[✂️ 1]'])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('gh: the status check could not run: ')
})

test('a failed exit logs its code and the first line of stderr', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('', 2, 'usage: hook-io.ts\nmore\n'))

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses).toEqual([])
  expect(seen.logs).toEqual(['gh: the status check failed with exit 2: usage: hook-io.ts'])
})

test('an exit 0 with no report logs that it wrote none', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'))

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses).toEqual([])
  expect(seen.logs).toEqual(['gh: the status check wrote no report'])
})

test('a Bash git call refreshes the pin', async ($, on) => {
  const { seen, clock } = stub(on, (index) =>
    ran(index === 0 ? report({ behind: 1 }) : report({ prune: 2 })),
  )

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull --ff-only' })
  await clock.settle()

  expect(seen.runs.length).toBe(2)
  expect(seen.runs[1]?.slice(2)).toEqual(['status', '--json', CWD])
  expect(seen.statuses).toEqual(['[behind]', '[✂️ 2]'])
})

test('a Bash ls call does not refresh the pin', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })))

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  expect(seen.statuses).toEqual(['[behind]'])
})

test('no second check starts while one runs, and one more run follows it', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(report({ prune: index + 1 })), {
    delayMs: 1_000,
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.settle()

  // Two requests came while the first run was open: still one run.
  expect(seen.runs.length).toBe(1)
  await clock.advance(1_000)
  // The first run ended, and one more run started for both requests.
  expect(seen.runs.length).toBe(2)
  expect(seen.statuses).toEqual(['[✂️ 1]'])
  await clock.advance(1_000)
  expect(seen.runs.length).toBe(2)
  expect(seen.statuses).toEqual(['[✂️ 1]', '[✂️ 2]'])
})

test('the timer refreshes the pin every five minutes', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(report({ prune: index + 1 })))

  await $.session.start(START)
  await clock.settle()
  await clock.advance(299_999)
  expect(seen.runs.length).toBe(1)
  await clock.advance(1)

  expect(seen.runs.length).toBe(2)
  expect(seen.statuses).toEqual(['[✂️ 1]', '[✂️ 2]'])
})

test('the timer keeps its period after the first refresh', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(report({ prune: index + 1 })))

  await $.session.start(START)
  await clock.settle()
  await clock.advance(600_000)

  expect(seen.runs.length).toBe(3)
})

test('a second session start replaces the timer', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })))

  await $.session.start(START)
  await clock.settle()
  await $.session.start(START)
  await clock.settle()
  expect(seen.runs.length).toBe(2)
  await clock.advance(300_000)

  // One timer fired, not two.
  expect(seen.runs.length).toBe(3)
})

test('a git call that a hook refused does not refresh the pin', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })), { deny: 'not now' })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
})

test('a call to another tool does not refresh the pin, even with a git command', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })))

  await $.session.start(START)
  await clock.settle()
  // Only the Bash matcher keeps this out: the input names a git command.
  await $.tool.call({ tool: 'mcp__shell__run', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
})

test('a report after a failure resets the log, so the next failure logs again', async ($, on) => {
  const { seen, clock } = stub(on, (index) => {
    if (index === 1) return ran(report({ behind: 1 }))
    return ran('', 2, 'usage\n')
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.statuses).toEqual(['[behind]'])
  expect(seen.logs.length).toBe(2)
})

test('a report written before a signal ended the run is pinned', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ prune: 3 }), 1))

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses).toEqual(['[✂️ 3]'])
  expect(seen.logs).toEqual([])
})

test('a refresh reads the session directory again', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })), {
    cwd: () => '/work/other',
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.map((argv) => argv[4])).toEqual([CWD, '/work/other'])
  expect(seen.inits[1]).toEqual({ cwd: '/work/other', timeoutMs: 15_000 })
})

test('a session directory that cannot be read logs once and starts no run', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })), {
    cwd: () => {
      throw new Error('no session')
    },
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  expect(seen.statuses).toEqual(['[behind]'])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('gh: the status check could not run: ')
})

test('the timer reads the session directory again', async ($, on) => {
  const { seen, clock } = stub(on, () => ran(report({ behind: 1 })), {
    cwd: () => '/work/other',
  })

  await $.session.start(START)
  await clock.settle()
  await clock.advance(300_000)

  expect(seen.runs.map((argv) => argv[4])).toEqual([CWD, '/work/other'])
})

test('a request during a run that fails still gets one more run', async ($, on) => {
  const { seen, clock } = stub(
    on,
    (index) => {
      if (index === 0) return ran('', 2, 'usage\n')
      if (index === 1) throw new Error('spawn node ENOENT')
      return ran(report({ behind: 1 }))
    },
    { delayMs: 1_000 },
  )

  // A failed exit, then a run that rejects: each takes a request that came
  // while it was open.
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.advance(1_000)
  expect(seen.runs.length).toBe(2)
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.advance(1_000)
  expect(seen.runs.length).toBe(3)
  await clock.advance(1_000)

  expect(seen.statuses).toEqual(['[behind]'])
})

// --- the row in the prompt hint (#496) ------------------------------------------

test('the prompt hint draws the counts row above the engine line, with links', async ($, on) => {
  const { clock } = stub(on, () => ran(report({ behind: 1, pullRequests: 2, alerts: 3 })))

  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })

    // A Link shows its address as text too, so the row's text holds it.
    const PULLS =
      'https://github.com/acme/widgets/pulls?q=is%3Apr+is%3Aopen+draft%3Afalse+-author%3Aapp%2Fdependabot'
    const ALERTS = 'https://github.com/acme/widgets/security/dependabot'
    const row = await ui.find({ type: 'Text', text: /^gh: / })
    expect(row?.text).toBe(`gh: [behind] ${PULLS}[🔀 2] ${ALERTS}[🛡️ 3]`)
    expect(row?.props.dimColor).toBe(false)
    // The row, then the bracket inside it: the bracket is the last match.
    const brackets = await ui.findAll({ type: 'Text', text: `${ALERTS}[🛡️ 3]` })
    expect(brackets.at(-1)?.props.color).toBe('error')
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map((link) => [link.children, link.props.href])).toEqual([
      [['[🔀 2]'], PULLS],
      [['[🛡️ 3]'], ALERTS],
    ])
    // `behind` has no page, so it has no link.
    expect((await ui.find({ type: 'Text', text: '? for shortcuts' }))?.text).toBe(
      '? for shortcuts',
    )
    await ui.unmount()
  }
})

test('the prompt hint draws no link in a folder', async ($, on) => {
  const { clock } = stub(on, () =>
    ran(report({ alerts: 3 }, { repos: 2, repository: null })),
  )

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^gh: / }))?.text).toBe('gh: [repos: 2] [🛡️ 3]')
  expect(await ui.findAll({ type: 'Link' })).toEqual([])
  await ui.unmount()
})

test('the prompt hint draws each bracket in the colour of its kind', async ($, on) => {
  const counts = { behind: 1, prune: 2, pullRequests: 3, dependencies: 4, alerts: 5 }
  const { clock } = stub(on, () => ran(report(counts, { repos: 2, repository: null })))

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

  const row = await ui.find({ type: 'Text', text: /^gh: / })
  expect(row?.text).toBe('gh: [repos: 2] [behind] [✂️ 2] [🔀 3] [🤖 4] [🛡️ 5]')
  expect(row?.props.color).toBeUndefined()
  const colours: [string, unknown][] = []
  for (const text of ['[repos: 2]', '[behind]', '[✂️ 2]', '[🔀 3]', '[🤖 4]', '[🛡️ 5]']) {
    // The row, then the bracket inside it: the bracket is the last match.
    const bracket = (await ui.findAll({ type: 'Text', text })).at(-1)
    colours.push([text, bracket?.props.color])
  }
  expect(colours).toEqual([
    ['[repos: 2]', 'success'],
    ['[behind]', 'warning'],
    ['[✂️ 2]', 'suggestion'],
    ['[🔀 3]', 'planMode'],
    ['[🤖 4]', 'merged'],
    ['[🛡️ 5]', 'error'],
  ])
  await ui.unmount()
})

test('a report with problems draws the counts row dim, with no colour and no problem row', async ($, on) => {
  const { clock } = stub(on, () =>
    ran(report({ behind: 1, alerts: 3 }, { problems: ['first', 'second'] })),
  )

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

  const ALERTS = 'https://github.com/acme/widgets/security/dependabot'
  const rows = await ui.findAll({ type: 'Text', text: /^gh:/ })
  expect(rows.map((row) => row.text)).toEqual([`gh: [behind] ${ALERTS}[🛡️ 3]`, 'gh:'])
  expect(await ui.findAll({ type: 'Text', text: /⚠️|first|second/ })).toEqual([])
  for (const text of [/^gh:/, '[behind]', `${ALERTS}[🛡️ 3]`]) {
    const found = await ui.findAll({ type: 'Text', text })
    expect([String(text), found.length > 0]).toEqual([String(text), true])
    for (const element of found) {
      expect([element.text, element.props.dimColor, element.props.color]).toEqual([
        element.text,
        true,
        undefined,
      ])
    }
  }
  await ui.unmount()
})

test('a report with only problems draws only the engine line', async ($, on) => {
  const { clock } = stub(on, () => ran(report({}, { problems: ['first'] })))

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /gh:/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
  await ui.unmount()
})

test('the prompt hint draws only the engine line when there is nothing to show', async ($, on) => {
  const { clock } = stub(on, () => ran(report()))

  for (const when of ['before the first report', 'after it'] as const) {
    if (when === 'after it') {
      await $.session.start(START)
      await clock.settle()
    }
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect([when, (await ui.find({ type: 'Text', text: /gh:/ }))?.text]).toEqual([when, undefined])
    expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    await ui.unmount()
  }
})

test('a failed run draws the last row dim, until a report comes again', async ($, on) => {
  const { clock } = stub(on, (index) =>
    index === 1 ? ran('', 2, 'usage\n') : ran(report({ prune: index + 1 })),
  )

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^gh: \[/ }))?.props.dimColor).toBe(false)

  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  const dim = await ui.findAll({ type: 'Text', text: /gh:|✂️/ })
  expect(dim.length).toBeGreaterThan(0)
  for (const element of dim) {
    expect([element.text, element.props.dimColor, element.props.color]).toEqual([
      element.text,
      true,
      undefined,
    ])
  }
  expect((await ui.find({ type: 'Text', text: /^gh: \[/ }))?.text).toBe('gh: [✂️ 1]')

  // A report again draws the row bright.
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^gh: \[/ }))?.text).toBe('gh: [✂️ 3]')
  expect((await ui.find({ type: 'Text', text: /^gh: \[/ }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('after the prompt hint draws, the plain pin is cleared and later reports do not pin', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(report({ prune: index + 1 })))

  await $.session.start(START)
  await clock.settle()
  expect(seen.statuses).toEqual(['[✂️ 1]'])

  const ui = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(seen.statuses).toEqual(['[✂️ 1]', undefined])

  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  // The row follows the report, and the pin stays clear.
  expect((await ui.find({ type: 'Text', text: /^gh: / }))?.text).toBe('gh: [✂️ 2]')
  expect(seen.statuses.slice(2)).toEqual([undefined])

  // A second draw does not clear the pin again.
  await ui.redraw()
  expect(seen.statuses.length).toBe(3)
  await ui.unmount()
})

/** The answer of the issue-types read: a list with a type, or an empty one. */
const TYPES = ran('[{"name":"Bug","description":"A defect"}]\n')
const NO_TYPES = ran('[]\n')

/**
 * Stub the engine, and answer a `gh` run, the types read, with `types`.
 * Any other run is a status check with a clean report.
 */
const stubTypes = (
  on: On,
  types: (index: number) => ProcessRunResult,
  stubs?: Stubs,
): ReturnType<typeof stub> => {
  const stubbed: ReturnType<typeof stub> = stub(
    on,
    (index) => (stubbed.seen.runs[index]?.[0] === 'gh' ? types(index) : ran(report())),
    stubs,
  )
  return stubbed
}

/** The runs that read the issue types. */
const typesRuns = (seen: Seen): (readonly string[])[] =>
  seen.runs.filter((argv) => argv[0] === 'gh')

test('gh issue create with no --type is denied when the repository has types', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => TYPES)

  const result = await $.tool.call({ tool: 'Bash', command: 'gh issue create --title "t"' })
  await clock.settle()

  expect(result.deny).toContain('gh:issues')
  expect(typesRuns(seen).length).toBe(1)
  expect(typesRuns(seen)[0]?.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(seen.inits[0]).toEqual({ cwd: CWD, timeoutMs: 5_000 })
  // A denied call does not refresh the row.
  expect(seen.runs.length).toBe(1)
})

test('an empty --type is denied, a --type with a value passes with no read', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => TYPES)

  expect((await $.tool.call({ tool: 'Bash', command: 'gh issue create --type=' })).deny).toBeDefined()
  seen.runs.length = 0
  const bug = await $.tool.call({ tool: 'Bash', command: 'gh issue create --type Bug' })
  const task = await $.tool.call({ tool: 'Bash', command: 'gh issue create --type=Task' })
  await clock.settle()

  expect(bug.deny).toBeUndefined()
  expect(task.deny).toBeUndefined()
  expect(typesRuns(seen)).toEqual([])
})

test('a repository with no types passes', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => NO_TYPES)

  const result = await $.tool.call({ tool: 'Bash', command: 'gh issue create --title "t"' })
  await clock.settle()

  expect(result.deny).toBeUndefined()
  expect(typesRuns(seen).length).toBe(1)
})

test('a read that fails, rejects, or gives no list passes', async ($, on) => {
  const { clock } = stubTypes(on, (index) => {
    if (index === 0) return ran('', 1, 'HTTP 502')
    if (index === 1) return ran('no json')
    throw new Error('timed out')
  })

  for (const repo of ['a/one', 'a/two', 'a/three']) {
    const result = await $.tool.call({ tool: 'Bash', command: `gh issue create -R ${repo}` })
    expect(result.deny).toBeUndefined()
  }
  await clock.settle()
})

test('a session directory that cannot be read passes', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => TYPES, {
    cwd: () => {
      throw new Error('no directory')
    },
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'gh issue create' })
  await clock.settle()

  expect(result.deny).toBeUndefined()
  expect(typesRuns(seen)).toEqual([])
})

test('two creates in one repository share one read, and one repository has its own', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => TYPES)

  const both = await $.tool.call({
    tool: 'Bash',
    command: 'gh issue create --type Bug && gh issue create -R a/b --title x',
  })
  const again = await $.tool.call({ tool: 'Bash', command: 'gh issue create --repo=a/b' })
  const here = await $.tool.call({ tool: 'Bash', command: 'gh issue create' })
  const hereAgain = await $.tool.call({ tool: 'Bash', command: 'gh issue create' })
  await clock.settle()

  expect([both.deny, again.deny, here.deny, hereAgain.deny].map((deny) => deny !== undefined)).toEqual([
    true,
    true,
    true,
    true,
  ])
  const reads = typesRuns(seen)
  expect(reads.length).toBe(2)
  expect(reads[0]?.slice(4, 7)).toEqual(['owner=a', '-F', 'repo=b'])
  expect(reads[1]?.slice(4, 7)).toEqual(['owner={owner}', '-F', 'repo={repo}'])
})

test('a command that is not gh issue create reads nothing', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => TYPES)

  await $.tool.call({ tool: 'Bash', command: 'gh issue list' })
  await $.tool.call({ tool: 'Bash', command: 'echo "gh issue create"' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()

  expect(typesRuns(seen)).toEqual([])
})

test('a gh issue create that passes refreshes the row after it runs', async ($, on) => {
  const { seen, clock } = stubTypes(on, () => NO_TYPES)

  await $.tool.call({ tool: 'Bash', command: 'gh issue create --title t' })
  await clock.settle()

  // The types read, then the status check.
  expect(seen.runs.map((argv) => argv[0])).toEqual(['gh', 'node'])
})
