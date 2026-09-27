// The command function behind the workstreams plugin's `SessionStart`
// hook. `hooks/session-start.ts` calls it with the process's own edges,
// so a test calls it with no process (ADR 001, `.claude/rules/type-ts.md`).
//
// This file replaces the `preflight` subcommand (#244). A skill has no
// preflight step (`.claude/rules/_design-principles.md`, "Dependencies
// outside a plugin"). It puts the check in a `SessionStart` hook instead,
// over the plugin's own table, with `lib/dependencies.ts`
// `absentDependencies`.
//
// Every check here is local. `gh auth token` reads a stored credential
// and makes no call to GitHub. That is unlike the removed `preflight`
// subcommand's `gh auth status`. `gh extension list` reads the local
// extension directory. A hook must stay fast, with no network call.
//
// The registry read, and the reviewer check against each copy's
// `agents/` directory, move here from `preflight.ts`. A registry that
// cannot be read falls back to `claude plugin list --json`. A hook runs
// outside the tool permission system, so neither read needs a new
// permission.
//
// This code reports a registry, or a fallback, that cannot be read either
// way, as itself. It never reports it as missing plugins. An unreadable
// file needs a different fix. To tell someone to install what they
// already have sends them the wrong way.
//
// `preflight.ts`'s `OPTIONAL_PLUGINS` row for `gh` goes with it.
// `question/SKILL.md` now reads its own skill listing for `/gh:sync`. It
// no longer asks this hook about the `gh` plugin.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { absentDependencies, type Dependency } from '../lib/dependencies.ts'
import { emit } from '../lib/hook-output.ts'
import type { Runner } from '../lib/process.ts'
import type { Output } from '../lib/streams.ts'

/** The time the whole check may take, in milliseconds. `hooks.json` gives
 *  the hook 3 seconds (`.claude/rules/_design-principles.md`), and this
 *  stays well under it, the way the gh hook's own `DEADLINE_MS` does. */
export const DEADLINE_MS = 2_500

/** The plugin prefix `lib/hook-output.ts` colours, with no trailing
 *  colon (`.claude/rules/path-hooks.md`). */
const PLUGIN_PREFIX = 'workstreams'

/** One problem line: the plugin prefix, then `⚠️`, then `problem`. */
const problemLine = (problem: string): string => `${PLUGIN_PREFIX}: ⚠️ ${problem}`

/** The plugin the review loop's reviewers live in. */
const REVIEWER_PLUGIN = 'pr-review-toolkit'

/** The reviewer agents `/workstreams:review` dispatches. A round that
 *  finds one missing halfway through has already spent the others. */
export const REQUIRED_REVIEWERS: readonly string[] = [
  'code-reviewer',
  'comment-analyzer',
  'silent-failure-hunter',
  'pr-test-analyzer',
  'type-design-analyzer',
]

/** Where Claude records the plugins that are installed, or `""` when
 *  there is nowhere to look. Moved from `preflight.ts` (#244). The
 *  override lets this command's own suite point it at a file it wrote.
 *  That file needs no `HOME` the rest of the process shares. */
export const registryPath = (env: NodeJS.ProcessEnv): string => {
  const override = env.WORKSTREAMS_INSTALLED_PLUGINS
  if (override !== undefined && override !== '') return override
  const home = env.HOME
  if (home === undefined || home === '') return ''
  return path.join(home, '.claude', 'plugins', 'installed_plugins.json')
}

/** Every install path `plugins` records for `id`, under any marketplace,
 *  with no duplicate. One plugin has one entry per project that
 *  installed it. Moved from `preflight.ts` (#244). */
export const installPathsFor = (plugins: Record<string, unknown>, id: string): string[] => {
  const paths: string[] = []
  for (const [key, value] of Object.entries(plugins)) {
    if (!key.startsWith(`${id}@`)) continue
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const record = entry as Record<string, unknown> | null
      const installPath = record === null ? undefined : record.installPath
      if (typeof installPath === 'string' && !paths.includes(installPath)) paths.push(installPath)
    }
  }
  return paths
}

/** Whether `plugins` names `id` under any marketplace at all. A fork
 *  under another marketplace is still that plugin to the skill that runs
 *  its commands. */
const hasPlugin = (plugins: Record<string, unknown>, id: string): boolean =>
  Object.keys(plugins).some((key) => key.startsWith(`${id}@`))

/** The plugins object a readable registry, or its fallback, named, or
 *  `null` when this code could not read either one. */
