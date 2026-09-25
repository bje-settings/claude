// This file tests the orchestrator against real repositories. It is the
// port of `tests/gh/test_gh_sync.py`.
//
// The parity block compares each scenario's full report with
// `fixtures/bash-sync-output.json`. This fixture came from `gh-sync.sh`,
// before its deletion. Everything above the parity block states a claim.
// The report alone does not prove that claim.
//
// **The stand-in job is the seam.** The Python code copies a script to reach
// this seam. `orchestrator_copy(gh, job=TIMED_JOB)` places a fake
// `gh-sync-repo.py` next to a copy of the orchestrator. This lets the test
// state a job's timing and exit status as a fact, not a hope. In the
// in-process fan-out, the stand-in is a function, and `createSyncCommand`
// takes it as an argument. The test asserts the throttle and the section
// order exactly as before.
//
// The code used to drop the status at this point. Issue #81 (round 7)
// changed that: a throw, or a non-zero answer, now makes the run answer
// `failed`. The section "the exit status" below describes where that fact
// lands.
//
// **Issue #127 deleted the Python code this file ports.**
// `plugins/gh/scripts/*.py`, its `lib/`, `plugins/gh/hooks/hook-io.py`, and
// `tests/gh/` are gone from the tree. The file and line references below
// point to commit `cd0d515`, the last commit that held them. Each reference
// states where a rule came from.
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitCodeFor } from '#gh/lib/envelope.ts'
import { createOutput, type OutputStream } from '#gh/lib/streams.ts'
import { createSyncCommand, runSync } from '#gh/subcommands/sync.ts'
import type { SyncRepoOptions } from '#gh/subcommands/sync-repo.ts'
import { createGhMock, type GhClient } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

export const GOLDEN: Record<string, { status: number; stdout: string }> = JSON.parse(
  read('bash-sync-output.json'),
)

export const PYTHON: Record<
  string,
  Record<string, { status: number; stdout: string; stderr: string }>
> = JSON.parse(read('python-cli-output.json'))

/** This file reads the DIVERGENCES table from a file. It does not write the
 *  table again here. If this port outputs a line that differs from the
 *  Python line, the table must record it first. Only then can a test
 *  assert it. */
export const DIVERGENCES: {
  inProcessFanOut: { now: string }
  failureSummary: { fanOut: string; single: string }
} = JSON.parse(read('divergences.json'))

/** The recorded line for a job that threw, with its placeholder filled in.
 *  The table names the line. The report writes the line with a newline
 *  after it. */
export const failed = (message: string): string =>
  `${DIVERGENCES.inProcessFanOut.now.replace('<message>', message)}\n`

/** The recorded stderr message for a fan-out where one or more repositories
 *  failed (#81), with its placeholders filled in. */
export const fanOutFailed = (failedCount: number, total: number): string =>
  DIVERGENCES.failureSummary.fanOut
    .replace('<n>', String(failedCount))
    .replace('<total>', String(total))

/** The recorded stderr message for the single-repository path when that one
 *  repository's job failed (#81). */
export const singleFailed = (name: string): string =>
  DIVERGENCES.failureSummary.single.replace('<name>', name)

/** A `gh` client with no merged pull requests. Every scenario in this file
 *  matches this case: the reports test branches and discovery, not pull
 *  requests. */
export const ghDouble = (): GhClient => ({
  ...createGhMock({}),
  listMergedPullRequests: async () => [],
})

export function capture() {
  const out: string[] = []
  const err: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })
  return {
    output: createOutput(stream(out), stream(err)),
    stdout: () => out.join(''),
  }
}

export interface Fixture {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
}

export function fixture(): Fixture {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))
  return { sandbox, git, repo, env: sandbox.env }
}

/** Run the command, optionally over a stand-in job. */
export async function run(
  f: Fixture,
  argv: readonly string[],
  options: { job?: (job: SyncRepoOptions) => Promise<number>; cwd?: string } = {},
) {
  const captured = capture()
  const command = options.job === undefined ? runSync : createSyncCommand(options.job)
  const envelope = await command(argv, {
    cwd: options.cwd ?? f.sandbox.path,
    env: f.env,
    output: captured.output,
    createGh: () => ghDouble(),
  })
  return {
    envelope,
    status: exitCodeFor(envelope),
    stdout: captured.stdout(),
    stderr: envelope.outcome === 'ok' ? '' : envelope.error,
  }
}

export function normalise(text: string, sandbox: Sandbox): string {
  let out = text
  for (const spelling of [realpathSync(sandbox.path), sandbox.path]) {
    out = out.split(spelling).join('<sandbox>')
  }
  return out.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
}

/** A job that records when it ran. This lets a test assert the throttle
 *  from the outside, not from a guess based on the output order. This
 *  function is the port of the Python's `TIMED_JOB`. */
export function timedJob(spans: { name: string; start: number; end: number }[], ms: number) {
  return async (options: SyncRepoOptions): Promise<number> => {
    const start = performance.now()
    await new Promise((resolve) => setTimeout(resolve, ms))
    spans.push({ name: path.basename(options.repo), start, end: performance.now() })
    options.report.write(`${path.basename(options.repo)}\n`)
    return 0
  }
}

/** The largest number of spans open at one time. This function reads the
 *  answer from the spans themselves. For each moment a job started, it
 *  counts how many other jobs had started and not yet finished. It does not
 *  count function calls or use a timer. A span already recorded cannot run
 *  again. */
export function mostAtOnce(spans: { start: number; end: number }[]): number {
  return Math.max(
    0,
    ...spans.map(
      (span) => spans.filter((other) => other.start <= span.start && other.end > span.start).length,
    ),
  )
}

/** Do any two of these spans overlap in time? */
export function overlapping(spans: { start: number; end: number }[]): boolean {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  return ordered.some((span, index) => {
    const next = ordered[index + 1]
    return next !== undefined && span.end > next.start
  })
}

// --- parity with the shell version ------------------------------------------------------

/** The scenarios of `tests/gh/test_gh_sync.py`, one for one. */
export const SCENARIOS: Record<string, (f: Fixture) => string[]> = {
  fan_out_two_repos: (f) => {
    f.git.createAt(f.sandbox.join('fan'), 'aaa')
    f.git.createAt(f.sandbox.join('fan'), 'bbb')
    return ['--dry-run', f.sandbox.join('fan')]
  },
  fan_out_pending_deletion: (f) => {
    const work = f.git.createAt(f.sandbox.join('fan'), 'aaa')
    f.git.branchWithWork(work, 'gone')
    f.git.mergeCommit(work, 'gone')
    return ['--dry-run', f.sandbox.join('fan')]
  },
  fan_out_dirty_neighbour: (f) => {
    f.git.createAt(f.sandbox.join('fan'), 'clean')
    const dirty = f.git.createAt(f.sandbox.join('fan'), 'dirty')
    f.git.dirty(dirty)
    return ['--dry-run', f.sandbox.join('fan')]
  },
  no_repositories: (f) => {
    mkdirSync(f.sandbox.join('empty'))
    return ['--dry-run', f.sandbox.join('empty')]
  },
  not_recursive: (f) => {
    f.git.createAt(f.sandbox.join('deep', 'nested'), 'x')
    return ['--dry-run', f.sandbox.join('deep')]
  },
  bare_repository_only: (f) => {
    mkdirSync(f.sandbox.join('bare'))
    f.git.git(f.sandbox.path, 'init', '-q', '--bare', f.sandbox.join('bare', 'thing.git'))
    return ['--dry-run', f.sandbox.join('bare')]
  },
  single_repository: (f) => ['--dry-run', f.repo],
}
