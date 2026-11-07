// The gh hooks module (`plugins/gh/hooks/register.ts`), under
// `claude plugin test` (ADR 007, ruling 3). `scripts/plugin-test.ts` copies
// this file into the plugin's `tests/` folder, so the plugin is one folder
// up from here at run time.
//
// Each hook the test adds with `on` stands for the engine. Every engine
// call the module makes has a stub in result form: `process.run`,
// `ui.status`, `ui.log`, `session.cwd`, the clock, `session.start` and
// `tool.call`. A call with no stub would reach nothing.
import type { On, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/** The session's directory, as the stubs answer it. */
const CWD = '/work/repo'

/** A run of `hook-io.ts status` that exits `exitCode` with `stdout`. */
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
  return { seen, clock }
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

test('a session start pins the stdout of the status run, as one line', async ($, on) => {
  const { seen, clock } = stub(on, () =>
    ran('gh: [behind] [🤖 2]\ngh: ⚠️ fetch failed: Invalid username or token\n'),
  )

  await $.session.start(START)
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  const [argv] = seen.runs
  expect(argv?.[0]).toBe('node')
  expect(String(argv?.[1]).endsWith('/hooks/hook-io.ts')).toBe(true)
  expect(argv?.slice(2)).toEqual(['status', CWD])
  expect(seen.inits).toEqual([{ cwd: CWD, timeoutMs: 15_000 }])
  expect(seen.statuses).toEqual([
    'gh: [behind] [🤖 2] ⚠️ fetch failed: Invalid username or token',
  ])
  expect(seen.logs).toEqual([])
})

test('a session start does not wait for the status run', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), { delayMs: 1_000 })

  await $.session.start(START)

  // The start has resolved, and the run is still held on the clock.
  expect(seen.statuses).toEqual([])
  await clock.advance(1_000)
  expect(seen.statuses).toEqual(['gh: [behind]'])
})

test('an empty stdout clears the line', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(index === 0 ? 'gh: [behind]\n' : ''))

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.statuses).toEqual(['gh: [behind]', undefined])
})

test('a failed run keeps the last line, and logs why once', async ($, on) => {
  const { seen, clock } = stub(on, (index) => {
    if (index === 0) return ran('gh: [✂️ 1]\n')
    if (index === 1) throw new Error('spawn node ENOENT')
    return ran('', 2, 'usage: hook-io.ts {session-start|status [dir]}\n')
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git fetch' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
  await clock.settle()

  expect(seen.runs.length).toBe(3)
  // No clear and no second pin: the line from the first run stays.
  expect(seen.statuses).toEqual(['gh: [✂️ 1]'])
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

test('a Bash git call refreshes the line', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(index === 0 ? 'gh: [behind]\n' : 'gh: [✂️ 2]\n'))

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull --ff-only' })
  await clock.settle()

  expect(seen.runs.length).toBe(2)
  expect(seen.runs[1]?.slice(2)).toEqual(['status', CWD])
  expect(seen.statuses).toEqual(['gh: [behind]', 'gh: [✂️ 2]'])
})

test('a Bash ls call does not refresh the line', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'))

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  expect(seen.statuses).toEqual(['gh: [behind]'])
})

test('no second check starts while one runs, and one more run follows it', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(`gh: [✂️ ${index + 1}]\n`), { delayMs: 1_000 })

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
  expect(seen.statuses).toEqual(['gh: [✂️ 1]'])
  await clock.advance(1_000)
  expect(seen.runs.length).toBe(2)
  expect(seen.statuses).toEqual(['gh: [✂️ 1]', 'gh: [✂️ 2]'])
})

test('the timer refreshes the line every five minutes', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(`gh: [✂️ ${index + 1}]\n`))

  await $.session.start(START)
  await clock.settle()
  await clock.advance(299_999)
  expect(seen.runs.length).toBe(1)
  await clock.advance(1)

  expect(seen.runs.length).toBe(2)
  expect(seen.statuses).toEqual(['gh: [✂️ 1]', 'gh: [✂️ 2]'])
})

test('the timer keeps its period after the first refresh', async ($, on) => {
  const { seen, clock } = stub(on, (index) => ran(`gh: [✂️ ${index + 1}]\n`))

  await $.session.start(START)
  await clock.settle()
  await clock.advance(600_000)

  expect(seen.runs.length).toBe(3)
})

test('a second session start replaces the timer', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'))

  await $.session.start(START)
  await clock.settle()
  await $.session.start(START)
  await clock.settle()
  expect(seen.runs.length).toBe(2)
  await clock.advance(300_000)

  // One timer fired, not two.
  expect(seen.runs.length).toBe(3)
})

test('a git call that a hook refused does not refresh the line', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), { deny: 'not now' })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
})

test('a call to another tool does not refresh the line, even with a git command', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'))

  await $.session.start(START)
  await clock.settle()
  // Only the Bash matcher keeps this out: the input names a git command.
  await $.tool.call({ tool: 'mcp__shell__run', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
})

test('a line after a failure resets the log, so the next failure logs again', async ($, on) => {
  const { seen, clock } = stub(on, (index) => {
    if (index === 1) return ran('gh: [behind]\n')
    return ran('', 2, 'usage\n')
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.statuses).toEqual(['gh: [behind]'])
  expect(seen.logs.length).toBe(2)
})

test('a line written before a signal ended the run is pinned', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [✂️ 3]\n', 1))

  await $.session.start(START)
  await clock.settle()

  expect(seen.statuses).toEqual(['gh: [✂️ 3]'])
  expect(seen.logs).toEqual([])
})

test('a refresh reads the session directory again', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), {
    cwd: () => '/work/other',
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.map((argv) => argv[3])).toEqual([CWD, '/work/other'])
  expect(seen.inits[1]).toEqual({ cwd: '/work/other', timeoutMs: 15_000 })
})

test('a session directory that cannot be read logs once and starts no run', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), {
    cwd: () => {
      throw new Error('no session')
    },
  })

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  expect(seen.statuses).toEqual(['gh: [behind]'])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toContain('gh: the status check could not run: ')
})
