// Helpers shared by the hook-io test files. The hook runs in process, with
// real git (`harness/git.ts`) and an injected `gh` double. A fixture repository
// gets a github.com remote URL, and git's `insteadOf` maps that URL back to
// the local bare origin. So the hook reads a GitHub name, and its fetch still
// reaches nothing but the sandbox.
import { expect } from 'vitest'
import type { Output, Writer } from '#gh/lib/streams.ts'
import { type HookEdges, runHookIo } from '#gh/subcommands/hook-io.ts'
import type { GhClient } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

/** A writer that keeps whatever text it receives. */
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

export const createOutputPair = (): Output & { stdout: () => string; stderr: () => string } => {
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

export interface Rig {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
}

export const createRig = (): Rig => {
  const sandbox = createSandbox()
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
 */
export const hangingFetch = (rig: Rig, work: string): void => {
  const url = rig.git.git(work, 'config', '--get', 'remote.origin.url')
  const bare = rig.git.git(work, 'remote', 'get-url', 'origin')
  rig.git.git(work, 'config', '--unset', `url.${bare}.insteadOf`)
  rig.git.git(work, 'config', 'protocol.ext.allow', 'always')
  rig.git.git(work, 'config', 'url.ext::sleep 60.insteadOf', url)
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
  const output = createOutputPair()
  const status = await runHookIo(argv, {
    cwd: () => rig.sandbox.path,
    env: rig.sandbox.env,
    stdin: () => Promise.resolve(''),
    output,
    createGh: () => gh,
    // Far above the 5 s the hook gets in a session. A whole suite of real
    // git at once is slow, and only the deadline tests mean to reach it.
    deadlineMs: 20_000,
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

/** The #230 acceptance rule for one run of `session-start`: at most one line
 *  in `systemMessage`, and no `additionalContext` at all. */
export const expectOneLine = (stdout: string): void => {
  if (stdout === '') return
  expect(stdout.endsWith('\n')).toBe(true)
  expect(stdout.slice(0, -1)).not.toContain('\n')
  const body = JSON.parse(stdout) as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['systemMessage'])
  expect(typeof body.systemMessage).toBe('string')
  expect(body.systemMessage as string).not.toMatch(/[\r\n\u2028\u2029]/)
}
