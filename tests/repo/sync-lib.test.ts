// The tests of `scripts/sync-lib.ts`, the root script that copies `lib/`
// into each plugin (ADR 006). A root script may run in process (`CLAUDE.md`).
// Each case builds a marketplace-shaped tree in a temporary directory, the
// same way `repo-layout.test.ts` does.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderText } from '../../lib/envelope.ts'
import { entry, type Host, libClosure, ROOT, syncLib } from '../../scripts/sync-lib.ts'

let scratch = ''

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

/** Write each file, keyed by its path relative to a new temporary root. */
const build = (files: Readonly<Record<string, string>>): string => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bje-sync-lib-'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true })
    writeFileSync(path.join(scratch, file), text)
  }
  return scratch
}

const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8')

/** The shared files of most trees: `a.ts` imports `b.ts`, and `b.ts` imports `c.ts`. */
const LIB = {
  'lib/a.ts': "import { b } from './b.ts'\n",
  'lib/b.ts': "export { c } from './c.ts'\n",
  'lib/c.ts': 'export const c = 1\n',
  'lib/unused.ts': 'export const u = 1\n',
} as const

describe('the closure of a plugin', () => {
  it('holds each direct import and each transitive one, from each .ts file in the plugin', () => {
    const root = build({
      ...LIB,
      // A specifier that leaves lib/ is not a lib/ file.
      'lib/d.ts': "import { x } from '../elsewhere.ts'\n",
      'lib/e.ts': 'export const e = 1\n',
      'lib/f.ts': 'export const f = 1\n',
      'plugins/p/src/x.ts': "import { a } from './lib/a.ts'\nimport { y } from './y.ts'\n",
      'plugins/p/src/y.ts': "import { readFileSync } from 'node:fs'\n",
      'plugins/p/src/subcommands/z.ts': "import { b } from '../lib/b.ts'\n",
      'plugins/p/scripts/p.ts': "await import('../src/lib/d.ts')\n",
      // A file outside src/ and scripts/ counts too.
      'plugins/p/hooks/h.ts': "import { e } from '../src/lib/e.ts'\n",
      'plugins/p/skills/s/tool.ts': "import { f } from '../../src/lib/f.ts'\n",
      // A file that is not .ts is not read.
      'plugins/p/README.md': "import { u } from './src/lib/unused.ts'\n",
      'plugins/p/src/notes.md': "import { u } from './lib/unused.ts'\n",
      // A stale copy is not read. Else it would keep itself alive.
      'plugins/p/src/lib/unused.ts': "import { u } from './unused.ts'\n",
    })
    expect(libClosure(root, 'p')).toEqual({
      outcome: 'ok',
      value: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    })
  })

  it('holds the imports of a plugin that has no src directory yet', () => {
    const root = build({
      ...LIB,
      'plugins/p/scripts/p.ts': "import { c } from '../src/lib/c.ts'\n",
    })
    expect(renderText(syncLib(['--check'], root)).stderr).toBe(
      'plugins/p/src/lib/c.ts: missing, lib/c.ts is imported',
    )
  })

  it('is empty for a plugin that imports no lib file', () => {
    const root = build({ ...LIB, 'plugins/p/src/x.ts': "import { y } from './y.ts'\n" })
    expect(libClosure(root, 'p')).toEqual({ outcome: 'ok', value: [] })
  })

  it('refuses an import of a file that lib does not hold', () => {
    const root = build({ ...LIB, 'plugins/p/src/x.ts': "import { z } from './lib/gone.ts'\n" })
    expect(renderText(syncLib(['--check'], root))).toEqual({
      stdout: '',
      stderr: 'plugins/p imports lib/gone.ts, which lib/ does not hold',
      exitCode: 2,
    })
  })
})

