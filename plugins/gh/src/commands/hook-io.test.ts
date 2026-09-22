// The SessionStart hook, in process, against what the Python wrote.
//
// `fixtures/hook-output.json` is 54 runs of `plugins/gh/hooks/hook-io.py`
// captured before a line of this port existed, and the acceptance of #127 is
// that the port's stdout is byte-identical to it on the same repository
// state. So every parity example below rebuilds the state with real git
// (`harness/git.ts`; git is never mocked, ADR 001), replays the row, and
// compares the whole of stdout and the whole of stderr against the capture.
//
// The fan-out rows also carry what the Python's child printed, and the child
// is replayed through the injected runner rather than started. That is
// deliberate: the hook's own contract is the decision it takes and the
// document it wraps a report in, while whether `gh.ts sync` prints what
// `gh-sync.py` printed is layer 2's contract, pinned by `bash-sync-output.json`.
// Replaying the recorded child keeps this file honest about which of the two
// it is testing, and `../hook.test.ts` runs the real child end to end.
//
// `fixtures/divergences-hook.json` is the table of what the port deliberately
// says instead of the Python. It is data a test reads, never README prose:
// the acceptance is byte-identical, so a divergence that is not in that file
// and asserted from it is a defect.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGhMock } from '../../../../harness/gh.ts'
import { createGitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { type Runner, type RunOptions, type RunResult, run as realRun } from '../lib/process.ts'
import { createOutput, type Output, type OutputStream, type Writer } from '../lib/streams.ts'
import {
  type BranchStatus,
  branchMessageText,
  countCandidates,
  countLines,
  emit,
  type FanOutSummary,
  fanOutSummary,
  formatG,
  type HookEdges,
  lastLine,
  parseCount,
  payloadCwd,
  pythonFloat,
  repoCount,
  reportMessageText,
  returnCode,
  runHookIo,
  SYNC_TIMEOUT,
  SYNC_TIMEOUT_ENV,
  scrubRepositoryEnv,
  summaryLine,
  syncTimeout,
  USAGE,
  which,
} from './hook-io.ts'
import { failureLine, runSync as runSyncCommand, statusLine } from './sync.ts'
import { REPORT } from './sync-repo.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', 'fixtures')

interface CapturedChild {
  status: number
  stdout: string
  stderr: string
}

interface CapturedRun {
  argv: string[]
  stdin: string
  env: Record<string, string>
  status: number
  stdout: string
  stderr: string
  child?: CapturedChild
}

interface Capture {
  runs: Record<string, CapturedRun>
  syncTimeout: { raw: string; seconds: string; formatted: string }[]
}

const capture = JSON.parse(readFileSync(path.join(FIXTURES, 'hook-output.json'), 'utf8')) as Capture

interface Divergences {
  /** The names a row's text may carry in braces, and what each one stands
   *  for. Documented as data beside the rows that use them. */
  placeholders: { name: string; why: string }[]
  /** A literal substitution applied to every captured row before it is
   *  compared: what the Python wrote, and what the port writes instead. A
   *  `{name}` in either half is filled from the state the example built,
   *  because the port's messages carry computed counts and a fixed pair of
   *  strings cannot express one. */
  text: { name: string; python: string; port: string; why: string }[]
  /** Where the port's text differs from the Python's because a path moved,
   *  as a pair of the Python's spelling and the port's. */
  paths: { name: string; python: string; port: string; why: string }[]
  /** Rows of the captured `syncTimeout` table the port deliberately answers
   *  differently for. */
  syncTimeout: { raw: string; python: string; port: string; why: string }[]
  /** Everything else, as prose that names the state it is about. */
  notes: { name: string; why: string }[]
}

const divergences = JSON.parse(
  readFileSync(path.join(FIXTURES, 'divergences-hook.json'), 'utf8'),
) as Divergences

/** The capture replaced the sandbox it was built in with `<sandbox>`, so the
 *  replay replaces its own the same way before comparing. `scenarios.py`
 *  `normalise` is the original. */
const normalise = (text: string, sandbox: string): string => text.split(sandbox).join('<sandbox>')

/** A writer that keeps what it was given, with the `Writer` shape the command
 *  takes. */
const collector = (): Writer & { text: () => string } => {
  const chunks: string[] = []
  let silenced = false
  return {
    write: (text: string) => {
      chunks.push(text)
    },
    silence: () => {
      silenced = true
    },
    get silenced() {
      return silenced
    },
    text: () => chunks.join(''),
  }
}

const createOutputPair = (): Output & { stdout: () => string; stderr: () => string } => {
  const out = collector()
  const err = collector()
  return {
    out,
    err,
    silence: () => {
      out.silence()
      err.silence()
    },
    stdout: out.text,
    stderr: err.text,
  }
}

/** One call the hook made to the injected runner, whole: the command, every
 *  argument, and the options it was built with. Asserted as a whole rather
 *  than counted (`.claude/rules/type-ts.md`). */
interface RunCall {
  command: string
  args: string[]
  options: RunOptions
}

const runResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 1,
  startFailure: null,
  streamErrors: [],
  ...overrides,
})

interface Harness {
  sandbox: Sandbox
  git: ReturnType<typeof createGitFixtures>
  /** An entry point that exists and is readable, standing in for
   *  `scripts/gh.ts`. The hook only ever reads it to decide whether the install
   *  is complete; the child itself is the injected runner. */
  entry: string
}

const harness = (): Harness => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const scripts = sandbox.join('plugin', 'scripts')
  mkdirSync(scripts, { recursive: true })
  const entry = path.join(scripts, 'gh.ts')
  writeFileSync(entry, '// stands in for the entry point\n')
  return { sandbox, git, entry }
}

interface ReplayOptions {
  /** The directory `process.cwd()` answers with, for the rows whose payload
   *  carries no usable one. */
  processCwd: string
  env?: NodeJS.ProcessEnv
  entry?: string
  /** What the injected runner answers with, when the row has no recorded
   *  child of its own. */
  result?: RunResult
}

interface Replayed {
  status: number
  stdout: string
  stderr: string
  calls: RunCall[]
}

/** Replay one captured row in process. */
const replay = async (
  harnessed: Harness,
  name: string,
  options: ReplayOptions,
): Promise<Replayed> => {
  const row = capture.runs[name]
  if (row === undefined) throw new Error(`no captured run named ${name}`)
  const output = createOutputPair()
  const calls: RunCall[] = []
  const child = row.child
  const runner: Runner = (command, args = [], runOptions = {}) => {
    calls.push({ command, args: [...args], options: runOptions })
    return Promise.resolve(
      options.result ??
        runResult(
          child === undefined
            ? {}
            : { status: child.status, stdout: child.stdout, stderr: child.stderr },
        ),
    )
  }
  const edges: HookEdges = {
    cwd: () => options.processCwd,
    env: options.env ?? harnessed.sandbox.env,
    stdin: () => Promise.resolve(row.stdin),
    output,
    run: runner,
    nodePath: '/usr/bin/node',
    entry: options.entry ?? harnessed.entry,
  }
  const status = await runHookIo(row.argv, edges)
  return {
    status,
    stdout: normalise(output.stdout(), harnessed.sandbox.path),
    stderr: normalise(output.stderr(), harnessed.sandbox.path),
    calls,
  }
}

/** What a captured case's own state makes true, filled into the placeholders
 *  the divergence rows carry. Raw text: the escaping is applied here. */
type Fields = Record<string, string>

/** A row's text with its placeholders filled. A name the case did not supply
 *  becomes the empty string, which reduces a row that does not apply to this
 *  case to text no captured document can contain. */
const fill = (text: string, fields: Fields): string =>
  text.replace(/\{([a-z]+)\}/g, (_match, name: string) => fields[name] ?? '')

/** One string as it appears INSIDE the hook's JSON document: `emit` writes
 *  every message through `asciiJson`, so a newline there is a backslash and an
 *  `n`. `JSON.stringify` applies exactly that escaping to everything the table
 *  holds, all of which is ASCII. */
const inJson = (text: string): string => JSON.stringify(text).slice(1, -1)

/** The Python's text with every recorded substitution applied, which is what
 *  the port is expected to have written. */
const expected = (text: string, fields: Fields = {}): string => {
  let answer = text
  for (const entry of divergences.text) {
    const python = fill(entry.python, fields)
    const port = fill(entry.port, fields)
    // Raw first, which is stderr, and then the escaped form, which is how the
    // same sentence appears on stdout. A multi-line raw string cannot occur
    // inside a JSON document, so no occurrence is substituted twice.
    answer = answer.split(python).join(port)
    answer = answer.split(inJson(python)).join(inJson(port))
  }
  return answer
}

