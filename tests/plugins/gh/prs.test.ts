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

import { hasMatch, isOid, isPullRequestRow, mergeCommitOf, ownRows, pullRefOf } from '#gh/prs.ts'

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

// A field from gh goes into a git argv only through these readers. Each
// refusal below keeps a value that git could read as a flag, or as another
// object, out of that argv.
const SHA1 = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

describe('isOid', () => {
  it('accepts a full SHA-1 or SHA-256', () => {
    expect(isOid(SHA1)).toBe(true)
    expect(isOid(SHA256)).toBe(true)
  })

  it('refuses a short, long, upper-case or flag-shaped value, and a non-string', () => {
    expect(isOid('a'.repeat(39))).toBe(false)
    expect(isOid('a'.repeat(41))).toBe(false)
    expect(isOid('A'.repeat(40))).toBe(false)
    expect(isOid(`-${SHA1}`)).toBe(false)
    expect(isOid(`${SHA1}\n`)).toBe(false)
    expect(isOid(40)).toBe(false)
  })
})

describe('mergeCommitOf', () => {
  it('reads the oid that gh answers', () => {
    expect(mergeCommitOf({ mergeCommit: { oid: SHA1 } })).toBe(SHA1)
  })

  it('answers null for a row with no merge commit git can read', () => {
    expect(mergeCommitOf({})).toBeNull()
    expect(mergeCommitOf({ mergeCommit: null })).toBeNull()
    expect(mergeCommitOf({ mergeCommit: SHA1 })).toBeNull()
    expect(mergeCommitOf({ mergeCommit: { oid: '--upload-pack=x' } })).toBeNull()
  })
})

describe('pullRefOf', () => {
  it('names the head ref of a numbered row', () => {
    expect(pullRefOf({ number: 7 })).toBe('refs/pull/7/head')
  })

  it('answers null for a row with no whole number', () => {
    expect(pullRefOf({})).toBeNull()
    expect(pullRefOf({ number: 1.5 })).toBeNull()
    expect(pullRefOf({ number: '1' })).toBeNull()
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
