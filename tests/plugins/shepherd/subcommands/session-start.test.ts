// The shepherd plugin's `SessionStart` hook, in process. Each case hands
// the command a `FileReads` over a fixed set of paths, so no `PATH` walk
// reads the machine. `../session-start.test.ts` runs the process boundary.
import path from 'node:path'
import { expect, it } from 'vitest'
import { captureOutput } from '#harness/output.ts'
import type { FileReads } from '#shepherd/lib/dependencies.ts'
import { runSessionStart } from '#shepherd/subcommands/session-start.ts'

const BIN = '/stub/bin'
const HOME = '/stub/home'
const STACK = path.join(HOME, '.local', 'share', 'gh', 'extensions', 'gh-stack')
const ENV = { PATH: BIN, HOME }

/** A read that never answers, as a hung filesystem gives. */
const never = (): Promise<never> => new Promise(() => {})

/** `FileReads` that finds each of `present` and nothing else. `stack` is the
 *  extension directory's answer: there, absent, or a read that never ends. */
const reads = (
  present: readonly string[],
  stack: 'there' | 'absent' | 'hangs' = 'there',
): FileReads => ({
  readText: () => Promise.reject(new Error('not read here')),
  canRun: (target) =>
    present.some((tool) => target === path.join(BIN, tool))
      ? Promise.resolve()
      : Promise.reject(new Error(`ENOENT: ${target}`)),
  kindOf: (target) => {
    if (target !== STACK) return Promise.resolve('other')
    if (stack === 'hangs') return never()
    return stack === 'there'
      ? Promise.resolve('directory')
      : Promise.reject(new Error(`ENOENT: ${target}`))
  },
})

/** The run, and what it wrote. */
const run = async (files: FileReads, env: NodeJS.ProcessEnv = ENV, deadlineMs = 2_500) => {
  const output = captureOutput()
  const status = await runSessionStart({
    env,
    output,
    files,
    deadlineMs,
    platform: 'linux',
  })
  return { status, stdout: output.stdout(), stderr: output.stderr() }
}

/** The payload the hook writes, parsed, with the colour codes stripped. */
const payload = (stdout: string) => {
  const parsed = JSON.parse(stdout) as {
    systemMessage: string
    hookSpecificOutput?: { hookEventName: string; additionalContext: string }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the SGR codes colour() writes.
  const plain = parsed.systemMessage.replace(/\u001b\[[0-9;]*m/g, '')
  return {
    lines: plain.split('\n').slice(1),
    context: parsed.hookSpecificOutput?.additionalContext,
    event: parsed.hookSpecificOutput?.hookEventName,
  }
}

it('writes nothing at all when git, gh and the gh stack extension are present', async () => {
  const ran = await run(reads(['git', 'gh']))

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('says the plugin cannot run when git is absent', async () => {
  const ran = await run(reads(['gh']))

  expect(ran.status).toBe(0)
  expect(payload(ran.stdout)).toEqual({
    lines: ['shepherd: ⚠️ git not found on PATH'],
    context: 'git is absent. The shepherd plugin cannot run.',
    event: 'SessionStart',
  })
  expect(ran.stderr).toBe('git not found on PATH\n')
})

it('says the plugin cannot run when gh is absent, and checks the extension no further', async () => {
  const ran = await run(reads(['git'], 'absent'))

  expect(payload(ran.stdout)).toEqual({
    lines: ['shepherd: ⚠️ GitHub CLI (gh) not found on PATH'],
    context: 'GitHub CLI (gh) is absent. The shepherd plugin cannot run.',
    event: 'SessionStart',
  })
  expect(ran.stderr).toBe('GitHub CLI (gh) not found on PATH\n')
})

it('names both tools, in table order, when git and gh are absent', async () => {
  const ran = await run(reads([]))

  expect(payload(ran.stdout)).toEqual({
    lines: ['shepherd: ⚠️ git not found on PATH', 'shepherd: ⚠️ GitHub CLI (gh) not found on PATH'],
    context: 'git, GitHub CLI (gh) are absent. The shepherd plugin cannot run.',
    event: 'SessionStart',
  })
})

it('says the stack merge cannot run when only the gh stack extension is absent', async () => {
  const ran = await run(reads(['git', 'gh'], 'absent'))

  expect(ran.status).toBe(0)
  expect(payload(ran.stdout)).toEqual({
    lines: ['shepherd: ⚠️ gh stack extension not found'],
    context: 'gh stack extension is absent. /shepherd:merge cannot merge a stack.',
    event: 'SessionStart',
  })
  expect(ran.stderr).toBe('gh stack extension not found\n')
})

it('reports an extension read that never answers as could not be checked, with no additionalContext, inside the deadline', async () => {
  const started = performance.now()

  const ran = await run(reads(['git', 'gh'], 'hangs'), ENV, 50)

  expect(performance.now() - started).toBeLessThan(1_000)
  expect(payload(ran.stdout)).toEqual({
    lines: ['shepherd: ⚠️ gh stack extension could not be checked'],
    context: undefined,
    event: undefined,
  })
  expect(ran.stderr).toBe('gh stack extension could not be checked\n')
})

it('reports a home it cannot name as an extension it could not check', async () => {
  const ran = await run(reads(['git', 'gh']), { PATH: BIN })

  expect(payload(ran.stdout).lines).toEqual(['shepherd: ⚠️ gh stack extension could not be checked'])
})

it('finds the gh stack extension under XDG_DATA_HOME before the home', async () => {
  const xdg = '/stub/xdg'
  const files: FileReads = {
    ...reads(['git', 'gh'], 'absent'),
    kindOf: (target) =>
      target === path.join(xdg, 'gh', 'extensions', 'gh-stack')
        ? Promise.resolve('directory')
        : reads(['git', 'gh'], 'absent').kindOf(target),
  }

  const ran = await run(files, { ...ENV, XDG_DATA_HOME: xdg })

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('reports a PATH walk that never answers as could not be checked, never as absent', async () => {
  const hung: FileReads = { ...reads(['git', 'gh']), canRun: () => never() }
  const started = performance.now()

  const ran = await run(hung, ENV, 50)

  expect(performance.now() - started).toBeLessThan(1_000)
  expect(payload(ran.stdout)).toEqual({
    lines: [
      'shepherd: ⚠️ git could not be checked',
      'shepherd: ⚠️ GitHub CLI (gh) could not be checked',
    ],
    context: undefined,
    event: undefined,
  })
})
