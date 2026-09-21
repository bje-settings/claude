// The stream handling's own claims, including the two the port does NOT
// implement because node already holds them. Those two are pinned against a
// real child rather than asserted in prose: if a future node stopped opening
// /dev/null over a closed descriptor, or started encoding stdout with the
// locale, this file goes red instead of a session losing its report.
import { expect, it } from 'vitest'
import { createSandbox } from '../harness/sandbox.ts'
import { run } from './process.ts'
import { createOutput, createWriter, readStdinText } from './streams.ts'

const HARNESS_FIXTURES = `${import.meta.dirname}/../harness/fixtures`

/** A stand-in for `process.stdout`: what was written, and a way to raise the
 *  error node would raise. Not a mock of a system boundary (the boundary is
 *  covered against a real child below); it is the only way to deliver an
 *  `ENOSPC` on demand. */
const fake = () => {
  const written: string[] = []
  const listeners: Array<(error: NodeJS.ErrnoException) => void> = []
  return {
    written,
    stream: {
      write(text: string) {
        written.push(text)
        return true
      },
      on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void) {
        listeners.push(listener)
        return undefined
      },
    },
    raise(code: string) {
      const error: NodeJS.ErrnoException = new Error(code)
      error.code = code
      for (const listener of listeners) listener(error)
    },
  }
}

/** An async iterable over the chunks a stream would hand out. */
async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value
}

it('writes through to the stream it was given', () => {
  const stdout = fake()

  createWriter(stdout.stream).write('a line\n')

  expect(stdout.written).toEqual(['a line\n'])
})

it('goes quiet for good once the reader has gone away', () => {
  // `gh-sync.py:79`: the jobs have already run and may have deleted branches,
  // so the run finishes rather than abandoning the loop, and every later line
  // is dropped instead of raising again.
  const stdout = fake()
  const writer = createWriter(stdout.stream)

  writer.write('first\n')
  stdout.raise('EPIPE')
  writer.write('second\n')

  expect(writer.silenced).toBe(true)
  expect(stdout.written).toEqual(['first\n'])
})

it('re-throws every error that is not a broken pipe', () => {
  // Round 5's review finding on #156: registering a listener silences node's
  // default crash for EVERY code on that stream, so a disk that filled up
  // would disappear along with the broken pipe.
  const stdout = fake()
  createWriter(stdout.stream)

  expect(() => stdout.raise('ENOSPC')).toThrow('ENOSPC')
})

it('can be silenced deliberately, with nothing having gone wrong', () => {
  const stdout = fake()
  const writer = createWriter(stdout.stream)

  writer.silence()
  writer.write('after\n')

  expect(writer.silenced).toBe(true)
  expect(stdout.written).toEqual([])
})

it('keeps stderr alive when stdout loses its reader', () => {
  // `include_stderr=False` (`gh-sync.py:83`): the pipe is the reader's
  // business, and a real failure after that point still has to reach the
  // terminal.
  const stdout = fake()
  const stderr = fake()
  const output = createOutput(stdout.stream, stderr.stream)

  stdout.raise('EPIPE')
  output.out.write('dropped\n')
  output.err.write('still said\n')

  expect(stdout.written).toEqual([])
  expect(stderr.written).toEqual(['still said\n'])
})

it('silences both at the end of a run', () => {
  const stdout = fake()
  const stderr = fake()
  const output = createOutput(stdout.stream, stderr.stream)

  output.silence()
  output.out.write('dropped\n')
  output.err.write('dropped\n')

  expect(stdout.written).toEqual([])
  expect(stderr.written).toEqual([])
})

it('reads stdin as UTF-8, replacing what it cannot decode', async () => {
  const text = await readStdinText(
    chunks(new TextEncoder().encode('✓ done '), new Uint8Array([0xff])),
  )

  expect(text).toBe('✓ done �')
})

it('reads an empty stdin as an empty string', async () => {
  await expect(readStdinText(chunks())).resolves.toBe('')
})

it('writes UTF-8 whatever the locale says, so `use_utf8` has nothing to port', async () => {
  // Python encodes stdout with the locale's codec, so under LC_ALL=C the
  // report's ✓ is a UnicodeEncodeError on its first line. node does not.
  const sandbox = createSandbox()

  const result = await run(process.execPath, [`${HARNESS_FIXTURES}/echo-argv.ts`, '✓ done'], {
    env: { ...sandbox.env, LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' },
  })

  expect(JSON.parse(result.stdout)).toEqual(['✓ done'])
})

it('survives a descriptor that was closed before it started, so `bind_closed_streams` has nothing to port', async () => {
  // Python sets `sys.stdout` to None here and raises an AttributeError after
  // the work is already done (`streams.py`'s `bind_closed_streams`). node
  // opens /dev/null over a closed stdio descriptor during startup, so the
  // writes are discarded and the child still exits 0.
  const result = await run('sh', [
    '-c',
    'exec 1>&- ; "$0" "$1" ok',
    process.execPath,
    `${HARNESS_FIXTURES}/echo-argv.ts`,
  ])

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('')
})
