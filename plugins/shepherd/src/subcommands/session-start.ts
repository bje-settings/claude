// The command function behind the shepherd plugin's `SessionStart` hook.
// `hooks/session-start.ts` calls it with the process's own edges, so a test
// calls it with no process (ADR 001, `.claude/rules/type-ts.md`).
//
// It checks the plugin's dependency table with `lib/dependencies.ts`
// (`.claude/rules/_design-principles.md`, "Dependencies outside a plugin").
// When everything is present, it writes nothing. Otherwise it reports the
// problems of git and gh first, then the problem of the `gh stack`
// extension. A missing tool stops the whole plugin. A missing extension
// stops only the stack merge.
//
// Every read is local and async, and has a time limit from one clock
// (#267). A read that did not finish in time reads as "could not be
// checked", never as absent.
import {
  absentDependencies,
  type Dependency,
  deadlineClock,
  type FileReads,
  isPresent,
} from '../lib/dependencies.ts'
import { emit } from '../lib/hook-output.ts'
import type { Output } from '../lib/streams.ts'

/** The time the whole check may take, in milliseconds. `hooks.json` gives
 *  the hook 3 seconds (`.claude/rules/_design-principles.md`), and this
 *  stays well under it. */
export const DEADLINE_MS = 2_500

/** How long the entry waits, once its output has left, before it ends a
 *  process that a hung read still holds (`lib/process.ts`
 *  `endOnceWritten`). The deadline, this, and the start of node together
 *  stay under the 3 s that `hooks.json` gives. */
export const END_GRACE_MS = 20

/** The plugin prefix `lib/hook-output.ts` colours, with no trailing
 *  colon (`.claude/rules/path-hooks.md`). */
const PLUGIN_PREFIX = 'shepherd'

/** What the plugin needs, in the order their lines show. Every command
 *  runs git and gh. `shepherd-stack merge` runs `gh stack merge`. */
const DEPENDENCIES: readonly Dependency[] = [
  { tool: 'git', label: 'git' },
  { tool: 'gh', label: 'GitHub CLI (gh)' },
  { tool: 'stack', label: 'gh stack extension', via: 'gh-extension' },
]

/** The edges this command reads: no process, and no `gh` call. */
export interface SessionStartEdges {
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  /** Every filesystem read this command makes. */
  readonly files: FileReads
  readonly deadlineMs: number
  /** `process.platform`, which tells where gh keeps its extensions. */
  readonly platform: string
}

/** The rows of a table that are absent, and one problem for each row that
 *  is absent or could not be checked. */
interface Findings {
  readonly absent: readonly Dependency[]
  readonly problems: readonly string[]
}

/** {@link Findings} for `rows`. `missing` is the words of a problem line
 *  for an absent row. */
const findings = (
  rows: readonly Dependency[],
  presence: ReadonlyMap<string, boolean | null | undefined>,
  missing: string,
): Findings => {
  const absent = absentDependencies(rows, (tool) => presence.get(tool) !== false)
  const unchecked = rows.filter((row) => presence.get(row.tool) === null)
  return {
    absent,
    problems: [
      ...absent.map((row) => `${row.label} ${missing}`),
      ...unchecked.map((row) => `${row.label} could not be checked`),
    ],
  }
}

/** The `additionalContext` for an absent git or gh: the plugin cannot run. */
const toolContext = (absent: readonly Dependency[]): string => {
  const labels = absent.map((row) => row.label).join(', ')
  const verb = absent.length === 1 ? 'is' : 'are'
  return `${labels} ${verb} absent. The shepherd plugin cannot run.`
}

/** The `additionalContext` for an absent extension: what cannot run. */
const extensionContext = (absent: readonly Dependency[]): string =>
  absent.map((row) => `${row.label} is absent. /shepherd:merge cannot merge a stack.`).join(' ')

/** Check the shepherd plugin's dependency table, and answer the exit
 *  status: always 0, so nothing here can stop a session. */
export const runSessionStart = async (edges: SessionStartEdges): Promise<number> => {
  const { env, output, files, deadlineMs, platform } = edges
  const remaining = deadlineClock(deadlineMs)
  const found = await Promise.all(
    DEPENDENCIES.map((row) => isPresent(row, env, files, remaining(), platform)),
  )
  const presence = new Map(DEPENDENCIES.map((row, index) => [row.tool, found[index]]))

  const tools = findings(
    DEPENDENCIES.filter((row) => row.via === undefined),
    presence,
    'not found on PATH',
  )
  const extensions = findings(
    DEPENDENCIES.filter((row) => row.via === 'gh-extension'),
    presence,
    'not found',
  )
  // The extension read is a file read under gh's data directory. It needs
  // no tool, so a tool problem does not hide its line (ruling 7 on #480).
  const problems = [...tools.problems, ...extensions.problems]
  if (problems.length === 0) return 0
  for (const problem of problems) output.err.write(`${problem}\n`)
  const lines = problems.map((problem) => `${PLUGIN_PREFIX}: ⚠️ ${problem}`)
  const sentences = [
    ...(tools.absent.length === 0 ? [] : [toolContext(tools.absent)]),
    ...(extensions.absent.length === 0 ? [] : [extensionContext(extensions.absent)]),
  ]
  const context = sentences.length === 0 ? undefined : sentences.join(' ')
  output.out.write(emit(PLUGIN_PREFIX, lines.join('\n'), context))
  return 0
}
