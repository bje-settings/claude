// Claude Code skips a hook under an event name that it does not know, with
// no error (docs/rules/hooks-event-name-known.md). The same `hooks` object
// is in `hooks/hooks.json`, in settings, and inline in `plugin.json`.
import type { JSONRuleDefinition } from '@eslint/json'
import { HOOK_EVENTS } from '../data/hook-events.ts'
import { docsUrl } from '../docs-url.ts'

export const name = 'hooks-event-name-known'
export const language = 'json'
export const files = [
  '**/hooks/hooks.json',
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '**/.claude-plugin/plugin.json',
]

type Options = [{ additionalEvents: string[] }]

/** The letters of a name, in lowercase, with no `_`, `-` or space. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The text of a member name: a string in JSON, or a bare identifier in
 *  JSON5. */
function keyOf(
  name: { type: 'String'; value: string } | { type: 'Identifier'; name: string },
): string {
  return name.type === 'String' ? name.value : name.name
}

/** The Levenshtein distance between `a` and `b`. */
export function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

/** The known event that `key` is a near miss of, or null. A near miss has
 *  the same letters with a different case or separator, or is at most two
 *  edits from a known name. */
export function nearMiss(key: string, known: readonly string[]): string | null {
  const folded = fold(key)
  let best: string | null = null
  let bestDistance = 3
  for (const event of known) {
    if (fold(event) === folded) {
      return event
    }
    const d = distance(folded, fold(event))
    if (d < bestDistance) {
      best = event
      bestDistance = d
    }
  }
  return best
}

export const rule: JSONRuleDefinition<{
  RuleOptions: Options
  MessageIds: 'unknown' | 'nearMiss' | 'rename'
}> = {
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description: 'Use a hook event name that Claude Code knows',
      url: docsUrl(name),
    },
    schema: [
      {
        type: 'object',
        properties: {
          additionalEvents: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ additionalEvents: [] }],
    messages: {
      unknown: 'Claude Code does not know the hook event "{{key}}", and skips it.',
      nearMiss:
        'Claude Code does not know the hook event "{{key}}", and skips it. Did you mean "{{event}}"?',
      rename: 'Rename to "{{event}}".',
    },
  },
  create(context) {
    const known = [...HOOK_EVENTS, ...context.options[0].additionalEvents]
    return {
      Document(node) {
        if (node.body.type !== 'Object') {
          return
        }
        const hooks = node.body.members.find((member) => keyOf(member.name) === 'hooks')
        if (hooks === undefined || hooks.value.type !== 'Object') {
          return
        }
        for (const member of hooks.value.members) {
          const key = keyOf(member.name)
          if (known.includes(key)) {
            continue
          }
          const event = nearMiss(key, known)
          if (event === null) {
            context.report({ node: member.name, messageId: 'unknown', data: { key } })
            continue
          }
          context.report({
            node: member.name,
            messageId: 'nearMiss',
            data: { key, event },
            suggest: [
              {
                messageId: 'rename',
                data: { event },
                fix: (fixer) => fixer.replaceText(member.name, JSON.stringify(event)),
              },
            ],
          })
        }
      },
    }
  },
}
