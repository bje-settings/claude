// `/audit:context`: read a checkout's context files, and report the references
// in them that no longer resolve. The TypeScript port of the spike's `cli.ts`
// (#164) as a command function (RFC 001 decision 3): parsed arguments and
// injected clients in, an envelope out, with `scripts/audit.ts` the thin adapter
// over it.
//
// Tier 0 only in this layer, and complete on its own: everything it produces
// is read from the tree and from one batched issue lookup, with no model call
// anywhere. The model stages are reported as skipped, with the reason, so that
// "skipped" can never be read as "nothing found".

import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { markdownFiles, scopeFilter, trackedPaths } from '../discover.ts'
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { type GhClient, GhError, type GhResults } from '../lib/gh.ts'
import { runGit, toplevel } from '../lib/git.ts'
import type { Output } from '../lib/streams.ts'
import {
  extractBlockRefs,
  extractRefs,
  issueNumbers,
  markIgnored,
  type PackageJsonCache,
  resolveRefs,
} from '../refs.ts'
import { type Report, renderFindings, type SkippedStage } from '../report.ts'
import { splitMarkdown } from '../split.ts'
import type { OpaqueBlock, SplitWarning, Unit } from '../types.ts'

/** The process's edges, as `scripts/audit.ts` builds them. `now` is the clock, so
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

/** A whole number, written out. A pattern rather than `Number.isInteger`, for
 *  the reason `sync.ts` gives its own `-j` check: the value reaches an
 *  arithmetic context, where anything this does not refuse is reinterpreted
 *  silently, and a pattern refuses `2.5`, `-1`, `1e3` and `abc` as one rule
 *  rather than as four arms a test would have to reach separately. */
const COUNT_RE = /^\d+$/

/** A fraction from 0 to 1, written out. Same argument as {@link COUNT_RE}, and
 *  the bound is part of the pattern: a threshold above 1 compares against a
 *  similarity that can never reach it, so every pair is dropped and the run
 *  reports nothing found. */
const FRACTION_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/

/** The count options, checked together: `lib/args.ts` has no numeric kind, and
 *  each of these is a bound layer 5 slices work down to. */
const COUNT_FLAGS = ['max-pairs', 'max-evidence'] as const

/**
 * True when `argv` asks for help. A raw scan of the tokens themselves, checked
 * before anything is parsed, so usage wins over a bad `--scope` rather than
 * losing to it. `plugins/mermaid/src/commands/url.ts` is where this shape was
 * settled and why.
 */
export const wantsHelp = (argv: readonly string[]): boolean =>
  argv.includes('-h') || argv.includes('--help')

/**
 * Every file's blocks, in file order, or why one of them could not be read.
 *
 * Discovery lists the index and the read comes from the working tree, and the
 * two differ in ordinary use: a staged deletion, a `git mv` in flight, a
 * sparse checkout, a symlink whose target is gone. Letting the read throw ends
 * the run with node's own `fs` stack trace, no envelope and no exit code from
 * the contract, so the reason is carried back instead and the caller refuses
 * with the file named.
 */
const splitAll = (
  root: string,
  files: string[],
): {
  units: Unit[]
  opaque: OpaqueBlock[]
  warnings: SplitWarning[]
  unreadable: string | null
} => {
  const units: Unit[] = []
  const opaque: OpaqueBlock[] = []
  const warnings: SplitWarning[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(path.join(root, file), 'utf8')
    } catch (error) {
      return {
        units,
        opaque,
        warnings,
        unreadable: `${file}, which git lists as tracked: ${(error as Error).message}`,
      }
    }
    const split = splitMarkdown(file, text)
    units.push(...split.units)
    opaque.push(...split.opaque)
    warnings.push(...split.warnings)
  }
  return { units, opaque, warnings, unreadable: null }
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
 * Why the model stages did not run.
 *
 * Both reasons are true as written. `no_key` is the environment holding no
 * `TYPESAFE_API_KEY`, which is what a run on a machine that has never been set
 * up reports. `no_jev` is the other two cases, and they are the same fact: the
 * caller asked for tier 0 alone with `--no-jev`, or there is a key and no
 * client to spend it (`lib/jev.ts` lands at layer 4, and layer 5 is where the
 * stages themselves replace this).
 */
const skipReason = (env: NodeJS.ProcessEnv, noJev: boolean): SkippedStage['reason'] => {
  const key = env.TYPESAFE_API_KEY ?? ''
  return key !== '' || noJev ? 'no_jev' : 'no_key'
}

/** What the issue lookup answered, with the numbers as `gh` reports them.
 *
 *  `gh` is not reached at all when nothing names an issue: the client resolves
 *  the repository on its first call, so asking it for an empty list would be a
 *  network round trip to answer a question nobody asked.
 */
const issueStates = async (
  root: string,
  edges: ContextEdges,
  numbers: readonly number[],
): Promise<GhResults['issueStates']> => {
  if (numbers.length === 0) return { states: {}, unavailable: null }
  try {
    return await edges.createGh(root).issueStates({ numbers })
  } catch (error) {
    // The real client folds its own failures into `unavailable` and never
    // throws (`lib/README.md`), so this is the belt to that braces: a client
    // that did throw would otherwise take the whole audit down over one
    // lookup. `GhError` is the only failure it declares, and `detail` is gh's
    // own account of it without the argv prefix the message carries.
    //
    // Tested rather than cast, the way every other command here reads one
    // (`plugins/gh/src/commands/shepherd-pr.ts:248`). A cast reads `detail`
    // off whatever was thrown, and `undefined` is folded into `ok` by the
    // caller, so a client that failed some other way would report a lookup
    // that succeeded while every issue ref said unavailable.
    if (error instanceof GhError) return { states: {}, unavailable: error.detail }
    return { states: {}, unavailable: `issue lookup threw: ${String(error)}` }
  }
}

