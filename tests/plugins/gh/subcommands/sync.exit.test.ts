// sync, part of its tests: the exit status and parity with the report the shell version printed.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync.test-support.ts` holds the helpers and the header that says what the tests prove.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SyncRepoOptions } from '#gh/subcommands/sync-repo.ts'
import {
  failed,
  fanOutFailed,
  fixture,
  GOLDEN,
  normalise,
  run,
  SCENARIOS,
  singleFailed,
} from './sync.test-support.ts'

// --- the exit status (#81) -----------------------------------------------------------

describe('the exit status', () => {
  it('exits 1 on the single-repository path when the job throws', async () => {
    const f = fixture()

    const result = await run(f, [f.repo], {
      job: async (): Promise<void> => {
        throw new Error('boom')
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe(failed('boom'))
    expect(result.stderr).toBe(singleFailed(path.basename(f.repo)))
  })

  it('exits 0 on the single-repository path when the job answers', async () => {
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
    const job = async (options: SyncRepoOptions): Promise<void> => {
      const name = path.basename(options.repo)
      if (name === 'bbb') throw new Error('boom')
      options.report.write(`${name}\n`)
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
    // This is the core claim (see the PR body for #81): stdout does not
    // change by one byte. Only `failed(...)` on stderr is new. The test
    // above proves this with `toContain` per section, plus a check of the
    // order. This test proves the same claim with one exact `toBe` of the
    // whole report. It does this the way the "keeps every repository's
    // lines together" test does, for a clean run.
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<void> => {
      const name = path.basename(options.repo)
      if (name === 'bbb') throw new Error('boom')
      options.report.write(`${name}\n`)
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.stdout).toBe(
      `${realpathSync(f.sandbox.join('fan'))} (3 repos)\n\naaa\nbbb\n${failed('boom')}ccc\n`,
    )
  })

  it('counts every failed repository, not just whether any failed', async () => {
    const f = fixture()
    for (const name of ['aaa', 'bbb', 'ccc']) f.git.createAt(f.sandbox.join('fan'), name)
    const job = async (options: SyncRepoOptions): Promise<void> => {
      const name = path.basename(options.repo)
      if (name === 'bbb' || name === 'ccc') throw new Error('boom')
      options.report.write(`${name}\n`)
    }

    const result = await run(f, [f.sandbox.join('fan')], { job })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(fanOutFailed(2, 3))
  })

  it('exits 0 in the fan-out when every job answers', async () => {
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
