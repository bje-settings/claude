// The command function behind the lsp-merge plugin's `SessionStart` hook.
// `hooks/session-start.ts` calls it with the process's own edges, so a test
// calls it with no process (`.claude/rules/type-ts.md`).
//
// It checks three things, and writes nothing when all of them hold
// (`.claude/rules/_design-principles.md`, Dependencies outside a plugin):
//
// 1. The dependency table: the `claude` CLI, which the conflict check runs.
//    A missing required tool stops all other checks
//    (`.claude/rules/path-hooks.md`).
// 2. The config: `.claude/lsp-merge.json` is there and valid. The proxy
//    exits without it, and lsp-merge still claims its extensions.
// 3. Conflicts: another enabled plugin with a language server. Claude Code
//    gives each extension to one server only, so that plugin can take
//    extensions from lsp-merge (ADR 006). `claude plugin list --json` names
//    the enabled plugins. `claude plugin details <id>` counts the language
//    servers of each one. The hook never reads the plugin cache: that layout
//    is not documented. If `details` cannot answer in time, the `*-lsp` name
//    convention decides for that plugin.
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

import { configPath, loadConfig } from '../config.ts'
import { recordOf } from '../jsonrpc.ts'
import { absentDependencies, type Dependency } from '../lib/dependencies.ts'
import { emit } from '../lib/hook-output.ts'
import type { Runner } from '../lib/process.ts'
import type { Output } from '../lib/streams.ts'

/** The time the whole check may take, in milliseconds. `hooks.json` gives
 *  the hook 3 seconds. The list and the details calls each get half. */
export const DEADLINE_MS = 2_500

const PLUGIN_PREFIX = 'lsp-merge'

const DEPENDENCIES: readonly Dependency[] = [
  { tool: 'claude', label: 'the Claude Code CLI (claude)' },
]

export interface SessionStartEdges {
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly run: Runner
  readonly deadlineMs: number
  /** The directory the hook runs in. Claude Code sets
   *  `CLAUDE_PROJECT_DIR`, and this is the fallback. */
  readonly cwd: string
  readonly readFile: (file: string) => string
}

/** Whether `tool` is on `env.PATH`. A PATH walk in the shape of the
 *  workstreams hook's own `which`, because nothing crosses a plugin
 *  boundary but `lib/`. */
const which = (tool: string, env: NodeJS.ProcessEnv): boolean => {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isDirectory()) return true
    } catch {
      // Not here, or not executable. Check the next directory.
    }
  }
  return false
}

/** Whether the text of `claude plugin details` shows a language server, or
 *  `null` when the text has no count to read. */
export const hasLanguageServer = (details: string): boolean | null => {
  const match = /^\s*LSP servers \((\d+)\)/m.exec(details)
  return match === null ? null : Number(match[1]) > 0
}

/** The ids of the enabled plugins in `claude plugin list --json` output,
 *  other than lsp-merge itself, or `null` when the output is not a list. */
export const enabledPlugins = (listing: string): string[] | null => {
  let document: unknown
  try {
    document = JSON.parse(listing)
  } catch {
    return null
  }
  if (!Array.isArray(document)) return null
  return document.flatMap((entry) => {
    const { id, enabled } = recordOf(entry)
    return enabled === true && typeof id === 'string' && !id.startsWith(`${PLUGIN_PREFIX}@`)
      ? [id]
      : []
  })
}

/** The enabled plugins, other than lsp-merge, that run a language server,
 *  or `null` when the list of enabled plugins cannot be read. */
const conflictingPlugins = async (
  edges: SessionStartEdges,
  projectDir: string,
): Promise<string[] | null> => {
  const options = { env: edges.env, cwd: projectDir, timeoutMs: edges.deadlineMs / 2 }
  const list = await edges.run('claude', ['plugin', 'list', '--json'], options)
  const ids = list.status === 0 ? enabledPlugins(list.stdout) : null
  if (ids === null) return null
  const verdicts = await Promise.all(
    ids.map(async (id) => {
      const details = await edges.run('claude', ['plugin', 'details', id], options)
      const verdict = details.status === 0 ? hasLanguageServer(details.stdout) : null
      return verdict ?? /-lsp@/.test(id)
    }),
  )
  return ids.filter((_, index) => verdicts[index])
}

/** Check the plugin's dependencies, config and conflicts, and answer the
 *  exit status: always 0, so nothing here can stop a session. */
export const runSessionStart = async (edges: SessionStartEdges): Promise<number> => {
  const { env, output } = edges
  const projectDir = env.CLAUDE_PROJECT_DIR || edges.cwd
  const problems: string[] = []
  const details: string[] = []

  const absent = absentDependencies(DEPENDENCIES, (tool) => which(tool, env))
  if (absent.length > 0) {
    problems.push(...absent.map((dependency) => `${dependency.label} is absent`))
  } else {
    const relative = path.relative(projectDir, configPath(projectDir))
    const config = loadConfig(projectDir, edges.readFile)
    if (config.outcome === 'invalid') {
      problems.push(`${relative} ${config.missing ? 'is missing' : 'is not valid'}`)
      details.push(...config.errors)
    }
    const conflicts = await conflictingPlugins(edges, projectDir)
    if (conflicts === null) problems.push('the enabled plugins could not be checked')
    else if (conflicts.length > 0) {
      problems.push(`other language server plugins are enabled: ${conflicts.join(', ')}`)
    }
  }

  if (problems.length === 0) return 0
  for (const line of [...problems, ...details]) output.err.write(`${line}\n`)
  const lines = problems.map((problem) => `${PLUGIN_PREFIX}: ⚠️ ${problem}`)
  const additionalContext =
    `lsp-merge cannot merge language servers as configured: ${problems.join('; ')}. ` +
    'A file whose extension another plugin claims does not reach lsp-merge.'
  output.out.write(emit(PLUGIN_PREFIX, lines.join('\n'), additionalContext))
  return 0
}
