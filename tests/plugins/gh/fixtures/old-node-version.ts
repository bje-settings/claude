// This fixture runs the hook entry point as if a node below the floor ran
// it. `hook.test.ts` uses it to cover the below-floor branch (#245) at the
// process boundary. This suite cannot spawn a real node under the floor.
// So this overrides what the hook reads. It imports the real entry point
// after the override. `deleted-cwd.ts` reaches the outermost handler the
// same way: it breaks a real precondition first.
//
// argv: the hook to run.
Object.defineProperty(process, 'version', { value: 'v20.19.0', configurable: true })

const [hook = ''] = process.argv.slice(2)
process.argv = [process.argv[0] ?? '', hook, 'session-start']
await import(hook)
