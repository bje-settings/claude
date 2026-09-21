// The orchestrator, against real repositories: the port of
// `tests/gh/test_gh_sync.py`.
//
// The parity block compares each scenario's whole report with
// `fixtures/bash-sync-output.json`, captured from `gh-sync.sh` before it was
// deleted. Everything above it is a claim the report alone does not prove.
//
// **The stand-in job is the seam the Python reaches by copying a script.**
// `orchestrator_copy(gh, job=TIMED_JOB)` puts a fake `gh-sync-repo.py` beside
// a copy of the orchestrator so that a job's timing and exit status are
// something the test states rather than something it hopes for. With the
// fan-out in-process that stand-in is a function, and `createSyncCommand`
// takes it; the throttle, the section order and the dropped status are
// asserted exactly as they were.
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

/** The recorded divergences, read rather than restated: a line this port says
 *  instead of what the Python said has to be in the table to be asserted. */
const DIVERGENCES: { inProcessFanOut: { now: string } } = JSON.parse(read('divergences.json'))

/** The recorded line for a job that threw, with its placeholder filled in.
 *  The table names a line; the report writes it with a newline after it. */
const failed = (message: string): string =>
  `${DIVERGENCES.inProcessFanOut.now.replace('<message>', message)}\n`

/** A `gh` with no merged pull requests, which is every scenario here: the
 *  reports these assert are about branches and discovery, not about pull
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

/** A job that records when it ran, so the throttle is asserted from the
 *  outside rather than inferred from the output order. The Python's
 *  `TIMED_JOB`, as a function. */
function timedJob(spans: { name: string; start: number; end: number }[], ms: number) {
  return async (options: SyncRepoOptions): Promise<number> => {
    const start = performance.now()
    await new Promise((resolve) => setTimeout(resolve, ms))
    spans.push({ name: path.basename(options.repo), start, end: performance.now() })
    options.report.write(`${path.basename(options.repo)}\n`)
    return 0
  }
}

/** The most spans open at once, read off the spans themselves: at every
 *  moment a job started, how many other jobs had started and not finished.
 *  No call counting and no timer to outrun, because a span that has already
 *  been recorded cannot be rescheduled. */
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

// --- argument handling ----------------------------------------------------------

describe('the command line', () => {
  it('rejects a zero -j rather than spinning forever', async () => {
    const f = fixture()

    const result = await run(f, ['-j', '0', f.sandbox.path])

    expect(result.status).toBe(2)
    // The port's own line compared to the captured Python, not both compared
    // to the same literal: an assertion that restates the string a third time
    // can never go red from a change to the port. The newline is the Python
    // script's; the envelope leaves it to the entry point.
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
    // `rest.pop(0)` takes the next token whatever it is, so a flag after `-j`
    // is its value and the refusal names it rather than the flag.
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
    // The PORT against the capture, not the capture against a literal: the
    // Python refused the same name from the same sandbox, so the two values
    // are directly comparable once the sandbox path is normalised, and the
    // path SPELLING is part of what parity means here. The capture carries
    // the trailing newline `print` adds.
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

  it('drops the job’s status on the single-repository path', async () => {
    // Documented parity, pinned: `gh-sync.sh` dropped the status at its lines
    // 72 to 73, so a skipped repo and a broken job are the same answer there.
    // Changing it is a behaviour change rather than a port, and #81 is where
    // it lands; this test is what makes the change visible when it comes.
    const f = fixture()

    const result = await run(f, [f.repo], { job: async () => 9 })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('✗')
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
    // Discovery asks git the question and answers "no" when it cannot ask.
    // Without this check a machine with no git is told it has no repositories,
    // which is a wiring mistake wearing the answer to a different question.
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

// --- reporting ----------------------------------------------------------------------

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
    // The stand-in writes its section in two halves either side of a sleep, so
    // with two jobs in flight the halves of two repositories are being written
    // at the same time: a fan-out that passed a job's output through as it
    // arrived would split a section in half, every run. The recorded spans
    // prove two really were in flight, so a serialised run cannot pass this by
    // never overlapping in the first place.
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
    // `overlapping` above says the throttle is not a queue. It does not say it
    // is a throttle: a fan-out that ignored -j entirely and started every job
    // would satisfy it. Both halves are needed, and the spans already recorded
    // carry the answer, so this costs no new timing.
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
    // `gh-sync.py:123` to `:135` is the rule in as many words: a job that
    // raises "would otherwise raise out of the pool and take every other
    // repository's report with it. It is this repo's answer, not the run's."
    // A direct call cannot fail to start, but it can throw, and `syncRepo`
    // deliberately lets anything that is not a `GhError` out. Uncaught, the
    // header and every finished section are discarded after the work is done.
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

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('a\n')
    expect(result.stdout).toContain('c\n')
    // The WHOLE section, not just the line: `b` threw before writing a
    // heading of its own, and a bare cross line would sit under `a`'s
    // heading and blame a repository that synced cleanly. `gh-sync.py:135`
    // puts the basename in the same string for the child that never ran.
    expect(result.stdout).toContain(`b\n${failed('boom')}`)
    expect(result.stdout).not.toContain(`a\n${failed('boom')}`)
  })

  it('puts a failure that arrived mid-line on a line of its own', async () => {
    // `gh-sync.py:171` to `:173`: a section without a trailing newline would
    // otherwise have the failure appended to the end of its last line.
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

  it('says so on the single-repository path too, rather than crashing the run', async () => {
    // That path has no section to fold the failure into, as `gh-sync.py:245`
    // to `:251` has it for a child it could not start, and the status still
    // does not change: #81 is the dropped status and it stays as it is.
    //
    // Thrown as a bare value rather than an `Error`, which a rejected promise
    // may carry and which the Python never had to think about: `str(error)`
    // there always had something to print, so the port says what arrived
    // instead of `undefined`.
    const f = fixture()
    const work = f.git.createAt(f.sandbox.join('one'), 'only')
    const notAnError: unknown = 'boom'

    const result = await run(f, [work], {
      job: async (): Promise<number> => {
        throw notAnError
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(failed('boom'))
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
