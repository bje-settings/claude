// Tier 0 (#164, #172): pull the references out of a unit's text and resolve
// each one against the tree, with no model call anywhere. `types.ts` is the
// contract; nothing here invents a shape it does not already declare.
//
// The port of the spike's `refs.ts`, minus everything that spawned `gh`:
// layer 1 moved the issue lookup into `lib/gh.ts` `issueStates`, so an issue's
// state arrives here as an answer the caller already has.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Ref, Resolution } from './types.ts'

/** What every extracted ref carries until {@link resolveRefs} runs. */
const UNRESOLVED: Resolution = { status: 'unchecked', reason: 'not_resolved_yet' }

/** An inline code span: a single backtick, content with no backtick or
 *  newline, a closing backtick. A simplification of CommonMark's rule, which
 *  allows multi-backtick delimiters; every path, file:line and script
 *  reference this audit cares about is written with a single pair. */
const INLINE_CODE_RE = /`([^`\n]+)`/g

/** Extensions specific enough that a backticked token ending in one is a path
 *  reference and not a generic example. Deliberately narrower than "every
 *  extension a repository might contain": a broad extension like `.md` or
 *  `.json` also names a whole class of prose example, so those go through
 *  {@link KNOWN_BARE_FILENAMES} instead, by exact name rather than by
 *  suffix. */
const KNOWN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.zsh',
  '.rb',
  '.go',
  '.rs',
  '.css',
  '.scss',
  '.html',
])

/** Bare filenames worth treating as a path reference on their own, even though
 *  their extension is too generic to qualify by suffix alone. */
const KNOWN_BARE_FILENAMES = new Set([
  'package.json',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'README.md',
  'lefthook.yml',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'biome.json',
  '.gitignore',
  '.npmrc',
  '.editorconfig',
])

/**
 * Whether `value` reads as a path.
 *
 * Rejected outright: a value containing whitespace (a command line that
 * happens to name a path, where no existence check on the whole string can
 * ever succeed) and a value containing `://` (a URL has slashes and is no path
 * in the tree).
 *
 * Accepted: a value with a directory component, a narrowly-specific extension,
 * or a well-known bare filename.
 */
const looksLikePath = (value: string): boolean => {
  if (/\s/.test(value)) return false
  if (value.includes('://')) return false
  if (value.includes('/')) return true
  if (KNOWN_BARE_FILENAMES.has(value)) return true
  return KNOWN_EXTENSIONS.has(extname(value))
}

/** pnpm and yarn subcommands that are real CLI operations rather than a
 *  package.json script name, so `pnpm install` is not read as a script called
 *  "install". `test` is deliberately absent from both: `pnpm test` and
 *  `yarn test` run the "test" script. `npm` needs no such list, because only
 *  its explicit `npm run <name>` form is read as a script at all. */
const PNPM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'upgrade',
  'outdated',
  'link',
  'unlink',
  'why',
  'list',
  'ls',
  'audit',
  'licenses',
  'pack',
  'publish',
  'init',
  'create',
  'dlx',
  'exec',
  'env',
  'store',
  'import',
  'rebuild',
  'prune',
  'patch',
  'root',
  'config',
  'set',
  'get',
  'deploy',
  'doctor',
  'recursive',
  'run',
])

const YARN_BUILTINS = new Set([
  'install',
  'add',
  'remove',
  'upgrade',
  'why',
  'list',
  'link',
  'unlink',
  'info',
  'init',
  'create',
  'dlx',
  'exec',
  'config',
  'cache',
  'audit',
  'licenses',
  'pack',
  'publish',
  'workspace',
  'workspaces',
  'set',
  'unplug',
  'plugin',
  'node',
  'version',
  'versions',
  'bin',
  'tag',
  'run',
])

const SCRIPT_NAME = '[\\w:.-]+'

/** A path, then `:`, then a line or a line range. The path part is checked
 *  against {@link looksLikePath} as well, so `note:1` is prose and
 *  `lib/git.ts:115` is a reference. */
const FILE_LINE_RE = /^([^\s:]+):(\d+)(?:-(\d+))?$/

