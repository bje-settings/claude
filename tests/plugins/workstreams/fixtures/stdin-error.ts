// The guard's entry point, run in a process whose stdin fails mid read.
//
// `hooks/guard.ts` promises that nothing inside it can deny a tool call by
// accident. Whatever goes wrong leaves stdout empty, an account on stderr,
// and a status of 0. The guard itself already answers everything it
// foresees, without it reaching that outer handler. So the only way to
// exercise the handler is a failure nothing below it can handle, from
// inside a process that has one. Reading stdin is the one edge the entry
// point cannot hand to a seam: the payload arrives there, and a descriptor
// can fail after it opens.
//
// `plugins/gh/src/fixtures/deleted-cwd.ts` is the same fixture for the same
// handler in the `gh` hook. There, the unforeseen failure available was a
// working directory that had been removed.
//
// argv is the hook entry to run.
import { Readable } from 'node:stream'

const [hook = ''] = process.argv.slice(2)
const failing = new Readable({
  read() {
    this.destroy(new Error('stdin went away mid read'))
  },
})
Object.defineProperty(process, 'stdin', { configurable: true, value: failing })
await import(hook)