type Plugins = Record<string, unknown> | null

/** `claude plugin list --json`'s answer, grouped the way the registry
 *  file's own `plugins` object groups its entries. So `hasPlugin` and
 *  `installPathsFor` read either source the same way. `null` when the
 *  command failed, or said something this cannot parse. */
const listInstalledPlugins = async (
  run: Runner,
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<Plugins> => {
  const result = await run('claude', ['plugin', 'list', '--json'], { env, timeoutMs: deadlineMs })
  if (result.status !== 0) return null
  let document: unknown
  try {
    document = JSON.parse(result.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(document)) return null
  const plugins: Record<string, { installPath: string }[]> = {}
  for (const entry of document) {
    const record = entry as Record<string, unknown> | null
    const id = record === null ? undefined : record.id
    if (typeof id !== 'string') continue
    const installPath = record?.installPath
    const row = plugins[id] ?? []
    if (typeof installPath === 'string') row.push({ installPath })
    plugins[id] = row
  }
  return plugins
}

/** Read the registry file, or fall back to `claude plugin list --json`
 *  when it cannot be read. A file that is not there yet is a session
 *  with nothing installed from this marketplace. That is not a
 *  failure. It answers as an empty plugins object, with no fallback
 *  call. */
const readRegistry = async (
  env: NodeJS.ProcessEnv,
  run: Runner,
  deadlineMs: number,
): Promise<Plugins> => {
  const file = registryPath(env)
  if (file === '') return listInstalledPlugins(run, env, deadlineMs)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return listInstalledPlugins(run, env, deadlineMs)
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return listInstalledPlugins(run, env, deadlineMs)
  }
  const plugins =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>).plugins
      : undefined
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return listInstalledPlugins(run, env, deadlineMs)
  }
  return plugins as Record<string, unknown>
}

/** Whether `tool` is on `env.PATH`. A PATH walk, not a run, so a `gh`
 *  that is not executable is not on PATH. Written in the shape
 *  `plugins/gh/src/subcommands/hook-io.ts`'s own `which` uses, since
 *  nothing crosses a plugin boundary but `lib/` (`.claude/rules/type-ts.md`). */