const isFileLineToken = (token: string): boolean => {
  const match = FILE_LINE_RE.exec(token)
  return match !== null && looksLikePath(match[1] as string)
}

/** A ref paired with where in the text it was found, so a caller can emit refs
 *  in source order however many passes produced them. */
type Located = { at: number; ref: Ref }

const scriptRef = (value: string): Ref => ({ kind: 'script', value, resolution: UNRESOLVED })

/** Script invocations for one manager. `requireRun` is `npm`'s rule: only the
 *  explicit `npm run <name>` form is a script, because most bare npm
 *  subcommands, unlike pnpm's and yarn's, are not also valid script
 *  shorthands. Everywhere else the bare form is a script unless `builtins`
 *  says it is a real subcommand. */
const scriptsFromManager = (
  text: string,
  manager: string,
  requireRun: boolean,
  builtins: Set<string> | null,
): Located[] => {
  const pattern = requireRun
    ? new RegExp(`\\b${manager}\\s+run\\s+(${SCRIPT_NAME})`, 'g')
    : new RegExp(`\\b${manager}\\s+(run\\s+)?(${SCRIPT_NAME})`, 'g')
  const located: Located[] = []
  for (const match of text.matchAll(pattern)) {
    if (requireRun) {
      located.push({ at: match.index, ref: scriptRef(`${manager} run ${match[1]}`) })
      continue
    }
    const explicit = match[1] !== undefined
    const name = match[2] as string
    if (!explicit && builtins?.has(name)) continue
    located.push({
      at: match.index,
      ref: scriptRef(explicit ? `${manager} run ${name}` : `${manager} ${name}`),
    })
  }
  return located
}

/** Every `pnpm`, `npm` or `yarn` script invocation in `text`. Never called on
 *  plain prose, so a sentence that happens to say "pnpm test" outside
 *  backticks is not extracted. */
const locateScripts = (text: string): Located[] => [
  ...scriptsFromManager(text, 'pnpm', false, PNPM_BUILTINS),
  ...scriptsFromManager(text, 'npm', true, null),
  ...scriptsFromManager(text, 'yarn', false, YARN_BUILTINS),
]

/** One inline code span's content. A token that is not a path is not a
 *  reference. */
const locateInCodeSpan = (token: string): Located[] => {
  const trimmed = token.trim()
  // A script invocation first: it is the only kind whose token carries
  // whitespace, which every other rule here refuses.
  const scripts = locateScripts(trimmed)
  if (scripts.length > 0) return scripts
  if (isFileLineToken(trimmed)) {
    return [{ at: 0, ref: { kind: 'file_line', value: trimmed, resolution: UNRESOLVED } }]
  }
  if (looksLikePath(trimmed)) {
    return [{ at: 0, ref: { kind: 'path', value: trimmed, resolution: UNRESOLVED } }]
  }
  return []
}

/** `located` in source order, stably: two refs found at the same offset keep
 *  the order the passes produced them in. */
const inSourceOrder = (located: Located[]): Ref[] =>
  [...located].sort((a, b) => a.at - b.at).map((entry) => entry.ref)

/**
 * Every reference in `text`, unresolved; {@link resolveRefs} fills each one in.
 *
 * Order is the order the references appear in `text`, and it is stable: a
 * consumer taking "the first ref" of a unit therefore takes the first one the
 * writer wrote.
 */
export const extractRefs = (text: string): Ref[] => {
  const located: Located[] = []
  for (const span of text.matchAll(INLINE_CODE_RE)) {
    const base = span.index + 1
    for (const entry of locateInCodeSpan(span[1] as string)) {
      located.push({ at: base + entry.at, ref: entry.ref })
    }
  }
  return inSourceOrder(located)
}

/** What {@link resolveRefs} needs to answer each kind: the repository root and
 *  the repo-relative file the refs came from, for a path written relative to
 *  the file rather than to the root. Nothing here reaches the network. */
