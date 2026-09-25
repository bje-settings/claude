// Python's `tests/gh/test_lib_prs.py` has one test per arm. This file follows
// the same pattern. The commands reach these functions through the sync
// report. But a broken filter that lets a fork through would force-delete
// someone's branch. So each arm has its own test here too.
//
// **Issue #127 deleted the Python this file ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from the
// tree. The file and line references below match commit `cd0d515`, the last
// commit with these files. Each reference stays because it shows where a rule
// came from.
import { describe, expect, it } from 'vitest'

import { hasMatch, isPullRequestRow, namesBranch, ownRows } from '#gh/prs.ts'

const MINE = { headRefName: 'feature', headRefOid: 'abc', isCrossRepository: false }
const FORK = { headRefName: 'feature', headRefOid: 'abc', isCrossRepository: true }

describe('ownRows', () => {
  it('drops forks', () => {
    expect(ownRows([MINE, FORK])).toEqual([MINE])
  })

  it('keeps a row with no isCrossRepository field', () => {
    // A missing field is not a fork. A filter that reads it as a fork would
    // keep every branch.
    const row = { headRefName: 'feature', headRefOid: 'abc' }
    expect(ownRows([row])).toEqual([row])
  })
})

describe('hasMatch', () => {
  it('wants the name and the commit', () => {
    expect(hasMatch([MINE], 'feature', 'abc')).toBe(true)
  })

  it('rejects a moved tip', () => {
    // The regression the commit check exists for: same name, different commit.
    expect(hasMatch([MINE], 'feature', 'def')).toBe(false)
  })

  it('rejects another name', () => {
    expect(hasMatch([MINE], 'other', 'abc')).toBe(false)
  })
})

describe('namesBranch', () => {
  it('ignores the commit', () => {
    expect(namesBranch([MINE], 'feature')).toBe(true)
    expect(namesBranch([MINE], 'other')).toBe(false)
  })
})

describe('isPullRequestRow', () => {
  it('accepts an object, which is the only shape the readers can ask about', () => {
    expect(isPullRequestRow({})).toBe(true)
    expect(isPullRequestRow(MINE)).toBe(true)
  })

  it('refuses a number, a string, null and a list', () => {
    // The caller reports the error `gh returned rows that are not pull
    // requests` for each of these values. If it treated any of them as an
    // empty window, it would assume an absence it never checked.
    expect(isPullRequestRow(1)).toBe(false)
    expect(isPullRequestRow('pr')).toBe(false)
    expect(isPullRequestRow(null)).toBe(false)
    expect(isPullRequestRow([])).toBe(false)
  })
})
