// Helpers shared by the hook-io test files. The hook runs in process, with
// real git (`harness/git.ts`) and an injected `gh` double. A fixture repository
// gets a github.com remote URL, and git's `insteadOf` maps that URL back to
// the local bare origin. So the hook reads a GitHub name, and its fetch still
// reaches nothing but the sandbox.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { nodeFileReads } from '#gh/lib/dependencies.ts'
import { type HookEdges, runHookIo } from '#gh/subcommands/hook-io.ts'
import type { GhClient } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { captureOutput } from '#harness/output.ts'
import { createSandbox, findOnPath, type Sandbox } from '#harness/sandbox.ts'

export interface Rig {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
}

export const createRig = (): Rig => {
  const sandbox = createSandbox()
  // A `gh` that always fails comes first on PATH. The hook then finds a
  // GitHub CLI on any machine, and a spawned run never reaches GitHub. An
  // in-process run gets its client from the test, so it never runs this.
  const bin = sandbox.stubPath(sandbox.join('bin-gh'))
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh: stand-in for tests" >&2\nexit 1\n', {
    mode: 0o755,
  })
  return { sandbox, git: createGitFixtures(sandbox) }
}

/**
 * Give `work` the github.com remote URL of `name`, and map that URL back to
 * the bare origin the fixture already has. The hook reads the URL git holds
 * in its configuration, so it sees `name`. `git fetch` applies `insteadOf`,
 * so it still fetches from the sandbox.
 */
export const onGitHub = (rig: Rig, work: string, name: string): string => {
  const bare = rig.git.git(work, 'remote', 'get-url', 'origin')
  const url = `https://github.com/${name}.git`
  rig.git.git(work, 'config', `url.${bare}.insteadOf`, url)
  rig.git.git(work, 'config', 'remote.origin.url', url)
  return work
}

/**
 * Make the fetch of `work` hang until the hook kills it. git's `ext`
 * transport runs a command in place of a server, and `sleep` never answers.
 * So this repository is late for any deadline, however fast the machine is.
 * `sleep` is named by its full path, because a test can run the hook with a
 * PATH that holds only a few tools.
 */
export const hangingFetch = (rig: Rig, work: string): void => {
  const url = rig.git.git(work, 'config', '--get', 'remote.origin.url')
  const bare = rig.git.git(work, 'remote', 'get-url', 'origin')
  rig.git.git(work, 'config', '--unset', `url.${bare}.insteadOf`)
  rig.git.git(work, 'config', 'protocol.ext.allow', 'always')
  const sleep = findOnPath('sleep', rig.sandbox.env.PATH) ?? 'sleep'
  rig.git.git(work, 'config', `url.ext::${sleep} 60.insteadOf`, url)
}

/**
 * A PATH whose `git` runs `script` first, then the real git. `script` is
 * shell `case` arms on `$*`, so an arm can fail, or wait, on one call.
 */
export const wrappedGit = (rig: Rig, name: string, script: string): string => {
  const real = findOnPath('git', rig.sandbox.env.PATH) ?? 'git'
  const bin = rig.sandbox.join(name)
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\ncase "$*" in\n${script}\nesac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  )
  return `${bin}${path.delimiter}${rig.sandbox.env.PATH}`
}

/** A work tree on GitHub as `name`, at `<root>/work`. */
export const githubRepo = (rig: Rig, root: string, name: string): string =>
  onGitHub(rig, rig.git.create(root), name)

/** One repository's GitHub side, as the double answers it. */
export const side = (alerts = 0, dependencies = 0, merged: unknown[] = []) => ({
  alerts,
  dependencies,
  mergedPullRequests: merged as {
    headRefName: string
    headRefOid: string
    isCrossRepository: false
  }[],
})

export interface Ran {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the hook in process with `argv`, and hand back what it wrote. */
export const runHook = async (
  rig: Rig,
  argv: readonly string[],
  gh: GhClient,
  overrides: Partial<HookEdges> = {},
): Promise<Ran> => {
  const output = captureOutput()
  const status = await runHookIo(argv, {
    cwd: () => rig.sandbox.path,
    env: rig.sandbox.env,
    stdin: () => Promise.resolve(''),
    output,
    createGh: () => gh,
    files: nodeFileReads,
    // Far above the 5 s the hook gets in a session. A whole suite of real
    // git at once is slow, and only the deadline tests mean to reach it.
    deadlineMs: 20_000,
    platform: process.platform,
    ...overrides,
  })
  return { status, stdout: output.stdout(), stderr: output.stderr() }
}

/** Run `status <dir>`, and hand back what it wrote. */
export const statusOf = (
  rig: Rig,
  dir: string,
  gh: GhClient,
  overrides: Partial<HookEdges> = {},
): Promise<Ran> => runHook(rig, ['status', dir], gh, overrides)

/** The start of each problem line. */
const PROBLEM = 'gh: ⚠️ '

/**
 * The #230 and #243 acceptance rule for one run of `session-start`:
 * nothing, or one JSON document on one line, with `systemMessage` and,
 * only when a dependency is absent, a `hookSpecificOutput.additionalContext`
 * beside it. `systemMessage` starts with a newline, then at most one status
 * line. Each other line is a problem line, and no kind of problem shows
 * twice.
 */
export const expectStatusLines = (stdout: string): void => {
  if (stdout === '') return
  expect(stdout.endsWith('\n')).toBe(true)
  expect(stdout.slice(0, -1)).not.toContain('\n')
  const body = JSON.parse(stdout) as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual(
    Object.keys(body).includes('hookSpecificOutput')
      ? ['hookSpecificOutput', 'systemMessage']
      : ['systemMessage'],
  )
  if ('hookSpecificOutput' in body) {
    expect(body.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' })
    expect(typeof (body.hookSpecificOutput as Record<string, unknown>).additionalContext).toBe(
      'string',
    )
  }
  expect(typeof body.systemMessage).toBe('string')
  expect(body.systemMessage).toMatch(/^\n/)
  // Colour codes wrap each line; the shape is checked on the text inside them.
  const message = (body.systemMessage as string)
    .slice(1)
    .split('\u001b')
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, '')))
    .join('')
  expect(message).not.toMatch(/[\r\u2028\u2029]/)
  const [first = '', ...rest] = message.split('\n')
  const problems = first.startsWith(PROBLEM) ? [first, ...rest] : rest
  if (!first.startsWith(PROBLEM)) expect(first).toMatch(/^gh: \[[^\n]+\]$/)
  for (const line of problems) expect(line.startsWith(PROBLEM), line).toBe(true)
  // The kind is the fixed text, before a count or a cause.
  const kinds = problems.map(
    (line) => line.slice(PROBLEM.length).split(/: | in [0-9]+ repos?\b/)[0],
  )
  expect(new Set(kinds).size, message).toBe(kinds.length)
}
