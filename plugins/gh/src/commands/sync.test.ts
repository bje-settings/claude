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
import { describe, expect, it } from 'vitest'
import { createGhMock, type GhClient } from '../../../../harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '../../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { exitCodeFor } from '../lib/envelope.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import { createSyncCommand, parseSyncArgs, runSync } from './sync.ts'
import type { SyncRepoOptions } from './sync-repo.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

const GOLDEN: Record<string, { status: number; stdout: string }> = JSON.parse(
  read('bash-sync-output.json'),
)

const PYTHON: Record<
  string,
  Record<string, { status: number; stdout: string; stderr: string }>
> = JSON.parse(read('python-cli-output.json'))

/** This file reads the DIVERGENCES table from a file. It does not write the
 *  table again here. If this port outputs a line that differs from the
 *  Python line, the table must record it first. Only then can a test
 *  assert it. */
const DIVERGENCES: {
  inProcessFanOut: { now: string }
  failureSummary: { fanOut: string; single: string }
} = JSON.parse(read('divergences.json'))

/** The recorded line for a job that threw, with its placeholder filled in.
 *  The table names the line. The report writes the line with a newline
 *  after it. */
const failed = (message: string): string =>
  `${DIVERGENCES.inProcessFanOut.now.replace('<message>', message)}\n`

/** The recorded stderr message for a fan-out where one or more repositories
 *  failed (#81), with its placeholders filled in. */
const fanOutFailed = (failedCount: number, total: number): string =>
  DIVERGENCES.failureSummary.fanOut
    .replace('<n>', String(failedCount))
    .replace('<total>', String(total))

/** The recorded stderr message for the single-repository path when that one
 *  repository's job failed (#81). */
const singleFailed = (name: string): string =>
  DIVERGENCES.failureSummary.single.replace('<name>', name)

/** A `gh` client with no merged pull requests. Every scenario in this file
 *  matches this case: the reports test branches and discovery, not pull
 *  requests. */
const ghDouble = (): GhClient => ({
  ...createGhMock({}),
  listMergedPullRequests: async () => [],
})

