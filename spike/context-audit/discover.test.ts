import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { discoverFiles, scopeFilter } from './discover.ts'

/** A real, throwaway git checkout: `discoverFiles` shells out to `git
 *  ls-files`, so the fixture has to be a repository git itself will answer,
 *  never a directory this suite pretends is one. */
const createRepo = (): { root: string; commit: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'context-audit-discover-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  const commit = () => {
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'test'], { cwd: root })
  }
  return { root, commit }
}

describe('discoverFiles', () => {
  const repos: string[] = []
  after(() => {
    for (const root of repos) rmSync(root, { recursive: true, force: true })
  })

  it('finds tracked markdown files at any depth, sorted', () => {
    const { root, commit } = createRepo()
    repos.push(root)
    mkdirSync(join(root, 'plugins', 'gh'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# root\n')
    writeFileSync(join(root, 'CLAUDE.md'), '# claude\n')
    writeFileSync(join(root, 'plugins', 'gh', 'README.md'), '# gh\n')
    writeFileSync(join(root, 'plugins', 'gh', 'notes.txt'), 'not markdown\n')
    commit()

    assert.deepEqual(discoverFiles(root), ['CLAUDE.md', 'README.md', 'plugins/gh/README.md'])
  })

  it('excludes an untracked markdown file', () => {
    const { root, commit } = createRepo()
    repos.push(root)
    writeFileSync(join(root, 'tracked.md'), 'tracked\n')
    commit()
    writeFileSync(join(root, 'untracked.md'), 'untracked\n')

    assert.deepEqual(discoverFiles(root), ['tracked.md'])
  })

  it('applies an optional filter', () => {
    const { root, commit } = createRepo()
    repos.push(root)
    writeFileSync(join(root, 'README.md'), 'a\n')
    writeFileSync(join(root, 'CHANGELOG.md'), 'b\n')
    commit()

    assert.deepEqual(
      discoverFiles(root, (path) => path === 'README.md'),
      ['README.md'],
    )
  })

  it('scopeFilter keeps CLAUDE.md, README.md and .claude/**/*.md by basename or path', () => {
    const { root, commit } = createRepo()
    repos.push(root)
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
    mkdirSync(join(root, 'plugins', 'gh'), { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'a\n')
    writeFileSync(join(root, 'plugins', 'gh', 'README.md'), 'b\n')
    writeFileSync(join(root, '.claude', 'rules', 'foo.md'), 'c\n')
    writeFileSync(join(root, 'plugins', 'gh', 'other.md'), 'd\n')
    commit()

    assert.deepEqual(discoverFiles(root, scopeFilter), [
      '.claude/rules/foo.md',
      'CLAUDE.md',
      'plugins/gh/README.md',
    ])
  })
})
