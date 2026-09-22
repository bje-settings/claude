// The preflight command. Every arm in process: the process runner is
// injected, so no `gh` is started and none has to be on the machine, and the
// registry is a real file in a sandbox whose `HOME` is inside it, so the read
// itself, the permission failure and the absent file are all real rather than
// mocked.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import type { Runner, RunResult } from '../lib/process.ts'
import type { Output, Writer } from '../lib/streams.ts'
import { excerpt, type Finding, registryPath, runPreflight } from './preflight.ts'

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

/** What a child that ran and said this would report. */
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

/** A runner answering each `gh` subcommand from a table, and recording what
 *  it was asked. A subcommand with no entry answers as a child that succeeded
 *  and said nothing. */
const runnerFor = (
  table: Record<string, Partial<RunResult>>,
  asked: string[] = [],
): Runner & { asked: string[] } => {
  const runner = async (_command: string, args: readonly string[] = []): Promise<RunResult> => {
    const key = args.join(' ')
    asked.push(key)
    return result(table[key] ?? {})
  }
  return Object.assign(runner, { asked })
}

/** Everything present: gh runs, is logged in, and has the stack extension. */
const HEALTHY: Record<string, Partial<RunResult>> = {
  '--version': { stdout: 'gh version 2.98.0 (2026-08-20)\n' },
  'auth status': { stdout: 'Logged in to github.com\n' },
  'extension list': { stdout: 'gh stack\tgithub/gh-stack\tv0.1.0\n' },
}

/** A sandbox with a registry file written into the `HOME` inside it. */
const withRegistry = (sandbox: Sandbox, contents: string): NodeJS.ProcessEnv => {
  const file = registryPath(sandbox.env)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return sandbox.env
}

const INSTALLED = JSON.stringify({
  version: 1,
  plugins: { 'gh@bje': {}, 'pr-review-toolkit@claude-plugins-official': {} },
})

const run = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  table: Record<string, Partial<RunResult>> = HEALTHY,
) => {
  const output = createOutputPair()
  const status = await runPreflight(argv, { env, output, run: runnerFor(table) })
  return { status, stdout: output.stdout(), stderr: output.stderr() }
}

const findings = (stdout: string): Finding[] =>
  (JSON.parse(stdout) as { missing: Finding[] }).missing

describe('when everything is present', () => {
  it('exits 0 and says so', async () => {
    const sandbox = createSandbox()
    const ran = await run([], withRegistry(sandbox, INSTALLED))

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('everything the workstreams skills depend on is present\n')
    expect(ran.stderr).toBe('')
  })

  it('answers --json with an ok report and no findings', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED))

    expect(ran.status).toBe(0)
    expect(JSON.parse(ran.stdout)).toEqual({ ok: true, missing: [] })
  })
})

describe('the command line', () => {
  it('prints its own usage for --help', async () => {
    const ran = await run(['--help'], createSandbox().env)

    expect(ran.status).toBe(0)
    expect(ran.stdout).toMatch(/^Check what the workstreams skills depend on/)
  })

  it('refuses a flag nobody declared, exit 2, with nothing on stdout', async () => {
    const ran = await run(['--nope'], createSandbox().env)

    expect(ran.status).toBe(2)
    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain('--nope')
  })
})

describe('what gh can be missing', () => {
  it('reports gh itself and stops, rather than asking a missing binary three questions', async () => {
    const sandbox = createSandbox()
    const output = createOutputPair()
    const runner = runnerFor({
      '--version': { status: null, startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' } },
    })
    const status = await runPreflight(['--json'], {
      env: withRegistry(sandbox, INSTALLED),
      output,
      run: runner,
    })

    expect(status).toBe(1)
    expect(findings(output.stdout())).toEqual([
      { id: 'gh', hint: 'install the GitHub CLI: https://cli.github.com' },
    ])
    expect(runner.asked).toEqual(['--version'])
  })

  it('reports a gh that is there and cannot be run, which is the shell’s 126', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      '--version': { status: 126 },
    })

    expect(findings(ran.stdout)[0]?.id).toBe('gh')
  })

  it('reports a gh on PATH that exits 127 for itself the same way', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      '--version': { status: 127 },
    })

    expect(findings(ran.stdout)[0]?.id).toBe('gh')
  })

  it('reports a login that is not there, carrying gh’s own words', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      ...HEALTHY,
      'auth status': { status: 1, stderr: 'You are not logged into any GitHub hosts.\n' },
    })

    expect(ran.status).toBe(1)
    expect(findings(ran.stdout)).toEqual([
      {
        id: 'gh-auth',
        hint: 'gh auth login',
        detail: 'You are not logged into any GitHub hosts.',
      },
    ])
  })

  it('falls back to stdout for a failure that said nothing on stderr', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      ...HEALTHY,
      'auth status': { status: 1, stdout: 'could not reach github.com\n' },
    })

    expect(findings(ran.stdout)[0]?.detail).toBe('could not reach github.com')
  })

  it('reports an extension listing that could not be read, rather than calling the extension absent', async () => {
    // A listing that failed says nothing about which extensions are
    // installed, and telling someone to install one they already have sends
    // them the wrong way.
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      ...HEALTHY,
      'extension list': { status: 1, stderr: 'gh: HTTP 500\n' },
    })

    expect(findings(ran.stdout)).toEqual([
      { id: 'gh-extension-list', hint: 'gh extension list', detail: 'gh: HTTP 500' },
    ])
  })

  it('reports the stack extension as missing when the listing has other extensions but not it', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      ...HEALTHY,
      'extension list': { stdout: 'gh dash\tdlvhdr/gh-dash\tv4.0.0\n' },
    })

    expect(findings(ran.stdout)).toEqual([
      { id: 'gh-stack', hint: 'gh extension install github/gh-stack' },
    ])
  })

  it('accepts the stack extension whatever repository it was installed from', async () => {
    // A fork installed under the same command is the same extension to the
    // skill that runs `gh stack submit`.
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
      ...HEALTHY,
      'extension list': { stdout: '  gh stack\tsomeone/gh-stack-fork\tv9.9.9\n' },
    })

    expect(JSON.parse(ran.stdout)).toEqual({ ok: true, missing: [] })
  })
})

