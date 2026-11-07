// The tests of `scripts/plugin-test.ts`, the root script that runs a
// function-hooks plugin's tests with `claude plugin test` (ADR 007). A fake
// `claude` on PATH records the folder it gets and answers a chosen status.
// The script deletes a folder, so each case also checks that the folder is
// gone (`CLAUDE.md`, "Fixture quality").
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runScript } from '#harness/spawn.ts'
import { entry, type Host, pluginTest, ROOT, runClaude } from '../../scripts/plugin-test.ts'

let scratch = ''
const savedPath = process.env.PATH

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bje-plugin-test-spec-'))
})

afterEach(() => {
  process.env.PATH = savedPath
  delete process.env.FAKE_STATUS
  rmSync(scratch, { recursive: true, force: true })
})

/** Write each file, keyed by its path relative to a new tree root. */
const build = (files: Readonly<Record<string, string>>): string => {
  const root = path.join(scratch, 'tree')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  mkdirSync(path.join(root, 'plugins'), { recursive: true })
  return root
}

const LOG = () => path.join(scratch, 'log')

/** Put a `claude` first on PATH. It logs its folder and files, then answers FAKE_STATUS. */
const fakeClaude = (): void => {
  const bin = path.join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = path.join(bin, 'claude')
  writeFileSync(
    script,
    `#!/bin/sh\necho "$1 $2 $3" >> "${LOG()}"\n(cd "$3" && find . -type f | sort) >> "${LOG()}"\nexit "\${FAKE_STATUS:-0}"\n`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
}

/** The folders that the fake `claude` was asked to test. */
const folders = (): string[] =>
  existsSync(LOG())
    ? readFileSync(LOG(), 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('plugin test '))
        .map((l) => l.slice('plugin test '.length))
    : []

const MODS = {
  'plugins/mod/hooks/hooks.json': '{"modules": ["./register.ts"]}',
  'plugins/mod/hooks/register.ts': 'export {}\n',
  'plugins/mod/.claude-plugin/plugin.json': '{}',
  'plugins/mod/skip.txt': 'x',
  'tests/plugins/mod/a.test.tsx': 'a',
  'tests/plugins/mod/deep/b.test.tsx': 'b',
  'tests/plugins/mod/helper.ts': 'not a test',
  'plugins/plain/hooks/hooks.json': '{"hooks": {}}',
  'plugins/plain/other.txt': 'x',
  'plugins/bare/x.txt': 'x',
  'plugins/odd/hooks/hooks.json': 'null',
}

describe('plugin-test with no argument', () => {
  it('says so and exits 0 when no plugin has modules', () => {
    fakeClaude()
    const result = pluginTest(
      [],
      build({ 'plugins/plain/hooks/hooks.json': '{"hooks": {}}' }),
      runClaude,
    )
    expect(result).toEqual({
      stdout: 'plugin-test: no plugin has hooks modules',
      stderr: '',
      exitCode: 0,
    })
    expect(folders()).toEqual([])
  })

  it('runs each plugin with modules, copies its files and its tsx tests, and removes the folder', () => {
    fakeClaude()
    const result = pluginTest([], build(MODS), runClaude)
    expect(result.exitCode).toBe(0)
    const [folder, ...rest] = folders()
    expect(rest).toEqual([])
    expect(readFileSync(LOG(), 'utf8')).toBe(
      [
        `plugin test ${folder}`,
        './.claude-plugin/plugin.json',
        './hooks/hooks.json',
        './hooks/register.ts',
        './skip.txt',
        './tests/a.test.tsx',
        './tests/deep/b.test.tsx',
        '',
      ].join('\n'),
    )
    expect(existsSync(folder as string)).toBe(false)
  })
})

describe('plugin-test with a plugin', () => {
  it('runs a plugin that has no tests directory and no modules, and removes the folder', () => {
    fakeClaude()
    const result = pluginTest(['bare'], build(MODS), runClaude)
    expect(result.exitCode).toBe(0)
    expect(folders()).toHaveLength(1)
    expect(existsSync(folders()[0] as string)).toBe(false)
  })

  it('passes a failing status through, and removes the folder', () => {
    fakeClaude()
    process.env.FAKE_STATUS = '7'
    const result = pluginTest(['mod'], build(MODS), runClaude)
    expect(result.exitCode).toBe(7)
    expect(existsSync(folders()[0] as string)).toBe(false)
  })

  it('keeps the first failing status when several plugins run', () => {
    const root = build({
      'plugins/a/hooks/hooks.json': '{"modules": []}',
      'plugins/b/hooks/hooks.json': '{"modules": []}',
    })
    const seen: string[] = []
    const statuses = [3, 5]
    const result = pluginTest([], root, (folder) => {
      seen.push(folder)
      return statuses.shift() as number
    })
    expect(result.exitCode).toBe(3)
    expect(seen).toHaveLength(2)
    for (const folder of seen) expect(existsSync(folder)).toBe(false)
  })

  it('removes the folder when the run throws', () => {
    let seen = ''
    expect(() =>
      pluginTest(['mod'], build(MODS), (folder) => {
        seen = folder
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(seen)).toBe(false)
  })

  it('refuses an unknown plugin with exit 2 and the usage line, and runs nothing', () => {
    fakeClaude()
    const result = pluginTest(['nope'], build(MODS), runClaude)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe('unknown plugin nope\nusage: node scripts/plugin-test.ts [<plugin>]')
    expect(folders()).toEqual([])
  })

  it('refuses a stray argument and a flag with exit 2', () => {
    fakeClaude()
    const root = build(MODS)
    const stray = pluginTest(['mod', 'bare'], root, runClaude)
    expect(stray.exitCode).toBe(2)
    expect(stray.stderr).toBe('usage: node scripts/plugin-test.ts [<plugin>]')
    expect(pluginTest(['--nope'], root, runClaude).exitCode).toBe(2)
    expect(folders()).toEqual([])
  })
})

describe('runClaude', () => {
  it('answers 1 when claude cannot start', () => {
    process.env.PATH = path.join(scratch, 'empty')
    expect(runClaude(scratch)).toBe(1)
  })
})

describe('the entry', () => {
  const host = () => {
    const h: Host & { out: string; err: string } = {
      out: '',
      err: '',
      stdout: { write: (t) => (h.out += t) },
      stderr: { write: (t) => (h.err += t) },
    }
    return h
  }

  it('does nothing when the file is imported', () => {
    const h = host()
    entry(false, ['nope'], build(MODS), h, () => 9)
    expect(h).toMatchObject({ out: '', err: '' })
    expect(h.exitCode).toBeUndefined()
  })

  it('refuses a node with no import.meta.main', () => {
    const h = host()
    entry(undefined, [], build(MODS), h, () => 9)
    expect(h.exitCode).toBe(2)
    expect(h.err).toContain('import.meta.main')
  })

  it('writes the stdout line and sets the status', () => {
    const h = host()
    entry(true, [], build({}), h, () => 9)
    expect(h).toMatchObject({
      out: 'plugin-test: no plugin has hooks modules\n',
      err: '',
      exitCode: 0,
    })
  })

  it('writes stderr and sets the refusal status', () => {
    const h = host()
    entry(true, ['nope'], build(MODS), h, () => 9)
    expect(h.out).toBe('')
    expect(h.err).toContain('unknown plugin nope')
    expect(h.exitCode).toBe(2)
  })

  it('passes the status of the run to the host', () => {
    const h = host()
    entry(true, ['mod'], build(MODS), h, () => 9)
    expect(h.exitCode).toBe(9)
  })

  it('uses the real runner by default', () => {
    fakeClaude()
    const h = host()
    entry(true, ['bare'], build(MODS), h)
    expect(h.exitCode).toBe(0)
    expect(folders()).toHaveLength(1)
  })
})

describe('the script as a process', () => {
  it('exits 2 with the reason for an unknown plugin', () => {
    fakeClaude()
    const result = runScript(path.join(ROOT, 'scripts', 'plugin-test.ts'), {
      args: ['no-such-plugin'],
      env: process.env,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown plugin no-such-plugin')
  })
})