/** Assert one replayed row against the capture, whole. */
const expectParity = (replayed: Replayed, name: string, fields: Fields = {}): void => {
  const row = capture.runs[name]
  if (row === undefined) throw new Error(`no captured run named ${name}`)
  expect(replayed.stdout).toBe(expected(row.stdout, fields))
  expect(replayed.stderr).toBe(expected(row.stderr, fields))
  expect(replayed.status).toBe(row.status)
}

/** The fan-out summary a captured report makes true, as the message carries
 *  it: the line and the newline after it. Written out per case rather than
 *  computed, so the expectation is not the code under test. */
const summaryField = (line: string): Fields => ({ summary: `${line}\n` })

// --- the seams: no repository, no child --------------------------------------

// The `branch` rows carry the default branch the seam was given on the
// command line; the `report` rows carry no summary, because the seam wraps a
// body it was handed rather than a fan-out it ran.
for (const [name, fields] of [
  ['cwd/with-a-cwd', {}],
  ['cwd/without-a-cwd', {}],
  ['cwd/not-json', {}],
  ['cwd/not-an-object', {}],
  ['cwd/empty-stdin', {}],
  ['cwd/non-ascii', {}],
  ['cwd/cwd-is-null', {}],
  ['branch/both-names', { target: 'main' }],
  ['branch/non-ascii', { target: 'main' }],
  ['branch/quotes-and-backslashes', { target: 'main' }],
  ['branch/one-name', {}],
  ['branch/three-names', {}],
  ['branch/no-names', {}],
  ['report/simple', {}],
  ['report/non-ascii', {}],
  ['report/empty-stdin', {}],
  ['report/trailing-newlines', {}],
  ['report/control-characters', {}],
  ['report/single-byte-locale', {}],
  ['report/astral', {}],
  ['usage/no-subcommand', {}],
  ['usage/unknown-subcommand', {}],
  ['usage/empty-subcommand', {}],
] as [string, Fields][]) {
  it(`writes what the Python wrote for ${name}`, async () => {
    const harnessed = harness()

    const replayed = await replay(harnessed, name, { processCwd: harnessed.sandbox.path })

    expectParity(replayed, name, fields)
    expect(replayed.calls).toEqual([])
  })
}

// --- session-start inside a repository ---------------------------------------

/** Build the repository a row was captured against, and replay the row with
 *  its payload pointed at it. */
const inRepo = async (
  name: string,
  build: (harnessed: Harness) => string,
): Promise<{ harnessed: Harness; replayed: Replayed }> => {
  const harnessed = harness()
  const repository = build(harnessed)
  const output = createOutputPair()
  const calls: RunCall[] = []
  const runner: Runner = (command, args = [], runOptions = {}) => {
    calls.push({ command, args: [...args], options: runOptions })
    return Promise.resolve(runResult())
  }
  const row = capture.runs[name]
  if (row === undefined) throw new Error(`no captured run named ${name}`)
  const status = await runHookIo(row.argv, {
    cwd: () => repository,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: repository })),
    output,
    run: runner,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })
  return {
    harnessed,
    replayed: {
      status,
      stdout: normalise(output.stdout(), harnessed.sandbox.path),
      stderr: normalise(output.stderr(), harnessed.sandbox.path),
      calls,
    },
  }
}

it('stays silent on the default branch, exactly as the Python did', async () => {
  const { replayed } = await inRepo('in-repo/default-branch', ({ sandbox, git }) =>
    git.create(sandbox.join('r')),
  )

  expectParity(replayed, 'in-repo/default-branch')
  // The in-repo branch touches no network and starts no child.
  expect(replayed.calls).toEqual([])
})

it('asks about syncing off the default branch, byte for byte', async () => {
  const { replayed } = await inRepo('in-repo/off-default-branch', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/off-default-branch', { target: 'main' })
})

it('writes the same bytes again, run twice against the same repository', async () => {
  // `in-repo/off-default-branch-again` is the capture's own idempotency row:
  // the Python ran the hook twice over one state and recorded both. It is the
  // one row of the fifty-four with no replay otherwise.
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')

  const replays: Replayed[] = []
  for (const name of ['in-repo/off-default-branch', 'in-repo/off-default-branch-again']) {
    const output = createOutputPair()
    const calls: RunCall[] = []
    const status = await runHookIo(['session-start'], {
      cwd: () => repository,
      env: harnessed.sandbox.env,
      stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: repository })),
      output,
      run: (command, args = [], options = {}) => {
        calls.push({ command, args: [...args], options })
        return Promise.resolve(runResult())
      },
      nodePath: '/usr/bin/node',
      entry: harnessed.entry,
    })
    const replayed: Replayed = {
      status,
      stdout: normalise(output.stdout(), harnessed.sandbox.path),
      stderr: normalise(output.stderr(), harnessed.sandbox.path),
      calls,
    }
    expectParity(replayed, name, { target: 'main' })
    replays.push(replayed)
  }

  // The second run read the same repository and said the same thing: nothing
  // the first run did changed the answer.
  expect(replays[1]?.stdout).toBe(replays[0]?.stdout)
})

it('falls back to a local main when origin/HEAD is not cached', async () => {
  const { replayed } = await inRepo('in-repo/local-main-fallback', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/local-main-fallback', { target: 'main' })
})

it('falls back to a local master when that is the name the clone kept', async () => {
  const { replayed } = await inRepo('in-repo/local-master-fallback', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'branch', '-m', 'main', 'master')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  // origin/master does not exist in this state, so the behind lookup fails
  // and its line is left out rather than reported as zero.
  expectParity(replayed, 'in-repo/local-master-fallback', { target: 'master' })
})

it('prefers a local main over a local master, because the order decides', async () => {
  const { replayed } = await inRepo('in-repo/prefers-local-main', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'branch', 'master', 'main')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  // `master` was branched off `main` and never committed to, so it sits on
  // the commit `origin/main` names. `/gh:sync` keeps exactly that branch
  // ("already at origin/main, nothing to prune"), so it is not a candidate and
  // no count line is written. No captured in-repo state has one.
  expectParity(replayed, 'in-repo/prefers-local-main', { target: 'main' })
})

it('prefers a cached origin/HEAD over a local main', async () => {
  const { replayed } = await inRepo('in-repo/origin-head-wins', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    return repository
  })

  // `trunk` is a remote-tracking name with no local branch behind it, so
  // both counts are lookups that cannot be made and both lines are absent.
  expectParity(replayed, 'in-repo/origin-head-wins', { target: 'trunk' })
})

it('passes an origin/HEAD outside the origin namespace through unchanged', async () => {
  const { replayed } = await inRepo('in-repo/origin-head-outside-namespace', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/trunk')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/origin-head-outside-namespace', {
    target: 'refs/heads/trunk',
  })
})

it('answers from the clone alone when the remote is unreachable', async () => {
  const { replayed } = await inRepo('in-repo/broken-origin-still-answers', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'checkout', '-q', '-b', 'side')
    git.breakOrigin(repository)
    return repository
  })

  expectParity(replayed, 'in-repo/broken-origin-still-answers', { target: 'main' })
})

it('stays silent on a detached HEAD, where there is no branch to compare', async () => {
  const { replayed } = await inRepo('in-repo/detached-head', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'checkout', '-q', '--detach')
    return repository
  })

  expectParity(replayed, 'in-repo/detached-head')
})

it('stays silent when no default branch resolves at all', async () => {
  const { replayed } = await inRepo('in-repo/no-default-resolves', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'checkout', '-q', '-b', 'side')
    // All three, and in this order: origin/HEAD is a symbolic ref and keeps
    // resolving after its target is deleted.
    git.forgetOriginHead(repository)
    git.dropRemoteBranches(repository)
    git.git(repository, 'branch', '-D', 'main')
    return repository
  })

  expectParity(replayed, 'in-repo/no-default-resolves')
})

// --- session-start outside a repository, with the child replayed --------------

/** The rows whose hook took the fan-out branch. The payload points at a
 *  directory that is not a checkout, and the recorded child is what the
 *  runner answers with. */
const fanOut = async (
  name: string,
  build?: (harnessed: Harness, directory: string) => void,
): Promise<{ harnessed: Harness; replayed: Replayed; directory: string }> => {
  const harnessed = harness()
  const directory = harnessed.sandbox.join('fan')
  mkdirSync(directory, { recursive: true })
  build?.(harnessed, directory)
  const row = capture.runs[name]
  if (row === undefined) throw new Error(`no captured run named ${name}`)
  const output = createOutputPair()
  const calls: RunCall[] = []
  const child = row.child
  const runner: Runner = (command, args = [], runOptions = {}) => {
    calls.push({ command, args: [...args], options: runOptions })
    return Promise.resolve(
      child === undefined
        ? runResult({ timedOut: true, signal: 'SIGKILL', status: null })
        : runResult({ status: child.status, stdout: child.stdout, stderr: child.stderr }),
    )
  }
  const status = await runHookIo(row.argv, {
    cwd: () => harnessed.sandbox.path,
    env: { ...harnessed.sandbox.env, ...row.env },
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: directory })),
    output,
    run: runner,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })
  return {
    harnessed,
    directory,
    replayed: {
      status,
      stdout: normalise(output.stdout(), harnessed.sandbox.path),
      stderr: normalise(output.stderr(), harnessed.sandbox.path),
      calls,
    },
  }
}

