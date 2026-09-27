// Plugin monitors. `claude plugin validate --strict` does not read the
// entries of a plugin's `monitors/monitors.json`, at 2.1.263 or at
// 2.1.283: an unknown key passes both. Claude Code refuses the entry only
// when it loads the plugin, and a monitor loads only in an interactive
// session. So this file makes the checks the validator leaves out
// (plugins/manifest-reference, "monitors").
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginDirs } from './repo.ts'

const KEYS = ['name', 'command', 'description', 'when']
const REQUIRED = ['name', 'command', 'description']
const SKILL_INVOKE = /^on-skill-invoke:([a-z0-9-]+)$/
const DISPATCHER = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w-]+\.ts)"/

/** Each problem with the monitors of each plugin under `root`. */
function monitorProblems(root?: string): string[] {
  const problems: string[] = []
  for (const plugin of pluginDirs(root)) {
    const file = path.join(plugin, 'monitors', 'monitors.json')
    if (!existsSync(file)) continue
    const where = path.relative(path.dirname(plugin), file)
    const entries: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(entries)) {
      problems.push(`${where}: not an array`)
      continue
    }
    const names = new Set<string>()
    for (const entry of entries as Record<string, unknown>[]) {
      const label = `${where}: ${String(entry.name)}`
      for (const key of Object.keys(entry)) {
        if (!KEYS.includes(key)) problems.push(`${label}: unknown key ${key}`)
      }
      for (const key of REQUIRED) {
        if (typeof entry[key] !== 'string' || entry[key] === '') {
          problems.push(`${label}: no ${key}`)
        }
      }
      if (names.has(String(entry.name))) problems.push(`${label}: name used twice`)
      names.add(String(entry.name))
      const when = entry.when ?? 'always'
      const skill = typeof when === 'string' ? SKILL_INVOKE.exec(when) : null
      if (when !== 'always' && skill === null) problems.push(`${label}: when ${String(when)}`)
      if (
        skill !== null &&
        !existsSync(path.join(plugin, 'skills', skill[1] as string, 'SKILL.md'))
      ) {
        problems.push(`${label}: no skill ${skill[1]}`)
      }
      const script = DISPATCHER.exec(String(entry.command))
      if (script !== null && !existsSync(path.join(plugin, script[1] as string))) {
        problems.push(`${label}: no ${script[1]}`)
      }
    }
  }
  return problems.sort()
}

it('finds a monitor to check', () => {
  // Without one, the check below passes on nothing.
  expect(
    pluginDirs().some((plugin) => existsSync(path.join(plugin, 'monitors', 'monitors.json'))),
  ).toBe(true)
})

it('gives every monitor only known keys, the required ones, a skill and a script that exist', () => {
  expect(monitorProblems()).toEqual([])
})

describe('the monitor check, on a synthetic plugin', () => {
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('refuses an unknown key, an absent field, a repeated name, and a skill or script that does not exist', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-monitors-'))
    const plugin = path.join(scratch, 'p')
    mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
    mkdirSync(path.join(plugin, 'monitors'), { recursive: true })
    const root = '$' + '{CLAUDE_PLUGIN_ROOT}'
    const entries = [
      {
        name: 'a',
        command: `node "${root}/scripts/p.ts" watch`,
        description: 'd',
        when: 'on-skill-invoke:start',
        extra: 1,
      },
      { name: 'a', command: 'true', when: 'sometimes' },
    ]
    writeFileSync(path.join(plugin, 'monitors', 'monitors.json'), JSON.stringify(entries))
    expect(monitorProblems(scratch)).toEqual([
      'p/monitors/monitors.json: a: name used twice',
      'p/monitors/monitors.json: a: no description',
      'p/monitors/monitors.json: a: no scripts/p.ts',
      'p/monitors/monitors.json: a: no skill start',
      'p/monitors/monitors.json: a: unknown key extra',
      'p/monitors/monitors.json: a: when sometimes',
    ])
  })
})
