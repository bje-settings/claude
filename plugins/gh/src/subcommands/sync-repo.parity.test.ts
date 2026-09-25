// sync-repo, part of its tests: parity with the report the shell version printed.
// The file is one of several so that vitest can run them at the same time (#205).
// `sync-repo.test-support.ts` holds the helpers and the header that says what the tests prove.
import { describe, expect, it } from 'vitest'
import {
  DIVERGENCES,
  fixture,
  GOLDEN,
  normalise,
  run,
  SCENARIOS,
} from './sync-repo.test-support.ts'

// --- parity with the shell version --------------------------------------------------

describe('parity with the report the shell version printed', () => {
  it('has a captured report for every scenario', () => {
    // A scenario with no golden would silently assert nothing.
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(GOLDEN).sort())
  })

  it('applies every recorded divergence to a golden that still contains it', () => {
    for (const [name, change] of Object.entries(DIVERGENCES['bash-output.json'])) {
      expect(GOLDEN[name]?.stdout).toContain(change.was)
    }
  })

  for (const name of Object.keys(SCENARIOS).sort()) {
    it(`matches the shell report for ${name}`, async () => {
      const f = fixture()
      const built = SCENARIOS[name]?.(f)
      if (built === undefined) throw new Error(`no scenario named ${name}`)

      const result = await run(f, built.argv, { gh: built.gh, env: built.env })

      const golden = GOLDEN[name]
      if (golden === undefined) throw new Error(`no golden for ${name}`)
      const change = DIVERGENCES['bash-output.json'][name]
      const expected =
        change === undefined ? golden.stdout : golden.stdout.replace(change.was, change.now)
      expect(result.status).toBe(golden.status)
      expect(normalise(result.stdout, f.sandbox)).toBe(expected)
    })
  }
})
