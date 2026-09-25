// This file stands in for `scripts/gh.ts`'s own `sync` dispatch. It adds
// the one thing a spawned process cannot otherwise reach: a job that
// throws.
//
// No externally reachable state can make `syncRepo`, the real job, throw.
// `lib/process.ts`'s `run` never rejects. Every git call in `lib/git.ts`
// answers `null` on failure, rather than throw. Every `gh` failure that
// `lib/gh.ts` reports arrives as a `GhError`. `sync-repo.ts`'s `ask()`
// always catches that error.
//
// The #81 exit-1 contract needs proof at a real process boundary, not
// inside `commands/sync.test.ts`'s in-process suite. The only way to
// prove it there is to import the real `createSyncCommand`, with a
// throwing stand-in in place of `syncRepo`.
//
// Everything below MIRRORS `scripts/gh.ts`'s own `sync` arm and its
// `write` helper, rather than call them. `write` is an unexported
// `const`, and the `sync` arm is a branch inside `run`. Neither is
// reachable from outside that file. `fixtures/README.md` states what
// this leaves untested. This gap is the exit-1 case specifically. A
// future break confined to `scripts/gh.ts`'s own `write` or `sync` arm
// would not be caught here.
//
// argv is passed straight through to `sync`, as `scripts/gh.ts sync` would
// take it.
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
