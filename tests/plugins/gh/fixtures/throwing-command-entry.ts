// This file stands in for `scripts/gh.ts`'s own dispatch and its top-level
// catch (#218 finding 7). No externally reachable command throws through a
// spawned process with no `gh` reachable at all (ADR 001 forbids a stub
// binary, and `throwing-sync-entry.ts`'s own header states why nothing else
// can make a real job throw). So this fixture MIRRORS `scripts/gh.ts`'s own
// dispatch and its catch, over one command that always throws, in place of
// a real one.
//
// `fixtures/README.md` states what a mirror like this leaves untested: a
// future defect confined to `scripts/gh.ts`'s own `run` or its catch would
// not be caught here.
import { createOutput } from '#gh/lib/streams.ts'

const output = createOutput(process.stdout, process.stderr)

const run = async (): Promise<number> => {
  throw new Error('boom')
}

process.exitCode = await run().catch((error: unknown) => {
  output.err.write(`gh: ${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})
