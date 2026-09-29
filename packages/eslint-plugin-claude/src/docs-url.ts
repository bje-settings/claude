// The page that an editor opens from a report. Each rule has one doc under
// `docs/rules/` (ADR 005). A test checks that the doc exists.
const DOCS =
  'https://github.com/bje-settings/claude/blob/main/packages/eslint-plugin-claude/docs/rules'

/** The URL of the doc for the rule `name`. */
export function docsUrl(name: string): string {
  return `${DOCS}/${name}.md`
}
