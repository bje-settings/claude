// A skill description is limited in two places (docs/rules/skill-description-max-length.md):
// the Agent Skills spec limits `description` to 1,024 characters, and the
// Claude Code skill listing cuts `description` plus `when_to_use` at 1,536.
import type { MarkdownRuleDefinition } from '@eslint/markdown'
import { docsUrl } from '../docs-url.ts'
import { parseFrontmatter, stringField } from '../frontmatter.ts'

export const name = 'skill-description-max-length'
export const language = 'markdown'
export const files = ['**/SKILL.md']

type Options = [{ max: number; listingMax: number }]

export const rule: MarkdownRuleDefinition<{
  RuleOptions: Options
  MessageIds: 'descriptionTooLong' | 'listingTruncated'
}> = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Limit the length of a skill description',
      url: docsUrl(name),
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 1 },
          listingMax: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ max: 1024, listingMax: 1536 }],
    messages: {
      descriptionTooLong:
        '`description` has {{length}} characters. The Agent Skills limit is {{max}}.',
      listingTruncated:
        '`description` plus `when_to_use` has {{length}} characters. The skill listing cuts it at {{max}}.',
    },
  },
  create(context) {
    const [{ max, listingMax }] = context.options
    return {
      yaml(node) {
        const data = parseFrontmatter(node.value)
        if (data === null) {
          return
        }
        const description = stringField(data, 'description')
        if (description.length > max) {
          context.report({
            node,
            messageId: 'descriptionTooLong',
            data: { length: String(description.length), max: String(max) },
          })
        }
        const listing = description.length + stringField(data, 'when_to_use').length
        if (listing > listingMax) {
          context.report({
            node,
            messageId: 'listingTruncated',
            data: { length: String(listing), max: String(listingMax) },
          })
        }
      },
    }
  },
}
