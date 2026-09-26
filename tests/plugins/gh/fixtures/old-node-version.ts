// This fixture runs the hook entry point as if a node below the floor ran
// it. `hook.test.ts` uses it to cover the below-floor branch (#245) at the
// process boundary: this suite cannot spawn a real node under the floor,
// so this overrides what the hook reads, and imports the real entry point
// after the override, the same way `deleted-cwd.ts` reaches the outermost
// handler by breaking a real precondition first.
//
// argv: the hook to run.
Object.defineProperty(process, 'version', { value: 'v20.19.0', configurable: true })

const [hook = ''] = process.argv.slice(2)
process.argv = [process.argv[0] ?? '', hook, 'session-start']
await import(hook)