const which = (tool: string, env: NodeJS.ProcessEnv): boolean => {
  const listed = env.PATH ?? ''
  if (listed === '') return false
  for (const directory of listed.split(path.delimiter)) {
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

/** Whether `gh auth token` can answer, or `null` when the check itself
 *  could not run to a real answer.
 *
 *  A timeout, or a child that could not start at all, says nothing about
 *  whether a login is there. To read either as "absent" would send a
 *  logged-in person to `gh auth login` for no reason. This follows the
 *  rule this file states for the registry, above. This reports a check
 *  that cannot answer as itself. It never reports it as what it was
 *  checking. A clean non-zero exit, with no timeout and no start
 *  failure, is a real answer. `gh auth token` failed because there is
 *  no stored credential.
 *
 *  This reads a stored credential, and makes no call to GitHub: a
 *  `SessionStart` hook must stay local. */
const ghLoggedIn = async (
  run: Runner,
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<boolean | null> => {
  const result = await run('gh', ['auth', 'token'], { env, timeoutMs: deadlineMs })
  if (result.timedOut || result.startFailure !== null) return null
  return result.status === 0
}

/** Whether the listing names the `gh stack` extension, or `null` when
 *  this code could not read the listing itself.
 *
 *  A listing that failed, for any reason, says nothing about which
 *  extensions exist. The deleted `preflight.ts` kept this as its own
 *  finding (`gh-extension-list`), apart from "the extension is not
 *  there". This keeps the same split, rather than fold every failure
 *  into an absent extension.
 *
 *  Matched on the command, not the repository. A fork installed under
 *  the same command is the same extension to the skill that runs
 *  `gh stack submit`. */
const ghStackInstalled = async (
  run: Runner,
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<boolean | null> => {
  const result = await run('gh', ['extension', 'list'], { env, timeoutMs: deadlineMs })
  if (result.status !== 0) return null
  return result.stdout.split('\n').some((line) => line.trim().startsWith('gh stack'))
}

/** The install paths `plugins` records for `pr-review-toolkit` that a
 *  copy is actually at, right now. The registry keeps an entry per
 *  project that installed it. A stale one goes on an update or a
 *  reinstall. */
const reachableReviewerPaths = (plugins: Record<string, unknown>): string[] =>
  installPathsFor(plugins, REVIEWER_PLUGIN).filter((root) => existsSync(root))

/** The edges this command reads: no process, no `gh` on the machine, no
 *  `claude` on it either. */
export interface SessionStartEdges {
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly run: Runner
  readonly deadlineMs: number
}

/** The dependency table row and whether it holds right now, together.
 *  This run only builds a row for a check it actually made. When `gh`
 *  itself is absent, this run leaves out `gh-login` and `gh-stack`.
 *  When the plugin that carries the reviewer rows is absent, this run
 *  leaves them out too. This run also leaves them out when it cannot
 *  check that plugin at all. */
interface Row extends Dependency {
  readonly present: boolean
}

/** Check the workstreams plugin's dependency table, and answer the exit
 *  status: always 0, so nothing here can stop a session
 *  (`.claude/rules/_design-principles.md`). When everything is present,
 *  this writes nothing at all. */
export const runSessionStart = async (edges: SessionStartEdges): Promise<number> => {
  const { env, run, output, deadlineMs } = edges
  const ghPresent = which('gh', env)

  const [ghLogin, ghStack, plugins] = await Promise.all([
    ghPresent ? ghLoggedIn(run, env, deadlineMs) : Promise.resolve(true),
    ghPresent ? ghStackInstalled(run, env, deadlineMs) : Promise.resolve(true),
    readRegistry(env, run, deadlineMs),
  ])

  // A check that timed out, or a `gh` that could not run, gets a
  // problem line of its own. It never becomes a row that
  // `absentDependencies` reads as "absent". The fix for a check that
  // could not run differs from the fix for a real absence. This code
  // cannot tell which one is true.
  const rows: Row[] = [{ tool: 'gh', label: 'the GitHub CLI (gh)', present: ghPresent }]
  const problems: string[] = []
  if (ghPresent) {
    if (ghLogin === null) problems.push('a gh login could not be checked')
    else rows.push({ tool: 'gh-login', label: 'a gh login', present: ghLogin })
    if (ghStack === null) problems.push('the gh stack extension could not be checked')
    else rows.push({ tool: 'gh-stack', label: 'the gh stack extension', present: ghStack })
  }

  // A registry, or its fallback, that this code could not read at all is
  // a problem line of its own. It is never five missing plugins. The fix
  // for an unreadable file differs from the fix for an absent plugin.
  // This code cannot tell whether the plugin is there.
  if (plugins === null) {
    problems.push('the installed plugins file could not be read')
  } else {
    const reviewerPluginPresent = hasPlugin(plugins, REVIEWER_PLUGIN)
    rows.push({
      tool: REVIEWER_PLUGIN,
      label: 'the pr-review-toolkit plugin',
      present: reviewerPluginPresent,
    })
    if (reviewerPluginPresent) {
      const reachable = reachableReviewerPaths(plugins)
      if (reachable.length === 0) {
        // Every recorded install path is gone, or none was recorded at
        // all. Either way this cannot check a single reviewer agent. So
        // it says that, rather than name five agents that may well be
        // there in a copy this cannot find.
        problems.push(
          'no installed copy of pr-review-toolkit could be checked for its reviewer agents',
        )
      } else {
        for (const reviewer of REQUIRED_REVIEWERS) {
          rows.push({
            tool: `reviewer:${reviewer}`,
            label: `pr-review-toolkit's ${reviewer} agent`,
            present: reachable.some((root) =>
              existsSync(path.join(root, 'agents', `${reviewer}.md`)),
            ),
          })
        }
      }
    }
  }

  // Every tool `absentDependencies` asks about here is a tool this run
  // itself just put in `rows`, under the same name. So the lookup below
  // always finds one. The assertion is erased at runtime and adds no
  // branch a test would have to invent an input for. `lib/node-floor.ts`
  // makes the same trade on its own match groups.
  const table: Dependency[] = rows.map(({ tool, label }) => ({ tool, label }))
  const presence = new Map(rows.map((row) => [row.tool, row.present]))
  const absent = absentDependencies(table, (tool) => presence.get(tool) as boolean)
  const reasons = [...absent.map((dependency) => `${dependency.label} is absent`), ...problems]

  if (reasons.length === 0) return 0
  for (const reason of reasons) output.err.write(`${reason}\n`)
  const lines = reasons.map(problemLine)
  const additionalContext = `The workstreams skills cannot run: ${reasons.join('; ')}.`
  output.out.write(emit(PLUGIN_PREFIX, lines.join('\n'), additionalContext))
  return 0
}
