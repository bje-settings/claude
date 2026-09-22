// The guard's entry point, run in a process whose stdin fails mid read.
//
// `hooks/guard.ts` promises that nothing which happens inside it can deny a
// tool call by accident: whatever goes wrong leaves stdout empty, an account
// on stderr and a status of 0. Everything the guard itself foresees is already
// answered without reaching that outer handler, so the only way to exercise it
// is a failure nothing below it can be asked to handle, from inside a process
// that has one. Reading stdin is the one edge the entry point cannot hand to a
// seam: the payload arrives there, and a descriptor can fail after it opens.
//
// `plugins/gh/src/fixtures/deleted-cwd.ts` is the same fixture for the same
// handler in the `gh` hook, where the unforeseen failure available was a
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