function capture() {
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

interface Fixture {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly repo: string
  readonly env: NodeJS.ProcessEnv
}

function fixture(): Fixture {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const repo = git.create(sandbox.join('r'))
  return { sandbox, git, repo, env: sandbox.env }
}

/** Run the command, optionally over a stand-in job. */
async function run(
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

function normalise(text: string, sandbox: Sandbox): string {
  let out = text
  for (const spelling of [realpathSync(sandbox.path), sandbox.path]) {
    out = out.split(spelling).join('<sandbox>')
  }
  return out.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
}

/** A job that records when it ran. This lets a test assert the throttle
 *  from the outside, not from a guess based on the output order. This
 *  function is the port of the Python's `TIMED_JOB`. */
function timedJob(spans: { name: string; start: number; end: number }[], ms: number) {
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
function mostAtOnce(spans: { start: number; end: number }[]): number {
  return Math.max(
    0,
    ...spans.map(
      (span) => spans.filter((other) => other.start <= span.start && other.end > span.start).length,
    ),
  )
}

/** Do any two of these spans overlap in time? */
function overlapping(spans: { start: number; end: number }[]): boolean {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  return ordered.some((span, index) => {
    const next = ordered[index + 1]
    return next !== undefined && span.end > next.start
  })
}

// --- the command line ----------------------------------------------------------

describe('the command line', () => {
  it('rejects a zero -j rather than spinning forever', async () => {
    const f = fixture()

    const result = await run(f, ['-j', '0', f.sandbox.path])

    expect(result.status).toBe(2)
    // This test compares the port's own output to the captured Python
    // output. It does not compare both to the same literal string. An
    // assertion that restates the string a third time could never fail from
    // a change to the port. The newline comes from the Python script. The
    // envelope leaves the newline to the entry point.
    expect(`${result.stderr}\n`).toBe(PYTHON.sync?.zero_jobs?.stderr)
  })

  it('rejects a non-numeric -j', async () => {
    const f = fixture()

    const result = await run(f, ['-j', 'four', f.sandbox.path])

    expect(result.status).toBe(2)
    expect(`${result.stderr}\n`).toBe(PYTHON.sync?.non_numeric_jobs?.stderr)
  })

  it('rejects an unknown flag', async () => {
    const f = fixture()

    const result = await run(f, ['--nope', f.sandbox.path])

    expect(result.status).toBe(2)
    expect(`${result.stderr}\n`).toBe(PYTHON.sync?.unknown_flag?.stderr)
  })

  it('accepts the attached -j4 form as well as -j 4', () => {
    const attached = parseSyncArgs(['-j2', '/somewhere'])
    const spaced = parseSyncArgs(['-j', '2', '/somewhere'])

    expect(
      attached.outcome === 'ok' && attached.value.kind === 'run' && attached.value.request,
    ).toEqual(spaced.outcome === 'ok' && spaced.value.kind === 'run' && spaced.value.request)
  })

  it('reads a bare -j at the end as no value at all, not as an invalid one', () => {
    const parsed = parseSyncArgs(['/somewhere', '-j'])

    expect(
      parsed.outcome === 'ok' && parsed.value.kind === 'run' && parsed.value.request.jobs,
    ).toBe(4)
  })

  it('takes whatever follows -j, as the Python does', () => {
    // `rest.pop(0)` takes the next token, whatever it is. A flag placed
    // after `-j` becomes its value. The refusal names the value, not the
    // flag.
    const parsed = parseSyncArgs(['-j', '--dry-run', '/somewhere'])

    expect(parsed.outcome).toBe('refused')
    expect(parsed.outcome === 'refused' && parsed.error).toBe('invalid -j value: --dry-run')
  })

  it('prints usage for --help without leaking code', async () => {
    const f = fixture()

    const result = await run(f, ['--help'])

    expect(result.status).toBe(0)
    expect(result.envelope.outcome === 'ok' && result.envelope.value).toContain('Usage:')
    expect(PYTHON.sync?.help?.stdout).toContain('Usage:')
  })

  it('rejects a target that is not a directory', async () => {
    const f = fixture()

    const result = await run(f, [f.sandbox.join('nothing-here')])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`not a directory: ${f.sandbox.join('nothing-here')}`)
    // This test compares the port's output to the captured Python output,
    // not the capture to a literal string. The Python refused the same name
    // from the same sandbox. So the two values compare directly once the
    // test normalises the sandbox path. The exact path spelling is part of
    // what parity means here. The capture keeps the trailing newline that
    // `print` adds.
    expect(normalise(`${result.stderr}\n`, f.sandbox)).toBe(PYTHON.sync?.not_a_directory?.stderr)
  })

  it('takes the working directory as the scope when no target is given', async () => {
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')

    const result = await run(f, ['--dry-run'], { cwd: f.sandbox.join('fan') })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('(1 repos)')
  })
})

// --- scope detection --------------------------------------------------------------

describe('the scope', () => {
  it('syncs the current repository when the target is a git repo', async () => {
    const f = fixture()

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already up to date')
    // No header: a single repository reports for itself.
    expect(result.stdout).not.toContain('repos)')
  })

  it('fans out over immediate subdirectories that are git repos', async () => {
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.createAt(f.sandbox.join('fan'), 'b')

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.stdout).toContain('(2 repos)')
    expect(result.stdout).toContain('already up to date')
  })

  it('does not recurse: a repo two levels down is out of scope', async () => {
    const f = fixture()
    f.git.createAt(f.sandbox.join('deep', 'nested'), 'x')

    const result = await run(f, ['--dry-run', f.sandbox.join('deep')])

    expect(result.stdout).toContain('No git repositories directly inside')
  })

  it('ignores a bare repository, which has no work tree to sync', async () => {
    const f = fixture()
    mkdirSync(f.sandbox.join('bare'))
    f.git.git(f.sandbox.path, 'init', '-q', '--bare', f.sandbox.join('bare', 'thing.git'))

    const result = await run(f, ['--dry-run', f.sandbox.join('bare')])

    expect(result.stdout).toContain('No git repositories directly inside')
  })

  it('refuses when git is not installed, rather than reporting no repositories', async () => {
    // Discovery asks git a question. It answers "no" when it cannot ask git
    // at all. Without this check, a machine with no git hears that it has
    // no repositories. That answer is wrong. It is a wiring mistake, not the
    // true answer to the question.
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')
    const withoutGit = { ...f, env: { ...f.env, PATH: f.sandbox.pathWithout('git') } }

    const result = await run(withoutGit, [f.sandbox.join('fan')])

    expect(result.status).toBe(2)
    expect(result.stdout).not.toContain('No git repositories')
    expect(`${result.stderr}\n`).toBe(PYTHON.sync?.missing_git?.stderr)
  })

  it('refuses a target it cannot read, which is not a target with nothing in it', async () => {
    const f = fixture()
    const blocked = f.sandbox.join('blocked')
    mkdirSync(blocked)
    const { chmodSync } = await import('node:fs')
    chmodSync(blocked, 0o000)
    try {
      const result = await run(f, ['--dry-run', blocked])

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('could not read')
      expect(result.stdout).not.toContain('No git repositories')
      expect(PYTHON.sync?.unreadable_target?.stderr).toContain('could not read ')
    } finally {
      chmodSync(blocked, 0o700)
    }
  })
})

// --- the report ----------------------------------------------------------------------

describe('the report', () => {
  it('reports each repository in directory order regardless of finish order', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    // The first job takes the longest, so a report written in finish order
    // would put it last.
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      await new Promise((resolve) => setTimeout(resolve, name === 'aaa' ? 60 : 0))
      options.report.write(`${name}\n`)
      return 0
    }

    const result = await run(f, ['--dry-run', '-j', '3', f.sandbox.join('fan')], { job })

    expect(result.stdout).toContain('(3 repos)')
    const positions = ['aaa', 'bbb', 'ccc'].map((name) => result.stdout.indexOf(name))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('keeps every repository’s lines together while jobs run concurrently', async () => {
    // The stand-in writes its section in two halves, with a sleep between
    // them. With two jobs that run at once, the halves of two repositories
    // write at the same time. A fan-out that passed a job's output through
    // as it arrived would split a section in half, every run. The recorded
    // spans prove that two jobs really did overlap. A run that never truly
    // overlaps cannot pass this test.
    const f = fixture()
    const names = ['aaa', 'bbb', 'ccc', 'ddd']
    for (const name of names) f.git.createAt(f.sandbox.join('fan'), name)
    const spans: { name: string; start: number; end: number }[] = []
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      const start = performance.now()
      options.report.write(`${name}\n  first half of ${name}\n`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      options.report.write(`  second half of ${name}\n`)
      spans.push({ name, start, end: performance.now() })
      return 0
    }

    const result = await run(f, ['-j', '2', f.sandbox.join('fan')], { job })

    expect(overlapping(spans)).toBe(true)
    const sections = names
      .map((name) => `${name}\n  first half of ${name}\n  second half of ${name}\n`)
      .join('')
    expect(result.stdout).toBe(`${realpathSync(f.sandbox.join('fan'))} (4 repos)\n\n${sections}`)
  })

  it('says so when a directory holds no git repositories', async () => {
    const f = fixture()
    mkdirSync(f.sandbox.join('empty'))

    const result = await run(f, ['--dry-run', f.sandbox.join('empty')])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      `No git repositories directly inside ${realpathSync(f.sandbox.join('empty'))}\n`,
    )
  })
})

