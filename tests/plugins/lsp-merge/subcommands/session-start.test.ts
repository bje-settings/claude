// The command function behind the lsp-merge `SessionStart` hook, in
// process. The runner is injected, so no `claude` starts. `which` walks a
// real PATH: a sandbox directory holds an empty executable named `claude`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createSandbox } from '#harness/sandbox.ts'
import type { Runner, RunResult } from '#lsp-merge/lib/process.ts'
import type { Output, Writer } from '#lsp-merge/lib/streams.ts'
import {
  DEADLINE_MS,
  enabledPlugins,
  hasLanguageServer,
  runSessionStart,
} from '#lsp-merge/subcommands/session-start.ts'

const collector = (): Writer & { text: () => string } => {
  const chunks: string[] = []
  return {
    write: (text: string) => {
      chunks.push(text)
    },
    silence: () => {},
    silenced: false,
    text: () => chunks.join(''),
  }
}

const outputPair = () => {
  const out = collector()
  const err = collector()
  const output: Output = { out, err, silence: () => {} }
  return { output, stdout: out.text, stderr: err.text }
}

const result = (reply: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...reply,
})

const listing = (plugins: { id: string; enabled: boolean }[]) => JSON.stringify(plugins)
const details = (servers: number) =>
  `x 0.1.0\n\nComponent inventory\n  Skills (0)\n  LSP servers (${servers})  name\n`

/** A runner that answers from a table keyed by `<command> <args>`. A call
 *  with no entry throws, so a test fails when a call it did not expect
 *  happens. */
const runnerFor = (table: Record<string, Partial<RunResult>>) => {
  const runner: Runner = async (command, args = []) => {
    const reply = table[`${command} ${args.join(' ')}`]
    if (reply === undefined) throw new Error(`unexpected call: ${command} ${args.join(' ')}`)
    return result(reply)
  }
  return runner
}

const VALID = JSON.stringify({
  ts: { command: 'node', extensionToLanguage: { '.ts': 'typescript' } },
})

/** A project with `config` (or none), and a PATH that has `claude` or not. */
const setup = (config: string | undefined, withClaude = true) => {
  const sandbox = createSandbox()
  const project = sandbox.join('project')
  mkdirSync(path.join(project, '.claude'), { recursive: true })
  if (config !== undefined) writeFileSync(path.join(project, '.claude', 'lsp-merge.json'), config)
  const bin = sandbox.join('bin')
  mkdirSync(path.join(bin, 'claude-dir', 'claude'), { recursive: true })
  if (withClaude) writeFileSync(path.join(bin, 'claude'), '', { mode: 0o755 })
  // An empty entry, a directory named `claude`, and a missing directory
  // all come before the real one, and the walk skips each.
  const PATH = ['', path.join(bin, 'claude-dir'), sandbox.join('missing'), bin].join(path.delimiter)
  return { project, env: { PATH, CLAUDE_PROJECT_DIR: project } }
}

const run = async (
  env: NodeJS.ProcessEnv,
  table: Record<string, Partial<RunResult>>,
  cwd = '/nowhere',
) => {
  const { output, stdout, stderr } = outputPair()
  const runner = runnerFor(table)
  const status = await runSessionStart({
    env,
    output,
    run: runner,
    deadlineMs: DEADLINE_MS,
    cwd,
    readFile: (file) => readFileSync(file, 'utf8'),
  })
  return { status, stdout: stdout(), stderr: stderr() }
}

