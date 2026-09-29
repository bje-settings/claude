// The configs choose files by glob. RuleTester cannot see a glob that
// matches nothing, so this test runs ESLint itself over a tree built in a
// temporary directory. The tree is not committed, so neither the root lint
// nor Claude Code reads it as configuration.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ESLint, type Linter } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import plugin, {
  bje,
  configFor,
  recommended,
  strictSeverities,
} from '#eslint-plugin-claude/index.ts'

const long = 'a'.repeat(1025)
const badHooks = JSON.stringify({ hooks: { preToolUse: [] } })

const TREE: Record<string, string> = {
  'plugins/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'p', hooks: { Bogus: [] } }),
  'plugins/p/skills/s/SKILL.md': `---\nname: s\ndescription: ${long}\n---\n`,
  'plugins/p/commands/c.md': '# C\n',
  'plugins/p/hooks/hooks.json': badHooks,
  '.claude/commands/c.md': '# C\n',
  '.claude/settings.json': badHooks,
  '.claude/settings.local.json': badHooks,
  'docs/commands/c.md': '# Not a command\n',
  'docs/readme.md': '# Other Markdown\n',
  'other.json': badHooks,
}

let root = ''

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'eslint-plugin-claude-'))
  for (const [file, content] of Object.entries(TREE)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Each file with a report, and its rule ids with severity, as
 *  `file: rule@severity`. */
async function reports(config: Linter.Config[]): Promise<string[]> {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config })
  const results = await eslint.lintFiles(['.'])
  return results
    .flatMap((r) =>
      r.messages.map((m) => `${path.relative(root, r.filePath)}: ${m.ruleId}@${m.severity}`),
    )
    .sort()
}

const EXPECTED = (command: 1 | 2) => [
  `.claude/commands/c.md: @bje/claude/command-legacy-format@${command}`,
  '.claude/settings.json: @bje/claude/hooks-event-name-known@2',
  '.claude/settings.local.json: @bje/claude/hooks-event-name-known@2',
  `plugins/p/commands/c.md: @bje/claude/command-legacy-format@${command}`,
  'plugins/p/.claude-plugin/plugin.json: @bje/claude/hooks-event-name-known@2',
  'plugins/p/hooks/hooks.json: @bje/claude/hooks-event-name-known@2',
  'plugins/p/skills/s/SKILL.md: @bje/claude/skill-description-max-length@1',
]

describe('configs', () => {
  it('recommended reports each rule on its own files, at its own severity', async () => {
    expect(await reports(plugin.configs.recommended)).toEqual(EXPECTED(1).sort())
  })

  it('bje raises command-legacy-format to error', async () => {
    expect(await reports(plugin.configs.bje)).toEqual(EXPECTED(2).sort())
  })

  it('strict turns on every rule, at its bje severity or warn', async () => {
    expect(await reports(plugin.configs.strict)).toEqual(EXPECTED(2).sort())
  })
})

describe('severities', () => {
  const names = Object.keys(plugin.rules ?? {})

  it('names only rules the plugin has', () => {
    for (const map of [recommended, bje]) {
      for (const name of Object.keys(map)) {
        expect(names).toContain(name)
      }
    }
  })

  it('strict turns on at warn a rule that the base leaves off or omits', () => {
    expect(strictSeverities(['a', 'b', 'c', 'd'], { a: 'error', b: 'off', c: 'warn' })).toEqual({
      a: 'error',
      b: 'warn',
      c: 'warn',
      d: 'warn',
    })
  })

  it('builds no config object for a rule that is off or absent', () => {
    const built = configFor('t', { 'hooks-event-name-known': 'off' })
    expect(built).toEqual([])
    const one = configFor('t', { 'hooks-event-name-known': 'error' })
    expect(one.map((c) => c.name)).toEqual(['@bje/claude/t/hooks-event-name-known'])
  })
})
