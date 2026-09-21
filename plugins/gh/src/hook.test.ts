// The one spawned contract test for the hook entry point, and the wiring
// `hooks.json` actually carries.
//
// `commands/hook-io.test.ts` is where the hook's decisions are exercised, in
// process, against the captured Python. This file is the process boundary
// itself: the floor guard in front of it, argv, stdin, both streams and the
// exit status, plus the one run that starts the real `bin/gh.ts` child rather
// than an injected one.
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { createSandbox } from '../../../harness/sandbox.ts'
import { runScript } from '../../../harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', 'hooks', 'hook-io.ts')
const HOOKS_JSON = path.join(HERE, '..', 'hooks', 'hooks.json')
const FIXTURES = path.join(HERE, 'fixtures')

interface Capture {
  runs: Record<
    string,
    { argv: string[]; stdin: string; status: number; stdout: string; stderr: string }
  >
}
interface Divergences {
  text: { python: string; port: string }[]
}

const capture = JSON.parse(readFileSync(path.join(FIXTURES, 'hook-output.json'), 'utf8')) as Capture
const divergences = JSON.parse(
  readFileSync(path.join(FIXTURES, 'divergences-hook.json'), 'utf8'),
) as Divergences

/** The Python's text with every recorded substitution applied. */
const expected = (text: string): string => {
  let answer = text
  for (const entry of divergences.text) answer = answer.split(entry.python).join(entry.port)
  return answer
}

const row = (name: string) => {
  const captured = capture.runs[name]
  if (captured === undefined) throw new Error(`no captured run named ${name}`)
  return captured
}

/** The additionalContext of a SessionStart response, with the contract
 *  asserted on the way past: the event name, and `systemMessage` carrying the
 *  identical text, because every message this hook emits must reach the user
 *  whether or not the model ever takes a turn. */
const contextOf = (stdout: string): string => {
  const body = JSON.parse(stdout) as {
    systemMessage: string
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  expect(body.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(body.systemMessage).toBe(body.hookSpecificOutput.additionalContext)
  return body.hookSpecificOutput.additionalContext
}

it('answers a wiring mistake with the usage line and exit 2, and nothing on stdout', () => {
  const sandbox = createSandbox()
  const captured = row('usage/no-subcommand')

  const result = runScript(HOOK, { env: sandbox.env })

  expect(result.status).toBe(captured.status)
  expect(result.stdout).toBe(captured.stdout)
  expect(result.stderr).toBe(expected(captured.stderr))
})

it('prints the usage line the Python printed, on stderr', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, { args: ['session_start'], env: sandbox.env })

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(
    'usage: hook-io.ts {session-start|cwd|branch <current> <default>|report}\n',
  )
})

it('reads the payload cwd off stdin, byte for byte', () => {
  const sandbox = createSandbox()
  const captured = row('cwd/non-ascii')

  const result = runScript(HOOK, { args: captured.argv, stdin: captured.stdin, env: sandbox.env })

  expect(result.status).toBe(captured.status)
  expect(result.stdout).toBe(captured.stdout)
})

it('writes the branch message the Python wrote, byte for byte', () => {
  const sandbox = createSandbox()
  const captured = row('branch/non-ascii')

  const result = runScript(HOOK, { args: captured.argv, env: sandbox.env })

  expect(result.status).toBe(captured.status)
  expect(result.stdout).toBe(captured.stdout)
})

it('wraps a report holding ✓, ✗ and · whatever the locale says', () => {
  const sandbox = createSandbox()
  const captured = row('report/non-ascii')

  const result = runScript(HOOK, {
    args: captured.argv,
    stdin: captured.stdin,
    // node writes strings as UTF-8 whatever the locale says, which is the
    // half of `use_utf8` that has no counterpart here (`lib/streams.ts`).
    env: { ...sandbox.env, LC_ALL: 'en_US.ISO8859-1' },
  })

  expect(result.status).toBe(captured.status)
  expect(result.stdout).toBe(captured.stdout)
  expect(result.stderr).toBe('')
})