it('stays silent when the fan-out found no repositories', async () => {
  const { replayed } = await fanOut('fan-out/no-repositories')

  expectParity(replayed, 'fan-out/no-repositories')
})

it('stays silent when the fan-out found everything in order', async () => {
  const { replayed } = await fanOut('fan-out/one-repository-in-order')

  expectParity(replayed, 'fan-out/one-repository-in-order')
})

it('stays silent when the report holds nothing actionable', async () => {
  const { replayed } = await fanOut('fan-out/nothing-actionable')

  expectParity(replayed, 'fan-out/nothing-actionable')
})

it('reports prunable work, wrapped exactly as the Python wrapped it', async () => {
  const { replayed } = await fanOut('fan-out/prunable-work')

  expectParity(
    replayed,
    'fan-out/prunable-work',
    summaryField(
      '1 repository checked: 0 with upstream changes, 1 with prunable branches, 0 skipped, 0 not fully checked.',
    ),
  )
})

it('reports every repository a many-repository run had something to say about', async () => {
  const { replayed } = await fanOut('fan-out/many-repositories')

  expectParity(
    replayed,
    'fan-out/many-repositories',
    summaryField(
      '3 repositories checked: 0 with upstream changes, 1 with prunable branches, 0 skipped, 1 not fully checked.',
    ),
  )
})

it('speaks up when the merge lookups were degraded rather than reporting silence', async () => {
  const { replayed } = await fanOut('fan-out/degraded-merge-lookups')

  // The merge lookup fell back to ancestry alone, which the summary counts as
  // a repository that was not fully checked rather than as one in order.
  expectParity(
    replayed,
    'fan-out/degraded-merge-lookups',
    summaryField(
      '1 repository checked: 0 with upstream changes, 0 with prunable branches, 0 skipped, 1 not fully checked.',
    ),
  )
})

it('reports a repository whose fetch failed, the ✗ arm of the filter', async () => {
  const { replayed } = await fanOut('fan-out/fetch-failed')

  expectParity(
    replayed,
    'fan-out/fetch-failed',
    summaryField(
      '1 repository checked: 0 with upstream changes, 0 with prunable branches, 0 skipped, 1 not fully checked.',
    ),
  )
})

it('quotes the last line of a child that exited non-zero, and keeps its stderr whole', async () => {
  const { replayed } = await fanOut('fan-out/child-exited-non-zero')

  expectParity(replayed, 'fan-out/child-exited-non-zero')
})

it('names the bound and the repository count when the fan-out ran out of time', async () => {
  const { replayed } = await fanOut('fan-out/timeout', ({ git }, directory) => {
    git.createAt(directory, 'a')
  })

  expectParity(replayed, 'fan-out/timeout')
})

it('counts every repository the fan-out was working through', async () => {
  const { replayed } = await fanOut('fan-out/timeout-two-repositories', ({ git }, directory) => {
    git.createAt(directory, 'a')
    git.createAt(directory, 'b')
  })

  expectParity(replayed, 'fan-out/timeout-two-repositories')
})

it('builds the child from the target, the scrubbed environment and no working directory', async () => {
  const { harnessed, replayed, directory } = await fanOut('fan-out/prunable-work')

  // Whole, never counted: the command, every argument, and the options the
  // child was constructed with.
  expect(replayed.calls).toEqual([
    {
      command: '/usr/bin/node',
      args: [harnessed.entry, 'sync', '--dry-run', '--no-install', directory],
      options: {
        env: scrubRepositoryEnv(harnessed.sandbox.env),
        timeoutMs: SYNC_TIMEOUT * 1000,
      },
    },
  ])
  // No `cwd`: the Python's `Popen` inherits the hook's, and naming the target
  // here would turn a directory that cannot be entered into a child that
  // never started. `fan-out/child-exited-non-zero` is that directory.
  expect(replayed.calls[0]?.options.cwd).toBeUndefined()
})

// --- session-start, the payload arms -----------------------------------------

for (const name of [
  'payload/not-json',
  'payload/empty-stdin',
  'payload/not-an-object',
  'payload/cwd-not-a-string',
  'payload/cwd-empty-string',
  'payload/no-cwd-key',
]) {
  it(`falls back to the process's own directory for ${name}`, async () => {
    const harnessed = harness()
    // Somewhere with nothing to say, as the Python examples chdir into.
    const elsewhere = harnessed.sandbox.join('elsewhere')
    mkdirSync(elsewhere, { recursive: true })

    const replayed = await replay(harnessed, name, { processCwd: elsewhere })

    expectParity(replayed, name)
    // The fallback directory is not a checkout, so the fan-out branch runs
    // and finds nothing: one child, and it said nothing actionable.
    expect(replayed.calls).toHaveLength(1)
  })
}

it('treats a cwd that names a directory that is not there as no cwd at all', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const replayed = await replay(harnessed, 'payload/cwd-does-not-exist', {
    processCwd: elsewhere,
  })

  expectParity(replayed, 'payload/cwd-does-not-exist')
  // The fallback, not the payload: the child was pointed at `elsewhere`.
  expect(replayed.calls[0]?.args).toContain(elsewhere)
})

it('still runs the whole check when stdin itself cannot be read', async () => {
  // `hook-io.py:144` catches `OSError` from `json.load(sys.stdin)`, which is
  // the descriptor failing rather than the document being malformed: a hook
  // whose stdin is a directory answered "" and went on from `os.getcwd()`.
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')
  const output = createOutputPair()

  const status = await runHookIo(['session-start'], {
    cwd: () => repository,
    env: harnessed.sandbox.env,
    stdin: () => Promise.reject(new Error('EBADF: bad file descriptor, read')),
    output,
    run: () => Promise.resolve(runResult()),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(status).toBe(0)
  expect(output.stdout()).toContain("default branch is 'main'")
  expect(output.stderr()).toBe('')
})

it('prints the empty line the Python printed for a cwd read that failed', async () => {
  const harnessed = harness()
  const output = createOutputPair()

  const status = await runHookIo(['cwd'], {
    cwd: () => harnessed.sandbox.path,
    env: harnessed.sandbox.env,
    stdin: () => Promise.reject(new Error('EBADF: bad file descriptor, read')),
    output,
    run: () => Promise.resolve(runResult()),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(status).toBe(0)
  expect(output.stdout()).toBe('\n')
})

it('answers from the process cwd when the payload carries none, and still speaks', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')

  const replayed = await replay(harnessed, 'payload/falls-back-to-process-cwd', {
    processCwd: repository,
  })

  expectParity(replayed, 'payload/falls-back-to-process-cwd', { target: 'main' })
})

it('stays silent and notes it when git is not on PATH', async () => {
  const harnessed = harness()
  const directory = harnessed.sandbox.join('fan')
  mkdirSync(directory, { recursive: true })
  harnessed.git.createAt(directory, 'a')
  const env = { ...harnessed.sandbox.env, PATH: harnessed.sandbox.pathWithout('git') }

  const output = createOutputPair()
  const calls: RunCall[] = []
  const status = await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env,
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: directory })),
    output,
    run: (command, args = [], options = {}) => {
      calls.push({ command, args: [...args], options })
      return Promise.resolve(runResult())
    },
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  const row = capture.runs['fan-out/missing-git']
  expect(status).toBe(row?.status)
  expect(output.stdout()).toBe(row?.stdout)
  expect(output.stderr()).toBe(row?.stderr)
  // Neither branch was taken: no child, and no git call decided anything.
  expect(calls).toEqual([])
})

