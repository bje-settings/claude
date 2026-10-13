// An `Output` that keeps what a command function writes, for a test that
// runs the function in process. It is built over the real `createOutput` of
// `lib/streams.ts`, so a test sees the guard, the silence and the writer
// order that ship. Four test files each held a hand-made copy of this
// (#324), and a copy can drift from `createOutput`.
import { createOutput, type Output, type OutputStream } from '../lib/streams.ts'

/** The `Output` a command writes through, and the text that reached each
 *  stream. */
export interface CapturedOutput extends Output {
  stdout(): string
  stderr(): string
}

/** A stream that keeps its text in memory. It never fails, so it registers
 *  no error listener. */
const memoryStream = (): OutputStream & { text(): string } => {
  const chunks: string[] = []
  const stream = {
    write: (text: string): boolean => {
      chunks.push(text)
      return true
    },
    on: () => stream,
    text: () => chunks.join(''),
  }
  return stream
}

/** A fresh `Output` over two in-memory streams. */
export const captureOutput = (): CapturedOutput => {
  const out = memoryStream()
  const err = memoryStream()
  return { ...createOutput(out, err), stdout: out.text, stderr: err.text }
}