const systemMessage = (stdout: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the colour codes are the point
  (JSON.parse(stdout) as { systemMessage: string }).systemMessage.replace(/\u001b\[\d+m/g, '')

describe('runSessionStart', () => {
  it('writes nothing when claude is there, the config is valid, and no other plugin runs a server', async () => {
    const { env } = setup(VALID)

    const outcome = await run(env, {
      'claude plugin list --json': {
        stdout: listing([
          { id: 'lsp-merge@bje', enabled: true },
          { id: 'gh@bje', enabled: true },
          { id: 'typescript7-lsp@bje', enabled: false },
        ]),
      },
      'claude plugin details gh@bje': { stdout: details(0) },
    })

    expect(outcome).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  it('names every enabled plugin that runs a language server, by count or, failing that, by name', async () => {
    const { env } = setup(VALID)

    const outcome = await run(env, {
      'claude plugin list --json': {
        stdout: listing([
          { id: 'typescript7-lsp@bje', enabled: true },
          { id: 'pyright@other', enabled: true },
          { id: 'biome-lsp@bje', enabled: true },
          { id: 'odd-name@x', enabled: true },
          { id: 'gh@bje', enabled: true },
        ]),
      },
      'claude plugin details typescript7-lsp@bje': { stdout: details(1) },
      'claude plugin details pyright@other': { stdout: details(2) },
      'claude plugin details biome-lsp@bje': { status: null, timedOut: true },
      'claude plugin details odd-name@x': { stdout: 'no inventory here' },
      'claude plugin details gh@bje': { stdout: details(0) },
    })

    const problem =
      'lsp-merge: ⚠️ other language server plugins are enabled: typescript7-lsp@bje, pyright@other, biome-lsp@bje'
    expect(outcome.status).toBe(0)
    expect(systemMessage(outcome.stdout)).toBe(`\n${problem}`)
    expect(JSON.parse(outcome.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext:
        'lsp-merge cannot merge language servers as configured: other language server plugins are enabled: typescript7-lsp@bje, pyright@other, biome-lsp@bje. A file whose extension another plugin claims does not reach lsp-merge.',
    })
    expect(outcome.stderr).toBe(
      'other language server plugins are enabled: typescript7-lsp@bje, pyright@other, biome-lsp@bje\n',
    )
  })

  it('says so when the config is missing, and falls back to the working directory', async () => {
    const { env, project } = setup(undefined)
    const { CLAUDE_PROJECT_DIR: _, ...withoutProject } = env

    const outcome = await run(
      withoutProject,
      { 'claude plugin list --json': { stdout: '[]' } },
      project,
    )

    expect(systemMessage(outcome.stdout)).toBe('\nlsp-merge: ⚠️ .claude/lsp-merge.json is missing')
    expect(outcome.stderr).toContain(`${project}/.claude/lsp-merge.json is missing\n`)
  })

  it('says the config is not valid, and writes each error to stderr', async () => {
    const { env } = setup('{"ts": {"command": ""}}')

    const outcome = await run(env, { 'claude plugin list --json': { stdout: '[]' } })

    expect(systemMessage(outcome.stdout)).toBe('\nlsp-merge: ⚠️ .claude/lsp-merge.json is not valid')
    expect(outcome.stderr).toContain('ts: "command" must be a non-empty string\n')
  })

  it.each([
    ['fails', { status: 1 }],
    ['says something that is not JSON', { stdout: 'nope' }],
    ['says JSON that is not a list', { stdout: '{}' }],
  ])('says the plugins could not be checked when the list %s', async (_, reply) => {
    const { env } = setup(VALID)

    const outcome = await run(env, { 'claude plugin list --json': reply })

    expect(systemMessage(outcome.stdout)).toBe(
      '\nlsp-merge: ⚠️ the enabled plugins could not be checked',
    )
  })

  it('names only the absent claude CLI, and runs nothing else, when claude is not on PATH', async () => {
    const { env } = setup(undefined, false)

    const outcome = await run(env, {})

    expect(systemMessage(outcome.stdout)).toBe(
      '\nlsp-merge: ⚠️ the Claude Code CLI (claude) is absent',
    )
  })

  it('reads a PATH that is not set as one with nothing on it', async () => {
    const outcome = await run({}, {})

    expect(systemMessage(outcome.stdout)).toBe(
      '\nlsp-merge: ⚠️ the Claude Code CLI (claude) is absent',
    )
  })
})

describe('the parsers', () => {
  it('reads the language server count, or null when there is none to read', () => {
    expect(hasLanguageServer(details(1))).toBe(true)
    expect(hasLanguageServer(details(0))).toBe(false)
    expect(hasLanguageServer('Skills (0)')).toBeNull()
  })

  it('keeps only enabled entries with a string id, other than lsp-merge', () => {
    expect(
      enabledPlugins(
        JSON.stringify([
          { id: 'a@x', enabled: true },
          { id: 'b@x', enabled: false },
          { id: 3, enabled: true },
          null,
          { id: 'lsp-merge@bje', enabled: true },
        ]),
      ),
    ).toEqual(['a@x'])
  })
})
