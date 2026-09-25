// This fixture is the hook entry point. It runs after this process
// deletes its own working directory.
//
// `process.cwd()` raises an error there, and the payload carries no cwd
// to use instead. The fallback fails before any of the hook's own guards
// run. This error is unexpected, so nothing below can handle it, and it
// still must not stop a session. This is the exact case the entry point's
// outermost handler exists for. The only way to reach it is from inside a
// process that has already lost its directory. This fixture creates
// exactly that case.
//
// argv is the directory to enter and delete, then the hook to run.
import { rmdirSync } from 'node:fs'

const [directory = '', hook = ''] = process.argv.slice(2)
process.chdir(directory)
rmdirSync(directory)
// What the hook reads: `process.argv.slice(2)` is its own command line.
process.argv = [process.argv[0] ?? '', hook, 'session-start']
await import(hook)
