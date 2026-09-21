// The stdout and stderr handling every ported script repeats: the port of
// `plugins/gh/scripts/lib/streams.py`, whose three duties are UTF-8 text, a
// descriptor that is gone outright, and a reader that went away partway
// through (`cmd | head`).
//
// **Two of the three duties are node's already, and are pinned rather than
// reimplemented** (`streams.test.ts` proves each against a real child):
//
//   - *UTF-8*. `use_utf8` exists because Python encodes stdout with the
//     locale's codec, so `LC_ALL=en_US.ISO8859-1` turns the report's ✓ into a
//     UnicodeEncodeError on the first line. node writes a string as UTF-8
//     whatever the locale says, so there is nothing to configure on the way
//     out. The one place the duty is real is on the way **in**, which is what
//     {@link readStdinText} is for.
//   - *A closed descriptor*. `bind_closed_streams` exists because Python sets
//     `sys.stdout` to None when fd 1 was closed before launch, so every write
//     afterwards is an AttributeError raised after the work is done. node
//     opens /dev/null over any closed stdio descriptor during startup, so
//     `process.stdout` is always a real stream and the writes are discarded,
//     which is what a caller who ran `exec 1>&- ; ...` asked for.
//
// The third duty is real here and is what this file is:
//
//   - *EPIPE*. A closed reader makes the write fail **asynchronously**, as an
//     `error` event on the stream rather than as an exception at the call, so
//     there is nothing to wrap in a `try`. With no listener node treats that
//     event as uncaught and crashes with an internals stack trace, which is
//     how `gh-sync.py | head` would end. `silence_output` is the answer the
//     Python gives and {@link createWriter} is the same answer: the writer
//     goes quiet and the run finishes normally, because by then the jobs have
//     already run and may already have deleted branches, and abandoning the
//     rest of the loop would only lose the account of it (`gh-sync.py:63` to
//     `83`).
//
// **Only EPIPE is swallowed.** Registering a listener at all silences node's
// default crash for every error code on that stream, so an `ENOSPC` or `EIO`
// is re-thrown here rather than disappearing with the broken pipe. That is
// round 5's review finding on #156, and `plugins/mermaid/bin/mermaid.ts` is
// where the same rule landed for an entry point.
//
// This file ships. It imports nothing at all, and stays inside the erasable
// subset (ADR 001).

/**
 * As much of a writable stream as this file uses.
 *
 * Structural, so `process.stdout` satisfies it and a test satisfies it with
 * an object; an interface and not a class because every type that crosses the
 * `src/lib` symlink is seen by `tsc` under two identities and only a
 * structural one survives that (round 5's rule, reproduced on #156).
 */
export interface OutputStream {
  write(text: string): boolean
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/** One guarded stream. */
export interface Writer {
  /** Write, unless this writer has gone quiet. */
  write(text: string): void
  /** Go quiet for good. The port of `silence_output` called deliberately, as
   *  `gh-sync.py:269` does once the report is over. */
  silence(): void
  /** Whether anything is still being written. `gh-sync-repo.py:173` keeps the
   *  same flag (`self.quiet`) so that a report that lost its reader stops
   *  building lines nobody will read. */
  readonly silenced: boolean
}

/**
 * A writer over `stream` that goes quiet on a broken pipe.
 *
 * The EPIPE guard is installed once, here, rather than at each write, because
 * the failure is an event and not a return value. Every other error code is
 * re-thrown, which node then reports as the uncaught exception it would have
 * been with no listener at all.
 */
export const createWriter = (stream: OutputStream): Writer => {
  let silenced = false
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
      silenced = true
      return
    }
    throw error
  })
  return {
    write: (text) => {
      if (silenced) return
      stream.write(text)
    },
    silence: () => {
      silenced = true
    },
    get silenced() {
      return silenced
    },
  }
}

/** The pair a command writes through. */
export interface Output {
  readonly out: Writer
  readonly err: Writer
  /** Both, for the end of a run: "by then nothing is left to say"
   *  (`streams.py`'s `silence_output` default, `gh-sync.py:269`). */
  silence(): void
}

/**
 * stdout and stderr as two independently guarded writers.
 *
 * Independent on purpose, and it is the whole of `include_stderr=False`
 * (`gh-sync.py:83`): a reader that closed the pipe took stdout with it, while
 * the jobs are still running and a real failure afterwards still has to be
 * able to reach the terminal.
 *
 * The streams are arguments rather than defaults reaching for
 * `process.stdout`, so a command holds no reference to the process it happens
 * to be running in and this file's suite needs no process at all (ADR 001,
 * "the command function is the seam").
 */
export const createOutput = (out: OutputStream, err: OutputStream): Output => {
  const stdout = createWriter(out)
  const stderr = createWriter(err)
  return {
    out: stdout,
    err: stderr,
    silence: () => {
      stdout.silence()
      stderr.silence()
    },
  }
}

/**
 * Everything on `stream`, decoded as UTF-8 with replacement.
 *
 * The port of `use_utf8(sys.stdin)`, whose caller is `hook-io.py report`:
 * it reads a report carrying ✓, ✗ and ·, and an unreconfigured Python stream
 * raises UnicodeDecodeError instead of handing back a line. Replacement
 * rather than strict decoding, exactly as the Python's `errors="replace"`: a
 * stray byte must cost one character, not the whole report.
 *
 * The parameter is the stream, not `process.stdin`, for the same reason
 * {@link createOutput} takes its streams.
 */
export const readStdinText = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
