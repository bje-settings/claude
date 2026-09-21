// A stand-in for `bin/gh.ts`'s own `sync` dispatch, with the one thing a
// spawned process cannot otherwise reach: a job that throws.
//
// `syncRepo`, the real job, cannot be made to throw through any externally
// reachable state: `lib/process.ts` `run` never rejects, every git call in
// `lib/git.ts` answers `null` on failure rather than throwing, and every `gh`
// failure `lib/gh.ts` reports arrives as a `GhError`, which `sync-repo.ts`'s
// `ask()` always catches. So the only way to prove the #81 exit-1 contract at
// a real process boundary, rather than in `commands/sync.test.ts`'s in-process
// suite, is to drive the same production wiring `bin/gh.ts` uses with a
// throwing stand-in in place of `syncRepo`. Everything below mirrors
// `bin/gh.ts`'s own `sync` arm and its `write` helper, so what this proves
// about the envelope-to-exit-code wiring is what `bin.ts` wires too.
//
// argv is passed straight through to `sync`, as `bin/gh.ts sync` would take it.
import { createSyncCommand } from '../commands/sync.ts'
import { renderText } from '../lib/envelope.ts'
import { createOutput } from '../lib/streams.ts'

const output = createOutput(process.stdout, process.stderr)

const job = async (): Promise<number> => {
  throw new Error('boom')
}

/** Never called: the job always throws before a `gh` call would happen. */
const failingGhClient = (): never => {
  throw new Error('this fixture never calls gh')
}

const envelope = await createSyncCommand(job)(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  output,
  createGh: failingGhClient,
})

const rendered = renderText(envelope)
if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
process.exitCode = rendered.exitCode