export type ResolveContext = {
  root: string
  file: string
  /** Every tracked path, repo-relative, for the tail rule below. */
  tracked: readonly string[]
  /** Shared across every unit of one run, so each `package.json` is read
   *  once rather than once per unit. */
  packageJson: PackageJsonCache
}

/** One `package.json`, read once: its `scripts` object, or why there is none
 *  to read. */
export type PackageJsonEntry =
  | { found: true; scripts: Record<string, unknown> }
  | { found: false; reason: 'none' | 'unreadable' }

/** Absolute `package.json` path to what reading it produced. */
export type PackageJsonCache = Map<string, PackageJsonEntry>

const unchecked = (
  reason: 'machine_specific' | 'pattern' | 'unavailable' | 'no_resolver',
): Resolution => ({
  status: 'unchecked',
  reason,
})

/** `true` for a value this audit can never check: `~/` and an absolute path
 *  both name somewhere outside the tree being audited, so whether they exist
 *  depends on the machine running the audit rather than on the repository. */
const isMachineSpecific = (value: string): boolean => value.startsWith('~/') || isAbsolute(value)

/** `true` for a glob or a placeholder: a path shape extraction keeps on
 *  purpose, but one an existence check would always fail, which is a different
 *  fact from "looked and absent". */
const isPattern = (value: string): boolean => value.includes('*') || value.includes('<')

const toRepoRelative = (root: string, absolutePath: string): string =>
  relative(root, absolutePath).split(sep).join('/')

/**
 * A path's resolution.
 *
 * A path is looked for under the audited root first and only then relative to
 * the referencing file's own directory: prose names paths from the root far
 * more often than from the file, so when both exist the root's is the one
 * meant.
 *
 * Failing both, a tracked path the value ENDS, at a segment boundary, absolves
 * it: prose names paths relative to a context the reader supplies, and that is
 * not rot. A bare prefix or a mid-path substring is not enough, which is what
 * the leading slash in the comparison buys.
 */
const resolvePathValue = (value: string, ctx: ResolveContext): Resolution => {
  if (isMachineSpecific(value)) return unchecked('machine_specific')
  if (isPattern(value)) return unchecked('pattern')

  const fromRoot = join(ctx.root, value)
  if (existsSync(fromRoot)) return { status: 'found', repoPath: toRepoRelative(ctx.root, fromRoot) }

  const fromFile = join(dirname(join(ctx.root, ctx.file)), value)
  if (existsSync(fromFile)) {
    return { status: 'found', repoPath: toRepoRelative(ctx.root, fromFile) }
  }

  // A trailing slash says the value names a directory, which no tracked path
  // ever is: git tracks files, so a directory is absolved by a file inside it
  // rather than by a path that ends with it.
  const isDirectoryRef = value.endsWith('/')
  const tail = value.replace(/^\.\//, '').replace(/\/$/, '')
  // A one-segment directory reference matches a tracked path in almost any
  // repository, so a witness for it would absolve everything and prove
  // nothing.
  if (isDirectoryRef && !tail.includes('/')) return unchecked('pattern')
  const witness = ctx.tracked.find((tracked) =>
    isDirectoryRef ? `/${tracked}`.includes(`/${tail}/`) : tracked.endsWith(`/${tail}`),
  )
  if (witness !== undefined) return { status: 'tail_match', witness }

  return { status: 'absent' }
}

/** A file's line count the way `wc -l` counts it: a trailing newline ends the
 *  last line rather than starting an empty one. */
const countLines = (contents: string): number => {
  if (contents === '') return 0
  const lines = contents.split('\n').length
  return contents.endsWith('\n') ? lines - 1 : lines
}

/**
 * A `file:line` reference: where the file is, and then whether it is long
 * enough. The END of a range is what has to exist, so `15-25` overruns a
 * 20-line file.
 *
 * A file that cannot be read at all (a directory, say) is `unavailable`: the
 * count could not be taken, which is a different fact from "the line is not
 * there". Counts are cached per call, so a file named by several refs is read
 * once.
 */
const resolveFileLine = (
  ref: Ref,
  ctx: ResolveContext,
  lineCounts: Map<string, number | null>,
): Resolution => {
  // Extraction only ever produces a value this pattern matches, so the match
  // is read without a null arm nothing can reach.
  const match = FILE_LINE_RE.exec(ref.value) as RegExpExecArray
  const needed = Number(match[3] ?? match[2])

  const resolution = resolvePathValue(match[1] as string, ctx)
  if (resolution.status !== 'found') return resolution
  const repoPath = resolution.repoPath as string

  let count = lineCounts.get(repoPath)
  if (count === undefined) {
    count = readLineCount(join(ctx.root, repoPath))
    lineCounts.set(repoPath, count)
  }
  if (count === null) return unchecked('unavailable')
  if (count < needed) return { status: 'line_out_of_range', repoPath, lines: count }
  return { status: 'found', repoPath }
}

/** A file's line count, or `null` when it could not be read as a file. */
const readLineCount = (absolute: string): number | null => {
  try {
    return countLines(readFileSync(absolute, 'utf8'))
  } catch {
    return null
  }
}

const readPackageJson = (file: string): PackageJsonEntry => {
  if (!existsSync(file)) return { found: false, reason: 'none' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: unknown }
    if (typeof parsed.scripts === 'object' && parsed.scripts !== null) {
      return { found: true, scripts: parsed.scripts as Record<string, unknown> }
    }
    return { found: true, scripts: {} }
  } catch {
    return { found: false, reason: 'unreadable' }
  }
}

