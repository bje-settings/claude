// Repo-wide conventions that only a test can hold. This is ported from
// tests/test_repo_layout.py. Each of these is a rule written down
// somewhere in prose, CLAUDE.md, or a file under .claude/rules/, whose
// failure mode is silent. Prose does not survive a refactor by someone who
// has not read it, and none of these would show up as a broken test
// anywhere else.
//
// test_repo_layout.py's test_repo_tooling_never_touches_sys_path is
// deliberately NOT ported here. It parses Python with the `ast` module, to
// prove that no root script calls `sys.path.insert` or `sys.path.append`.
// Its subject (Python `scripts/`) went at #128, and the test itself at
// #138. Its TypeScript successor is the pair of rules below (ADR 006): no
// import leaves a plugin, and no plugin holds a symlink.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  binDirectories,
  crossPluginImports,
  developmentFiles,
  packageImports,
  pluginDirs,
  pluginSymlinks,
  ROOT,
  rel,
  reservedDirectoryNames,
  testsOutsideTests,
} from './repo.ts'

it('expresses a path relative to the repo root', () => {
  // `rel()` runs elsewhere only inside branches that stay empty against
  // this repository's own tree. Nothing here is currently missing a
  // flow, a LICENSE, or a license field. Without this direct case, its
  // body would never actually run, and coverage would not notice.
  expect(rel(path.join(ROOT, 'tests', 'repo', 'repo.ts'))).toBe(
    path.join('tests', 'repo', 'repo.ts'),
  )
})

it('finds plugins to check', () => {
  // This is the same guard tests/repo/skills.test.ts carries, for the same
  // reason. A glob that matches nothing makes every check below pass,
  // while it enforces nothing.
  expect(pluginDirs().length).toBeGreaterThan(0)
})