it('runs the whole session-start path in a real checkout, byte for byte', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repository = git.create(sandbox.join('r'))
  git.git(repository, 'checkout', '-q', '-b', 'side')

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: repository }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(row('in-repo/off-default-branch').stdout)
  expect(result.stderr).toBe('')
})

it('stays silent in a checkout that is already on its default branch', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repository = git.create(sandbox.join('r'))

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: repository }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  // Asserted, because "exit 0 with an empty stdout" is also what the crash
  // path answers with (see the outermost-handler example below): without
  // this, a hook that threw before it decided anything would pass here.
  expect(result.stderr).toBe('')
})

it('starts the real bin/gh.ts child for a directory of checkouts', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const fan = sandbox.join('fan')
  git.createAt(fan, 'a')
  git.branchWithWork(path.join(fan, 'a'), 'wip')
  // No `gh` at all: the fan-out then reports a lookup it could not make,
  // which is one of the three actionable markers, and nothing in this test
  // reaches the real GitHub (ADR 001: `gh` is injected, never a binary on
  // PATH).
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }

  const work = path.join(fan, 'a')
  const before = {
    branches: git.branches(work),
    current: git.currentBranch(work),
    head: git.headSha(work),
  }

  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: JSON.stringify({ session_id: 's1', cwd: fan }),
    env,
  })

  expect(result.status).toBe(0)
  const context = contextOf(result.stdout)
  expect(context).toContain('A read-only /gh:sync check ran for the repositories below')
  expect(context).toContain('could not')
  // The sentence the hook writes is "No branch, worktree, or working tree was
  // changed", and this is the one example in this layer that starts the real
  // child, so it is the only place that claim can be checked
  // (`test_reports_prunable_work_and_changes_nothing`).
  expect({
    branches: git.branches(work),
    current: git.currentBranch(work),
    head: git.headSha(work),
  }).toEqual(before)
})

it('exits 0 in silence when the payload is not a document at all', () => {
  const sandbox = createSandbox()

  // The fallback is the process's own directory, which here holds no
  // checkout and so has nothing to say.
  const result = runScript(HOOK, {
    args: ['session-start'],
    stdin: 'not json at all',
    env: sandbox.env,
    cwd: sandbox.path,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  // As above: silence has to be the decision, not a crash before one.
  expect(result.stderr).toBe('')
})

it('leaves its account on stderr and still exits 0 when nothing else caught it', () => {
  const sandbox = createSandbox()
  const doomed = sandbox.join('doomed')
  mkdirSync(doomed, { recursive: true })

  // The fixture enters `doomed`, removes it, and then runs the hook, so
  // `process.cwd()` raises where the payload has no cwd to use instead.
  const result = runScript(path.join(FIXTURES, 'deleted-cwd.ts'), {
    args: [doomed, HOOK],
    stdin: '{"session_id":"s1"}',
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  // node's own account, where `claude --debug` keeps it, as the Python's
  // traceback went.
  expect(result.stderr).toContain('ENOENT')
  expect(result.stderr).toMatch(/\n {4}at /)
})

// --- the wiring hooks.json carries -------------------------------------------

it('runs the hook entry with node, behind the silent guard, at the same matcher', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    description: string
    hooks: { SessionStart: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
  }
  const entries = config.hooks.SessionStart

  expect(entries).toHaveLength(1)
  expect(entries[0]?.matcher).toBe('startup')
  // Spelled in two pieces because biome refuses a `${` inside a plain
  // string, and the value under test is a shell command carrying Claude
  // Code's own expansion rather than a TypeScript template.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    `command -v node >/dev/null 2>&1 && node "${expansion}/hooks/hook-io.ts" session-start; exit 0`,
  ])
  // The budget the 50 second bound on the fan-out is sized against.
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([60])
  // The description is what a user reads in the plugin listing, and it is
  // still true of what the hook does.
  expect(config.description).toBe(
    'Report-only sync check when a session starts. Fetches, but never changes a branch, ' +
      'worktree, or working tree.',
  )
})
