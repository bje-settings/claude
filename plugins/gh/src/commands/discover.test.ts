// The `discover` command against what `lib/discover.py` printed.
//
// `../discover.test.ts` covers the rule itself, in process, against real
// repositories. This file is the command line onto it: the ten states
// `fixtures/python-cli-output.json`'s `discover` rows were captured from,
// each replayed and compared on stdout, stderr and status.
//
// `fixtures/divergences-discover.json` is what this deliberately says
// instead, read by the test rather than described in prose.
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { runScript } from '../../../../harness/spawn.ts'
import type { Output, Writer } from '../lib/streams.ts'
import { HELP, runDiscover } from './discover.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', 'fixtures')
const BIN = path.join(HERE, '..', '..', 'bin', 'gh.ts')

interface CapturedRun {
  argv: string[]
  status: number
  stdout: string
  stderr: string
}

const PYTHON = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'python-cli-output.json'), 'utf8')) as {
    discover: Record<string, CapturedRun>
  }
).discover

interface Divergences {
  /** A row whose stderr the port words differently, with the port's own
   *  spelling as a prefix that must still hold. */
  stderr: { name: string; python: string; port: string; why: string }[]
}

const divergences = JSON.parse(
  readFileSync(path.join(FIXTURES, 'divergences-discover.json'), 'utf8'),
) as Divergences

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

/** The capture replaced the sandbox it was built in with `<sandbox>`, in both
 *  its logical and its resolved spelling: discovery answers with the path git
 *  reports, and on macOS the temp directory sits behind a /private symlink. */
const normalise = (text: string, sandbox: Sandbox): string =>
  text.split(realpathSync(sandbox.path)).join('<sandbox>').split(sandbox.path).join('<sandbox>')

interface Ran {
  status: number
  stdout: string
  stderr: string
}

const runIn = async (
  sandbox: Sandbox,
  argv: readonly string[],
  cwd = sandbox.path,
): Promise<Ran> => {
  const output = createOutputPair()
  const status = await runDiscover(argv, { cwd, env: sandbox.env, output })
  return {
    status,
    stdout: normalise(output.stdout(), sandbox),
    stderr: normalise(output.stderr(), sandbox),
  }
}

const python = (name: string): CapturedRun => {
  const row = PYTHON[name]
  if (row === undefined) throw new Error(`no captured discover run named ${name}`)
  return row
}

const expectParity = (ran: Ran, name: string): void => {
  const row = python(name)
  expect(ran.stdout).toBe(row.stdout)
  expect(ran.stderr).toBe(row.stderr)
  expect(ran.status).toBe(row.status)
}

it('prints the checkout root for a path inside a repository', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))

  expectParity(await runIn(sandbox, [work]), 'repository')
})

it('prints the checkout root for a path deep inside a repository', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  mkdirSync(path.join(work, 'src', 'deep'), { recursive: true })

  expectParity(await runIn(sandbox, [path.join(work, 'src', 'deep')]), 'subdirectory')
})

it('answers about the caller own directory when no path is given', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))

  // The captured row ran with no argument at all, from inside the checkout.
  expectParity(await runIn(sandbox, [], work), 'default_target')
})

it('prints every checkout one level down, in name order', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const fan = sandbox.join('fan')
  git.createAt(fan, 'aaa')
  git.createAt(fan, 'bbb')

  expectParity(await runIn(sandbox, [fan]), 'fan_out')
})

it('skips a dotted directory, which the shell glob never matched either', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const hidden = sandbox.join('hidden')
  git.createAt(hidden, 'visible')
  git.createAt(hidden, '.buried')

  expectParity(await runIn(sandbox, [hidden]), 'hidden_directory')
})

it('does not recurse past the immediate subdirectories', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const deep = sandbox.join('deep')
  mkdirSync(path.join(deep, 'middle'), { recursive: true })
  git.createAt(path.join(deep, 'middle'), 'buried')

  expectParity(await runIn(sandbox, [deep]), 'not_recursive')
})