it('keeps one LICENSE, copied identically into every plugin', () => {
  // Each plugin directory carries its own copy, so it is self-describing
  // when distributed on its own. Several copies that must agree are a
  // drift shape a test should check, not one to trust blindly.
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
  // `claude plugin validate --strict` accepts the field. A reader who
  // looks at the manifest alone should not have to search for the file.
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
    // This covers pluginDirs' filter branches that the real plugins/ tree
    // never exercises, because every directory in it today is a
    // well-formed plugin. This tree has a stray tracked file directly
    // under the root, a directory with no .claude-plugin/ at all, a
    // directory whose .claude-plugin entry is a file, not a directory,
    // and a symlink that points at a plugin.
    //
    // The symlink is the one that makes the isDirectory() guard
    // load-bearing. A listing entry answers from lstat, so a link reports
    // false there, while existsSync follows it and finds the manifest.
    // Without the guard, the same plugin would be counted twice, once
    // under each name.
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

// The rules of ADR 006: no import leaves a plugin, and no plugin holds a
// symlink. Every arm is proven on a synthetic tree, in the `root`-parameter
// pattern `pluginDirs` already uses, because a rule whose branches never run
// is a rule nobody enforces. The real `plugins/` tree is then run through
// the same functions, which is what makes them a guard, not an exercise.
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

  it('accepts the copy of lib in the plugin, and the imports of that copy', () => {
    // The whole convention in one example: each specifier stays inside the
    // plugin, the same in the checkout and in the installed copy.
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/scripts/a.ts': "import { assertNodeFloor } from '../src/lib/node-floor.ts'\n",
        'a/src/lib/node-floor.ts': '',
        'a/src/lib/args.ts': "import { ok } from './envelope.ts'\n",
        'a/src/lib/envelope.ts': '',
      },
    })
    expect(crossPluginImports(plugins)).toEqual([])
  })

  it('reads the copies too, and refuses an import out of one', () => {
    // A lib/ file whose import leaves lib/ works in the checkout. Its copy
    // in a plugin then imports a path that the installed plugin lacks.
    const plugins = build({
      plugins: ['a'],
      files: { 'a/src/lib/bad.ts': "import { x } from '../../../elsewhere.ts'\n" },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/lib/bad.ts: imports ../../../elsewhere.ts, which resolves outside the plugin',
    ])
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

  it('refuses the root lib reached around the copy', () => {
    // `../../../lib` resolves for a contributor who works in the
    // checkout, and for nobody who installed the plugin. The cache copy
    // has no repository root above it. A catch here is the difference
    // between a failed test and an unresolved import on a user's machine.
    const plugins = build({
      plugins: ['a'],
      files: { 'a/src/url.ts': "import { ok } from '../../../lib/envelope.ts'\n" },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.ts: imports ../../../lib/envelope.ts, which resolves outside the plugin',
    ])
  })

  it('refuses the harness from any file in a plugin, a test file included', () => {
    // The harness never ships. So a plugin file that reaches for it has an
    // import the installed plugin cannot resolve. Tests live under tests/
    // (ADR 004), so no file in a plugin has a reason to reach for it.
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/src/url.test.ts': "import { createGhMock } from '../../../harness/gh.ts'\n",
        'a/src/url.ts': "import { createGhMock } from '../../../harness/gh.ts'\n",
      },
    })
    expect(crossPluginImports(plugins)).toEqual([
      'a/src/url.test.ts: imports ../../../harness/gh.ts, which resolves outside the plugin',
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
    // This tree holds two properties, both invisible to the names the
    // other fixtures use. `plugins/gh-security` starts with the string
    // `plugins/gh`. So without the separator the containment test appends,
    // an import from `gh` into `gh-security` would read as though it
    // stayed inside itself, and the rule would stop holding for that
    // pair. This repository has `gh` today, and is one plugin away from a
    // `gh-*` sibling. The second violation is written in the plugin that
    // sorts last, so a scan that stopped after the first plugin would
    // report only one of the two.
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

  it('reads only .ts files, and never walks into a symlink', () => {
    // A walk into a link would read files that are not in the plugin.
    // `pluginSymlinks` refuses the link itself.
    const plugins = build({
      plugins: ['a'],
      files: {
        'a/README.md': "import { anything } from '../../b/src/thing.ts'\n",
        'a/src/url.ts': '',
      },
      links: { 'a/src/lib': path.join('..', '..', '..', 'lib') },
    })
    // Three levels up, not two. Walked as `plugins/a/src/lib/outward.ts`,
    // the specifier resolves to `plugins/elsewhere.ts`, outside the
    // plugin. So this arm goes red the moment the walk descends into the
    // link.
    writeFileSync(
      path.join(scratch, 'lib', 'outward.ts'),
      "import { x } from '../../../elsewhere.ts'\n",
    )
    expect(crossPluginImports(plugins)).toEqual([])
  })

  it('refuses each symlink in a plugin, wherever it points', () => {
    // A link out of the plugin is skipped by an install from a local path.
    // A link inside the plugin, a link to nothing and a link to a file are
    // refused too: a plugin holds real files only (ADR 006).
    const plugins = build({
      plugins: ['linked', 'inside', 'dangling', 'deep', 'plain'],
      files: {
        'inside/src/real.ts': '',
        'plain/src/url.ts': '',
        'plain/src/lib/gh.ts': '',
      },
      links: {
        'linked/src/lib': path.join('..', '..', '..', 'lib'),
        'inside/src/alias.ts': 'real.ts',
        'dangling/src/lib': path.join('..', 'nowhere'),
        'deep/skills/s/SKILL.md': path.join('..', '..', '..', 'elsewhere.md'),
      },
    })
    expect(pluginSymlinks(plugins)).toEqual([
      'dangling/src/lib is a symlink',
      'deep/skills/s/SKILL.md is a symlink',
      'inside/src/alias.ts is a symlink',
      'linked/src/lib is a symlink',
    ])
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
  // plugin's entry point is in `scripts/` since #185. The third list is
  // the one rule with no other way to turn red: claude.ai refuses `bin/`
  // at publish time, not anything here.
  expect(crossPluginImports()).toEqual([])
  expect(pluginSymlinks()).toEqual([])
  expect(binDirectories()).toEqual([])
})

// The two rules of ADR 004: a plugin holds only what an installed plugin
// uses at run time, and no directory in it takes the name of a component
// it is not.
describe('what a plugin ships', () => {
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  // Written out, not read from RESERVED_DIRECTORIES, so that a name gone
  // from that list turns this test red (ADR 004 decision 6 names all ten).
  const components = [
    'agents',
    'bin',
    'commands',
    'evals',
    'hooks',
    'monitors',
    'output-styles',
    'skills',
    'themes',
    'workflows',
  ]

  /** Empty files and directories under a new temporary root. A name that
   *  ends in `/` is a directory. */
  const tree = (entries: readonly string[]): string => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-ships-'))
    for (const entry of entries) {
      const full = path.join(scratch, entry)
      if (entry.endsWith('/')) mkdirSync(full, { recursive: true })
      else {
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, '')
      }
    }
    return scratch
  }

  it('refuses a test file, a test helper and a fixtures directory in a plugin or in lib', () => {
    const root = tree([
      'plugins/a/src/url.ts',
      'plugins/a/src/url.test.ts',
      'plugins/a/src/deep/url.test-support.ts',
      'plugins/a/src/fixtures/',
      'lib/gh.ts',
      'lib/gh.test.ts',
      'lib/fixtures/sleep.ts',
    ])
    expect(developmentFiles([path.join(root, 'plugins'), path.join(root, 'lib')])).toEqual([
      'lib/fixtures is a fixtures directory, and it would ship',
      'lib/gh.test.ts is test code, and it would ship',
      'plugins/a/src/deep/url.test-support.ts is test code, and it would ship',
      'plugins/a/src/fixtures is a fixtures directory, and it would ship',
      'plugins/a/src/url.test.ts is test code, and it would ship',
    ])
  })

  it('does not follow a symlink, so a file is reported once, at its real path', () => {
    const root = tree(['lib/gh.test.ts', 'plugins/a/src/'])
    symlinkSync(path.join('..', '..', '..', 'lib'), path.join(root, 'plugins', 'a', 'src', 'lib'))
    expect(developmentFiles([path.join(root, 'plugins')])).toEqual([])
  })

  it('refuses a linked fixtures directory, which the installer copies as a real one', () => {
    const root = tree(['plugins/a/src/', 'tests/fixtures/', 'tests/data.json'])
    const src = path.join(root, 'plugins', 'a', 'src')
    symlinkSync(path.join('..', '..', '..', 'tests', 'fixtures'), path.join(src, 'fixtures'))
    // A link to a file and a link to nothing are not directories.
    symlinkSync(path.join('..', '..', '..', 'tests', 'data.json'), path.join(src, 'data.json'))
    symlinkSync('missing', path.join(src, 'gone'))
    expect(developmentFiles([path.join(root, 'plugins')])).toEqual([
      'plugins/a/src/fixtures is a fixtures directory, and it would ship',
    ])
  })

  it('refuses a component name below the root, and commands at the root', () => {
    const root = tree([
      'plugins/a/.claude-plugin/',
      'plugins/a/skills/view/',
      'plugins/a/skills/view/hooks/',
      'plugins/a/hooks/',
      'plugins/a/src/deep/agents/',
      'plugins/b/.claude-plugin/',
      'plugins/b/commands/',
      'plugins/b/src/subcommands/',
      'plugins/c/.claude-plugin/',
      ...components.map((name) => `plugins/c/src/${name}/`),
    ])
    symlinkSync('subcommands', path.join(root, 'plugins', 'b', 'src', 'commands'))
    expect(reservedDirectoryNames(path.join(root, 'plugins'))).toEqual([
      'a/skills/view/hooks uses the name of a plugin component',
      'a/src/deep/agents uses the name of a plugin component',
      'b/commands is the legacy component; use skills/',
      'b/src/commands uses the name of a plugin component',
      ...components.map((name) => `c/src/${name} uses the name of a plugin component`),
    ])
  })

  it('refuses a # import in a plugin or in lib, which no installed plugin resolves', () => {
    const root = tree(['plugins/a/src/', 'lib/'])
    const files: Record<string, string> = {
      'plugins/a/src/url.ts': "import { x } from '#lib/args.ts'\nimport 'node:fs'\n",
      'plugins/a/hooks/entry.ts': "await import('#harness/gh.ts')\n",
      'plugins/a/src/ok.ts': "import { y } from './lib/args.ts'\n",
      'lib/gh.ts': "import { z } from '#gh/lib/args.ts'\n",
    }
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), text)
    }
    expect(packageImports([path.join(root, 'plugins'), path.join(root, 'lib')])).toEqual([
      'lib/gh.ts: imports #gh/lib/args.ts, which only this checkout resolves',
      'plugins/a/hooks/entry.ts: imports #harness/gh.ts, which only this checkout resolves',
      'plugins/a/src/url.ts: imports #lib/args.ts, which only this checkout resolves',
    ])
  })
})

