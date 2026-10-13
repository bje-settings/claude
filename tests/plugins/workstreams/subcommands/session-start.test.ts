// The command function behind the workstreams `SessionStart` hook. Every
// arm runs in process, with the process runner injected: no `gh` and no
// `claude` binary starts, and neither has to be on the machine. The
// registry is a real file in a sandbox whose `HOME` is inside it, so the
// read itself, the permission failure, and the absent file, are all
// real, rather than mocked.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureOutput } from '#harness/output.ts'
import { runResult, tableRunner } from '#harness/runner.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'
import type { Runner, RunResult } from '#workstreams/lib/process.ts'
import {
  DEADLINE_MS,
  installPathsFor,
  REQUIRED_REVIEWERS,
  registryPath,
  runSessionStart,
} from '#workstreams/subcommands/session-start.ts'

/** A sandbox with a registry file written into the `HOME` inside it. */
const withRegistry = (sandbox: Sandbox, contents: string): NodeJS.ProcessEnv => {
  const file = registryPath(sandbox.env)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return sandbox.env
}

/** A cache copy of `pr-review-toolkit` inside the sandbox, that carries
 *  `agents` and nothing else, and its path. */
const withReviewers = (
  sandbox: Sandbox,
  agents: readonly string[] = REQUIRED_REVIEWERS,
): string => {
  const root = sandbox.join('cache', 'pr-review-toolkit')
  mkdirSync(path.join(root, 'agents'), { recursive: true })
  for (const agent of agents) writeFileSync(path.join(root, 'agents', `${agent}.md`), '---\n')
  return root
}

/** A registry that names `pr-review-toolkit` installed at `roots`. */
const installed = (roots: readonly string[]): string =>
  JSON.stringify({
    version: 2,
    plugins: {
      'pr-review-toolkit@claude-plugins-official': roots.map((installPath) => ({
        scope: 'user',
        installPath,
      })),
    },
  })

/** Everything present: gh is on PATH, `gh auth token` and `gh extension
 *  list` both answer as they do on a healthy machine. */
const HEALTHY: Record<string, Partial<RunResult>> = {
  'gh auth token': { stdout: 'gho_abc123\n' },
  'gh extension list': { stdout: 'gh stack\tgithub/gh-stack\tv0.1.0\n' },
}

/** `text` with `lib/hook-output.ts` `colour`'s SGR codes removed, so an
 *  assertion can read the plain words a person sees, the way a terminal
 *  renders them. `emit`'s own output is JSON, so a control byte reaches
 *  here as the six-character `\u001b` escape `JSON.stringify` writes, not
 *  as one real byte: this parses the JSON first, then strips it from the
 *  decoded string. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the SGR codes colour() writes.
const CONTROL_CODE = /\u001b\[[0-9;]*m/g
const plain = (text: string): string => text.replace(CONTROL_CODE, '')

/** The `systemMessage` `emit` wrote, with no colour, or `""` when there
 *  was nothing to write at all. */
const systemMessageOf = (raw: string): string =>
  raw === '' ? '' : plain((JSON.parse(raw) as { systemMessage: string }).systemMessage)

const run = async (
  env: NodeJS.ProcessEnv,
  table: Record<string, Partial<RunResult>> = HEALTHY,
  procPresent = true,
): Promise<{ status: number; stdout: string; raw: string; stderr: string; asked: string[] }> => {
  const output = captureOutput()
  const runner = tableRunner(table)
  const status = await runSessionStart({
    env,
    output,
    run: runner,
    deadlineMs: DEADLINE_MS,
    procPresent,
  })
  const raw = output.stdout()
  return {
    status,
    stdout: systemMessageOf(raw),
    raw,
    stderr: output.stderr(),
    asked: runner.asked.map((entry) => entry.key),
  }
}

/** Puts a stand-in `gh` ahead of everything else on `env`'s PATH. The
 *  binary itself is never run: the runner is injected, and this only
 *  needs to exist for the PATH walk that answers whether `gh` is there. */
