// sync, part of its tests: the command line, the scope and the report.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSyncArgs } from '#gh/subcommands/sync.ts'
import type { SyncRepoOptions } from '#gh/subcommands/sync-repo.ts'
import { fixture, normalise, overlapping, PYTHON, run } from './sync.test-support.ts'

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
    const job = async (options: SyncRepoOptions): Promise<void> => {
      const name = path.basename(options.repo)
      await new Promise((resolve) => setTimeout(resolve, name === 'aaa' ? 60 : 0))
      options.report.write(`${name}\n`)
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
    const job = async (options: SyncRepoOptions): Promise<void> => {
      const name = path.basename(options.repo)
      const start = performance.now()
      options.report.write(`${name}\n  first half of ${name}\n`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      options.report.write(`  second half of ${name}\n`)
      spans.push({ name, start, end: performance.now() })
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