it('notes a missing entry point and costs the check nothing else', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  const missing = harnessed.sandbox.join('lonely', 'scripts', 'gh.ts')

  const output = createOutputPair()
  const calls: RunCall[] = []
  const status = await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: elsewhere })),
    output,
    run: (command, args = [], options = {}) => {
      calls.push({ command, args: [...args], options })
      return Promise.resolve(runResult())
    },
    nodePath: '/usr/bin/node',
    entry: missing,
  })

  const row = capture.runs['fan-out/missing-entry-point']
  expect(status).toBe(row?.status)
  expect(output.stdout()).toBe(row?.stdout)
  // The path is the one divergence: the entry point moved from
  // `scripts/gh-sync.py` to `scripts/gh.ts`, and the recorded row names both.
  // Both halves are pinned against the run they describe, the Python's
  // against the captured stderr and the port's against the path this example
  // reports: a row asserted on one side only is prose, and #185 changed that
  // side when it moved the entry point out of `bin/`.
  const moved = divergences.paths.find((entry) => entry.name === 'fan-out/missing-entry-point')
  expect(moved).toBeDefined()
  expect(row?.stderr).toContain(moved?.python)
  expect(output.stderr()).toBe(`missing ${missing}\n`)
  expect(output.stderr()).toContain(`${moved?.port}\n`)
  expect(calls).toEqual([])
})

// --- the truthiness guards, each with the example that fails on a revert -------

it('reads a git that exits 0 in silence as being inside a repository', async () => {
  // The Python asks `git(...) is not None`, so a `git rev-parse` that
  // succeeds with no output at all puts it on the in-repo branch.
  // `lib/git.ts`'s `toplevel` folds that empty answer into `null`, which is
  // the right reading for a caller that wants the root and the wrong one
  // here: with it, this directory would be fanned out over instead.
  const harnessed = harness()
  const shim = harnessed.git.gitShim()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  const calls: RunCall[] = []
  const status = await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env: {
      ...harnessed.sandbox.env,
      PATH: `${shim.directory}${path.delimiter}${harnessed.sandbox.env.PATH}`,
      GIT_STUB_SILENT: 'rev-parse',
    },
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: elsewhere })),
    output,
    run: (command, args = [], options = {}) => {
      calls.push({ command, args: [...args], options })
      return Promise.resolve(runResult({ stdout: 'a: would delete gone\n' }))
    },
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(status).toBe(0)
  // No child at all: the hook believed it was inside a checkout.
  expect(calls).toEqual([])
  expect(output.stdout()).toBe('')
})

it('falls back to a local main when symbolic-ref exits 0 with nothing to say', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')
  const shim = harnessed.git.gitShim()

  const output = createOutputPair()
  const status = await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env: {
      ...harnessed.sandbox.env,
      PATH: `${shim.directory}${path.delimiter}${harnessed.sandbox.env.PATH}`,
      GIT_STUB_SILENT: 'symbolic-ref',
    },
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: repository })),
    output,
    run: () => Promise.resolve(runResult()),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(status).toBe(0)
  // The ref answered nothing, so the local fallback decided, and it named
  // `main` rather than the empty string the ref actually held.
  expect(output.stdout()).toContain("default branch is 'main'")
})

it('quotes the exit status when the child failed without a word', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    output,
    // Whitespace only, which `last_line` reads as nothing to quote.
    run: () => Promise.resolve(runResult({ status: 7, stderr: '\n   \n' })),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(output.stdout()).toContain('could not run the sync check: exit status 7')
  // Its stderr went where the debug log will have it, whole and unchanged.
  expect(output.stderr()).toBe('\n   \n')
})

it('adds the newline a child that failed mid-line did not write', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () => Promise.resolve(runResult({ status: 2, stderr: 'could not read it' })),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(output.stderr()).toBe('could not read it\n')
  expect(output.stdout()).toContain('could not run the sync check: could not read it')
})

it('writes nothing at all for a child that failed with an empty stderr', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () => Promise.resolve(runResult({ status: 5 })),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(output.stderr()).toBe('')
  expect(output.stdout()).toContain('could not run the sync check: exit status 5')
})

it('uses the report on stdout rather than the could-not-run line when sync itself answers non-zero (#81)', async () => {
  // `gh.ts sync` now exits 1 when one of its own repositories failed, AFTER
  // writing the whole report to stdout (round 7, `commands/sync.ts`). Falling
  // to the could-not-run line here would throw that report away and say
  // something strictly less true about a check that ran to completion.
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () =>
      Promise.resolve(
        runResult({
          status: 1,
          stdout: 'fan (1 repos)\n\na\n  ✗ the sync failed: boom\n',
          stderr: '1 of 1 repositories failed to sync',
        }),
      ),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  // `✗` and not `toContain('✗')`: `emit` escapes it above ASCII
  // (`asciiJson`), so it is the ASCII half of the line that survives intact.
  expect(output.stdout()).toContain('the sync failed: boom')
  expect(output.stdout()).not.toContain('could not run the sync check')
  // The child's own account still reaches the debug log, exactly as it does
  // on any other non-zero exit.
  expect(output.stderr()).toBe('1 of 1 repositories failed to sync\n')
})

it('falls back to the could-not-run line when sync answers non-zero with no report at all', async () => {
  // The counter-example: a non-zero status with EMPTY stdout (a crash before
  // any report reached it, or a refusal) still reads as a degraded run.
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () => Promise.resolve(runResult({ status: 1, stderr: 'missing git: not on PATH' })),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(output.stdout()).toContain('could not run the sync check: missing git: not on PATH')
})

it('falls back to the could-not-run line when an external signal kills sync, even with a partial report on stdout', async () => {
  // The third case, distinct from both above: a non-zero status AND non-empty
  // stdout, but the stdout is not a `failed(...)` report because nothing
  // wrote one. `result.timedOut` only catches the hook's own bound, so a
  // `signal` reaching here (an OOM kill, a stray SIGTERM) is a run cut short
  // mid-report, not `sync` answering `failed(...)` after writing the whole
  // report (round 7 layer 2, review round 1 finding).
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () =>
      Promise.resolve(
        runResult({
          status: null,
          signal: 'SIGKILL',
          stdout: 'fan (2 repos)\n\na\n',
          stderr: '',
        }),
      ),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(output.stdout()).toContain('could not run the sync check: exit status')
  expect(output.stdout()).not.toContain('fan (2 repos)')
})

it('says nothing when the child could not be started at all', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const output = createOutputPair()
  const status = await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: harnessed.sandbox.env,
    stdin: () => Promise.resolve('{}'),
    run: () =>
      Promise.resolve(
        runResult({
          status: 127,
          startFailure: { code: 'ENOENT', message: 'spawn node ENOENT' },
          stderr: 'this is never read',
        }),
      ),
    output,
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  expect(status).toBe(0)
  expect(output.stdout()).toBe('')
  expect(output.stderr()).toBe('')
})

it('reads a bound above the timer ceiling as no bound at all', async () => {
  const harnessed = harness()
  const elsewhere = harnessed.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  const calls: RunCall[] = []

  await runHookIo(['session-start'], {
    cwd: () => elsewhere,
    env: { ...harnessed.sandbox.env, [SYNC_TIMEOUT_ENV]: 'inf' },
    stdin: () => Promise.resolve('{}'),
    run: (command, args = [], options = {}) => {
      calls.push({ command, args: [...args], options })
      return Promise.resolve(runResult())
    },
    output: createOutputPair(),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })

  // No `timeoutMs`: above the ceiling node would clamp to 1 ms and kill the
  // child on the next tick, where `communicate(timeout=inf)` waits. The
  // length comes first, because `calls[0]?.` on an empty list is `undefined`
  // too and would pass for a fan-out that never ran.
  expect(calls).toHaveLength(1)
  expect(calls[0]?.options.timeoutMs).toBeUndefined()
})

// --- the pure pieces ----------------------------------------------------------

it('reads a payload cwd only when it is a string in a JSON object', () => {
  expect(payloadCwd('{"cwd":"/some/where"}')).toBe('/some/where')
  expect(payloadCwd('{"cwd":3}')).toBe('')
  expect(payloadCwd('{"cwd":null}')).toBe('')
  expect(payloadCwd('{"cwd":""}')).toBe('')
  expect(payloadCwd('{}')).toBe('')
  // A JSON array decodes to a list, which is not a dict: `typeof []` is
  // 'object', so `Array.isArray` is the half `typeof` cannot answer.
  expect(payloadCwd('["a","b"]')).toBe('')
  expect(payloadCwd('"a string"')).toBe('')
  expect(payloadCwd('null')).toBe('')
  expect(payloadCwd('not json')).toBe('')
  expect(payloadCwd('')).toBe('')
})

it('reads the bound exactly as Python float() and the g format do', () => {
  for (const row of capture.syncTimeout) {
    const recorded = divergences.syncTimeout.find((entry) => entry.raw === row.raw)
    // The formatted value is the whole of what the bound decides that anyone
    // ever sees, and it is a total function of the bound, so comparing it
    // compares both `float()` and the `g` format in one.
    const answered = formatG(syncTimeout({ [SYNC_TIMEOUT_ENV]: row.raw }))
    expect(answered).toBe(recorded === undefined ? row.formatted : recorded.port)
  }
})