/** A block tier 0 fills in: a unit or an opaque block, both of which carry
 *  `file` and `refs` and are read the same way here. */
type Blocks = {
  readonly units: Unit[]
  readonly opaque: OpaqueBlock[]
  readonly tracked: readonly string[]
}

/**
 * Tier 0: every unit and opaque block gets its refs, resolved against the tree
 * and against one batched issue lookup. Answers why that lookup was
 * unavailable, or `null`.
 *
 * Extraction runs first for everything, so every issue number in the whole run
 * goes to `gh` in one call rather than one call per unit. A repository whose
 * files name no issue at all never reaches `gh`, which is what the injected
 * mock proves: an endpoint with no registered reply throws.
 */
const tierZero = async (
  root: string,
  edges: ContextEdges,
  blocks: Blocks,
): Promise<{ issueLookup: string | null; ignoreCheck: string | null }> => {
  const extracted = [
    ...blocks.units.map((block) => ({ block, refs: extractRefs(block.text) })),
    ...blocks.opaque.map((block) => ({
      block,
      refs: extractBlockRefs(block.text, block.lang, block.kind),
    })),
  ]
  const numbers = [...new Set(extracted.flatMap((entry) => issueNumbers(entry.refs)))]
  const lookup = await issueStates(root, edges, numbers)
  // One cache for the whole run: a `package.json` governs every file under it,
  // so reading it once per unit would read the same file dozens of times.
  const packageJson: PackageJsonCache = new Map()
  for (const { block, refs } of extracted) {
    block.refs = resolveRefs(refs, {
      root,
      file: block.file,
      tracked: blocks.tracked,
      packageJson,
      // A number the lookup left out is one it gave no usable answer for,
      // never "no such issue".
      issueState: (n) => lookup.states[String(n)] ?? 'unavailable',
    })
  }
  const ignoreCheck = await markIgnored([...blocks.units, ...blocks.opaque], root, edges.env)
  return { issueLookup: lookup.unavailable, ignoreCheck }
}

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
  // `parseCommandLine` admits positionals so that this command can take its
  // root as one; how many it takes is this command's own rule. A second word
  // is far more often a quoting mistake than a request, and auditing the first
  // and ignoring the rest would hide it.
  const { options, positionals } = parsed.value
  if (positionals.length > 1) return refused(`one root at most, not: ${positionals.join(' ')}`)
  for (const flag of COUNT_FLAGS) {
    if (!COUNT_RE.test(options[flag])) {
      return refused(`--${flag} must be a whole number, not "${options[flag]}"`)
    }
  }
  const threshold = options['pair-threshold']
  if (!FRACTION_RE.test(threshold)) {
    return refused(`--pair-threshold must be 0 to 1, not "${threshold}"`)
  }
  // Opened before anything is read, and closed again: the model stages layer 5
  // adds are paid for, so a run must not spend them and only then find that
  // the file it was told to write cannot be opened. It catches a missing
  // directory, a directory in the file's place and a read-only file alike.
  //
  // `a` rather than `w`, because this is a probe: both modes create the file
  // and both fail on those three cases, but `w` would also empty the caller's
  // previous report on the way to a run that still refuses below. The write
  // that earns it is a separate call, at `writeFileSync`'s own default of `w`,
  // so the report replaces the file rather than being appended to it.
  const out = options.out
  if (out !== '') {
    try {
      closeSync(openSync(out, 'a'))
    } catch (error) {
      return refused(`could not open ${out} for writing: ${(error as Error).message}`)
    }
  }
  const started = edges.now()

  const target = positionals[0] ?? edges.cwd
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

  // `all` passes a predicate that keeps everything rather than no predicate at
  // all, so discovery has one shape and the scope is decided here, where the
  // flag is read.
  const filter = options.scope === 'context' ? scopeFilter : () => true
  const tracked = await trackedPaths(root, edges.env)
  if (tracked === null) return refused(`could not list the tracked files of ${root}`)
  const files = markdownFiles(tracked, filter)
  const { units, opaque, warnings, unreadable } = splitAll(root, files)
  if (unreadable !== null) return refused(`could not read ${unreadable}`)
  const tier0 = await tierZero(root, edges, { units, opaque, tracked })

  const report: Report = {
    root,
    files,
    units,
    opaque,
    warnings,
    issueLookup: tier0.issueLookup ?? 'ok',
    ignoreCheck: tier0.ignoreCheck ?? 'ok',
    skipped: skippedStages(skipReason(edges.env, options['no-jev'])),
    // Rounded: the clock a caller passes is `performance.now()`, whose
    // fractional milliseconds are noise in a report and noise in a diff.
    wallClockMs: Math.round(edges.now() - started),
  }

  edges.output.out.write(options.json ? `${JSON.stringify(report)}\n` : renderFindings(report))
  // The text as well as the file: `--out` is what a caller keeps, and the
  // findings are what the caller reads now.
  if (out !== '') writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  return ok('')
}
