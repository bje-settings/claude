// Repo-wide conventions that only a test can hold. Ported from
// tests/test_repo_layout.py: each of these is a rule written down somewhere
// in prose, CLAUDE.md or a file under .claude/rules/, whose failure mode
// is silent. Prose does not survive a refactor by someone who has not read
// it, and none of these would show up as a broken test anywhere else.
//
// test_repo_layout.py's test_repo_tooling_never_touches_sys_path is
// deliberately NOT ported here: it parses Python with the `ast` module to
// prove no root script does `sys.path.insert`/`sys.path.append`, and its
// subject (Python `scripts/`) retires with #138. Its TypeScript successor is
// the pair of rules below, which #125 can state now that the root lib exists:
// the `src/lib` symlink is the only path out of a plugin, and it is a symlink
// to exactly one place. The Python test stays in tests/test_repo_layout.py
// until #138.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  binDirectories,
  crossPluginImports,
  LIB_LINK_TARGET,
  libLinkViolations,
  pluginDirs,
  ROOT,
  rel,
} from './repo.ts'

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
  // is distributed on its own. Several copies that must agree is a drift
  // shape worth asserting rather than trusting.
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
    // Coverage of pluginDirs' filter branches that the real plugins/ tree
    // never exercises, because every directory in it today is a well-formed
    // plugin: a stray tracked file directly under the root, a directory with
    // no .claude-plugin/ at all, a directory whose .claude-plugin entry is a
    // file rather than a directory, and a symlink pointing at a plugin.
    //
    // The symlink is the one that makes the isDirectory() guard load-bearing.
    // A listing entry answers from lstat, so a link reports false there,
    // while existsSync follows it and finds the manifest: without the guard
    // the same plugin would be counted twice, once under each name.
    //
    // So a link is looked through at `src` and dropped here, which reads as a
    // contradiction and is not one: `pluginDirs` is pre-existing code that
    // `tests/skills.test.ts` also walks, and what a plugin *is* is not this
    // layer's question. What is this layer's question, whether a plugin
    // reaches the shared library the one way the convention allows, is asked
    // of every plugin the existing filter admits.
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-plugins-'))
    writeFileSync(path.join(scratch, 'README.md'), 'not a plugin directory\n')
    mkdirSync(path.join(scratch, 'no-manifest'), { recursive: true })
    mkdirSync(path.join(scratch, 'manifest-is-a-file'), { recursive: true })
    writeFileSync(path.join(scratch, 'manifest-is-a-file', '.claude-plugin'), '')
    mkdirSync(path.join(scratch, 'valid-plugin', '.claude-plugin'), { recursive: true })
    symlinkSync('valid-plugin', path.join(scratch, 'linked-plugin'))
    const found = pluginDirs(scratch).map((p) => path.relative(scratch, p))
    expect(found).toEqual(['valid-plugin'])
  })
})