it('answers the default bound for an override nobody set', () => {
  expect(syncTimeout({})).toBe(SYNC_TIMEOUT)
})

it('refuses the spellings Number() would have accepted', () => {
  expect(pythonFloat('')).toBeNull()
  expect(pythonFloat('0x10')).toBeNull()
  expect(pythonFloat('   ')).toBeNull()
  expect(pythonFloat('1_000')).toBe(1000)
  expect(pythonFloat('+4')).toBe(4)
  expect(pythonFloat('.5')).toBe(0.5)
  expect(pythonFloat('5.')).toBe(5)
  expect(pythonFloat('-inf')).toBe(Number.NEGATIVE_INFINITY)
  expect(pythonFloat('Infinity')).toBe(Number.POSITIVE_INFINITY)
  expect(Number.isNaN(pythonFloat('NaN') as number)).toBe(true)
})

it('skips at each end exactly what float() skips, and nothing else', () => {
  // `trim()` diverges from `float()` in both directions at once, and either
  // one decides how long a session start waits for the fan-out.
  // `python3 -c "float('\u00855')"` is 5.0, where `trim()` leaves the NEL and
  // the grammar refuses the string.
  expect(pythonFloat('\u00855')).toBe(5)
  expect(syncTimeout({ [SYNC_TIMEOUT_ENV]: '\u00855' })).toBe(5)
  // `python3 -c "float('\ufeff5')"` raises ValueError, where `trim()` eats the
  // byte-order mark a pasted or generated value carries and the grammar then
  // accepts it.
  expect(pythonFloat('\ufeff5')).toBeNull()
  expect(syncTimeout({ [SYNC_TIMEOUT_ENV]: '\ufeff5' })).toBe(SYNC_TIMEOUT)
  // The four information separators are `str.strip()`'s and not `float()`'s,
  // so the two classes cannot be the same one: `'\u001c5'.strip()` is `'5'`
  // and `float('\u001c5')` raises.
  expect(pythonFloat('\u001c5')).toBeNull()
  expect(lastLine('\u001c5')).toBe('5')
})

it('formats the bound the way Python g does, on both sides of the exponent', () => {
  expect(formatG(50)).toBe('50')
  expect(formatG(0.5)).toBe('0.5')
  expect(formatG(1234567)).toBe('1.23457e+06')
  expect(formatG(1e-7)).toBe('1e-07')
  expect(formatG(500000)).toBe('500000')
  expect(formatG(Number.POSITIVE_INFINITY)).toBe('inf')
})

it('reads a signal as the negative status Python reported for it', () => {
  expect(returnCode(3, null)).toBe(3)
  expect(returnCode(0, null)).toBe(0)
  expect(returnCode(null, 'SIGKILL')).toBe(-9)
  expect(returnCode(null, 'SIGTERM')).toBe(-15)
  // Neither, which a `close` event cannot carry: the answer for a child that
  // neither exited nor was signalled.
  expect(returnCode(null, null)).toBe(0)
})

it('counts nothing rather than failing twice when discovery cannot answer', async () => {
  const sandbox = createSandbox()
  const notADirectory = sandbox.join('a-file')
  writeFileSync(notADirectory, 'not a directory\n')

  // One detail inside a message about a fan-out that already ran out of
  // time: a discovery that could not answer must not lose the message.
  expect(await repoCount(notADirectory, sandbox.env)).toBe(0)
  expect(await repoCount(sandbox.join('not there at all'), sandbox.env)).toBe(0)
})

it('takes the last line with anything in it', () => {
  expect(lastLine('')).toBe('')
  expect(lastLine('\n   \n')).toBe('')
  expect(lastLine('first\nlast\n\n')).toBe('last')
  expect(lastLine('  only  ')).toBe('only')
})

it('splits the lines and strips the blanks the way Python does', () => {
  // `str.splitlines`, not `split('\n')`: a child that redrew its progress
  // leaves the carriage return inside the line, and the Python quoted only
  // what came after it. This is the sentence the session is given.
  expect(lastLine('fetching\rerror: repository is gone')).toBe('error: repository is gone')
  expect(lastLine('a\u2028b')).toBe('b')
  expect(lastLine('a\u0085b')).toBe('b')
  expect(lastLine('a\x0cb')).toBe('b')
  // `\r\n` is one boundary, so it leaves no empty line between the two.
  expect(lastLine('first\r\nlast')).toBe('last')
  // `str.strip()` counts the file separators as whitespace and `trim()` does
  // not, so without the Python set this answers with a control character.
  expect(lastLine('said something\n\x1c\x1f')).toBe('said something')
})

it('writes one response the way json.dump with ensure_ascii writes it', () => {
  expect(emit('hi')).toBe(
    '{"systemMessage": "hi", "hookSpecificOutput": ' +
      '{"hookEventName": "SessionStart", "additionalContext": "hi"}}\n',
  )
  // Every character above `~` escaped, including DEL and each half of an
  // astral pair; the short forms left as `JSON.stringify` wrote them.
  expect(emit('✓\u007f\u{1f600}\t"\\')).toContain('"\\u2713\\u007f\\ud83d\\ude00\\t\\"\\\\"')
})

it('finds a tool the way shutil.which does, and refuses a directory named after one', () => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  mkdirSync(path.join(bin, 'git'), { recursive: true })

  // A directory carrying the traverse bit passes an executable check, so
  // without the directory test this would be found as git.
  expect(which('git', { PATH: bin })).toBeNull()
  expect(which('git', {})).toBeNull()
  expect(which('git', sandbox.env)).not.toBeNull()
})

it('reads a PATH set to nothing as no PATH, and an empty entry as the cwd', () => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  mkdirSync(bin, { recursive: true })
  const tool = path.join(bin, 'git')
  writeFileSync(tool, '#!/bin/sh\nexit 0\n')
  chmodSync(tool, 0o755)
  // The only way to show what an empty PATH entry resolves against, because
  // the walk asks the process's own directory and takes no `cwd`. Synchronous
  // and restored in the same statement, so nothing else in this file can run
  // between the two.
  const before = process.cwd()
  process.chdir(bin)
  try {
    // `shutil.which`'s `if not path: return None`. Without the fold this
    // answers with the bare `git` beside us, and the hook takes the branch the
    // Python kept silent about.
    expect(which('git', { PATH: '' })).toBeNull()
    // An empty entry inside a PATH is a different question, and Python looks a
    // bare name up in the working directory there, so this one must be found.
    expect(which('git', { PATH: `${path.delimiter}${sandbox.join('nowhere')}` })).toBe('git')
  } finally {
    process.chdir(before)
  }
})

it('removes only the variables that displace the repository a call names', () => {
  const scrubbed = scrubRepositoryEnv({
    GIT_DIR: '/elsewhere/.git',
    GIT_INDEX_FILE: '/elsewhere/.git/index',
    GIT_WORK_TREE: '/elsewhere',
    GH_REPO: 'acme/widgets',
    GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
    HOME: '/home/me',
    PATH: '/usr/bin',
  })

  expect(scrubbed).toEqual({
    GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
    HOME: '/home/me',
    PATH: '/usr/bin',
  })
})

it('carries the usage line the wiring mistake is diagnosed by', () => {
  expect(USAGE).toBe('usage: hook-io.ts {session-start|cwd|branch <current> <default>|report}\n')
})

it('records every divergence from the Python as data, and no more', () => {
  // The port's own acceptance is byte-identical, so the two rows it could not
  // avoid are still exactly those: a path that moved, and a number grammar
  // that stops at ASCII digits. The text rows are #110's deliberate
  // rewording, one per block of sentences that changed.
  expect(divergences.paths.map((entry) => entry.name)).toEqual(['fan-out/missing-entry-point'])
  expect(divergences.syncTimeout.map((entry) => entry.raw)).toEqual(['２'])
  expect(divergences.text.map((entry) => entry.name)).toEqual([
    'the usage line names the file that carries it',
    'the in-repo message states the status instead of instructing the agent',
    'the fan-out message leads with a computed summary line',
    'the fan-out message names how to act once, as a fact',
  ])
  for (const entry of [
    ...divergences.text,
    ...divergences.paths,
    ...divergences.syncTimeout,
    ...divergences.notes,
    ...divergences.placeholders,
  ]) {
    expect(entry.why.length).toBeGreaterThan(20)
  }
})

it('documents every placeholder its rows use, and uses every one it documents', () => {
  // Without this a row could carry a name nothing fills, which reduces to the
  // empty string and quietly asserts a sentence the port never writes.
  const used = new Set<string>()
  for (const entry of divergences.text) {
    for (const match of `${entry.python}${entry.port}`.matchAll(/\{([a-z]+)\}/g)) {
      used.add(match[1] ?? '')
    }
  }
  expect([...used].sort()).toEqual(divergences.placeholders.map((entry) => entry.name).sort())
})