const withGhOnPath = (sandbox: Sandbox, env: NodeJS.ProcessEnv): void => {
  const bin = sandbox.join('bin')
  env.PATH = sandbox.stubPath(bin)
  for (const tool of ['gh', 'pgrep', 'lsof']) {
    writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
}

/** A sandbox with `gh` on PATH, and a registry that carries the reviewer
 *  plugin, so a test about one row does not also trip on the others. */
const healthySandbox = (): { sandbox: Sandbox; env: NodeJS.ProcessEnv } => {
  const sandbox = createSandbox()
  const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
  withGhOnPath(sandbox, env)
  return { sandbox, env }
}

describe('when everything is present', () => {
  it('writes nothing at all', async () => {
    const { env } = healthySandbox()

    const ran = await run(env)

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('')
    expect(ran.stderr).toBe('')
  })
})

describe('gh', () => {
  it('reports gh itself absent, and asks nothing about its login or its extensions', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    env.PATH = sandbox.pathWithout('gh')

    const ran = await run(env)

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('workstreams: ⚠️ the GitHub CLI (gh) is absent')
    expect(ran.asked).toEqual([])
  })

  it('reports gh absent with no PATH at all set, and with PATH set to the empty string', async () => {
    const sandbox = createSandbox()
    const registry = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    const { PATH: _path, ...withoutPath } = registry

    const withNoPath = await run(withoutPath)
    expect(withNoPath.stdout).toContain('workstreams: ⚠️ the GitHub CLI (gh) is absent')

    const withEmptyPath = await run({ ...registry, PATH: '' })
    expect(withEmptyPath.stdout).toContain('workstreams: ⚠️ the GitHub CLI (gh) is absent')
  })

  it('reports a login that is not there, from a local check that never asks GitHub', async () => {
    const { env } = healthySandbox()

    const ran = await run(env, {
      ...HEALTHY,
      'gh auth token': { status: 1, stderr: 'gh: not logged in\n' },
    })

    expect(ran.stdout).toContain('workstreams: ⚠️ a gh login is absent')
    expect(ran.asked).toContain('gh auth token')
  })

  it('reports a timed-out login check as itself, never as an absent login', async () => {
    // A timeout says nothing about whether a login is there. To read it
    // as "absent" would send an already logged-in person to `gh auth
    // login` for no reason. This happens every time the check times out.
    const { env } = healthySandbox()

    const ran = await run(env, {
      ...HEALTHY,
      'gh auth token': { status: null, timedOut: true, signal: 'SIGKILL' },
    })

    expect(ran.stdout).toContain('workstreams: ⚠️ a gh login could not be checked')
    expect(ran.stdout).not.toContain('a gh login is absent')
  })

  it('reports a login check that could not start as itself, never as an absent login', async () => {
    const { env } = healthySandbox()

    const ran = await run(env, {
      ...HEALTHY,
      'gh auth token': { status: 126, startFailure: { code: 'EACCES', message: 'gh: EACCES' } },
    })

    expect(ran.stdout).toContain('workstreams: ⚠️ a gh login could not be checked')
    expect(ran.stdout).not.toContain('a gh login is absent')
  })

  it('reports the stack extension as absent when the listing has other extensions but not it', async () => {
    const { env } = healthySandbox()

    const ran = await run(env, { ...HEALTHY, 'gh extension list': { stdout: 'gh dash\n' } })

    expect(ran.stdout).toContain('workstreams: ⚠️ the gh stack extension is absent')
  })

  it('accepts the stack extension whatever repository it was installed from', async () => {
    const { env } = healthySandbox()

    const ran = await run(env, {
      ...HEALTHY,
      'gh extension list': { stdout: '  gh stack\tsomeone/gh-stack-fork\tv9.9.9\n' },
    })

    expect(ran.stdout).toBe('')
  })

  it('reports a failed extension listing as itself, never as an absent extension', async () => {
    // A listing that failed says nothing about which extensions exist.
    // The deleted `preflight.ts` kept this apart from an absent
    // extension, for the same reason. To tell someone to install an
    // extension they already have sends them the wrong way.
    const { env } = healthySandbox()

    const ran = await run(env, { ...HEALTHY, 'gh extension list': { status: 1 } })

    expect(ran.stdout).toContain('workstreams: ⚠️ the gh stack extension could not be checked')
    expect(ran.stdout).not.toContain('the gh stack extension is absent')
  })

  it('reports a timed-out extension listing as itself, never as an absent extension', async () => {
    const { env } = healthySandbox()

    const ran = await run(env, {
      ...HEALTHY,
      'gh extension list': { status: null, timedOut: true, signal: 'SIGKILL' },
    })

    expect(ran.stdout).toContain('workstreams: ⚠️ the gh stack extension could not be checked')
    expect(ran.stdout).not.toContain('the gh stack extension is absent')
  })
})

