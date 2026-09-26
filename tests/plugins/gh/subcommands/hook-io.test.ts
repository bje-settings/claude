// The SessionStart hook, in process: the `session-start` response, the
// payload it reads, the usage contract, and the small helpers the check is
// built from. `hook-io.status.test.ts` covers the check itself, and
// `hook-io.prune.test.ts` covers the prune rule.
//
// The #230 acceptance test is the table at the end. Every state it builds
// writes at most one line, in `systemMessage`, and no `additionalContext`.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  DEADLINE_MS,
  emit,
  parseCount,
  payloadCwd,
  scrubRepositoryEnv,
  USAGE,
  which,
} from '#gh/subcommands/hook-io.ts'
import { createGhMock, type GhClient, ghFails } from '#harness/gh.ts'
import {
  createRig,
  expectOneLine,
  githubRepo,
  hangingFetch,
  onGitHub,
  type Rig,
  runHook,
  side,
} from './hook-io.test-support.ts'

const answering = (repositories: Record<string, ReturnType<typeof side>>): GhClient =>
  createGhMock({ repositoryStatus: { repositories, unavailable: null } })

/** Run `session-start` with `payload` on stdin. */
const sessionStart = (rig: Rig, payload: string, gh: GhClient, cwd: string = rig.sandbox.path) =>
  runHook(rig, ['session-start'], gh, { stdin: () => Promise.resolve(payload), cwd: () => cwd })

// --- session-start ------------------------------------------------------------

it('writes the line as the systemMessage of one JSON document, and nothing else', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await sessionStart(
    rig,
    JSON.stringify({ session_id: 's1', cwd: work }),
    answering({ 'acme/widgets': side(0, 2) }),
  )

  expect(ran).toEqual({
    status: 0,
    stdout: '{"systemMessage":"gh: [behind 1] [🤖 2]"}\n',
    stderr: '',
  })
})

it('writes nothing at all when there is nothing to show', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await sessionStart(
    rig,
    JSON.stringify({ cwd: work }),
    answering({ 'acme/widgets': side() }),
  )

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('still exits 0 when the check found only a failure', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await sessionStart(
    rig,
    JSON.stringify({ cwd: work }),
    createGhMock({ repositoryStatus: ghFails('gh: HTTP 401') }),
  )

  expect(ran).toEqual({
    status: 0,
    stdout: '{"systemMessage":"gh: ⚠️"}\n',
    stderr: 'GitHub: GhError: gh: HTTP 401\n',
  })
})

it('falls back to its own directory when the payload names none it can use', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  const gh = answering({ 'acme/widgets': side() })

  for (const payload of [
    '',
    'not json',
    '["a"]',
    '{"cwd":3}',
    '{"cwd":""}',
    '{}',
    JSON.stringify({ cwd: rig.sandbox.join('not-there') }),
  ]) {
    const ran = await sessionStart(rig, payload, gh, work)
    expect([payload, ran.stdout]).toEqual([payload, '{"systemMessage":"gh: [behind 1]"}\n'])
  }
})

it('prefers the payload directory over its own directory', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  const elsewhere = rig.sandbox.join('elsewhere')
  mkdirSync(elsewhere, { recursive: true })

  const ran = await sessionStart(
    rig,
    JSON.stringify({ cwd: work }),
    answering({ 'acme/widgets': side() }),
    elsewhere,
  )

  expect(ran.stdout).toBe('{"systemMessage":"gh: [behind 1]"}\n')
})

it('still runs the whole check when stdin itself cannot be read', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await runHook(rig, ['session-start'], answering({ 'acme/widgets': side() }), {
    stdin: () => Promise.reject(new Error('EBADF: bad file descriptor, read')),
    cwd: () => work,
  })

  expect(ran).toEqual({ status: 0, stdout: '{"systemMessage":"gh: [behind 1]"}\n', stderr: '' })
})

it('bounds the whole check at five seconds by default', () => {
  expect(DEADLINE_MS).toBe(5_000)
})

// --- the usage contract ------------------------------------------------------

it('answers anything it does not know with the usage line and exit 2', async () => {
  const rig = createRig()

  for (const argv of [[], ['session_start'], ['report'], ['cwd'], ['status', 'a', 'b']]) {
    const ran = await runHook(rig, argv, createGhMock())
    expect([argv, ran]).toEqual([argv, { status: 2, stdout: '', stderr: USAGE }])
  }
})

it('names both subcommands in its usage line', () => {
  expect(USAGE).toBe('usage: hook-io.ts {session-start|status [dir]}\n')
})