it('prints nothing for a directory with no checkouts in it', async () => {
  const sandbox = createSandbox()
  const empty = sandbox.join('empty')
  mkdirSync(empty, { recursive: true })

  expectParity(await runIn(sandbox, [empty]), 'no_repositories')
})

it('prints nothing, and exits 0, when git cannot be run at all', async () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  const withoutGit = { ...sandbox.env, PATH: sandbox.pathWithout('git') }
  const output = createOutputPair()

  const status = await runDiscover([work], { cwd: sandbox.path, env: withoutGit, output })

  // "Discovery asks git whether a directory is a checkout, and answers no
  // when git cannot be run at all." The command publishes that as it found
  // it; `gh.ts sync` is where a missing git becomes a sentence.
  expect(output.stdout()).toBe(python('missing_git').stdout)
  expect(status).toBe(python('missing_git').status)
})

it('refuses a target that is not a directory, on stderr and with exit 1', async () => {
  const sandbox = createSandbox()

  expectParity(await runIn(sandbox, [sandbox.join('nope')]), 'not_a_directory')
})

it('says a target could not be read rather than that it held nothing', async () => {
  const sandbox = createSandbox()
  const blocked = sandbox.join('blocked')
  mkdirSync(blocked, { recursive: true })
  chmodSync(blocked, 0o000)
  let ran: Ran
  try {
    ran = await runIn(sandbox, [blocked])
  } finally {
    // Restored before anything else can trip over it, including the
    // sandbox's own cleanup.
    chmodSync(blocked, 0o755)
  }

  const row = python('unreadable_target')
  expect(ran.status).toBe(row.status)
  expect(ran.stdout).toBe(row.stdout)
  // The sentence is the Python's; the reason after the colon is node's own
  // account of the same errno, which is the one recorded divergence.
  const recorded = divergences.stderr.find((entry) => entry.name === 'unreadable_target')
  expect(recorded).toBeDefined()
  expect(row.stderr).toContain(recorded?.python)
  expect(ran.stderr).toContain(recorded?.port)
  expect(ran.stderr.startsWith('could not read <sandbox>/blocked: ')).toBe(true)
  // A directory nobody can read cannot be produced as root, which is a
  // reported skip rather than a silent pass.
  expect(process.getuid?.()).not.toBe(0)
})

// --- what a command line of its own owes -------------------------------------

it('prints its own usage for --help, and for -h, with a status of 0', async () => {
  const sandbox = createSandbox()

  for (const flag of ['--help', '-h']) {
    const ran = await runIn(sandbox, [flag])

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`${HELP}\n`)
    expect(ran.stderr).toBe('')
  }
})

it('refuses a second target rather than answering about one of them', async () => {
  const sandbox = createSandbox()

  const ran = await runIn(sandbox, [sandbox.path, sandbox.path])

  expect(ran.status).toBe(2)
  expect(ran.stdout).toBe('')
  expect(ran.stderr).toBe('usage: gh.ts discover [path]\n')
})

it('records every divergence from the Python as data, and no more', () => {
  expect(divergences.stderr.map((entry) => entry.name)).toEqual(['unreadable_target'])
  for (const entry of divergences.stderr) {
    expect(entry.why.length).toBeGreaterThan(20)
  }
})

it('is reachable through bin/gh.ts, as the shepherd skill reaches it', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const fan = sandbox.join('fan')
  git.createAt(fan, 'aaa')
  git.createAt(fan, 'bbb')

  const result = runScript(BIN, { args: ['discover', fan], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(normalise(result.stdout, sandbox)).toBe(python('fan_out').stdout)
  expect(result.stderr).toBe('')
})

it('lists itself in the command list bin/gh.ts prints', () => {
  const sandbox = createSandbox()

  const result = runScript(BIN, { args: [], env: sandbox.env })

  expect(result.stdout).toContain('discover [path]')
})