/** The nearest `package.json` from the referencing file's directory up to and
 *  including the audited root. One that does not parse stops the walk: the
 *  answer is then "the manifest governing this file could not be read", not
 *  "look further up". */
const findScripts = (ctx: ResolveContext): PackageJsonEntry => {
  const rootAbs = resolve(ctx.root)
  let dir = dirname(join(ctx.root, ctx.file))
  for (;;) {
    const candidate = join(dir, 'package.json')
    let entry = ctx.packageJson.get(candidate)
    if (entry === undefined) {
      entry = readPackageJson(candidate)
      ctx.packageJson.set(candidate, entry)
    }
    if (entry.found || entry.reason === 'unreadable') return entry
    // The walk starts inside the audited root and stops at it, so there is no
    // filesystem root to guard against here.
    if (resolve(dir) === rootAbs) return entry
    dir = dirname(dir)
  }
}

const scriptName = (value: string): string => {
  // Extraction only ever produces one of these three shapes, so the match is
  // read without a null arm nothing can reach.
  const match = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?(\S+)$/.exec(value) as RegExpExecArray
  return match[1] as string
}

/** A script's resolution. No manifest at all means there is nothing to resolve
 *  against; one that does not parse means the question could not be asked.
 *  Neither is a missing script, and the two are not the same finding. */
const resolveScript = (ref: Ref, ctx: ResolveContext): Resolution => {
  const entry = findScripts(ctx)
  if (!entry.found) {
    return unchecked(entry.reason === 'none' ? 'no_resolver' : 'unavailable')
  }
  // `repoPath` is null: a script is a name in a manifest rather than a file.
  return Object.hasOwn(entry.scripts, scriptName(ref.value))
    ? { status: 'found', repoPath: null }
    : { status: 'absent' }
}

/** `refs`, each carrying the `Resolution` `types.ts` declares. Order is
 *  preserved. */
const resolveOne = (
  ref: Ref,
  ctx: ResolveContext,
  lineCounts: Map<string, number | null>,
): Resolution => {
  if (ref.kind === 'file_line') return resolveFileLine(ref, ctx, lineCounts)
  if (ref.kind === 'script') return resolveScript(ref, ctx)
  return resolvePathValue(ref.value, ctx)
}

export const resolveRefs = (refs: Ref[], ctx: ResolveContext): Ref[] => {
  // Keyed by repo-relative path, so the counts are safe to share across the
  // refs of one call and no file is read twice.
  const lineCounts = new Map<string, number | null>()
  return refs.map((ref) => ({
    ...ref,
    resolution: resolveOne(ref, ctx, lineCounts),
  }))
}