describe('the pr-review-toolkit plugin and its reviewers', () => {
  it('reports the plugin absent when the registry names no plugin at all', async () => {
    const { sandbox, env } = healthySandbox()
    withRegistry(sandbox, JSON.stringify({ plugins: {} }))

    const ran = await run(env)

    expect(ran.stdout).toContain('workstreams: ⚠️ the pr-review-toolkit plugin is absent')
  })

  it('accepts a plugin installed from some other marketplace', async () => {
    const sandbox = createSandbox()
    const registry = JSON.stringify({
      plugins: { 'pr-review-toolkit@somewhere-else': [{ installPath: withReviewers(sandbox) }] },
    })
    const env = withRegistry(sandbox, registry)
    withGhOnPath(sandbox, env)

    const ran = await run(env)

    expect(ran.stdout).toBe('')
  })

  it('names each reviewer no installed copy carries', async () => {
    const sandbox = createSandbox()
    const partial = REQUIRED_REVIEWERS.filter((name) => name !== 'type-design-analyzer')
    const env = withRegistry(sandbox, installed([withReviewers(sandbox, partial)]))
    withGhOnPath(sandbox, env)

    const ran = await run(env)

    expect(ran.stdout).toContain(
      "workstreams: ⚠️ pr-review-toolkit's type-design-analyzer agent is absent",
    )
    expect(ran.stdout).not.toContain('code-reviewer')
  })

  it('accepts a reviewer that only one of several installed copies carries', async () => {
    const { sandbox, env } = healthySandbox()
    const partial = sandbox.join('older')
    mkdirSync(path.join(partial, 'agents'), { recursive: true })
    withRegistry(sandbox, installed([partial, withReviewers(sandbox)]))

    const ran = await run(env)

    expect(ran.stdout).toBe('')
  })

  it('reports no copy could be checked, never five missing reviewers, when every recorded path is gone', async () => {
    const { sandbox, env } = healthySandbox()
    withRegistry(sandbox, installed([sandbox.join('cache', 'removed-on-update')]))

    const ran = await run(env)

    expect(ran.stdout).toContain(
      'workstreams: ⚠️ no installed copy of pr-review-toolkit could be checked for its reviewer agents',
    )
    expect(ran.stdout).not.toContain('agent is absent')
  })

  it('asks nothing about reviewers when the plugin that carries them is absent', async () => {
    const { sandbox, env } = healthySandbox()
    withRegistry(sandbox, JSON.stringify({ plugins: {} }))

    const ran = await run(env)

    expect(ran.stdout).not.toContain('reviewer')
  })
})

describe('the installed-plugins registry', () => {
  it('reads a registry file that is not there as nothing installed from it, with no fallback call', async () => {
    const sandbox = createSandbox()
    const env = sandbox.env
    withGhOnPath(sandbox, env)

    const ran = await run(env)

    expect(ran.stdout).toContain('workstreams: ⚠️ the pr-review-toolkit plugin is absent')
    expect(ran.asked).not.toContain('claude plugin list --json')
  })

  it('falls back to claude plugin list --json when the registry file cannot be read', async () => {
    const { sandbox, env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, {
      ...HEALTHY,
      'claude plugin list --json': {
        stdout: JSON.stringify([
          { id: 'pr-review-toolkit@bje', installPath: withReviewers(sandbox) },
        ]),
      },
    })

    expect(ran.stdout).toBe('')
    expect(ran.asked).toContain('claude plugin list --json')
  })

  it('reports the registry as itself, never as missing plugins, when the fallback also fails', async () => {
    const { env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, { ...HEALTHY, 'claude plugin list --json': { status: 1 } })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('workstreams: ⚠️ the installed plugins file could not be read')
    expect(ran.stdout).not.toContain('pr-review-toolkit plugin is absent')
  })

  it('reports a registry that is not valid JSON the same way', async () => {
    const { env } = healthySandbox()
    writeFileSync(registryPath(env), 'not json at all')

    const ran = await run(env, { ...HEALTHY, 'claude plugin list --json': { status: 1 } })

    expect(ran.stdout).toContain('workstreams: ⚠️ the installed plugins file could not be read')
  })
})

