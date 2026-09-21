// One test per arm, the way `tests/gh/test_lib_prs.py` has one: the commands
// reach these through the sync report, but a filter that quietly stopped
// excluding forks would be a force delete of somebody's branch, so each arm is
// asserted here too.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; the file and line references below are to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { describe, expect, it } from 'vitest'

import { hasMatch, isPullRequestRow, namesBranch, ownRows } from './prs.ts'

const MINE = { headRefName: 'feature', headRefOid: 'abc', isCrossRepository: false }
const FORK = { headRefName: 'feature', headRefOid: 'abc', isCrossRepository: true }

describe('ownRows', () => {
  it('drops forks', () => {
    expect(ownRows([MINE, FORK])).toEqual([MINE])
  })

  it('keeps a row with no isCrossRepository field', () => {
    // A missing field is not a fork; treating it as one would keep every
    // branch.
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
    // `gh returned rows that are not pull requests` is the reason the caller
    // reports for each of these, and reading any of them as an empty window
    // would be an absence that was never checked.
    expect(isPullRequestRow(1)).toBe(false)
    expect(isPullRequestRow('pr')).toBe(false)
    expect(isPullRequestRow(null)).toBe(false)
    expect(isPullRequestRow([])).toBe(false)
  })
})
