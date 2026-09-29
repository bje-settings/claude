// A command file is the legacy form of a skill (docs/rules/command-legacy-format.md).
// The glob is broad, so the rule itself checks that the `commands/`
// directory is one that Claude Code reads: `.claude/commands/`, or
// `commands/` at the root of a plugin.
import path from 'node:path'
import type { MarkdownRuleDefinition } from '@eslint/markdown'
import { docsUrl } from '../docs-url.ts'
import { isPluginRoot } from '../plugin-root.ts'

export const name = 'command-legacy-format'
export const language = 'markdown'
export const files = ['**/commands/**/*.md']

/** True when `file` is under a `commands/` directory that Claude Code
 *  reads as commands. */
export function isCommandFile(file: string): boolean {
  const parts = path.resolve(file).split(path.sep)
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] !== 'commands') {
      continue
    }
    const parent = parts.slice(0, i).join(path.sep) || path.sep
    if (parts[i - 1] === '.claude' || isPluginRoot(parent)) {
      return true
    }
  }
  return false
}

export const rule: MarkdownRuleDefinition<{ MessageIds: 'legacy' }> = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Use a skill, not the legacy command format',
      url: docsUrl(name),
    },
    schema: [],
    messages: {
      legacy:
        'Commands are the legacy form of a skill. Move this file to `skills/<name>/SKILL.md`.',
    },
  },
  create(context) {
    return {
      root(node) {
        if (isCommandFile(context.filename)) {
          context.report({ node, messageId: 'legacy' })
        }
      },
    }
  },
}
