// The hook, in process: the `session-start` dependency check, the usage
// contract, and the small helpers the check is built from.
// `hook-io.status.test.ts` covers the `status` check itself, and
// `hook-io.prune.test.ts` covers the prune rule.
//
// The #230 acceptance test is the table at the end. For every state it
// builds, `status` writes at most one status line, then one problem line for
// each kind of failure. `session-start` writes only the lines of a missing
// tool, with `additionalContext`, and nothing for every other state (#488).
import { expect, it } from 'vitest'
import { type FileReads, nodeFileReads } from '#gh/lib/dependencies.ts'
import {
  DEADLINE_MS,
  emit,
  parseCount,
  scrubRepositoryEnv,
  USAGE,
} from '#gh/subcommands/hook-io.ts'
import { createGhMock, type GhClient, ghFails } from '#harness/gh.ts'
import {
  createRig,
  expectStatusLines,
  githubRepo,
  hangingFetch,
  onGitHub,
  type Rig,
  runHook,
  side,
  wrappedGit,
} from './hook-io.test-support.ts'

const answering = (repositories: Record<string, ReturnType<typeof side>>): GhClient =>
  createGhMock({ repositoryStatus: { repositories, unavailable: null } })

// --- session-start ------------------------------------------------------------

it('writes nothing, fetches nothing and asks GitHub nothing when git and gh are present', async () => {
  // The hooks module pins the counts now (#488). A repository with counts
  // gets no line from this mode, and its origin ref stays where it was.
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  const before = rig.git.sha(work, 'refs/remotes/origin/main')

  // `createGhMock()` throws for any call, so a GitHub request would fail.
  const ran = await runHook(rig, ['session-start'], createGhMock(), { cwd: () => work })

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
  expect(rig.git.sha(work, 'refs/remotes/origin/main')).toBe(before)
})

