// `/audit:context`: read a checkout's context files, and report the references
// in them that no longer resolve. The TypeScript port of the spike's `cli.ts`
// (#164) as a command function (RFC 001 decision 3): parsed arguments and
// injected clients in, an envelope out, with `bin/audit.ts` the thin adapter
// over it.
//
// Tier 0 only in this layer, and complete on its own: everything it produces
// is read from the tree and from one batched issue lookup, with no model call
// anywhere. The model stages are reported as skipped, with the reason, so that
// "skipped" can never be read as "nothing found".

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { discoverFiles, scopeFilter } from '../discover.ts'
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import type { GhClient } from '../lib/gh.ts'
import { runGit, toplevel } from '../lib/git.ts'
import type { Output } from '../lib/streams.ts'
import { extractRefs, resolveRefs } from '../refs.ts'
import { type Report, renderFindings, type SkippedStage } from '../report.ts'
import { splitMarkdown } from '../split.ts'
import type { OpaqueBlock, SplitWarning, Unit } from '../types.ts'

/** The process's edges, as `bin/audit.ts` builds them. `now` is the clock, so
 *  that a report's `wallClockMs` is a value a test states rather than a
 *  duration it has to tolerate. */
export interface ContextEdges {
  /** The directory the caller started in, which is the default root. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly createGh: (cwd: string) => GhClient
  readonly now: () => number
}

// `as const`, never `: ArgSpec` or `satisfies ArgSpec`: either annotation
// widens `choices` to `readonly string[]` and collapses the parsed options to
// an index signature (`lib/README.md`). Every count and the threshold are
// string options with a default, checked below rather than by the parser,
// which has no numeric kind.
const ARG_SPEC = {
  scope: { type: 'string', default: 'context', choices: ['context', 'all'] },
  shape: { type: 'string', default: 'per_section', choices: ['per_section', 'per_unit'] },
  'no-jev': { type: 'boolean' },
  json: { type: 'boolean' },
  out: { type: 'string', default: '' },
  'max-pairs': { type: 'string', default: '300' },
  'max-evidence': { type: 'string', default: '200' },
  'pair-threshold': { type: 'string', default: '0.5' },
} as const

const USAGE = `usage: audit.ts context [root] [--scope context|all]
       [--shape per_section|per_unit] [--no-jev] [--json] [--out FILE]
       [--max-pairs N] [--max-evidence N] [--pair-threshold X]

Audits a checkout's context files (CLAUDE.md, README.md and anything under a
.claude/ directory; --scope all reads every tracked .md) for references that
no longer resolve. The root defaults to the working directory.

Tier 0 reads the tree and one batched issue lookup and needs no model. The
model stages need TYPESAFE_API_KEY and are reported as skipped without it, or
with --no-jev. --json writes the whole report instead of the findings text;
--out writes it to a file as well.`

/**
 * True when `argv` asks for help. A raw scan of the tokens themselves, checked
 * before anything is parsed, so usage wins over a bad `--scope` rather than
 * losing to it. `plugins/mermaid/src/commands/url.ts` is where this shape was
 * settled and why.
 */
export const wantsHelp = (argv: readonly string[]): boolean =>
  argv.includes('-h') || argv.includes('--help')

/** Every file's blocks, in file order. */
const splitAll = (
  root: string,
  files: string[],
): { units: Unit[]; opaque: OpaqueBlock[]; warnings: SplitWarning[] } => {
  const units: Unit[] = []
  const opaque: OpaqueBlock[] = []
  const warnings: SplitWarning[] = []
  for (const file of files) {
    const split = splitMarkdown(file, readFileSync(path.join(root, file), 'utf8'))
    units.push(...split.units)
    opaque.push(...split.opaque)
    warnings.push(...split.warnings)
  }
  return { units, opaque, warnings }
}

/**
 * Why git could not be run at all, or `null` when it ran.
 *
 * It asks git rather than the PATH: running the command answers the question
 * the caller has, and `lib/process.ts` already separates "never started" from
 * "ran and said no" for it. `--version` because it is git's cheapest
 * subcommand and needs no repository to answer in. node's own message is
 * passed through, since it names both the command and the code.
 */
const gitMissing = async (env: NodeJS.ProcessEnv): Promise<string | null> => {
  const probe = await runGit(['--version'], { env })
  return probe.startFailure === null ? null : probe.startFailure.message
}

/** The three stages this layer never runs, each carrying the same reason. */
const skippedStages = (reason: SkippedStage['reason']): SkippedStage[] =>
  (['classify', 'pairs', 'evidence'] as const).map((stage) => ({ stage, reason }))

/**
 * The command function.
 *
 * The report goes to `output` as it is built, and the envelope carries only
 * the status: a payload here would be written a second time by the adapter.
 */
export const runContext = async (
  argv: readonly string[],
  edges: ContextEdges,
): Promise<Envelope<string>> => {
  if (wantsHelp(argv)) return ok(USAGE)

  const parsed = parseCommandLine(argv, ARG_SPEC)
  if (parsed.outcome !== 'ok') return parsed
  const started = edges.now()

  const target = parsed.value.positionals[0] ?? edges.cwd
  const root = await toplevel({ cwd: target, env: edges.env })
  if (root === null) {
    // `toplevel` answers `null` for a directory outside any checkout and for a
    // git that could not be run at all, and a reader sent to look for a
    // checkout when git is simply missing is sent to the wrong place. Asked
    // only here, on the failing path, because a machine with git has nothing
    // to learn from the probe.
    const missing = await gitMissing(edges.env)
    if (missing !== null) return refused(`missing git: ${missing}`)
    return refused(`not a git repository: ${target}`)
  }

  const files = await discoverFiles(root, edges.env, scopeFilter)
  if (files === null) return refused(`could not list the tracked files of ${root}`)
  const { units, opaque, warnings } = splitAll(root, files)
  for (const unit of units) {
    unit.refs = resolveRefs(extractRefs(unit.text), { root, file: unit.file })
  }

  const report: Report = {
    root,
    files,
    units,
    opaque,
    warnings,
    issueLookup: 'ok',
    skipped: skippedStages('no_key'),
    wallClockMs: edges.now() - started,
  }

  edges.output.out.write(
    parsed.value.options.json ? `${JSON.stringify(report)}\n` : renderFindings(report),
  )
  return ok('')
}