describe('the write', () => {
  it('replaces a link, writes a missing or changed copy, and removes a stale one', () => {
    const root = build({
      ...LIB,
      'plugins/linked/src/x.ts': "import { a } from './lib/a.ts'\n",
      'plugins/copied/src/x.ts': "import { c } from './lib/c.ts'\n",
      'plugins/copied/src/lib/c.ts': 'export const c = 2\n',
      'plugins/copied/src/lib/unused.ts': LIB['lib/unused.ts'],
      'plugins/copied/src/lib/deep/old.ts': '',
    })
    symlinkSync(path.join('..', '..', '..', 'lib'), path.join(root, 'plugins/linked/src/lib'))

    expect(renderText(syncLib([], root))).toEqual({
      stdout: [
        'plugins/copied/src/lib/c.ts: differs from lib/c.ts',
        'plugins/copied/src/lib/deep/old.ts: extra, no file in the plugin imports it',
        'plugins/copied/src/lib/unused.ts: extra, no file in the plugin imports it',
        'plugins/linked/src/lib: not a directory of copies',
        'plugins/linked/src/lib/a.ts: missing, lib/a.ts is imported',
        'plugins/linked/src/lib/b.ts: missing, lib/b.ts is imported',
        'plugins/linked/src/lib/c.ts: missing, lib/c.ts is imported',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    })
    expect(lstatSync(path.join(root, 'plugins/linked/src/lib')).isDirectory()).toBe(true)
    for (const file of ['a.ts', 'b.ts', 'c.ts']) {
      expect(read(root, `plugins/linked/src/lib/${file}`)).toBe(read(root, `lib/${file}`))
    }
    expect(read(root, 'plugins/copied/src/lib/c.ts')).toBe(LIB['lib/c.ts'])
    for (const file of ['unused.ts', 'deep/old.ts']) {
      expect(
        lstatSync(path.join(root, 'plugins/copied/src/lib', file), { throwIfNoEntry: false }),
      ).toBeUndefined()
    }
    // A second run finds nothing to do, and says nothing.
    expect(renderText(syncLib([], root))).toEqual({ stdout: '', stderr: '', exitCode: 0 })
    expect(renderText(syncLib(['--check'], root))).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('removes a src/lib that is a file, then writes the copies', () => {
    const root = build({
      ...LIB,
      'plugins/p/src/x.ts': "import { c } from './lib/c.ts'\n",
      'plugins/p/src/lib': 'not a directory\n',
    })
    expect(renderText(syncLib([], root))).toEqual({
      stdout: [
        'plugins/p/src/lib: not a directory of copies',
        'plugins/p/src/lib/c.ts: missing, lib/c.ts is imported',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    })
    expect(read(root, 'plugins/p/src/lib/c.ts')).toBe(LIB['lib/c.ts'])
  })

  it('writes nothing when one plugin refuses, not even for a plugin before it', () => {
    const root = build({
      ...LIB,
      'plugins/a/src/lib/unused.ts': '',
      'plugins/b/src/x.ts': "import { z } from './lib/gone.ts'\n",
    })
    expect(renderText(syncLib([], root)).exitCode).toBe(2)
    expect(read(root, 'plugins/a/src/lib/unused.ts')).toBe('')
  })

  it('asks nothing of a plugin with no src, or of a file in plugins/', () => {
    const root = build({ ...LIB, 'plugins/bare/README.md': '', 'plugins/stray.md': '' })
    expect(renderText(syncLib(['--check'], root))).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })
})

describe('the check', () => {
  const tree = (): string =>
    build({
      ...LIB,
      'plugins/p/src/x.ts': "import { a } from './lib/a.ts'\n",
      'plugins/p/src/lib/a.ts': LIB['lib/a.ts'],
      'plugins/p/src/lib/b.ts': LIB['lib/b.ts'],
      'plugins/p/src/lib/c.ts': LIB['lib/c.ts'],
    })

  it('passes, and prints nothing, when each copy matches', () => {
    expect(renderText(syncLib(['--check'], tree()))).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    })
  })

  it('fails on a changed, a missing and an extra copy, and writes nothing', () => {
    const root = tree()
    writeFileSync(path.join(root, 'plugins/p/src/lib/a.ts'), `${LIB['lib/a.ts']}// edit\n`)
    rmSync(path.join(root, 'plugins/p/src/lib/c.ts'))
    writeFileSync(path.join(root, 'plugins/p/src/lib/unused.ts'), LIB['lib/unused.ts'])

    expect(renderText(syncLib(['--check'], root))).toEqual({
      stdout: '',
      stderr: [
        'plugins/p/src/lib/a.ts: differs from lib/a.ts',
        'plugins/p/src/lib/c.ts: missing, lib/c.ts is imported',
        'plugins/p/src/lib/unused.ts: extra, no file in the plugin imports it',
      ].join('\n'),
      exitCode: 1,
    })
    expect(read(root, 'plugins/p/src/lib/a.ts')).toBe(`${LIB['lib/a.ts']}// edit\n`)
    expect(
      lstatSync(path.join(root, 'plugins/p/src/lib/c.ts'), { throwIfNoEntry: false }),
    ).toBeUndefined()
    expect(read(root, 'plugins/p/src/lib/unused.ts')).toBe(LIB['lib/unused.ts'])
  })

  it('fails on a copy that differs by one byte only', () => {
    // Text with the same length and other bytes: a size compare passes it.
    const root = tree()
    writeFileSync(path.join(root, 'plugins/p/src/lib/c.ts'), 'export const c = 2\n')
    expect(renderText(syncLib(['--check'], root)).stderr).toBe(
      'plugins/p/src/lib/c.ts: differs from lib/c.ts',
    )
  })

  it('refuses a flag it does not know, and writes nothing', () => {
    const root = tree()
    rmSync(path.join(root, 'plugins/p/src/lib/c.ts'))
    const result = renderText(syncLib(['--fix'], root))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).not.toBe('')
    expect(
      lstatSync(path.join(root, 'plugins/p/src/lib/c.ts'), { throwIfNoEntry: false }),
    ).toBeUndefined()
  })
})

describe('the entry', () => {
  /** A stand-in for `process`, which records what the entry writes. */
  const host = (): Host & { out: string; err: string } => {
    const h = {
      out: '',
      err: '',
      exitCode: undefined as number | string | null | undefined,
      stdout: { write: (text: string) => (h.out += text) },
      stderr: { write: (text: string) => (h.err += text) },
    }
    return h
  }

  it('does nothing when node did not run the file', () => {
    const h = host()
    entry(false, ['--check'], build({ ...LIB, 'plugins/p/src/lib/stale.ts': '' }), h)
    expect([h.out, h.err, h.exitCode]).toEqual(['', '', undefined])
  })

  it('refuses on a node with no import.meta.main, in place of a silent pass', () => {
    const h = host()
    entry(undefined, ['--check'], build({ ...LIB, 'plugins/p/src/lib/stale.ts': '' }), h)
    expect([h.out, h.err, h.exitCode]).toEqual([
      '',
      'sync-lib: this node has no import.meta.main; run it on node 22.18 or newer\n',
      2,
    ])
  })

  it('writes the lines of a failure to stderr, and sets the status', () => {
    const h = host()
    entry(true, ['--check'], build({ ...LIB, 'plugins/p/src/lib/stale.ts': '' }), h)
    expect([h.out, h.err, h.exitCode]).toEqual([
      '',
      'plugins/p/src/lib/stale.ts: extra, no file in the plugin imports it\n',
      1,
    ])
  })

  it('writes the lines of a write to stdout', () => {
    const h = host()
    entry(true, [], build({ ...LIB, 'plugins/p/src/lib/stale.ts': '' }), h)
    expect([h.out, h.err, h.exitCode]).toEqual([
      'plugins/p/src/lib/stale.ts: extra, no file in the plugin imports it\n',
      '',
      0,
    ])
  })
})

it('names the repository root', () => {
  expect(lstatSync(path.join(ROOT, 'scripts', 'sync-lib.ts')).isFile()).toBe(true)
})

it('finds each copy in this repository equal to lib', () => {
  // The guard: the synthetic trees above prove the check, and this runs it.
  expect(renderText(syncLib(['--check'], ROOT))).toEqual({ stdout: '', stderr: '', exitCode: 0 })
})
