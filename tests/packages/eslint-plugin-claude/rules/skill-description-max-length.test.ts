// Fixtures sit on each side of both limits: 1,024 characters of
// `description` (Agent Skills spec), and 1,536 of `description` plus
// `when_to_use` (the Claude Code skill listing).
import { rule } from '#eslint-plugin-claude/rules/skill-description-max-length.ts'
import { markdownTester } from '../rule-tester.test-support.ts'

const skill = (fields: string) => `---\nname: s\n${fields}---\n\n# S\n`
const text = (n: number) => 'a'.repeat(n)

markdownTester.run('skill-description-max-length', rule as never, {
  valid: [
    { code: skill(`description: ${text(1024)}\n`) },
    { code: skill(`description: ${text(1024)}\nwhen_to_use: ${text(512)}\n`) },
    { code: '# No frontmatter\n' },
    { code: skill('description: [unclosed\n') },
    { code: skill('description: 3\n') },
    { code: skill(`description: ${text(1500)}\n`), options: [{ max: 1536 }] },
    { code: skill(`description: >-\n  ${text(1000)}\n  ${text(23)}\n`) },
  ],
  invalid: [
    {
      code: skill(`description: ${text(1025)}\n`),
      errors: [{ messageId: 'descriptionTooLong', data: { length: '1025', max: '1024' } }],
    },
    {
      code: skill(`description: ${text(1000)}\nwhen_to_use: ${text(537)}\n`),
      errors: [{ messageId: 'listingTruncated', data: { length: '1537', max: '1536' } }],
    },
    {
      code: skill(`description: ${text(1600)}\n`),
      errors: [{ messageId: 'descriptionTooLong' }, { messageId: 'listingTruncated' }],
    },
    {
      code: skill(`description: ${text(101)}\nwhen_to_use: ${text(100)}\n`),
      options: [{ max: 100, listingMax: 200 }],
      errors: [{ messageId: 'descriptionTooLong' }, { messageId: 'listingTruncated' }],
    },
  ],
})