// The rule ADR 001 states in prose and RFC 001 decision 4 records: the
// `src/lib` symlink is the only path out of a plugin, and a test file may
// additionally reach the shared harness. Every arm is proven on a synthetic
// tree, following the `root`-parameter pattern `pluginDirs` already uses,
// because no plugin in this repository carries the symlink until #126 and a
// rule whose branches never run is a rule nobody is enforcing. The real
// `plugins/` tree is then run through the same two functions, which is what
// makes them a guard rather than an exercise.
describe('the plugin boundary', () => {
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  interface Tree {
    /** Plugin directories to create, each with the manifest `pluginDirs` looks for. */
    readonly plugins: readonly string[]
    /** Files to write, keyed by their path relative to the plugins root. */
    readonly files?: Readonly<Record<string, string>>
    /** Symlinks to create, keyed by path relative to the plugins root. */
    readonly links?: Readonly<Record<string, string>>
  }

  /** A marketplace-shaped temporary tree: `lib/`, `harness/` and `plugins/`. */
  const build = (tree: Tree): string => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-layout-'))
    mkdirSync(path.join(scratch, 'lib'), { recursive: true })
    writeFileSync(path.join(scratch, 'lib', 'gh.ts'), '')
    mkdirSync(path.join(scratch, 'harness'), { recursive: true })
    writeFileSync(path.join(scratch, 'harness', 'gh.ts'), '')
    const plugins = path.join(scratch, 'plugins')
    for (const name of tree.plugins) {
      mkdirSync(path.join(plugins, name, '.claude-plugin'), { recursive: true })
    }
    for (const [file, content] of Object.entries(tree.files ?? {})) {
      const full = path.join(plugins, file)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    for (const [link, target] of Object.entries(tree.links ?? {})) {
      const full = path.join(plugins, link)
      mkdirSync(path.dirname(full), { recursive: true })
      symlinkSync(target, full)
    }
    return plugins
  }

  it('accepts an import inside the same plugin', () => {
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/src/url.ts': "import { x } from './helpers.ts'\nimport { y } from '../scripts/z.ts'\n",
        'a/src/helpers.ts': '',
        'a/scripts/z.ts': '',
      },
    })
    expect(crossPluginImports(plugins)).toEqual([])
  })

  it('accepts the root lib reached through the symlink', () => {
    // The whole convention in one example: the specifier stays inside the
    // plugin, which is also what the installed copy sees once Claude Code has
    // dereferenced the link into the cache.
    const plugins = build({
      plugins: ['a'],
      files: { 'a/scripts/a.ts': "import { assertNodeFloor } from '../src/lib/node-floor.ts'\n" },
      links: { 'a/src/lib': LIB_LINK_TARGET },
    })
    expect(crossPluginImports(plugins)).toEqual([])
  })

  it('refuses a relative import into another plugin', () => {
    const plugins = build({
      plugins: ['a', 'b'],
      files: {
        'a/src/url.ts': "import { shared } from '../../b/src/thing.ts'\n",
        'b/src/thing.ts': '',
      },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.ts: imports ../../b/src/thing.ts, which resolves outside the plugin',
    ])
  })

  it('refuses the root lib reached around the symlink', () => {
    // `../../../lib` resolves for a contributor working in the checkout and
    // for nobody who installed the plugin: the cache copy has no repository
    // root above it. Catching it here is the difference between a failed test
    // and an unresolved import on a user's machine.
    const plugins = build({
      plugins: ['a'],
      files: { 'a/src/url.ts': "import { ok } from '../../../lib/envelope.ts'\n" },
      links: { 'a/src/lib': LIB_LINK_TARGET },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.ts: imports ../../../lib/envelope.ts, which resolves outside the plugin',
    ])
  })

  it('accepts the harness in a test file and refuses it anywhere else', () => {
    // The harness never ships, so a shipped file reaching for it is an import
    // the installed plugin cannot resolve; a co-located test file reaching for
    // it is the arrangement ADR 001 asks for.
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/src/url.test.ts': "import { createGhMock } from '../../../harness/gh.ts'\n",
        'a/src/url.ts': "import { createGhMock } from '../../../harness/gh.ts'\n",
      },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.ts: imports ../../../harness/gh.ts, which resolves outside the plugin',
    ])
  })

  it('refuses a test file reaching somewhere that is neither its plugin nor the harness', () => {
    const plugins = build({
      plugins: ['a', 'b'],
      files: { 'a/src/url.test.ts': "import { thing } from '../../b/src/thing.ts'\n" },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.test.ts: imports ../../b/src/thing.ts, which resolves outside the plugin',
    ])
  })

  it('ignores bare specifiers and reads every spelling of a relative one', () => {
    // `import`, `from`, a side-effect import and a dynamic one: a rule that
    // read only static `from` clauses would miss the `await import` an entry
    // point uses after its floor check, which is exactly where a boundary
    // crossing would hide.
    const plugins = build({
      plugins: ['a', 'b'],
      files: {
        'a/src/url.ts': [
          "import { readFileSync } from 'node:fs'",
          "import { expect } from 'vitest'",
          "import '../../b/src/side.ts'",
          "export { thing } from '../../b/src/named.ts'",
          "const mod = await import('../../b/src/dynamic.ts')",
          'const tpl = await import(`../../b/src/backtick.ts`)',
          'const require = createRequire(import.meta.url)',
          "const legacy = require('../../b/src/required.ts')",
        ].join('\n'),
      },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.ts: imports ../../b/src/backtick.ts, which resolves outside the plugin',
      'a/src/url.ts: imports ../../b/src/dynamic.ts, which resolves outside the plugin',
      'a/src/url.ts: imports ../../b/src/named.ts, which resolves outside the plugin',
      'a/src/url.ts: imports ../../b/src/required.ts, which resolves outside the plugin',
      'a/src/url.ts: imports ../../b/src/side.ts, which resolves outside the plugin',
    ])
  })

  it('reads a plugin name as a whole name, and checks every plugin', () => {
    // Two properties one tree can hold, both of them invisible to the names
    // the other fixtures use. `plugins/gh-security` starts with the string
    // `plugins/gh`, so without the separator the containment test appends,
    // `gh` importing into `gh-security` would read as staying inside itself
    // and the rule would stop holding for that pair. This repository has `gh`
    // today and is one plugin away from a `gh-*` sibling. The second
    // violation is written in the plugin that sorts last, so a scan that
    // stopped after the first plugin would report only one of the two.
    const plugins = build({
      plugins: ['gh', 'gh-security'],
      files: {
        'gh/src/url.ts': "import { thing } from '../../gh-security/src/thing.ts'\n",
        'gh-security/src/thing.ts': "import { url } from '../../gh/src/url.ts'\n",
      },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'gh-security/src/thing.ts: imports ../../gh/src/url.ts, which resolves outside the plugin',
      'gh/src/url.ts: imports ../../gh-security/src/thing.ts, which resolves outside the plugin',
    ])
  })

  it('reads only .ts files, and never walks into the symlink', () => {
    // Walking the link would report the root lib's own imports as the
    // plugin's, and `lib/gh.ts` importing `node:child_process` is not a
    // boundary crossing.
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/README.md': "import { anything } from '../../b/src/thing.ts'\n",
        'a/src/url.ts': '',
      },
      links: { 'a/src/lib': LIB_LINK_TARGET },
    })
    // Three levels up, not two: walked as `plugins/a/src/lib/outward.ts` the
    // specifier resolves to `plugins/elsewhere.ts`, outside the plugin, so
    // this arm goes red the moment the walk starts descending the link. Two
    // levels would land back inside `plugins/a` and pass either way, which
    // would make the test an illustration rather than a proof.
    writeFileSync(
      path.join(scratch, 'lib', 'outward.ts'),
      "import { x } from '../../../elsewhere.ts'\n",
    )
    expect(crossPluginImports(plugins)).toEqual([])
  })

  it('accepts the committed symlink and nothing else in its place', () => {
    // `equivalent` is the arm that says the target is compared as a string
    // and not resolved: `../../../lib/` reaches the same directory from the
    // same place, and is still a violation, because the string is what Claude
    // Code's installer classifies.
    const plugins = build({
      plugins: ['linked', 'copied', 'misaimed', 'equivalent', 'plain'],
      files: { 'copied/src/lib/gh.ts': '', 'plain/src/url.ts': '' },
      links: {
        'linked/src/lib': LIB_LINK_TARGET,
        'misaimed/src/lib': path.join('..', '..', 'lib'),
        'equivalent/src/lib': `${LIB_LINK_TARGET}${path.sep}`,
      },
    })
    expect(libLinkViolations(plugins)).toEqual([
      'copied/src/lib is not a symlink',
      `equivalent/src/lib points at ${LIB_LINK_TARGET}${path.sep}, not ${LIB_LINK_TARGET}`,
      `misaimed/src/lib points at ../../lib, not ${LIB_LINK_TARGET}`,
    ])
  })

  it('looks through a src that is itself a symlink', () => {
    // A listing entry answers from lstat, so a linked `src` reports itself as
    // neither a directory nor a file. Skipping it would be a plugin hiding a
    // real copy of the shared library one link away from where the rule
    // looks, which is the copy libLinkViolations exists to refuse.
    const plugins = build({
      plugins: ['behind'],
      files: { 'elsewhere/lib/gh.ts': '' },
      links: { 'behind/src': path.join('..', 'elsewhere') },
    })
    expect(libLinkViolations(plugins)).toEqual(['behind/src/lib is not a symlink'])
  })

  it('asks nothing of a plugin that has no src directory, or a file where it would be', () => {
    const plugins = build({ plugins: ['bare', 'odd'], files: { 'odd/src': '' } })
    expect(libLinkViolations(plugins)).toEqual([])
  })

  it('asks nothing of a src link that points at nothing, or at a file', () => {
    // The two siblings of the case above, and the reason the probe follows the
    // link rather than reading the listing entry: both of these report
    // themselves as neither a directory nor a file, so a rule that only
    // skipped a plain file would hand `readdirSync` a path it cannot list and
    // die with ENOENT or ENOTDIR. A rule that aborts reports nothing, which is
    // worse than the violation it was looking for.
    const plugins = build({
      plugins: ['dangling', 'at-a-file'],
      files: { 'afile.ts': '' },
      links: {
        'dangling/src': path.join('..', 'nowhere'),
        'at-a-file/src': path.join('..', 'afile.ts'),
      },
    })
    expect(libLinkViolations(plugins)).toEqual([])
  })

  it('refuses a top-level bin directory, by either route to one', () => {
    // #185 and RFC 001 decision 16: claude.ai refuses a plugin that carries
    // one, so nothing in this repository goes red on its own when a `bin/`
    // comes back. A link to a directory installs as a directory and is the
    // same violation; a plain file named `bin`, a link to nothing, and the
    // `scripts/` the entry point actually lives in are not.
    const plugins = build({
      plugins: ['carries', 'linked', 'afile', 'dangling', 'clean'],
      files: {
        'carries/bin/carries.ts': '',
        'afile/bin': '',
        'clean/scripts/clean.ts': '',
        'elsewhere/linked.ts': '',
      },
      links: {
        'linked/bin': path.join('..', 'elsewhere'),
        'dangling/bin': path.join('..', 'nowhere'),
      },
    })
    expect(binDirectories(plugins)).toEqual([
      'carries/bin is a directory, and claude.ai refuses one',
      'linked/bin is a directory, and claude.ai refuses one',
    ])
  })
})

it('holds all three rules over the real plugins tree', () => {
  // The synthetic trees above prove the rules; this is the guard. Every
  // plugin's entry point is in `scripts/` since #185, and the third list is
  // the one that has no other way of going red: `bin/` is refused by
  // claude.ai at publish time rather than by anything here.
  expect(crossPluginImports()).toEqual([])
  expect(libLinkViolations()).toEqual([])
  expect(binDirectories()).toEqual([])
})