it('never asks for its own directory', async () => {
  const rig = createRig()

  const ran = await runHook(rig, ['session-start'], createGhMock(), {
    cwd: () => {
      throw new Error('the hook asked for its own directory')
    },
  })

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

// --- #267: a read that hangs ----------------------------------------------------

/** A read on a filesystem that hangs. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** Short, so each test waits for it. Long enough for a real read. */
const SHORT_DEADLINE_MS = 300

it('reports a PATH walk that never answers as could not be checked, with no additionalContext', async () => {
  const rig = createRig()
  const started = performance.now()

  const ran = await runHook(rig, ['session-start'], createGhMock(), {
    files: { ...nodeFileReads, canRun: () => never() },
    deadlineMs: SHORT_DEADLINE_MS,
  })

  expect(performance.now() - started).toBeLessThan(SHORT_DEADLINE_MS + 200)
  expect(ran).toEqual({
    status: 0,
    stdout: emit('gh: ⚠️ git could not be checked\ngh: ⚠️ GitHub CLI (gh) could not be checked'),
    stderr: 'git could not be checked\nGitHub CLI (gh) could not be checked\n',
  })
})

it('names only the absent tool in additionalContext when another walk never answers', async () => {
  const rig = createRig()
  const files: FileReads = {
    ...nodeFileReads,
    canRun: (target) => (target.endsWith('/gh') ? never() : nodeFileReads.canRun(target)),
  }

  const ran = await runHook(rig, ['session-start'], createGhMock(), {
    env: { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('git') },
    files,
    deadlineMs: SHORT_DEADLINE_MS,
  })

  expect(ran.status).toBe(0)
  expect(ran.stdout).toBe(
    emit(
      'gh: ⚠️ git not found on PATH\ngh: ⚠️ GitHub CLI (gh) could not be checked',
      'git is absent. The gh plugin cannot run.',
    ),
  )
})

it('writes nothing about the gh stack extension, which no gh command runs', async () => {
  // The rig installs no extension. The shepherd plugin's own hook checks it.
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await runHook(rig, ['session-start'], answering({ 'acme/widgets': side() }), {
    cwd: () => work,
  })

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('bounds the whole check well under the 3 second hooks.json timeout', () => {
  expect(DEADLINE_MS).toBe(2_500)
})

// --- the usage contract ------------------------------------------------------

it('answers anything it does not know with the usage line and exit 2', async () => {
  const rig = createRig()

  for (const argv of [
    [],
    ['session_start'],
    ['session-start', 'extra'],
    ['report'],
    ['cwd'],
    ['status', 'a', 'b'],
  ]) {
    const ran = await runHook(rig, argv, createGhMock())
    expect([argv, ran]).toEqual([argv, { status: 2, stdout: '', stderr: USAGE }])
  }
})

it('names both subcommands in its usage line', () => {
  expect(USAGE).toBe('usage: hook-io.ts {session-start|status [--json] [dir]}\n')
})

// --- the helpers -------------------------------------------------------------

it('writes the response with JSON.stringify, and one newline', () => {
  expect(emit('gh: [🛡️ 1]\ngh: ⚠️ fetch failed')).toBe(
    '{"systemMessage":"\\n\\u001b[36m\\u001b[1mgh:\\u001b[22m [🛡️ 1]\\u001b[0m\\n\\u001b[33m\\u001b[1mgh:\\u001b[22m ⚠️ fetch failed\\u001b[0m"}\n',
  )
  expect(emit('a "quote"')).toBe('{"systemMessage":"\\na \\"quote\\""}\n')
  expect(emit('gh:[🛡️ 1]')).toBe('{"systemMessage":"\\ngh:[🛡️ 1]"}\n')
})

it('reads a count only where git answered with one', () => {
  expect(parseCount('0')).toBe(0)
  expect(parseCount('12')).toBe(12)
  // git can fail, or exit 0 with nothing to say. Neither is a count of zero.
  expect(parseCount(null)).toBeNull()
  expect(parseCount('')).toBeNull()
  expect(parseCount('-1')).toBeNull()
  expect(parseCount('two')).toBeNull()
  expect(parseCount('1 2')).toBeNull()
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

// --- #230 and #243 acceptance: one line, and additionalContext only when a
// tool is absent ---------------------------------------------------------

/** One state the hook can meet, and the line it must write for it. */
interface Case {
  readonly name: string
  readonly build: (rig: Rig) => {
    cwd: string
    gh: GhClient
    deadlineMs?: number
    env?: NodeJS.ProcessEnv
  }
  readonly line: string | null
  /** How many failures the debug log gets, one line each. */
  readonly failures: number
  /** Set only for a case where a tool is absent. */
  readonly additionalContext?: string
}

const ONE = (rig: Rig): string => githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

/** A git whose fetch fails as GitHub refuses a bad token. */
const BAD_TOKEN = (rig: Rig): string =>
  wrappedGit(
    rig,
    'bin-bad-token',
    [
      "  fetch*) echo 'remote: Invalid username or token. Password authentication is not supported.' >&2",
      "    echo 'fatal: Authentication failed' >&2; exit 128 ;;",
    ].join('\n'),
  )

const CASES: readonly Case[] = [
  {
    name: 'a clean checkout',
    build: (rig) => ({ cwd: ONE(rig), gh: answering({ 'acme/widgets': side() }) }),
    line: null,
    failures: 0,
  },
  {
    name: 'every item',
    build: (rig) => {
      const work = ONE(rig)
      rig.git.branchWithWork(work, 'squashed')
      rig.git.mergeSquash(work, 'squashed')
      rig.git.remoteAdvance(work)
      const row = {
        headRefName: 'squashed',
        headRefOid: rig.git.sha(work, 'squashed'),
        isCrossRepository: false,
      }
      return { cwd: work, gh: answering({ 'acme/widgets': side(2, 3, [row]) }) }
    },
    line: 'gh: [behind] [✂️ 1] [🤖 3] [🛡️ 2]',
    failures: 0,
  },
  {
    name: 'a folder of repositories',
    build: (rig) => {
      const folder = rig.sandbox.join('folder')
      onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
      onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/b')
      return { cwd: folder, gh: answering({ 'acme/a': side(1), 'acme/b': side(1) }) }
    },
    line: 'gh: [repos: 2] [🛡️ 2]',
    failures: 0,
  },
  {
    name: 'a failed GitHub call',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock({ repositoryStatus: ghFails('gh: first line\nsecond line') }),
    }),
    line: 'gh: ⚠️ GitHub request failed: first line',
    failures: 1,
  },
  {
    name: 'a partial GitHub answer',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock({
        repositoryStatus: {
          repositories: { 'acme/widgets': { ...side(0, 1), alerts: null } },
          unavailable: 'one\ntwo',
        },
      }),
    }),
    line: 'gh: [🤖 1]\ngh: ⚠️ GitHub request failed: one\ngh: ⚠️ alerts could not be read',
    failures: 2,
  },
  {
    name: 'a deadline that passed',
    build: (rig) => ({
      cwd: (() => {
        const work = ONE(rig)
        hangingFetch(rig, work)
        return work
      })(),
      gh: { ...createGhMock(), repositoryStatus: () => new Promise(() => {}) },
      deadlineMs: 2_000,
    }),
    line: 'gh: ⚠️ timed out\ngh: ⚠️ GitHub request timed out',
    failures: 2,
  },
  {
    name: 'a remote that is not on GitHub',
    build: (rig) => ({ cwd: rig.git.create(rig.sandbox.join('r')), gh: createGhMock() }),
    line: null,
    failures: 0,
  },
  {
    name: 'one cause in a folder of three repositories',
    build: (rig) => {
      const folder = rig.sandbox.join('folder')
      for (const name of ['a', 'b', 'c'])
        onGitHub(rig, rig.git.createAt(folder, name), `acme/${name}`)
      return {
        cwd: folder,
        gh: answering({ 'acme/a': side(), 'acme/b': side(), 'acme/c': side(1) }),
        env: { ...rig.sandbox.env, PATH: BAD_TOKEN(rig) },
      }
    },
    line: 'gh: [repos: 3] [🛡️ 1]\ngh: ⚠️ fetch failed in 3 repos: Invalid username or token',
    failures: 3,
  },
  {
    name: 'one cause in one repository',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: answering({ 'acme/widgets': side() }),
      env: { ...rig.sandbox.env, PATH: BAD_TOKEN(rig) },
    }),
    line: 'gh: ⚠️ fetch failed: Invalid username or token',
    failures: 1,
  },
  {
    name: 'a missing git',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock(),
      env: { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('git') },
    }),
    line: 'gh: ⚠️ git not found on PATH',
    failures: 1,
    additionalContext: 'git is absent. The gh plugin cannot run.',
  },
  {
    name: 'a missing GitHub CLI',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock(),
      env: { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('gh') },
    }),
    line: 'gh: ⚠️ GitHub CLI (gh) not found on PATH',
    failures: 1,
    additionalContext: 'GitHub CLI (gh) is absent. The gh plugin cannot run.',
  },
  {
    name: 'a missing git and GitHub CLI',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock(),
      env: { ...rig.sandbox.env, PATH: rig.sandbox.join('no-bin') },
    }),
    line: 'gh: ⚠️ git not found on PATH\ngh: ⚠️ GitHub CLI (gh) not found on PATH',
    failures: 2,
    additionalContext: 'git, GitHub CLI (gh) are absent. The gh plugin cannot run.',
  },
]