// --- the in-repo status lines (#110) ------------------------------------------

const status = (overrides: Partial<BranchStatus> = {}): BranchStatus => ({
  current: 'side',
  target: 'main',
  behind: null,
  candidates: null,
  ...overrides,
})

it('writes no count line for a count of zero and none for one it could not read', () => {
  // Three different things, and two of them are silence for different
  // reasons: zero is an answer with nothing to report, null is no answer.
  expect(countLines(status({ behind: 0, candidates: 0 }))).toEqual([])
  expect(countLines(status())).toEqual([])
  expect(countLines(status({ behind: 0, candidates: null }))).toEqual([])
})

it('names how far the default branch is behind, in commits', () => {
  expect(countLines(status({ behind: 1 }))).toEqual([
    "Local 'main' is 1 commit behind 'origin/main'.",
  ])
  expect(countLines(status({ behind: 12 }))).toEqual([
    "Local 'main' is 12 commits behind 'origin/main'.",
  ])
})

it('names prunable candidates as candidates, never as branches that will go', () => {
  // Ancestry cannot see a squash merge and this message never asks gh, so
  // claiming any of them WILL be pruned would be claiming more than it knows.
  expect(countLines(status({ candidates: 1 }))).toEqual([
    "Prunable candidates: 1 local branch with a gone upstream or already merged into 'main'.",
  ])
  expect(countLines(status({ candidates: 3 }))).toEqual([
    "Prunable candidates: 3 local branches with a gone upstream or already merged into 'main'.",
  ])
})

it('keeps the branch line first, the counts in order, and the two closing lines', () => {
  expect(branchMessageText(status({ behind: 2, candidates: 1 }))).toBe(
    `This session started on branch 'side'; the repository's default branch is 'main'.
Local 'main' is 2 commits behind 'origin/main'.
Prunable candidates: 1 local branch with a gone upstream or already merged into 'main'.
These are local refs, as of the last fetch. /gh:sync --dry-run reports what would change here,
including what it would do with 'main'; /gh:sync makes those changes.
`,
  )
})

it('claims no outcome for the default branch it cannot check locally', () => {
  // `/gh:sync` fast-forwards the default branch, CREATES it where no local
  // branch of that name exists (the captured origin-head-wins state), or
  // refuses it as diverged. The hook resolves the name from the cached
  // origin/HEAD without checking a local branch of it exists, so none of the
  // three can be asserted here; `--dry-run`, named one line above, is what
  // answers it for this repository (review round 2).
  const message = branchMessageText(status({ behind: 2, candidates: 1 }))

  expect(message).not.toContain('fast-forward')
  expect(message).not.toContain('prunes')
  expect(message).toContain("what it would do with 'main'")
})

it('addresses the user with facts and the agent with nothing at all', () => {
  // The same text goes out as systemMessage, where a user reads it as the
  // agent speaking, so an imperative aimed at the agent reads to them as a
  // question they are expected to answer (#110).
  const both: [string, string][] = [
    [branchMessageText(status({ behind: 1, candidates: 1 })), '/gh:sync makes those changes.'],
    [
      reportMessageText('fan (1 repos)\n\na\n  · main already up to date (abc1234)', 'a summary'),
      '/gh:sync applies this for real.',
    ],
  ]

  for (const [message, acts] of both) {
    for (const imperative of ['Ask the user', 'Ask first', 'Offer to run', 'Do not ']) {
      expect(message).not.toContain(imperative)
    }
    // Stated once, so a reader is not told twice what to type.
    expect(message.split(acts)).toHaveLength(2)
  }
})

it('reads a count only where git answered with one', () => {
  expect(parseCount('0')).toBe(0)
  expect(parseCount('12')).toBe(12)
  // git failing, and git exiting 0 with nothing to say. Reading the second as
  // zero would report "up to date" about a question never answered.
  expect(parseCount(null)).toBeNull()
  expect(parseCount('')).toBeNull()
  expect(parseCount('-1')).toBeNull()
  expect(parseCount('two')).toBeNull()
  expect(parseCount('1 2')).toBeNull()
})

/** A `refs` listing line: the ref and the commit it points at, as
 *  `for-each-ref --format='%(refname)<tab>%(objectname)'` writes it. The
 *  commit only has to be distinct, so a name stands in for a SHA. */
const at = (ref: string, commit = `${ref}-commit`): string => `${ref}\t${commit}`

it('counts a gone upstream and a merged branch once each', () => {
  const locals = [
    'main\trefs/remotes/origin/main',
    'goner\trefs/remotes/origin/goner',
    'landed\t',
    'both\trefs/remotes/origin/both',
    'side\t',
  ]
  const remotes = [at('refs/remotes/origin/HEAD'), at('refs/remotes/origin/main')]

  // `both` is gone AND merged, and is one candidate, not two.
  expect(countCandidates(locals, remotes, ['landed', 'both', 'side', 'main'], 'side', 'main')).toBe(
    3,
  )
})

it('never counts a branch whose upstream is still there', () => {
  // The gone half is about a branch left behind by a `fetch --prune`, not
  // about every branch that tracks one: without the ref test, every tracking
  // branch in the repository would be reported as prunable.
  const locals = ['side\t', 'tracked\trefs/remotes/origin/tracked']

  expect(countCandidates(locals, [at('refs/remotes/origin/tracked')], [], 'side', 'main')).toBe(0)
})

it('never counts a branch that tracks a local branch that is still there', () => {
  // `%(upstream)` answers with a local ref for a branch set to track one, and
  // a live local upstream is no more gone than a live remote one. A set built
  // from the remote-tracking refs alone would not hold `refs/heads/main` and
  // would report every such branch as a candidate.
  const locals = ['side\t', 'stacked\trefs/heads/main', 'main\trefs/remotes/origin/main']
  const refs = [
    at('refs/heads/main'),
    at('refs/heads/side'),
    at('refs/heads/stacked'),
    at('refs/remotes/origin/main'),
  ]

  expect(countCandidates(locals, refs, [], 'side', 'main')).toBe(0)
  // The other half of the same test: a local upstream that HAS gone still
  // counts, so the fix is not just "never look at a local upstream".
  expect(countCandidates(locals, [at('refs/remotes/origin/main')], [], 'side', 'main')).toBe(1)
})

it('never counts the branch the session is on, nor the default branch', () => {
  const locals = ['main\trefs/remotes/origin/main', 'side\t']

  // Both are reachable from `main`, and neither is anything to prune: one is
  // where work lands, the other is where the session is.
  expect(
    countCandidates(locals, [at('refs/remotes/origin/main')], ['main', 'side'], 'side', 'main'),
  ).toBe(0)
})

it('never counts a branch sitting on the cached origin tip, and still counts one past it', () => {
  // `/gh:sync` keeps a branch at `origin/<default>`'s own commit and says so
  // ("already at origin/main, nothing to prune"), so calling it a candidate
  // would name something the command refuses. A branch that carries a commit
  // of its own is a different answer and stays counted, which is what keeps
  // the line's example real.
  const locals = ['side\t', 'fresh\t', 'landed\t']
  const refs = [
    at('refs/remotes/origin/main', 'tip'),
    at('refs/heads/main', 'tip'),
    at('refs/heads/fresh', 'tip'),
    at('refs/heads/landed', 'landed-commit'),
    at('refs/heads/side', 'side-commit'),
  ]

  expect(countCandidates(locals, refs, ['fresh', 'landed'], 'side', 'main')).toBe(1)

  // The same holds for the gone-upstream half: `sync` does not prune by a gone
  // upstream at all, and the branch is an ancestor of the default branch by
  // sitting on its tip, so the tip guard is what it would meet.
  expect(
    countCandidates(['side\t', 'fresh\trefs/remotes/origin/fresh'], refs, [], 'side', 'main'),
  ).toBe(0)

  // With no cached `origin/main` there is no tip to compare against, and the
  // absence is not a tip of its own that every branch matches.
  expect(countCandidates(locals, [at('refs/heads/fresh', 'tip')], ['fresh'], 'side', 'main')).toBe(
    1,
  )
})

it('answers nothing when any one of the three listings could not be read', () => {
  const locals = ['side\t']
  const remotes = [at('refs/remotes/origin/main')]
  const merged = ['main']

  expect(countCandidates(null, remotes, merged, 'side', 'main')).toBeNull()
  expect(countCandidates(locals, null, merged, 'side', 'main')).toBeNull()
  expect(countCandidates(locals, remotes, null, 'side', 'main')).toBeNull()
  // All three present is the only shape that answers, even when the answer is
  // zero.
  expect(countCandidates(locals, remotes, merged, 'side', 'main')).toBe(0)
})

