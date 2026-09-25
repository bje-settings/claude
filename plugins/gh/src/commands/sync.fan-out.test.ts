// sync, part of its tests: the throttle and the fan-out.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync.test-support.ts` holds the helpers and the header that says what the tests prove.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  failed,
  fixture,
  mostAtOnce,
  overlapping,
  run,
  singleFailed,
  timedJob,
} from './sync.test-support.ts'
import type { SyncRepoOptions } from './sync-repo.ts'

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
