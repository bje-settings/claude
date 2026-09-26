// This is the one spawned contract test for the hook entry point. It also
// tests the wiring that `hooks.json` carries.
//
// `subcommands/hook-io*.test.ts` run the hook's decisions in process. This
// file runs the process boundary itself: the floor guard in front of it,
// argv, stdin, both streams, and the exit status. On the `vitest-floor` leg,
// the child runs on node 22.18, so each case here also proves the entry
// point loads on the floor. Nothing here reaches GitHub: every case either
// has no GitHub remote, or runs with no `gh` on PATH.
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { findOnPath } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'
import {
  createRig,
  expectOneLine,
  githubRepo,
  hangingFetch,
  wrappedGit,
} from './subcommands/hook-io.test-support.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = pluginFile('gh', 'hooks', 'hook-io.ts')
const HOOKS_JSON = pluginFile('gh', 'hooks', 'hooks.json')
const FIXTURES = path.join(HERE, 'fixtures')

it('answers a wiring mistake with the usage line and exit 2, and nothing on stdout', () => {
  const rig = createRig()

  for (const args of [[], ['report']]) {
    const result = runScript(HOOK, { args, env: rig.sandbox.env })

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('usage: hook-io.ts {session-start|status [dir]}\n')
  }
})

it('stays silent in a clean checkout', () => {
  const rig = createRig()
  // A remote that is not on GitHub: the hook asks `gh` nothing about it.
  const work = rig.git.create(rig.sandbox.join('r'))

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: work }),
    env: rig.sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  // The crash path also exits 0 with nothing on stdout. An empty stderr is
  // what shows that silence was the decision.
  expect(result.stderr).toBe('')
})

it('exits 0 in silence when the payload is not a document at all', () => {
  const rig = createRig()

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: 'not json at all',
    env: rig.sandbox.env,
    cwd: rig.sandbox.path,
  })

  expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
})

it('writes one line for a real checkout, end to end, and changes no branch', () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'goner')
  rig.git.push(work, 'goner')
  rig.git.git(work, 'branch', '--set-upstream-to=origin/goner', 'goner')
  rig.git.git(rig.sandbox.join('r', 'origin.git'), 'branch', '-D', 'goner')
  rig.git.remoteAdvance(work)
  const before = {
    branches: rig.git.branches(work),
    current: rig.git.currentBranch(work),
    head: rig.git.headSha(work),
  }
  // No `gh` at all, so the GitHub half fails, and the line says so.
  const env = { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('gh') }
  const started = Date.now()

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: work }),
    env,
  })

  // stderr below names no late task, so the check ended before its 5 s
  // deadline. The process must end then too: a deadline timer left set
  // would hold it open until the timer fires.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(result.status).toBe(0)
  expectOneLine(result.stdout)
  expect(result.stdout).toBe('{"systemMessage":"gh: [behind 1] [prune 1] ⚠️"}\n')
  expect(result.stderr).toMatch(/^GitHub: cannot run gh: .*ENOENT.*\n$/)
  // The fetch moved `origin/main` and removed `origin/goner`. Nothing else
  // changed.
  expect({
    branches: rig.git.branches(work),
    current: rig.git.currentBranch(work),
    head: rig.git.headSha(work),
  }).toEqual(before)
  expect(
    rig.git.tryGit(work, 'rev-parse', '--verify', 'refs/remotes/origin/goner').status,
  ).not.toBe(0)

  // `status` writes the same line, bare.
  const status = runScript(HOOK, { args: ['status', work], env })
  expect(status.stdout).toBe('gh: [behind 1] [prune 1] ⚠️\n')
})

it('stops a fetch that hangs, so the hook ends inside the timeout hooks.json gives it', () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  hangingFetch(rig, work)
  const env = { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('gh') }
  const started = Date.now()

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: work }),
    env,
  })

  // The shipped deadline is 5 s. The process ends only when its children
  // do, so the fetch must stop at the deadline too, not when it gives up.
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"gh: ⚠️"}\n')
  expect(result.stderr).toContain('did not finish in 5000 ms\n')
})

it('gives a late second origin read only the time that is left', () => {
  const rig = createRig()
  // The origin is not on github.com, so the hook reads the URL twice. The
  // first read takes 3 s, and the second one never answers.
  const local = rig.git.create(rig.sandbox.join('r'))
  const sleep = findOnPath('sleep', rig.sandbox.env.PATH) ?? 'sleep'
  const PATH = wrappedGit(
    rig,
    'bin-slow-origin',
    [
      `  *'config --get remote.origin.url'*) '${sleep}' 3 ;;`,
      `  *'remote get-url'*) exec '${sleep}' 60 ;;`,
    ].join('\n'),
  )
  const started = Date.now()

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: local }),
    env: { ...rig.sandbox.env, PATH },
  })

  // The process ends only when its children do. A second read with the
  // time the first read had would live until about 8 s.
  expect(Date.now() - started).toBeLessThan(7_000)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"gh: ⚠️"}\n')
  expect(result.stderr).toContain('did not finish in 5000 ms\n')
})

it('leaves its account on stderr and still exits 0 when nothing else caught it', () => {
  const rig = createRig()
  const doomed = rig.sandbox.join('doomed')
  mkdirSync(doomed, { recursive: true })

  // The fixture enters `doomed`, removes it, and then runs the hook. So
  // `process.cwd()` throws, and the payload has no cwd to use instead.
  const result = runScript(path.join(FIXTURES, 'deleted-cwd.ts'), {
    args: [doomed, HOOK],
    stdin: '{"session_id":"s1"}',
    env: rig.sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('ENOENT')
  expect(result.stderr).toMatch(/\n {4}at /)
})

// --- the wiring hooks.json carries -------------------------------------------

it('runs the hook entry with node, behind the silent guard, on start, resume and clear', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    description: string
    hooks: { SessionStart: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
  }
  const entries = config.hooks.SessionStart

  expect(entries).toHaveLength(1)
  expect(entries[0]?.matcher).toBe('startup|resume|clear')
  // This is spelled in two pieces because biome refuses a `${` inside a
  // plain string. The value is a shell command with Claude Code's own
  // expansion, not a TypeScript template.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    `command -v node >/dev/null 2>&1 && node "${expansion}/hooks/hook-io.ts" session-start; exit 0`,
  ])
  // Twice the check's own 5 s deadline, so the line arrives before Claude
  // Code stops the hook.
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([10])
  expect(config.description).toBe(
    'One status line when a session starts: commits behind, branches to prune, dependency ' +
      'pull requests and Dependabot alerts. Fetches, but never changes a branch, worktree, or ' +
      'working tree.',
  )
})
