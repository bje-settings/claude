// This file is the stdout and stderr handling every ported script repeats.
// It is the port of `plugins/gh/scripts/lib/streams.py`. That script has
// three duties. They are UTF-8 text, and a descriptor that is gone
// outright. They are also a reader that went away partway through
// (`cmd | head`).
//
// **node already does two of the three duties. This file pins them, and
// does not build them again** (`streams.test.ts` proves each against
// a real child):
//
//   - *UTF-8*. `use_utf8` exists because Python encodes stdout with the
//     locale's codec. `LC_ALL=en_US.ISO8859-1` turns the report's ✓ into a
//     UnicodeEncodeError on the first line. node writes a string as UTF-8
//     whatever the locale says, so there is nothing to configure on the
//     way out. The one place the duty is real is on the way **in**, which
//     is {@link readStdinText}'s job.
//   - *A closed descriptor*. `bind_closed_streams` exists because Python
//     sets `sys.stdout` to None when fd 1 was closed before launch. Every
//     write afterward then raises an AttributeError, after the work is
//     done. node opens /dev/null over any closed stdio descriptor during
//     startup. `process.stdout` is then always a real stream, and the
//     writes are discarded. This is what a caller that ran `exec 1>&- ;
//     ...` asked for.
//
// The third duty is real here, and it is what this file is for:
//
//   - *EPIPE*. A closed reader makes the write fail **asynchronously**, as
//     an `error` event on the stream, not as an exception at the call.
//     There is nothing to wrap in a `try`. With no listener, node treats
//     that event as uncaught, and crashes with an internal stack trace.
//     That is how `gh-sync.py | head` would end.
//
//     `silence_output` is the answer the Python gives.
//     {@link createWriter} gives the same answer: the writer goes quiet
//     and the run finishes normally. By then the jobs have already run,
//     and may already have deleted branches. To abandon the rest of the
//     loop would only lose the account of it (`gh-sync.py:63` to `83`).
//
// **Only EPIPE is swallowed.** A listener, once registered, silences
// node's default crash for every error code on that stream. An `ENOSPC`
// or `EIO` is then re-thrown here, and does not disappear with the broken
// pipe. That is round 5's review finding on #156. The same rule also
// landed in `plugins/mermaid/scripts/mermaid.ts`, for an entry point.
//
// This file ships. It imports nothing at all, and stays inside the erasable
// subset (ADR 001).
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree. The
// file and line references below point to what they held at `cd0d515`.
// They stay because each one says where a rule came from. Nothing here
// changed with the deletion.

/** One stream error to report: node's code and node's message. */
export interface StreamFailure {
  /** node's own code, or the error's name for the rare error that carries
   *  none. Only `EPIPE` is ever absent from this account. Only a broken
   *  pipe is a reader that left, instead of a write that failed. */
  readonly code: string
  readonly message: string
}

/**
 * A stream `error` event as the zero or one failure to report.
 *
 * This is the one place the rule "only EPIPE is swallowed" is written
 * down. The writer below and `process.ts`'s three child pipes then decide
 * it the same way, instead of twice. It is a pure function: it takes the
 * error, and returns the account of it.
 *
 * This is what lets `process.ts` attach it to stdin, stdout and stderr
 * with no branch of its own. A caller that asked "is this EPIPE" would
 * need an `if`. Its non-EPIPE arm is a branch nothing can produce on a
 * real child. An arm no test can reach is the branch the coverage rule
 * says to restructure away, not to exclude.
 */
export const streamFailures = (error: NodeJS.ErrnoException): readonly StreamFailure[] =>
  error.code === 'EPIPE' ? [] : [{ code: error.code ?? error.name, message: error.message }]

/**
 * As much of a writable stream as this file uses.
 *
 * This type is structural, so `process.stdout` satisfies it, and a test
 * satisfies it with a plain object. It is an interface, not a class,
 * because `tsc` sees every type that crosses the `src/lib` symlink under
 * two identities. Only a structural type survives that (round 5's rule,
 * reproduced on #156).
 */
export interface OutputStream {
  write(text: string): boolean
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/** One guarded stream. */
export interface Writer {
  /** Write, unless this writer has gone quiet. */
  write(text: string): void
  /** Go quiet for good. This is the port of `silence_output`, called
   *  deliberately, as `gh-sync.py:269` does once the report is over. */
  silence(): void
  /** Whether this writer still writes. `gh-sync-repo.py:173` keeps the
   *  same flag (`self.quiet`), so a report that lost its reader does not
   *  build lines nobody will read. */
  readonly silenced: boolean
}

/**
 * A writer over `stream` that goes quiet on a broken pipe.
 *
 * The EPIPE guard is installed once, here, instead of at each write. The
 * reason is that the failure is an event, not a return value. Every other
 * error code is re-thrown. node then reports it as the uncaught exception
 * it would have been, with no listener at all.
 */
export const createWriter = (stream: OutputStream): Writer => {
  let silenced = false
  stream.on('error', (error) => {
    // {@link streamFailures} is the rule. An empty account means a broken pipe.
    if (streamFailures(error).length === 0) {
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
 * They are independent on purpose. This is the whole point of
 * `include_stderr=False` (`gh-sync.py:83`). A reader that closed the pipe
 * took stdout with it, while the jobs still run. A real failure afterward
 * still has to reach the terminal.
 *
 * The streams are arguments, not defaults that reach for `process.stdout`.
 * A command then holds no reference to the process it runs in. This
 * file's suite also needs no process at all (ADR 001, "the command
 * function is the seam").
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
 * This is the port of `use_utf8(sys.stdin)`, whose caller is `hook-io.py
 * report`. That caller reads a report that carries ✓, ✗ and ·. An
 * unreconfigured Python stream raises UnicodeDecodeError, and does not
 * hand back a line. This file uses replacement, not strict decoding, the
 * same as the Python's `errors="replace"`. A stray byte must cost one
 * character, not the whole report.
 *
 * The parameter is the stream, not `process.stdin`, for the same reason
 * {@link createOutput} takes its streams.
 */
export const readStdinText = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
