// The child servers lsp-merge runs, from `.claude/lsp-merge.json` in the
// project. The proxy reads the file on each start and keeps no copy
// (`.claude/rules/_design-principles.md`, State).
//
// Each entry has the shape of one server in a plugin's `.lsp.json`
// (https://code.claude.com/docs/en/plugins-reference#lspservers), keyed by
// a name. So a person copies a server from another plugin's README without
// a change. Entry order is the routing order: for a file, the first entry
// that claims its extension answers requests (`router.ts`).
//
// The proxy never reads another plugin's files from the Claude Code
// plugin cache. That layout is not documented.
import path from 'node:path'

/** One child server, after validation and substitution. */
export interface ChildConfig {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly extensionToLanguage: Readonly<Record<string, string>>
  readonly initializationOptions: unknown
  readonly settings: unknown
}

export type ConfigResult =
  | { readonly outcome: 'ok'; readonly children: readonly ChildConfig[] }
  | { readonly outcome: 'invalid'; readonly errors: readonly string[] }

/** Where the config lives in a project. */
export const configPath = (projectDir: string): string =>
  path.join(projectDir, '.claude', 'lsp-merge.json')

/** The keys a `.lsp.json` server may carry. Claude Code refuses any other
 *  key, and so does this file. The proxy uses the first six. It accepts the
 *  rest so that a copied entry stays valid, and ignores them: they tell
 *  Claude Code how to run a server, and Claude Code runs only lsp-merge. */
const USED_KEYS = [
  'command',
  'args',
  'env',
  'extensionToLanguage',
  'initializationOptions',
  'settings',
]
const IGNORED_KEYS = [
  'transport',
  'workspaceFolder',
  'startupTimeout',
  'shutdownTimeout',
  'restartOnCrash',
  'maxRestarts',
  'diagnostics',
]
const KNOWN_KEYS = new Set([...USED_KEYS, ...IGNORED_KEYS])

// Spelled in two pieces because biome refuses `${` inside a plain string.
const PROJECT_DIR_TOKEN = `$${'{'}CLAUDE_PROJECT_DIR}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string')

/** Validate one entry, and push each problem onto `errors`. */
const checkEntry = (
  name: string,
  entry: unknown,
  errors: string[],
): entry is Record<string, unknown> => {
  if (!isRecord(entry)) {
    errors.push(`${name}: must be an object`)
    return false
  }
  const before = errors.length
  for (const key of Object.keys(entry)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`${name}: unknown key "${key}"`)
  }
  if (typeof entry.command !== 'string' || entry.command === '') {
    errors.push(`${name}: "command" must be a non-empty string`)
  }
  if (
    entry.args !== undefined &&
    !(Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string'))
  ) {
    errors.push(`${name}: "args" must be an array of strings`)
  }
  if (entry.env !== undefined && !isStringRecord(entry.env)) {
    errors.push(`${name}: "env" must be an object of strings`)
  }
  const map = entry.extensionToLanguage
  if (!isStringRecord(map) || Object.keys(map).length === 0) {
    errors.push(`${name}: "extensionToLanguage" must be a non-empty object of strings`)
  } else {
    // The same rule Claude Code applies to its own `.lsp.json` at run time.
    for (const extension of Object.keys(map)) {
      if (!extension.startsWith('.') || extension.length < 2) {
        errors.push(`${name}: extension "${extension}" must start with "." (for example ".ts")`)
      }
    }
  }
  return errors.length === before
}

/** Put the project directory in place of each `${CLAUDE_PROJECT_DIR}`. */
const substitute = (value: string, projectDir: string): string =>
  value.replaceAll(PROJECT_DIR_TOKEN, projectDir)

/** Parse and validate the text of `lsp-merge.json`. */
export const parseConfig = (text: string, projectDir: string): ConfigResult => {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { outcome: 'invalid', errors: [`not valid JSON: ${(error as Error).message}`] }
  }
  if (!isRecord(document) || Object.keys(document).length === 0) {
    return { outcome: 'invalid', errors: ['must be an object with one entry for each server'] }
  }
  const errors: string[] = []
  const children: ChildConfig[] = []
  for (const [name, entry] of Object.entries(document)) {
    if (!checkEntry(name, entry, errors)) continue
    children.push({
      name,
      command: substitute(entry.command as string, projectDir),
      args: ((entry.args as string[] | undefined) ?? []).map((arg) => substitute(arg, projectDir)),
      env: Object.fromEntries(
        Object.entries((entry.env as Record<string, string> | undefined) ?? {}).map(
          ([key, value]) => [key, substitute(value, projectDir)],
        ),
      ),
      extensionToLanguage: entry.extensionToLanguage as Record<string, string>,
      initializationOptions: entry.initializationOptions,
      settings: entry.settings,
    })
  }
  return errors.length === 0 ? { outcome: 'ok', children } : { outcome: 'invalid', errors }
}

/** Read and parse the config of `projectDir`. `readFile` is the edge a
 *  test replaces. A file that is not there is one error, not a throw. */
export const loadConfig = (
  projectDir: string,
  readFile: (file: string) => string,
): ConfigResult => {
  const file = configPath(projectDir)
  let text: string
  try {
    text = readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'is missing' : `cannot be read (${code ?? 'unknown error'})`
    return { outcome: 'invalid', errors: [`${file} ${reason}`] }
  }
  const result = parseConfig(text, projectDir)
  if (result.outcome === 'ok') return result
  return { outcome: 'invalid', errors: result.errors.map((error) => `${file}: ${error}`) }
}
