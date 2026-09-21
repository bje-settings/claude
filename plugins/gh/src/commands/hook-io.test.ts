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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { type Runner, type RunOptions, type RunResult, run as realRun } from '../lib/process.ts'
import type { Output, Writer } from '../lib/streams.ts'
import {
  emit,
  formatG,
  type HookEdges,
  lastLine,
  payloadCwd,
  pythonFloat,
  repoCount,
  returnCode,
  runHookIo,
  SYNC_TIMEOUT,
  SYNC_TIMEOUT_ENV,
  scrubRepositoryEnv,
  syncTimeout,
  USAGE,
  which,
} from './hook-io.ts'

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
  /** A literal substitution applied to every captured row before it is
   *  compared: what the Python wrote, and what the port writes instead. */
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
   *  `bin/gh.ts`. The hook only ever reads it to decide whether the install
   *  is complete; the child itself is the injected runner. */
  entry: string
}

const harness = (): Harness => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const bin = sandbox.join('plugin', 'bin')
  mkdirSync(bin, { recursive: true })
  const entry = path.join(bin, 'gh.ts')
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

/** The Python's text with every recorded substitution applied, which is what
 *  the port is expected to have written. */
const expected = (text: string): string => {
  let answer = text
  for (const entry of divergences.text) answer = answer.split(entry.python).join(entry.port)
  return answer
}

/** Assert one replayed row against the capture, whole. */
const expectParity = (replayed: Replayed, name: string): void => {
  const row = capture.runs[name]
  if (row === undefined) throw new Error(`no captured run named ${name}`)
  expect(replayed.stdout).toBe(expected(row.stdout))
  expect(replayed.stderr).toBe(expected(row.stderr))
  expect(replayed.status).toBe(row.status)
}

// --- the seams: no repository, no child --------------------------------------

for (const name of [
  'cwd/with-a-cwd',
  'cwd/without-a-cwd',
  'cwd/not-json',
  'cwd/not-an-object',
  'cwd/empty-stdin',
  'cwd/non-ascii',
  'cwd/cwd-is-null',
  'branch/both-names',
  'branch/non-ascii',
  'branch/quotes-and-backslashes',
  'branch/one-name',
  'branch/three-names',
  'branch/no-names',
  'report/simple',
  'report/non-ascii',
  'report/empty-stdin',
  'report/trailing-newlines',
  'report/control-characters',
  'report/single-byte-locale',
  'report/astral',
  'usage/no-subcommand',
  'usage/unknown-subcommand',
  'usage/empty-subcommand',
]) {
  it(`writes what the Python wrote for ${name}`, async () => {
    const harnessed = harness()

    const replayed = await replay(harnessed, name, { processCwd: harnessed.sandbox.path })

    expectParity(replayed, name)
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

  expectParity(replayed, 'in-repo/off-default-branch')
})

it('falls back to a local main when origin/HEAD is not cached', async () => {
  const { replayed } = await inRepo('in-repo/local-main-fallback', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/local-main-fallback')
})

it('falls back to a local master when that is the name the clone kept', async () => {
  const { replayed } = await inRepo('in-repo/local-master-fallback', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'branch', '-m', 'main', 'master')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/local-master-fallback')
})

it('prefers a local main over a local master, because the order decides', async () => {
  const { replayed } = await inRepo('in-repo/prefers-local-main', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.forgetOriginHead(repository)
    git.git(repository, 'branch', 'master', 'main')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/prefers-local-main')
})

it('prefers a cached origin/HEAD over a local main', async () => {
  const { replayed } = await inRepo('in-repo/origin-head-wins', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    return repository
  })

  expectParity(replayed, 'in-repo/origin-head-wins')
})

it('passes an origin/HEAD outside the origin namespace through unchanged', async () => {
  const { replayed } = await inRepo('in-repo/origin-head-outside-namespace', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/trunk')
    git.git(repository, 'checkout', '-q', '-b', 'side')
    return repository
  })

  expectParity(replayed, 'in-repo/origin-head-outside-namespace')
})

it('answers from the clone alone when the remote is unreachable', async () => {
  const { replayed } = await inRepo('in-repo/broken-origin-still-answers', ({ sandbox, git }) => {
    const repository = git.create(sandbox.join('r'))
    git.git(repository, 'checkout', '-q', '-b', 'side')
    git.breakOrigin(repository)
    return repository
  })

  expectParity(replayed, 'in-repo/broken-origin-still-answers')
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

  expectParity(replayed, 'fan-out/prunable-work')
})

it('reports every repository a many-repository run had something to say about', async () => {
  const { replayed } = await fanOut('fan-out/many-repositories')

  expectParity(replayed, 'fan-out/many-repositories')
})

it('speaks up when the merge lookups were degraded rather than reporting silence', async () => {
  const { replayed } = await fanOut('fan-out/degraded-merge-lookups')

  expectParity(replayed, 'fan-out/degraded-merge-lookups')
})

it('reports a repository whose fetch failed, the ✗ arm of the filter', async () => {
  const { replayed } = await fanOut('fan-out/fetch-failed')

  expectParity(replayed, 'fan-out/fetch-failed')
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

it('answers from the process cwd when the payload carries none, and still speaks', async () => {
  const harnessed = harness()
  const repository = harnessed.git.create(harnessed.sandbox.join('r'))
  harnessed.git.git(repository, 'checkout', '-q', '-b', 'side')

  const replayed = await replay(harnessed, 'payload/falls-back-to-process-cwd', {
    processCwd: repository,
  })

  expectParity(replayed, 'payload/falls-back-to-process-cwd')
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
  const missing = harnessed.sandbox.join('lonely', 'bin', 'gh.ts')

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
  // `scripts/gh-sync.py` to `bin/gh.ts`, and the recorded row names both.
  const moved = divergences.paths.find((entry) => entry.name === 'fan-out/missing-entry-point')
  expect(moved).toBeDefined()
  expect(row?.stderr).toContain(moved?.python)
  expect(output.stderr()).toBe(`missing ${missing}\n`)
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
  // child on the next tick, where `communicate(timeout=inf)` waits.
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
  // The acceptance is byte-identical, so the only divergences are the two
  // the port cannot avoid: a path that moved, and a number grammar that
  // stops at ASCII digits.
  expect(divergences.paths.map((entry) => entry.name)).toEqual(['fan-out/missing-entry-point'])
  expect(divergences.syncTimeout.map((entry) => entry.raw)).toEqual(['２'])
  expect(divergences.text).toHaveLength(1)
  for (const entry of [
    ...divergences.text,
    ...divergences.paths,
    ...divergences.syncTimeout,
    ...divergences.notes,
  ]) {
    expect(entry.why.length).toBeGreaterThan(20)
  }
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