describe('test code outside tests/', () => {
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('refuses a test file or a test helper that vitest never collects', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-stray-'))
    for (const name of [
      'root.test.ts',
      'harness/gh.test.ts',
      'scripts/deep/build.test-support.ts',
      '.claude/skills/s/check.test.ts',
      'harness/gh.ts',
      'tests/lib/args.test.ts',
      'tests/plugins/a/sync.test-support.ts',
      '.claude/worktrees/w/harness/gh.test.ts',
      '.git/hooks/x.test.ts',
      'node_modules/p/index.test.ts',
      'harness/node_modules/p/index.test.ts',
      'elsewhere/linked.test.ts',
    ]) {
      mkdirSync(path.dirname(path.join(scratch, name)), { recursive: true })
      writeFileSync(path.join(scratch, name), '')
    }
    // A link is not followed, the way the other walks here do not follow one.
    symlinkSync('elsewhere', path.join(scratch, 'linked'))
    expect(testsOutsideTests(scratch)).toEqual([
      '.claude/skills/s/check.test.ts is test code outside tests/',
      'elsewhere/linked.test.ts is test code outside tests/',
      'harness/gh.test.ts is test code outside tests/',
      'root.test.ts is test code outside tests/',
      'scripts/deep/build.test-support.ts is test code outside tests/',
    ])
  })
})

it('holds the ADR 004 rules over the real plugins and lib trees', () => {
  expect(developmentFiles()).toEqual([])
  expect(reservedDirectoryNames()).toEqual([])
  expect(packageImports()).toEqual([])
  expect(testsOutsideTests()).toEqual([])
})
