// The one spawned contract test for the guard's entry point, and the wiring
// `hooks.json` actually carries.
//
// `subcommands/guard.test.ts` is where the decisions are exercised, in process.
// This file is the process boundary itself: the floor guard in front of it,
// stdin, both streams and the exit status, against real repositories, with
// the payloads Claude Code would really send.
//
// Every case asserts the exit status AND stdout. Exit 0 is what an allow and
// every degraded run answer with, so a status on its own cannot tell a
// decision from a crash before one; stdout is the decision (hooks.md,
// "PreToolUse decision control").
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = pluginFile('workstreams', 'hooks', 'guard.ts')
const HOOKS_JSON = pluginFile('workstreams', 'hooks', 'hooks.json')
const STDIN_ERROR = path.join(HERE, 'fixtures', 'stdin-error.ts')

/** A `PreToolUse` payload, in the shape hooks.md documents, with `agent_id`
 *  and `agent_type` added only when a case is a subagent's. */
const payload = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/dev/null',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    ...fields,
  })

/** The denial a run wrote, with the contract asserted on the way past. */
const denialIn = (stdout: string): string => {
  const body = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string
      permissionDecision: string
      permissionDecisionReason: string
    }
  }
  expect(body.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
  return body.hookSpecificOutput.permissionDecisionReason
}

it('denies a subagent the background command it asked for', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      agent_type: 'workstreams:stream',
      cwd: sandbox.path,
      tool_input: { command: 'pnpm test', run_in_background: true },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(denialIn(result.stdout)).toContain('subagent workstreams:stream')
  expect(result.stderr).toBe('')
})

it('says nothing at all when the main conversation asks for the same thing', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, {
    stdin: payload({
      cwd: sandbox.path,
      tool_input: { command: 'pnpm test', run_in_background: true },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  // Nothing on stdout is no decision, so the user's own permission rules
  // still decide the call.
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('denies a subagent git checkout with a pathspec on a tree holding uncommitted work', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.dirty(work)

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      agent_type: 'workstreams:stream',
      cwd: work,
      tool_input: { command: 'git checkout -- file.txt' },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  const reason = denialIn(result.stdout)
  expect(reason).toContain(work)
  expect(reason).toContain('1 uncommitted change to tracked files')
  expect(result.stderr).toBe('')
  // The file is still there and still dirty: a PreToolUse hook decides before
  // the tool runs and changes nothing itself.
  expect(readFileSync(path.join(work, 'file.txt'), 'utf8')).toBe('base\ndirty\n')
})

it('allows the same command on a clean tree, in silence', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      agent_type: 'workstreams:stream',
      cwd: work,
      tool_input: { command: 'git restore .' },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('allows a subagent the ordinary commands a layer is built out of', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.dirty(work)

  for (const command of [
    'pnpm test',
    'git status --porcelain',
    'git add -A',
    'git commit -m x',
    // A branch switch, which git itself tells from a path, on a tree this
    // guard has just been taught to protect against `git checkout <path>`.
    'git checkout main',
  ]) {
    const result = runScript(HOOK, {
      stdin: payload({
        agent_id: 'agent_01',
        agent_type: 'workstreams:stream',
        cwd: work,
        tool_input: { command },
      }),
      env: sandbox.env,
    })

    expect({
      command,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ command, status: 0, stdout: '', stderr: '' })
  }
})

it('allows a tool that is not a shell, whatever the matcher lets through', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: 'git restore .' },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('exits 0 in silence when the payload is not a document at all', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, { stdin: 'not json at all', env: sandbox.env })

  expect(result.status).toBe(0)
  // No decision, so the tool call goes on; the account is on stderr, where
  // `claude --debug` keeps it.
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('workstreams guard: payload is not JSON')
})

it('exits 0 in silence on empty stdin, which is a hook run by hand', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, { stdin: '', env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('allowing the tool call')
})

it('allows, and says so on stderr, where git cannot report the tree', () => {
  const sandbox = createSandbox()

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      cwd: sandbox.path,
      tool_input: { command: 'git restore .' },
    }),
    env: sandbox.env,
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('git could not report the state of')
})

it('allows in silence with no git on PATH at all', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.dirty(work)
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('git') }

  const result = runScript(HOOK, {
    stdin: payload({
      agent_id: 'agent_01',
      cwd: work,
      tool_input: { command: 'git restore .' },
    }),
    env,
  })

  // A machine with no git cannot be told its tree is dirty, and a guard that
  // denied on a failed probe would deny every such call.
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('git could not report the state of')
})

it('leaves its account on stderr and still exits 0 when nothing else caught it', () => {
  const sandbox = createSandbox()

  // The one failure the entry point cannot hand to a seam, from inside a
  // process that has it (`src/fixtures/stdin-error.ts`). The promise under
  // test is the outer one: an unforeseen throw still leaves stdout empty, so
  // the tool call proceeds and no session stops for it.
  const result = runScript(STDIN_ERROR, { args: [HOOK], stdin: '', env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('stdin went away mid read')
})

// --- the wiring hooks.json carries -------------------------------------------

it('runs the hook entry with node, behind the silent guard, on both shell tools', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    description: string
    hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
  }
  const entries = config.hooks.PreToolUse

  expect(entries).toHaveLength(1)
  // Both tools: on Windows Claude Code routes shell commands through
  // PowerShell and may not register Bash at all, and "a hook that matches
  // only `Bash` never fires there" (hooks.md, "PowerShell").
  expect(entries[0]?.matcher).toBe('Bash|PowerShell')
  // Spelled in two pieces because biome refuses a `${` inside a plain
  // string, and the value under test is a shell command carrying Claude
  // Code's own expansion rather than a TypeScript template.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    `command -v node >/dev/null 2>&1 && node "${expansion}/hooks/guard.ts"; exit 0`,
  ])
  // Short, because this runs in front of every shell command. A command hook
  // that reaches its timeout does not block the call (hooks.md, "Timeouts"),
  // so the ceiling costs a stalled decision and never a stalled session.
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([10])
  // The description is what a user reads in the plugin listing, and it is
  // still true of what the hook does.
  expect(config.description).toBe(
    'Refuses two things to subagents only: a background command, and a git command that would ' +
      'overwrite uncommitted work in a tracked file (git restore, git checkout with a pathspec ' +
      'written with or without a --, and git checkout or git switch carrying a force, patch or ' +
      '--pathspec-from-file option). The main conversation is never denied.',
  )
})
