// @bje/eslint-plugin-claude: lint rules for Claude Code configuration
// files (ADR 005). Each rule module names its own files and language, so a
// new rule adds no entry to a central glob list.
//
// Three configs:
// - `recommended`: rules whose source is Anthropic documentation.
// - `bje`: `recommended` plus the conventions of the bje enterprise.
// - `strict`: `bje`, then each rule that is still off at `warn`.
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import type { ESLint, Linter } from 'eslint'
import * as commandLegacyFormat from './rules/command-legacy-format.ts'
import * as hooksEventNameKnown from './rules/hooks-event-name-known.ts'
import * as skillDescriptionMaxLength from './rules/skill-description-max-length.ts'

type Severity = 'off' | 'warn' | 'error'

export const PREFIX = '@bje/claude'

const modules = [skillDescriptionMaxLength, commandLegacyFormat, hooksEventNameKnown]

const LANGUAGES: Record<string, Linter.Config> = {
  markdown: { language: 'markdown/gfm', languageOptions: { frontmatter: 'yaml' } },
  json: { language: 'json/json' },
}

export const recommended: Record<string, Severity> = {
  'skill-description-max-length': 'warn',
  'command-legacy-format': 'warn',
  'hooks-event-name-known': 'error',
}

export const bje: Record<string, Severity> = {
  ...recommended,
  'command-legacy-format': 'error',
}

/** Each rule in `names` at its severity in `base`, or at `warn` when
 *  `base` leaves it off. */
export function strictSeverities(
  names: readonly string[],
  base: Record<string, Severity>,
): Record<string, Severity> {
  const out: Record<string, Severity> = {}
  for (const name of names) {
    const severity = base[name] ?? 'off'
    out[name] = severity === 'off' ? 'warn' : severity
  }
  return out
}

type Configs = Record<'recommended' | 'bje' | 'strict', Linter.Config[]>

const plugin = {
  meta: { name: '@bje/eslint-plugin-claude', version: '0.1.0' },
  rules: Object.fromEntries(modules.map((m) => [m.name, m.rule])),
  configs: {} as Configs,
} as unknown as ESLint.Plugin & { configs: Configs }

/** One config object for each rule that `severities` turns on, with the
 *  rule's own files and language. */
export function configFor(config: string, severities: Record<string, Severity>): Linter.Config[] {
  return modules
    .filter((m) => (severities[m.name] ?? 'off') !== 'off')
    .map((m) => ({
      name: `${PREFIX}/${config}/${m.name}`,
      files: m.files,
      plugins: { [PREFIX]: plugin, markdown, json } as Record<string, ESLint.Plugin>,
      ...LANGUAGES[m.language],
      rules: { [`${PREFIX}/${m.name}`]: severities[m.name] as Severity },
    }))
}

plugin.configs.recommended = configFor('recommended', recommended)
plugin.configs.bje = configFor('bje', bje)
plugin.configs.strict = configFor(
  'strict',
  strictSeverities(
    modules.map((m) => m.name),
    bje,
  ),
)

export default plugin
