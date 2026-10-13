// The runner fixtures' claims: the defaults of a child that did nothing
// wrong, and the key a table runner answers by.
import { expect, it } from 'vitest'
import { runResult, tableRunner } from '#harness/runner.ts'

it('makes a child that exited 0 and wrote nothing, by default', () => {
  expect(runResult()).toEqual({
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    combined: '',
    timedOut: false,
    elapsedMs: 0,
    startFailure: null,
    streamErrors: [],
  })
})

it('lets a reply override a field and keep the rest', () => {
  const result = runResult({ status: 1, stderr: 'no' })

  expect(result.status).toBe(1)
  expect(result.stderr).toBe('no')
  expect(result.timedOut).toBe(false)
})

it('answers a call from the entry keyed by command and arguments', async () => {
  const runner = tableRunner({ 'gh auth token': { stdout: 'token\n' } })

  const result = await runner('gh', ['auth', 'token'])

  expect(result.stdout).toBe('token\n')
  expect(result.status).toBe(0)
})

it('answers a call with no entry as a child that succeeded and said nothing', async () => {
  const runner = tableRunner({ 'gh auth token': { status: 1 } })

  expect(await runner('gh', ['other'])).toEqual(runResult())
})

it('keys a call with no arguments by the command alone', async () => {
  const runner = tableRunner({ pgrep: { status: 3 } })

  expect((await runner('pgrep')).status).toBe(3)
})

it('records the key and the options of each call, in order', async () => {
  const runner = tableRunner({})

  await runner('a', ['x'], { timeoutMs: 5 })
  await runner('b')

  expect(runner.asked).toEqual([
    { key: 'a x', options: { timeoutMs: 5 } },
    { key: 'b', options: {} },
  ])
})

it('appends to a list of calls that the caller passes in', async () => {
  const asked: { key: string; options: unknown }[] = []
  const runner = tableRunner({}, asked)

  await runner('a')

  expect(asked).toEqual([{ key: 'a', options: {} }])
})
