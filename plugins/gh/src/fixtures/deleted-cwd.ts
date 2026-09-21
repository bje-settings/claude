// The hook entry point, run from a working directory that has been deleted.
//
// `process.cwd()` raises there, and the payload carries no cwd to use
// instead, so the fallback fails before any of the hook's own guards are in
// play: unforeseen, so nothing below it can be asked to handle it, and still
// not a reason a session stops. That is the shape the entry point's outermost
// handler exists for, and the only way to reach it is from inside a process
// that has already lost its directory, which is what this fixture is.
//
// argv is the directory to enter and delete, then the hook to run.
import { rmdirSync } from 'node:fs'

const [directory = '', hook = ''] = process.argv.slice(2)
process.chdir(directory)
rmdirSync(directory)
// What the hook reads: `process.argv.slice(2)` is its own command line.
process.argv = [process.argv[0] ?? '', hook, 'session-start']
await import(hook)