describe('additionalContext', () => {
  it('names what is absent and says the workstreams skills cannot run', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    env.PATH = sandbox.pathWithout('gh')

    const ran = await run(env)

    const parsed = JSON.parse(ran.raw) as {
      hookSpecificOutput: { additionalContext: string }
    }
    expect(parsed.hookSpecificOutput.additionalContext).toContain('workstreams skills cannot run')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('the GitHub CLI (gh) is absent')
  })
})

describe('the deadline', () => {
  it('passes the given deadline through to every child it may start', async () => {
    const { env } = healthySandbox()
    const asked: { key: string; options: { timeoutMs?: number } }[] = []
    const output = captureOutput()
    const runner: Runner = async (command, args = [], options = {}) => {
      asked.push({
        key: `${command} ${args.join(' ')}`.trim(),
        options: options as { timeoutMs?: number },
      })
      return runResult(HEALTHY[`${command} ${args.join(' ')}`.trim()] ?? {})
    }

    await runSessionStart({ env, output, run: runner, deadlineMs: 1_234, procPresent: true })

    expect(asked.length).toBeGreaterThan(0)
    for (const call of asked) expect(call.options.timeoutMs).toBe(1_234)
  })

  it('passes the given deadline to the claude plugin list --json fallback too', async () => {
    // The test above never triggers the fallback: `healthySandbox` writes
    // a readable registry, so `readRegistry` never calls `run` at all.
    // This one makes the registry unreadable first, so the only way to
    // answer is the fallback call, and its own deadline is what this
    // checks.
    const { sandbox, env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)
    const output = captureOutput()
    const runner = tableRunner({
      ...HEALTHY,
      'claude plugin list --json': {
        stdout: JSON.stringify([
          { id: 'pr-review-toolkit@bje', installPath: withReviewers(sandbox) },
        ]),
      },
    })

    await runSessionStart({ env, output, run: runner, deadlineMs: 4_321, procPresent: true })

    const fallback = runner.asked.find((call) => call.key === 'claude plugin list --json')
    expect(fallback).toBeDefined()
    expect((fallback?.options as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(4_321)
  })
})

describe('concurrency', () => {
  it('starts every check at once, rather than one after another', async () => {
    // `ghLoggedIn` and `ghStackInstalled` each wait one delay. In
    // sequence that is two delays; at once it is close to one. A revert
    // to sequential `await`s inside `Promise.all` would fail the overlap
    // check below, whatever the machine's own speed.
    const { env } = healthySandbox()
    const output = captureOutput()
    const DELAY_MS = 150
    const windows: { key: string; start: number; end: number }[] = []
    const runner: Runner = async (command, args = []) => {
      const key = `${command} ${args.join(' ')}`.trim()
      const start = Date.now()
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
      windows.push({ key, start, end: Date.now() })
      return runResult(HEALTHY[key] ?? {})
    }

    await runSessionStart({ env, output, run: runner, deadlineMs: DEADLINE_MS, procPresent: true })

    expect(windows.length).toBe(2)
    const [first, second] = windows
    const overlap = first !== undefined && second !== undefined
    expect(overlap).toBe(true)
    if (first !== undefined && second !== undefined) {
      expect(first.start).toBeLessThan(second.end)
      expect(second.start).toBeLessThan(first.end)
    }
  })
})

describe('a claude plugin list --json entry with an id and no installPath', () => {
  it('treats it as a plugin no copy could be checked for, never as absent or a crash', async () => {
    const { env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, {
      ...HEALTHY,
      'claude plugin list --json': {
        stdout: JSON.stringify([{ id: 'pr-review-toolkit@bje' }]),
      },
    })

    expect(ran.stdout).toContain(
      'workstreams: ⚠️ no installed copy of pr-review-toolkit could be checked for its reviewer agents',
    )
    expect(ran.stdout).not.toContain('pr-review-toolkit plugin is absent')
  })
})

describe('the order of reasons', () => {
  it('lists an absent dependency before a problem that could not be checked', async () => {
    // `pathWithout` walks the sandbox's own PATH to find every essential
    // tool it must keep. It has to run before anything narrows that PATH
    // to a stub directory, so this builds the sandbox by hand rather than
    // through `healthySandbox`, the same way the `gh` tests above do.
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    env.PATH = sandbox.pathWithout('gh')
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, { ...HEALTHY, 'claude plugin list --json': { status: 1 } })

    const gh = ran.stdout.indexOf('the GitHub CLI (gh) is absent')
    const registry = ran.stdout.indexOf('the installed plugins file could not be read')
    expect(gh).toBeGreaterThanOrEqual(0)
    expect(registry).toBeGreaterThan(gh)
  })
})

describe('registryPath', () => {
  it('takes the path from the override when there is one', () => {
    const sandbox = createSandbox()
    const file = sandbox.join('elsewhere.json')

    expect(registryPath({ ...sandbox.env, WORKSTREAMS_INSTALLED_PLUGINS: file })).toBe(file)
    expect(registryPath({ ...sandbox.env, WORKSTREAMS_INSTALLED_PLUGINS: '' })).toBe(
      path.join(String(sandbox.env.HOME), '.claude', 'plugins', 'installed_plugins.json'),
    )
  })

  it('answers "" for an unset or an empty HOME', () => {
    const sandbox = createSandbox()
    const { HOME: _home, ...withoutHome } = sandbox.env

    expect(registryPath(withoutHome)).toBe('')
    expect(registryPath({ ...sandbox.env, HOME: '' })).toBe('')
  })
})

describe('installPathsFor', () => {
  it('reads one install path named twice as one place to look, and skips a malformed entry', () => {
    const paths = installPathsFor(
      {
        'pr-review-toolkit@x': [
          { installPath: '/a' },
          { installPath: '/a' },
          null,
          '/not-an-object',
          { scope: 'user' },
        ],
        'pr-review-toolkit@y': 'not a list',
        'gh@bje': [{ installPath: '/somewhere-else' }],
      },
      'pr-review-toolkit',
    )

    expect(paths).toEqual(['/a'])
  })
})

describe('pgrep and lsof', () => {
  /** A healthy sandbox whose PATH lacks the tools in `tools`. */
  const without = (...tools: string[]): NodeJS.ProcessEnv => {
    const { sandbox, env } = healthySandbox()
    for (const tool of tools) rmSync(path.join(sandbox.join('bin'), tool))
    return env
  }

  it('reports an absent pgrep in one line that names it', async () => {
    const ran = await run(without('pgrep'))

    expect(ran.stdout).toBe('\nworkstreams: ⚠️ pgrep is absent')
    expect(ran.stderr).toBe('pgrep is absent\n')
  })

  it('reports an absent pgrep even when /proc is there', async () => {
    const ran = await run(without('pgrep', 'lsof'), HEALTHY, true)

    expect(ran.stdout).toBe('\nworkstreams: ⚠️ pgrep is absent')
  })

  it('asks for no lsof row when /proc is there', async () => {
    const ran = await run(without('lsof'), HEALTHY, true)

    expect(ran.stdout).toBe('')
    expect(ran.stderr).toBe('')
  })

  it('reports an absent lsof in one line that names it when /proc is not there', async () => {
    const ran = await run(without('lsof'), HEALTHY, false)

    expect(ran.stdout).toBe('\nworkstreams: ⚠️ lsof is absent')
  })

  it('accepts lsof on PATH when /proc is not there', async () => {
    const ran = await run(without(), HEALTHY, false)

    expect(ran.stdout).toBe('')
  })
})

describe('gh on a PATH entry that is a directory named gh', () => {
  it('does not read the directory as the tool', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    const bin = sandbox.join('bin')
    mkdirSync(path.join(bin, 'gh'), { recursive: true })
    env.PATH = sandbox.stubPath(bin)

    const ran = await run(env)

    expect(ran.stdout).toContain('workstreams: ⚠️ the GitHub CLI (gh) is absent')
  })
})