for (const example of CASES) {
  const contextWords =
    example.additionalContext === undefined ? 'no additionalContext' : 'additionalContext'
  it(`writes one status line and one line per kind, and ${contextWords}, for ${example.name}`, async () => {
    const rig = createRig()
    const built = example.build(rig)
    const overrides = {
      ...(built.deadlineMs === undefined ? {} : { deadlineMs: built.deadlineMs }),
      ...(built.env === undefined ? {} : { env: built.env }),
    }

    // `status` writes the bare lines, which the hooks module pins.
    const status = await runHook(rig, ['status', built.cwd], built.gh, overrides)
    expect(status.status).toBe(0)
    expect(status.stdout).toBe(example.line === null ? '' : `${example.line}\n`)
    // The account on stderr is for the debug log: one line per failure, even
    // when a reason held a newline of its own.
    expect(status.stderr === '' ? 0 : status.stderr.split('\n').length - 1).toBe(example.failures)
    expect(status.stderr === '' || status.stderr.endsWith('\n')).toBe(true)

    // `session-start` writes only a missing tool, with `additionalContext`.
    const start = await runHook(rig, ['session-start'], built.gh, {
      ...overrides,
      cwd: () => built.cwd,
    })
    const missing = example.additionalContext !== undefined
    expect(start.status).toBe(0)
    expectStatusLines(start.stdout)
    expect(start.stdout).toBe(
      missing && example.line !== null ? emit(example.line, example.additionalContext) : '',
    )
    expect(start.stderr === '' ? 0 : start.stderr.split('\n').length - 1).toBe(
      missing ? example.failures : 0,
    )
  })
}