// --- the throttle -------------------------------------------------------------------

describe('the throttle', () => {
  it('throttles to one job at a time', async () => {
    const f = fixture()
    for (const name of ['a', 'b', 'c']) f.git.createAt(f.sandbox.join('fan'), name)
    const spans: { name: string; start: number; end: number }[] = []

    const result = await run(f, ['-j', '1', f.sandbox.join('fan')], {
      job: timedJob(spans, 40),
    })

    expect(result.status).toBe(0)
    expect(spans.map((span) => span.name).sort()).toEqual(['a', 'b', 'c'])
    expect(overlapping(spans)).toBe(false)
  })

  it('runs jobs concurrently when allowed, so -j is a throttle and not a queue', async () => {
    const f = fixture()
    for (const name of ['a', 'b', 'c']) f.git.createAt(f.sandbox.join('fan'), name)
    const spans: { name: string; start: number; end: number }[] = []

    const result = await run(f, ['-j', '3', f.sandbox.join('fan')], {
      job: timedJob(spans, 40),
    })

    expect(result.status).toBe(0)
    expect(overlapping(spans)).toBe(true)
  })

  it('never runs more than -j at once, which is the half overlap does not prove', async () => {
    // `overlapping` above proves the throttle is not a queue. It does not
    // prove the code is a throttle. A fan-out that ignored `-j` entirely and
    // started every job would also satisfy it. This test needs both halves.
    // The recorded spans already carry the answer. This test costs no new
    // timing.
    const f = fixture()
    for (const name of ['a', 'b', 'c', 'd', 'e']) f.git.createAt(f.sandbox.join('fan'), name)
    const spans: { name: string; start: number; end: number }[] = []

    const result = await run(f, ['-j', '2', f.sandbox.join('fan')], {
      job: timedJob(spans, 40),
    })

    expect(result.status).toBe(0)
    expect(spans).toHaveLength(5)
    expect(mostAtOnce(spans)).toBe(2)
  })
})