describe('gh on PATH: the walk past entries that do not count', () => {
  const ABSENT = 'workstreams: ⚠️ the GitHub CLI (gh) is absent'
  const stubbed = (sandbox: Sandbox, name: string, mode: number): string => {
    const dir = sandbox.join(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode })
    return dir
  }

  it('reads a file that is not executable as absent', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    env.PATH = stubbed(sandbox, 'plain', 0o644)

    expect((await run(env)).stdout).toContain(ABSENT)
  })

  it('walks past a directory and a plain file to a later executable', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    mkdirSync(sandbox.join('dir', 'gh'), { recursive: true })
    const listed = [
      sandbox.join('dir'),
      stubbed(sandbox, 'plain', 0o644),
      stubbed(sandbox, 'real', 0o755),
      sandbox.join('nowhere'),
    ]
    env.PATH = listed.join(path.delimiter)

    expect((await run(env)).stdout).not.toContain(ABSENT)
  })

  it('reads an empty PATH entry as the cwd', async () => {
    const sandbox = createSandbox()
    const env = withRegistry(sandbox, installed([withReviewers(sandbox)]))
    const bin = stubbed(sandbox, 'cwd', 0o755)
    env.PATH = `${path.delimiter}${sandbox.join('nowhere')}`
    const before = process.cwd()
    process.chdir(bin)
    try {
      expect((await run(env)).stdout).not.toContain(ABSENT)
    } finally {
      process.chdir(before)
    }
  })
})