it('reads a listing line with no separator as a branch with no upstream', () => {
  // A shape the format cannot produce. Read as "no upstream" rather than as a
  // branch whose name is the whole line, which would then be counted as gone
  // against a remote set it can never be in.
  expect(countCandidates(['orphan'], [], [], 'side', 'main')).toBe(0)
})

it('reads a ref listing line with no commit as a ref that exists', () => {
  // The other half of the same shape. A ref the format wrote without its
  // commit still answers the question `existing` asks, so an upstream naming
  // it is live; it just has no tip to compare against.
  expect(
    countCandidates(
      ['tracked\trefs/remotes/origin/tracked'],
      ['refs/remotes/origin/tracked'],
      [],
      'side',
      'main',
    ),
  ).toBe(0)
})

/** Run the in-repo path against a real checkout and hand back what it wrote. */
const messageFor = async (
  harnessed: Harness,
  repository: string,
  env: NodeJS.ProcessEnv = harnessed.sandbox.env,
): Promise<string> => {
  const output = createOutputPair()
  const status = await runHookIo(['session-start'], {
    cwd: () => repository,
    env,
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: repository })),
    output,
    run: () => Promise.resolve(runResult()),
    nodePath: '/usr/bin/node',
    entry: harnessed.entry,
  })
  // Every degraded path here has to stay a message, an exit 0 and a silent
  // stderr: nothing this hook looks up may cost a session.
  expect(status).toBe(0)
  expect(output.stderr()).toBe('')
  return output.stdout()
}

it('counts how far the default branch is behind the cached origin, with no fetch', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.commit(repository, 'second')
  harnessed.git.push(repository)
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')
  // The local default branch moved back, so the CACHED origin/main is one
  // commit ahead of it and nothing has to go to the network to see that.
  harnessed.git.git(repository, 'branch', '-f', 'main', 'main~1')

  expect(await messageFor(harnessed, repository)).toContain(
    "Local 'main' is 1 commit behind 'origin/main'.",
  )
})

it('still counts a branch on a local default that is itself behind the cached origin', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  git.commit(repository, 'second')
  git.push(repository)
  git.git(repository, 'checkout', '-q', '-b', 'side')
  // The local default moves back, so `stale` sits on it and NOT on the commit
  // the cached origin/main names.
  git.git(repository, 'branch', '-f', 'main', 'main~1')
  git.branch(repository, 'stale')

  const message = await messageFor(harnessed, repository)

  // Which tip the exclusion compares against is the whole question here.
  // /gh:sync fast-forwards main onto origin/main and then finds `stale`
  // strictly behind it, so it deletes it: excluding a branch by the LOCAL
  // default's tip would drop a real candidate from the count.
  expect(message).toContain("Local 'main' is 1 commit behind 'origin/main'.")
  expect(message).toContain(
    "Prunable candidates: 1 local branch with a gone upstream or already merged into 'main'.",
  )
})

it('counts a gone upstream and a landed branch as candidates', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  git.branchWithWork(repository, 'landed')
  git.mergeCommit(repository, 'landed')
  git.branchWithWork(repository, 'goner')
  git.push(repository, 'goner')
  git.git(repository, 'branch', '--set-upstream-to=origin/goner', 'goner')
  // What a `git fetch --prune` leaves behind once the branch is deleted on the
  // remote: the upstream is still configured and the ref it names is gone.
  git.git(repository, 'update-ref', '-d', 'refs/remotes/origin/goner')
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const message = await messageFor(harnessed, repository)

  expect(message).toContain(
    "Prunable candidates: 2 local branches with a gone upstream or already merged into 'main'.",
  )
  // The default branch is ahead of origin here, not behind, and being ahead is
  // not this message's subject.
  expect(message).not.toContain('behind')
})

it('does not count a branch tracking a live local branch, in a real checkout', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  // Its own commit, so ancestry does not reach it, and an upstream that is a
  // local branch and still exists. `gh stack` sets branches up this way.
  git.branchWithWork(repository, 'stacked')
  git.git(repository, 'branch', '--set-upstream-to=main', 'stacked')
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const message = await messageFor(harnessed, repository)

  expect(message).toContain("default branch is 'main'")
  expect(message).not.toContain('Prunable candidates')
})

it('counts a branch whose LOCAL upstream has gone, in a real checkout', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  // The half the pure function covers and real git never did: an upstream
  // that was a local branch and has since been deleted. `%(upstream)` still
  // answers `refs/heads/base`, and that ref is gone.
  git.branchWithWork(repository, 'base')
  git.branchWithWork(repository, 'stacked')
  git.git(repository, 'branch', '--set-upstream-to=base', 'stacked')
  git.git(repository, 'branch', '-D', 'base')
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const message = await messageFor(harnessed, repository)

  expect(message).toContain(
    "Prunable candidates: 1 local branch with a gone upstream or already merged into 'main'.",
  )
})

it('does not count the default branch because a tag shares its name', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  // `%(refname:short)` is the shortest UNAMBIGUOUS name, so a tag named after
  // a branch makes git answer `heads/main` for the branch. The names it is
  // compared against are plain, so the default branch survived both deletions
  // and was reported as a prunable candidate: a release tag was enough to make
  // the message state a false count (review round 2).
  git.git(repository, 'tag', 'main')
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const message = await messageFor(harnessed, repository)

  expect(message).toContain("default branch is 'main'")
  expect(message).not.toContain('Prunable candidates')
})

it('counts a merged branch with a commit of its own, never one on the cached tip', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  // Merged with a merge commit, so it is reachable from `main` AND carries a
  // commit of its own that `origin/main` does not name: a real candidate,
  // which is what keeps the line's one example real. `mergeCommit` pushes, so
  // `origin/main` is the merge commit afterwards.
  git.branchWithWork(repository, 'landed')
  git.mergeCommit(repository, 'landed')
  // Branched off `main` once it is level with `origin/main` and never
  // committed to, so it sits on exactly the commit the cached ref names.
  // `/gh:sync` keeps this branch and says why, so the message must not call it
  // a candidate.
  git.branch(repository, 'fresh')
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const message = await messageFor(harnessed, repository)

  expect(message).toContain(
    "Prunable candidates: 1 local branch with a gone upstream or already merged into 'main'.",
  )
})

it('leaves the behind line out when the count cannot be read at all', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')
  const shim = harnessed.git.gitShim('rev-list')

  const message = await messageFor(harnessed, repository, {
    ...harnessed.sandbox.env,
    PATH: `${shim.directory}${path.delimiter}${harnessed.sandbox.env.PATH}`,
    GIT_STUB_FAIL: shim.failing,
  })

  // The message it was always going to write, minus the line it could not
  // fill in.
  expect(message).toContain("default branch is 'main'")
  expect(message).not.toContain('behind')
})

it('leaves the behind line out when git exits 0 with nothing to say', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')
  const shim = harnessed.git.gitShim()

  const message = await messageFor(harnessed, repository, {
    ...harnessed.sandbox.env,
    PATH: `${shim.directory}${path.delimiter}${harnessed.sandbox.env.PATH}`,
    GIT_STUB_SILENT: 'rev-list',
  })

  // An empty answer is not a count of zero, and this line is left out rather
  // than saying the branch is up to date with a remote nothing compared it to.
  expect(message).toContain("default branch is 'main'")
  expect(message).not.toContain('behind')
})

it('leaves the candidate line out when a ref listing cannot be read', async () => {
  const harnessed = harness()
  const { git } = harnessed
  const repository = git.create(harnessed.sandbox.join('r'))
  git.branchWithWork(repository, 'landed')
  git.mergeCommit(repository, 'landed')
  git.git(repository, 'checkout', '-q', '-b', 'side')
  const shim = git.gitShim('for-each-ref')

  const message = await messageFor(harnessed, repository, {
    ...harnessed.sandbox.env,
    PATH: `${shim.directory}${path.delimiter}${harnessed.sandbox.env.PATH}`,
    GIT_STUB_FAIL: shim.failing,
  })

  expect(message).toContain("default branch is 'main'")
  expect(message).not.toContain('Prunable candidates')
})

// --- the fan-out summary (#110) -----------------------------------------------

/** A report of one repository whose section holds `lines`. */
const oneSection = (...lines: string[]): string =>
  ['/somewhere (1 repos)', '', 'a', ...lines].join('\n')

it('counts nothing for a report where every repository was in order', () => {
  expect(fanOutSummary(oneSection('  · main already up to date (abc1234)'))).toEqual({
    checked: 1,
    upstream: 0,
    prunable: 0,
    skipped: 0,
    unchecked: 0,
  })
})