// --- fan-out safety -------------------------------------------------------------------

describe('the fan-out', () => {
  it('keeps every other repository when one job throws', async () => {
    // `gh-sync.py:123` to `:135` state this same rule. A job that raises
    // "would otherwise raise out of the pool and take every other
    // repository's report with it. It is this repo's answer, not the run's."
    // A direct call cannot fail to start, but it can still throw. `syncRepo`
    // deliberately lets anything that is not a `GhError` pass through
    // uncaught. When that happens, the run discards the header and every
    // finished section after the work finishes.
    const f = fixture()
    for (const name of ['a', 'b', 'c']) f.git.createAt(f.sandbox.join('fan'), name)

    const result = await run(f, [f.sandbox.join('fan')], {
      job: async (options: SyncRepoOptions): Promise<number> => {
        const name = path.basename(options.repo)
        if (name === 'b') throw new Error('boom')
        options.report.write(`${name}\n`)
        return 0
      },
    })

    // Issue #81 (round 7) made one job's throw set the run's answer to
    // `failed`. The section "the exit status" below describes the exit-1
    // contract. This test itself is about the report, not the exit code.
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('a\n')
    expect(result.stdout).toContain('c\n')
    // This assertion checks the whole section, not just one line. `b`
    // threw before it wrote its own heading. A bare failure line would then
    // sit under `a`'s heading, and wrongly blame a repository that synced
    // cleanly. `gh-sync.py:135` puts the basename in the same string, for
    // the child that never ran.
    expect(result.stdout).toContain(`b\n${failed('boom')}`)
    expect(result.stdout).not.toContain(`a\n${failed('boom')}`)
  })

  it('puts a failure that arrived mid-line on a line of its own', async () => {
    // `gh-sync.py:171` to `:173`: this rule matters for a section with no
    // trailing newline. Without it, the failure text would append to the
    // end of the last line.
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.createAt(f.sandbox.join('fan'), 'b')

    const result = await run(f, [f.sandbox.join('fan')], {
      job: async (options: SyncRepoOptions): Promise<number> => {
        const name = path.basename(options.repo)
        options.report.write(name === 'a' ? 'half a line' : `${name}\n`)
        if (name === 'a') throw new Error('boom')
        return 0
      },
    })

    expect(result.stdout).toContain(`half a line\n${failed('boom')}`)
  })

  it('adds no blank line when the job threw on a line boundary', async () => {
    // This is the third arm of `gh-sync.py:172`'s `if output and not
    // output.endswith("\n")` check. A section that already ends in a
    // newline needs no extra heading, since it has one. It needs no
    // separator either. A blank line between the last report line and the
    // failure would be a gap. The Python version never printed that gap.
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.createAt(f.sandbox.join('fan'), 'b')

    const result = await run(f, [f.sandbox.join('fan')], {
      job: async (options: SyncRepoOptions): Promise<number> => {
        const name = path.basename(options.repo)
        options.report.write(`${name}\n`)
        if (name === 'a') throw new Error('boom')
        return 0
      },
    })

    expect(result.stdout).toContain(`a\n${failed('boom')}`)
    expect(result.stdout).not.toContain(`a\n\n${failed('boom')}`)
  })

  it('says so on the single-repository path too, rather than crashing the run', async () => {
    // This path has no section to fold the failure into. `gh-sync.py:245`
    // to `:251` handles this the same way, for a child that could not
    // start. Issue #81 (round 7) changed this: the run no longer drops the
    // status. The report stays the same, but now the run also answers
    // `failed`.
    //
    // This test throws a bare value, not an `Error`. A rejected promise may
    // carry a bare value like this. The Python code never had to handle
    // this case, because `str(error)` there always had something to print.
    // The port instead prints exactly what arrived, instead of `undefined`.
    const f = fixture()
    const work = f.git.createAt(f.sandbox.join('one'), 'only')
    const notAnError: unknown = 'boom'

    const result = await run(f, [work], {
      job: async (): Promise<number> => {
        throw notAnError
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe(failed('boom'))
    expect(result.stderr).toBe(singleFailed(path.basename(work)))
  })

  it('mutates nothing in --dry-run', async () => {
    const f = fixture()
    const work = f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.branchWithWork(work, 'gone')
    f.git.mergeCommit(work, 'gone')
    const before = f.git.branches(work)

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.stdout).toContain('would delete gone')
    expect(f.git.branches(work)).toEqual(before)
  })

  it('skips a dirty repository but still syncs its clean neighbours', async () => {
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'clean')
    const dirty = f.git.createAt(f.sandbox.join('fan'), 'dirty')
    f.git.dirty(dirty)

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.stdout).toContain('skipped: uncommitted changes')
    expect(result.stdout).toContain('already up to date')
  })

  it('passes --no-install through to the jobs', async () => {
    const f = fixture()
    const work = f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.lockfile(work, 'pnpm-lock.yaml')
    f.git.remoteAdvance(work, 'pnpm-lock.yaml')

    const result = await run(f, ['--dry-run', '--no-install', f.sandbox.join('fan')])

    expect(result.stdout).not.toContain('lock file changed')
  })

  it('reports the install on the same state without the flag', async () => {
    const f = fixture()
    const work = f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.lockfile(work, 'pnpm-lock.yaml')
    f.git.remoteAdvance(work, 'pnpm-lock.yaml')

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.stdout).toContain('lock file changed')
  })

  it('hands each job its own writer, so one job cannot silence another', async () => {
    const f = fixture()
    for (const name of ['a', 'b']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      if (name === 'a') options.report.silence()
      options.report.write(`${name}\n`)
      return 0
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.stdout).toContain('b\n')
    expect(result.stdout).not.toContain('a\n')
  })
})

