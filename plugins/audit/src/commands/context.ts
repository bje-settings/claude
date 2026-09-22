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
import { toplevel } from '../lib/git.ts'
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

const ARG_SPEC = { json: { type: 'boolean' } } as const

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
  const parsed = parseCommandLine(argv, ARG_SPEC)
  if (parsed.outcome !== 'ok') return parsed
  const started = edges.now()

  const target = parsed.value.positionals[0] ?? edges.cwd
  const root = await toplevel({ cwd: target, env: edges.env })
  if (root === null) return refused(`not a git repository: ${target}`)

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
