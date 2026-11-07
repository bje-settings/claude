// The gh hooks module (`plugins/gh/hooks/register.ts`), under
// `claude plugin test` (ADR 007, ruling 3). `scripts/plugin-test.ts` copies
// this file into the plugin's `tests/` folder, so the plugin is one folder
// up from here at run time.
//
// Each hook the test adds with `on` stands for the engine. Every engine
// call the module makes has a stub in result form: `process.run`,
// `ui.status`, `ui.log`, `session.cwd`, the clock, `session.start` and
// `tool.call`. A call with no stub would reach nothing.
import type { On, ProcessRunResult } from 'claude-code'
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
  /** The text of each `ui.status` call, `undefined` for a clear. */
  readonly statuses: (string | undefined)[]
  /** The text of each `ui.log` call. */
  readonly logs: string[]
}

/**
 * Stub every engine call the module makes. `answer` gives the result of
 * each `process.run` call in turn, or throws for a run that rejects. A
 * `delayMs` holds each run on the mocked clock for that long.
 */
const stub = (
  on: On,
  answer: (index: number) => ProcessRunResult,
  delayMs = 0,
): { seen: Seen; clock: ReturnType<typeof mock.clock> } => {
  const clock = mock.clock(on)
  const seen: Seen = { runs: [], statuses: [], logs: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', async (_, e) => {
    const index = seen.runs.length
    seen.runs.push(e.argv)
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
  expect(seen.statuses).toEqual([
    'gh: [behind] [🤖 2] ⚠️ fetch failed: Invalid username or token',
  ])
  expect(seen.logs).toEqual([])
})

test('a session start does not wait for the status run', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), 1_000)

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

test('no second check starts while one runs', async ($, on) => {
  const { seen, clock } = stub(on, () => ran('gh: [behind]\n'), 1_000)

  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.settle()

  expect(seen.runs.length).toBe(1)
  await clock.advance(1_000)
  expect(seen.runs.length).toBe(1)
  expect(seen.statuses).toEqual(['gh: [behind]'])

  // Once the run has ended, the next git call starts a check again.
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.settle()
  expect(seen.runs.length).toBe(2)
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