// --- the exit status (#81) -----------------------------------------------------------

describe('the exit status', () => {
  it('exits 1 on the single-repository path when the job throws', async () => {
    const f = fixture()

    const result = await run(f, [f.repo], {
      job: async (): Promise<number> => {
        throw new Error('boom')
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe(failed('boom'))
    expect(result.stderr).toBe(singleFailed(path.basename(f.repo)))
  })

  it('exits 1 on the single-repository path when the job answers non-zero without throwing', async () => {
    const f = fixture()

    const result = await run(f, [f.repo], { job: async () => 9 })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('exited with status 9')
    expect(result.stderr).toBe(singleFailed(path.basename(f.repo)))
  })

  it('exits 0 on the single-repository path when the job answers 0', async () => {
    const f = fixture()

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('exits 0 on the single-repository path for a skipped repository, with the real job', async () => {
    // This test uses the real `syncRepo`, not a stand-in. A skip is not a
    // failure, and that fact has not changed. `sync-repo.ts` always answers
    // 0 for one repository.
    const f = fixture()
    f.git.dirty(f.repo)

    const result = await run(f, ['--dry-run', f.repo])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: uncommitted changes')
    expect(result.stderr).toBe('')
  })

  it('exits 1 in the fan-out when one job throws, with every other section intact and in order', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      if (name === 'bbb') throw new Error('boom')
      options.report.write(`${name}\n`)
      return 0
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(fanOutFailed(1, 3))
    expect(result.stdout).toContain('aaa\n')
    expect(result.stdout).toContain(`bbb\n${failed('boom')}`)
    expect(result.stdout).toContain('ccc\n')
    const positions = ['aaa', 'bbb', 'ccc'].map((name) => result.stdout.indexOf(name))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('leaves the report exactly as it would be with no failure, plus the one failure line', async () => {
    // This is the core claim (see the PR body and `fixtures/divergences.json`,
    // key "exitStatus"): stdout does not change by one byte. Only
    // `failed(...)` on stderr is new. The test above proves this with
    // `toContain` per section, plus a check of the order. This test proves
    // the same claim with one exact `toBe` of the whole report. It does
    // this the way the "keeps every repository's lines together" test
    // does, for a clean run.
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      if (name === 'bbb') throw new Error('boom')
      options.report.write(`${name}\n`)
      return 0
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.stdout).toBe(
      `${realpathSync(f.sandbox.join('fan'))} (3 repos)\n\naaa\nbbb\n${failed('boom')}ccc\n`,
    )
  })

  it('exits 1 in the fan-out when a job answers non-zero without throwing', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      options.report.write(`${name}\n`)
      return name === 'bbb' ? 3 : 0
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(fanOutFailed(1, 2))
    expect(result.stdout).toContain(`bbb\n  ✗ the sync failed: exited with status 3\n`)
  })

  it('puts a non-zero status that arrived mid-line on a line of its own too', async () => {
    // The test "puts a failure that arrived mid-line on a line of its own"
    // (under "the fan-out") covers `appendFailure`'s mid-line branch
    // already. But it reaches that branch only through the throw call site.
    // The status-check call site uses the same shared helper. It has no
    // branch of its own to tell which caller sent it. This test proves the
    // guarantee also holds at that call site too. It does not rely only on
    // the fact that the two call sites contain identical text.
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'a')
    f.git.createAt(f.sandbox.join('fan'), 'b')

    const result = await run(f, [f.sandbox.join('fan')], {
      job: async (options: SyncRepoOptions): Promise<number> => {
        const name = path.basename(options.repo)
        options.report.write(name === 'a' ? 'half a line' : `${name}\n`)
        return name === 'a' ? 9 : 0
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('half a line\n  ✗ the sync failed: exited with status 9\n')
  })

  it('counts every failed repository, not just whether any failed', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<number> => {
      const name = path.basename(options.repo)
      if (name === 'bbb' || name === 'ccc') throw new Error('boom')
      options.report.write(`${name}\n`)
      return 0
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(fanOutFailed(2, 3))
  })

  it('exits 0 in the fan-out when every job answers 0', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb']) f.git.createAt(f.sandbox.join('fan'), name)

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('exits 0 in the fan-out for a skipped repository, with the real job', async () => {
    const f = fixture()
    f.git.createAt(f.sandbox.join('fan'), 'clean')
    const dirty = f.git.createAt(f.sandbox.join('fan'), 'dirty')
    f.git.dirty(dirty)

    const result = await run(f, ['--dry-run', f.sandbox.join('fan')])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped: uncommitted changes')
    expect(result.stderr).toBe('')
  })
})

// --- parity with the shell version ------------------------------------------------------

/** The scenarios of `tests/gh/test_gh_sync.py`, one for one. */
const SCENARIOS: Record<string, (f: Fixture) => string[]> = {
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

describe('parity with the report the shell version printed', () => {
  it('has a captured report for every scenario', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(GOLDEN).sort())
  })

  for (const name of Object.keys(SCENARIOS).sort()) {
    it(`matches the shell report for ${name}`, async () => {
      const f = fixture()
      const argv = SCENARIOS[name]?.(f)
      if (argv === undefined) throw new Error(`no scenario named ${name}`)

      const result = await run(f, argv)

      const golden = GOLDEN[name]
      if (golden === undefined) throw new Error(`no golden for ${name}`)
      expect(result.status).toBe(golden.status)
      expect(normalise(result.stdout, f.sandbox)).toBe(golden.stdout)
    })
  }
})
