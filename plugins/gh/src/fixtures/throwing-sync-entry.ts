// A stand-in for `scripts/gh.ts`'s own `sync` dispatch, with the one thing a
// spawned process cannot otherwise reach: a job that throws.
//
// `syncRepo`, the real job, cannot be made to throw through any externally
// reachable state: `lib/process.ts` `run` never rejects, every git call in
// `lib/git.ts` answers `null` on failure rather than throwing, and every `gh`
// failure `lib/gh.ts` reports arrives as a `GhError`, which `sync-repo.ts`'s
// `ask()` always catches. So the only way to prove the #81 exit-1 contract at
// a real process boundary, rather than in `commands/sync.test.ts`'s in-process
// suite, is to import the real `createSyncCommand` with a throwing stand-in
// in place of `syncRepo`. Everything below MIRRORS `scripts/gh.ts`'s own `sync`
// arm and its `write` helper rather than calling them, because `write` is an
// unexported `const` and the `sync` arm is a branch inside `run`, neither
// reachable from outside that file (`fixtures/README.md` states what this
// leaves untested: a future break confined to `scripts/gh.ts`'s own `write` or
// `sync` arm, for the exit-1 case specifically, would not be caught here).
//
// argv is passed straight through to `sync`, as `scripts/gh.ts sync` would take it.
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