describe('HOME unset entirely', () => {
  it('falls back to claude plugin list --json, with no file to read at all', async () => {
    const sandbox = createSandbox()
    const { HOME: _home, ...withoutHome } = sandbox.env
    withGhOnPath(sandbox, withoutHome)

    const ran = await run(withoutHome, {
      ...HEALTHY,
      'claude plugin list --json': {
        stdout: JSON.stringify([
          { id: 'pr-review-toolkit@bje', installPath: withReviewers(sandbox) },
        ]),
      },
    })

    expect(ran.stdout).toBe('')
    expect(ran.asked).toContain('claude plugin list --json')
  })
})

describe('a registry file that reads as JSON but not as plugins', () => {
  for (const [name, body] of [
    ['a document that is not an object', 'null'],
    ['an object with no plugins key', '{"version":1}'],
    ['a plugins key that is a list', '{"plugins":[]}'],
  ] as const) {
    it(`falls back to claude plugin list --json for ${name}`, async () => {
      const { sandbox, env } = healthySandbox()
      writeFileSync(registryPath(env), body)

      const ran = await run(env, {
        ...HEALTHY,
        'claude plugin list --json': {
          stdout: JSON.stringify([
            { id: 'pr-review-toolkit@bje', installPath: withReviewers(sandbox) },
          ]),
        },
      })

      expect(ran.stdout).toBe('')
      expect(ran.asked).toContain('claude plugin list --json')
    })
  }
})

describe('a claude plugin list --json that cannot be read as an answer', () => {
  it('reports the registry as itself for a reply that is not JSON', async () => {
    const { env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, { ...HEALTHY, 'claude plugin list --json': { stdout: 'not json' } })

    expect(ran.stdout).toContain('workstreams: ⚠️ the installed plugins file could not be read')
  })

  it('reports the registry as itself for a reply that is not a list', async () => {
    const { env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, {
      ...HEALTHY,
      'claude plugin list --json': { stdout: JSON.stringify({ not: 'a list' }) },
    })

    expect(ran.stdout).toContain('workstreams: ⚠️ the installed plugins file could not be read')
  })

  it('skips an entry with no id, or that is not an object, without failing the read', async () => {
    const { sandbox, env } = healthySandbox()
    chmodSync(registryPath(env), 0o000)

    const ran = await run(env, {
      ...HEALTHY,
      'claude plugin list --json': {
        stdout: JSON.stringify([
          null,
          { installPath: '/no-id' },
          { id: 'pr-review-toolkit@bje', installPath: withReviewers(sandbox) },
        ]),
      },
    })

    expect(ran.stdout).toBe('')
  })
})