it('counts each bucket from the marks sync-repo exports', () => {
  const cases: [string, Partial<FanOutSummary>][] = [
    [`${REPORT.note}would fast-forward main abc1234..def5678`, { upstream: 1 }],
    [`${REPORT.note}would create main from origin/main (abc1234)`, { upstream: 1 }],
    [`${REPORT.note}would delete gone (abc1234, merged into main)`, { prunable: 1 }],
    [`${REPORT.note}would remove worktree /w and delete gone (abc1234, merged)`, { prunable: 1 }],
    [`${REPORT.bad}${REPORT.skipped}uncommitted changes`, { skipped: 1 }],
    [`${REPORT.bad}fetch failed; nothing changed`, { unchecked: 1 }],
    [
      `${REPORT.note}could not read merged pull requests (gh: no); using ancestry alone`,
      {
        unchecked: 1,
      },
    ],
    // The lines `sync.ts` writes for a job that threw or answered non-zero
    // (#81), taken from its own producers rather than spelled again here: a
    // repository the run could not finish is counted, rather than lost
    // between the report and the summary above it. Asking `sync.ts` for the
    // text is what pins the two files to one mark. Spelled out, this case
    // stayed green when `sync.ts` wrote a mark of its own (review round 1).
    [failureLine(new Error('boom')).trimEnd(), { unchecked: 1 }],
    [statusLine(3).trimEnd(), { unchecked: 1 }],
  ]

  for (const [line, expectedCounts] of cases) {
    expect(fanOutSummary(oneSection(line)), line).toEqual({
      checked: 1,
      upstream: 0,
      prunable: 0,
      skipped: 0,
      unchecked: 0,
      ...expectedCounts,
    })
  }
})

it('leaves the dry-run notes these buckets are not about out of them', () => {
  // `--dry-run` writes more notes than the four the summary counts. Neither
  // of these says the default branch would move or that a branch would go, so
  // neither belongs in a bucket, and the repository is still one checked.
  // Without this, widening either bucket's openings is a change nothing
  // notices (review round 2).
  expect(
    fanOutSummary(
      oneSection(
        `${REPORT.note}would switch from side to main`,
        `${REPORT.note}lock file changed in that range; would run install`,
      ),
    ),
  ).toEqual({ checked: 1, upstream: 0, prunable: 0, skipped: 0, unchecked: 0 })
})

it('counts a repository once per bucket, whatever its section repeats', () => {
  expect(
    fanOutSummary(
      oneSection(
        `${REPORT.note}${REPORT.wouldDelete}one (abc1234, merged into main)`,
        `${REPORT.note}${REPORT.wouldDelete}two (def5678, merged into main)`,
        `${REPORT.note}${REPORT.wouldFastForward}main abc1234..def5678`,
      ),
    ),
  ).toEqual({ checked: 1, upstream: 1, prunable: 1, skipped: 0, unchecked: 0 })
})

it('counts a section per repository across a mixed report', () => {
  const report = [
    '/somewhere (4 repos)',
    '',
    'a',
    `${REPORT.note}${REPORT.wouldFastForward}main abc1234..def5678`,
    `${REPORT.note}${REPORT.wouldDelete}gone (abc1234, merged into main)`,
    'b',
    `${REPORT.bad}${REPORT.skipped}uncommitted changes`,
    'c',
    `${REPORT.bad}fetch failed; nothing changed`,
    'd',
    `${REPORT.note}main already up to date (abc1234)`,
  ].join('\n')

  expect(fanOutSummary(report)).toEqual({
    checked: 4,
    upstream: 1,
    prunable: 1,
    skipped: 1,
    unchecked: 1,
  })
})

it('ignores a mark line that sits under no heading at all', () => {
  // A shape `sync` cannot write, because every mark prints the repository's
  // name first. Counted against nothing rather than opening a section of its
  // own, which would report a repository that does not exist.
  expect(fanOutSummary(`/somewhere (1 repos)\n${REPORT.bad}orphaned\n`).checked).toBe(0)
})

it('writes the summary line with the noun the count calls for', () => {
  expect(summaryLine({ checked: 1, upstream: 0, prunable: 1, skipped: 0, unchecked: 0 })).toBe(
    '1 repository checked: 0 with upstream changes, 1 with prunable branches, 0 skipped, 0 not fully checked.',
  )
  expect(summaryLine({ checked: 3, upstream: 1, prunable: 1, skipped: 1, unchecked: 1 })).toBe(
    '3 repositories checked: 1 with upstream changes, 1 with prunable branches, 1 skipped, 1 not fully checked.',
  )
})

it('writes no summary at all over a report it found no repository in', () => {
  // A report only gets here once ACTIONABLE found a line worth speaking
  // about, so no repositories counted means the body is not shaped the way
  // the counting reads it, not that nothing was checked. A line of zeros
  // above a report that says otherwise is the one thing this message must
  // never do (review round 2).
  expect(summaryLine({ checked: 0, upstream: 0, prunable: 0, skipped: 0, unchecked: 0 })).toBeNull()

  const headerless = `a\n${REPORT.bad}fetch failed; nothing changed`
  expect(fanOutSummary(headerless).checked).toBe(0)
  expect(reportMessageText(headerless, summaryLine(fanOutSummary(headerless)))).toContain(
    headerless,
  )
  expect(reportMessageText(headerless, summaryLine(fanOutSummary(headerless)))).not.toContain(
    'repositories checked',
  )
})

it('agrees with a report the real sync command wrote', async () => {
  // The summary reads `sync`'s own words, so this is the example that fails
  // when those words change: the report is produced here by the real command
  // over real repositories, one per bucket, and nothing states its text.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const fan = sandbox.join('fan')
  mkdirSync(fan, { recursive: true })
  const prunable = git.createAt(fan, 'a')
  git.branchWithWork(prunable, 'gone')
  git.mergeCommit(prunable, 'gone')
  git.remoteAdvance(git.createAt(fan, 'b'))
  git.dirty(git.createAt(fan, 'c'))
  git.breakOrigin(git.createAt(fan, 'd'))
  git.createAt(fan, 'e')
  const out: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })

  const envelope = await runSyncCommand(['--dry-run', '--no-install', fan], {
    cwd: sandbox.path,
    env: sandbox.env,
    output: createOutput(stream(out), stream([])),
    createGh: () => ({ ...createGhMock({}), listMergedPullRequests: async () => [] }),
  })

  expect(envelope.outcome).toBe('ok')
  const report = out.join('').replace(/\n+$/, '')
  expect(fanOutSummary(report)).toEqual({
    checked: 5,
    upstream: 1,
    prunable: 1,
    skipped: 1,
    unchecked: 1,
  })
})

// --- the one example measured against a real timer ----------------------------
//
// Everything above injects the runner, so no test waits on a clock. These two
// use the real one (`lib/process.ts` `run`), because the bound and the
// process-group kill are what `hook-io.py:220` to `250` and `:276` to `:315`
// were, and an injected `timedOut: true` cannot show that the hook's own
// number reaches the timer. The bound is tiny on the side that must fire and
// generous on the side that must not, so neither depends on how loaded the
// runner is.

it('reports the bound when a real child outlives it, and kills it', async () => {
  const harnessed = harness()
  const directory = harnessed.sandbox.join('fan')
  mkdirSync(directory, { recursive: true })
  harnessed.git.createAt(directory, 'a')
  const output = createOutputPair()

  const status = await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env: { ...harnessed.sandbox.env, [SYNC_TIMEOUT_ENV]: '0.25' },
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: directory })),
    output,
    run: realRun,
    nodePath: process.execPath,
    entry: path.join(FIXTURES, 'slow-entry.ts'),
  })

  expect(status).toBe(0)
  expect(output.stdout()).toContain(
    `could not finish the sync check within 0.25 s (1 repositories under ${directory})`,
  )
})

it('does not fire a generous bound on a child that answers at once', async () => {
  const harnessed = harness()
  const directory = harnessed.sandbox.join('fan')
  mkdirSync(directory, { recursive: true })
  const output = createOutputPair()

  await runHookIo(['session-start'], {
    cwd: () => harnessed.sandbox.path,
    env: { ...harnessed.sandbox.env, [SYNC_TIMEOUT_ENV]: '120' },
    stdin: () => Promise.resolve(JSON.stringify({ session_id: 's1', cwd: directory })),
    output,
    run: realRun,
    nodePath: process.execPath,
    entry: path.join(FIXTURES, 'quick-entry.ts'),
  })

  // The child's own line, wrapped: not a timeout, and not silence.
  expect(output.stdout()).toContain('a: would delete gone')
  expect(output.stdout()).not.toContain('could not finish')
})
