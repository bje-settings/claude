// Repo-wide conventions that only a test can hold. Ported from
// tests/test_repo_layout.py: each of these is a rule written down somewhere
// in prose, CLAUDE.md or a file under .claude/rules/, whose failure mode
// is silent. Prose does not survive a refactor by someone who has not read
// it, and none of these would show up as a broken test anywhere else.
//
// test_repo_layout.py's test_repo_tooling_never_touches_sys_path is
// deliberately NOT ported here: it parses Python with the `ast` module to
// prove no root script does `sys.path.insert`/`sys.path.append`, its subject
// (Python `scripts/`) retires with #138, and its TypeScript successor, no
// cross-plugin import via the root lib, needs the root lib from #125,
// which does not exist yet. The Python test stays in tests/test_repo_layout.py
// until #138.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginDirs, ROOT, rel } from './repo.ts'

it('expresses a path relative to the repo root', () => {
  // rel() is exercised elsewhere only inside branches that stay empty
  // against this repository's own tree (nothing here is currently missing a
  // FLOW.md, a LICENSE, or a license field), so without this direct case its
  // body would never actually run and coverage would not notice.
  expect(rel(path.join(ROOT, 'tests', 'repo.ts'))).toBe(path.join('tests', 'repo.ts'))
})

it('finds plugins to check', () => {
  // The same guard tests/skills.test.ts carries, for the same reason: a glob
  // that matches nothing makes every check below pass while enforcing
  // nothing.
  expect(pluginDirs().length).toBeGreaterThan(0)
})

it('keeps one LICENSE, copied identically into every plugin', () => {
  // Each plugin directory carries its own so it is self-describing when it
  // is distributed on its own, and so a mirror copies it as an ordinary
  // tracked file with no special case. Several copies that must agree is
  // exactly the drift shape plugins/gh/scripts/lib/streams.py exists to warn
  // about, so it is asserted rather than trusted.
  const canonical = readFileSync(path.join(ROOT, 'LICENSE'))
  expect(canonical.toString('utf8')).toContain('MIT License')

  const wrong: string[] = []
  for (const plugin of pluginDirs()) {
    const licenseFile = path.join(plugin, 'LICENSE')
    let content: Buffer | undefined
    try {
      content = readFileSync(licenseFile)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      wrong.push(`${rel(plugin)}: no LICENSE`)
      continue
    }
    if (!content.equals(canonical)) {
      wrong.push(`${rel(plugin)}: LICENSE differs from the root copy`)
    }
  }
  expect(wrong).toEqual([])
})

it('declares the licence in the manifest as well as beside it', () => {
  // `claude plugin validate --strict` accepts the field; a reader looking at
  // the manifest alone should not have to go hunting for the file.
  const missing: string[] = []
  for (const plugin of pluginDirs()) {
    const manifest = JSON.parse(
      readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { license?: unknown }
    if (manifest.license !== 'MIT') {
      missing.push(`${rel(plugin)}: license is ${JSON.stringify(manifest.license)}`)
    }
  }
  expect(missing).toEqual([])
})

describe('pluginDirs filtering', () => {
  // '' rather than an unassigned `let`: if the `it` body throws before
  // mkdtempSync returns, an unguarded rmSync(undefined) here would replace
  // the real failure with its own TypeError.
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('filters directories to the ones that actually carry a plugin manifest', () => {
    // Coverage of pluginDirs' three filter branches that the real plugins/
    // tree never exercises, because every directory in it today is a
    // well-formed plugin: a stray tracked file directly under the root, a
    // directory with no .claude-plugin/ at all, and a directory whose
    // .claude-plugin entry exists but is a file rather than a directory.
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-plugins-'))
    writeFileSync(path.join(scratch, 'README.md'), 'not a plugin directory\n')
    mkdirSync(path.join(scratch, 'no-manifest'), { recursive: true })
    mkdirSync(path.join(scratch, 'manifest-is-a-file'), { recursive: true })
    writeFileSync(path.join(scratch, 'manifest-is-a-file', '.claude-plugin'), '')
    mkdirSync(path.join(scratch, 'valid-plugin', '.claude-plugin'), { recursive: true })
    const found = pluginDirs(scratch).map((p) => path.relative(scratch, p))
    expect(found).toEqual(['valid-plugin'])
  })
})