// --- the helpers -------------------------------------------------------------

it('writes the response with JSON.stringify, and one newline', () => {
  expect(emit('gh: [🛡️ 1] ⚠️')).toBe('{"systemMessage":"gh: [🛡️ 1] ⚠️"}\n')
  expect(emit('a "quote"')).toBe('{"systemMessage":"a \\"quote\\""}\n')
})

it('reads a payload cwd only when it is a string in a JSON object', () => {
  expect(payloadCwd('{"cwd":"/some/where"}')).toBe('/some/where')
  expect(payloadCwd('{"cwd":3}')).toBe('')
  expect(payloadCwd('{"cwd":null}')).toBe('')
  expect(payloadCwd('{"cwd":""}')).toBe('')
  expect(payloadCwd('{}')).toBe('')
  // `typeof []` is `'object'`, so `Array.isArray` answers the rest.
  expect(payloadCwd('["a","b"]')).toBe('')
  expect(payloadCwd('"a string"')).toBe('')
  expect(payloadCwd('null')).toBe('')
  expect(payloadCwd('not json')).toBe('')
  expect(payloadCwd('')).toBe('')
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

it('finds a tool on PATH, and refuses a directory named after one', () => {
  const rig = createRig()
  const bin = rig.sandbox.join('bin')
  mkdirSync(path.join(bin, 'git'), { recursive: true })

  // A directory has the traverse bit, which passes an executable check.
  expect(which('git', { PATH: bin })).toBeNull()
  expect(which('git', {})).toBeNull()
  expect(which('git', rig.sandbox.env)).not.toBeNull()
})

it('reads a PATH set to nothing as no PATH, and an empty entry as the cwd', () => {
  const rig = createRig()
  const bin = rig.sandbox.join('bin')
  mkdirSync(bin, { recursive: true })
  const tool = path.join(bin, 'git')
  writeFileSync(tool, '#!/bin/sh\nexit 0\n')
  chmodSync(tool, 0o755)
  // An empty PATH entry resolves against the process's own directory. The
  // change and the restore are in one synchronous block, so no other test
  // in this file runs between them.
  const before = process.cwd()
  process.chdir(bin)
  try {
    expect(which('git', { PATH: '' })).toBeNull()
    expect(which('git', { PATH: `${path.delimiter}${rig.sandbox.join('nowhere')}` })).toBe('git')
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

// --- #230 acceptance: one line, and no additionalContext ---------------------

/** One state the hook can meet, and the line it must write for it. */
interface Case {
  readonly name: string
  readonly build: (rig: Rig) => { cwd: string; gh: GhClient; deadlineMs?: number }
  readonly line: string | null
  /** How many failures the debug log gets, one line each. */
  readonly failures: number
}

const ONE = (rig: Rig): string => githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

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
    line: 'gh: [behind 1] [prune 1] [🤖 3] [🛡️ 2]',
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
    line: 'gh: 2 repos [🛡️ 2]',
    failures: 0,
  },
  {
    name: 'a failed GitHub call',
    build: (rig) => ({
      cwd: ONE(rig),
      gh: createGhMock({ repositoryStatus: ghFails('gh: first line\nsecond line') }),
    }),
    line: 'gh: ⚠️',
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
    line: 'gh: [🤖 1] ⚠️',
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
    line: 'gh: ⚠️',
    failures: 2,
  },
  {
    name: 'a remote that is not on GitHub',
    build: (rig) => ({ cwd: rig.git.create(rig.sandbox.join('r')), gh: createGhMock() }),
    line: null,
    failures: 0,
  },
]

for (const example of CASES) {
  it(`writes at most one line, and no additionalContext, for ${example.name}`, async () => {
    const rig = createRig()
    const built = example.build(rig)

    const ran = await runHook(rig, ['session-start'], built.gh, {
      stdin: () => Promise.resolve(JSON.stringify({ cwd: built.cwd })),
      ...(built.deadlineMs === undefined ? {} : { deadlineMs: built.deadlineMs }),
    })

    expect(ran.status).toBe(0)
    expectOneLine(ran.stdout)
    expect(ran.stdout).toBe(example.line === null ? '' : emit(example.line))
    // The account on stderr is for the debug log: one line per failure, even
    // when a reason held a newline of its own.
    expect(ran.stderr === '' ? 0 : ran.stderr.split('\n').length - 1).toBe(example.failures)
    expect(ran.stderr === '' || ran.stderr.endsWith('\n')).toBe(true)
  })
}