describe('the installed-plugins registry', () => {
  it('reports a plugin the registry does not name under any marketplace', async () => {
    const sandbox = createSandbox()
    const ran = await run(
      ['--json'],
      withRegistry(sandbox, JSON.stringify({ plugins: { 'mermaid@bje': {} } })),
    )

    expect(ran.status).toBe(1)
    expect(findings(ran.stdout)).toEqual([{ id: 'gh', hint: '/plugin install gh@bje' }])
  })

  it('accepts a plugin installed from some other marketplace', async () => {
    // A fork of `gh` under another marketplace is still `gh` to the skill
    // that runs its commands.
    const sandbox = createSandbox()
    const ran = await run(
      ['--json'],
      withRegistry(sandbox, JSON.stringify({ plugins: { 'gh@somewhere-else': {} } })),
    )

    expect(JSON.parse(ran.stdout)).toEqual({ ok: true, missing: [] })
  })

  it('reads a registry file that is not there as nothing installed from it', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], sandbox.env)

    expect(findings(ran.stdout)).toEqual([{ id: 'gh', hint: '/plugin install gh@bje' }])
  })

  it('reports a registry it could not read as itself, not as missing plugins', async () => {
    // The fix is a different one. A permission error reported as two missing
    // plugins sends a reader after the wrong thing entirely.
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, INSTALLED)
    chmodSync(registryPath(env), 0o000)
    const ran = await run(['--json'], env)

    const found = findings(ran.stdout)
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe('registry-unreadable')
    expect(found[0]?.hint).toContain('installed_plugins.json')
    expect(found[0]?.detail).toContain('EACCES')
  })

  it('reports a registry that is not valid JSON as itself', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], withRegistry(sandbox, 'not json at all'))

    const found = findings(ran.stdout)
    expect(found[0]?.id).toBe('registry-unreadable')
    expect(found[0]?.hint).toContain('is not valid JSON')
    expect(found[0]?.detail).not.toBe('')
  })

  for (const [name, body] of [
    ['a document that is not an object', 'null'],
    ['an object with no plugins key', '{"version":1}'],
    ['a plugins key that is a list', '{"plugins":[]}'],
  ] as const) {
    it(`reports ${name} as a registry with no plugins object`, async () => {
      const sandbox = createSandbox()
      const ran = await run(['--json'], withRegistry(sandbox, body))

      expect(findings(ran.stdout)[0]?.hint).toContain('has no plugins object')
    })
  }

  it('says it cannot locate the registry when HOME is not set', async () => {
    // An answer about the session that ran this, rather than a claim about
    // what is installed: a relative path would miss and report every plugin
    // as absent.
    const sandbox = createSandbox()
    const { HOME: _home, ...withoutHome } = sandbox.env
    const ran = await run(['--json'], withoutHome)

    expect(findings(ran.stdout)).toEqual([
      {
        id: 'registry-unreadable',
        hint: 'cannot locate the installed plugins file: HOME is not set',
      },
    ])
  })

  it('treats an empty HOME the same way an unset one is treated', async () => {
    const sandbox = createSandbox()
    const ran = await run(['--json'], { ...sandbox.env, HOME: '' })

    expect(findings(ran.stdout)[0]?.hint).toContain('HOME is not set')
  })

  it('takes the registry path from the override when there is one', async () => {
    const sandbox = createSandbox()
    const file = sandbox.join('elsewhere.json')
    writeFileSync(file, INSTALLED)

    expect(registryPath({ ...sandbox.env, WORKSTREAMS_INSTALLED_PLUGINS: file })).toBe(file)
    expect(registryPath({ ...sandbox.env, WORKSTREAMS_INSTALLED_PLUGINS: '' })).toBe(
      path.join(String(sandbox.env.HOME), '.claude', 'plugins', 'installed_plugins.json'),
    )
  })
})

describe('the report a person reads', () => {
  it('prints one line per finding, with the tool’s own message when there is one', async () => {
    const sandbox = createSandbox()
    const ran = await run([], withRegistry(sandbox, JSON.stringify({ plugins: {} })), {
      ...HEALTHY,
      'auth status': { status: 1, stderr: 'not logged in\n' },
    })

    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe('gh-auth: gh auth login: not logged in\ngh: /plugin install gh@bje\n')
  })
})

describe('excerpt', () => {
  it('puts a multi-line message on one line and bounds its length', async () => {
    expect(excerpt('first\nsecond\n')).toBe('first second')
    expect(excerpt('x'.repeat(400))).toHaveLength(160)
  })
})

it('falls back to stdout for an extension listing that failed silently on stderr', async () => {
  const sandbox = createSandbox()
  const ran = await run(['--json'], withRegistry(sandbox, INSTALLED), {
    ...HEALTHY,
    'extension list': { status: 1, stdout: 'could not read the extension directory\n' },
  })

  expect(findings(ran.stdout)[0]).toEqual({
    id: 'gh-extension-list',
    hint: 'gh extension list',
    detail: 'could not read the extension directory',
  })
})
