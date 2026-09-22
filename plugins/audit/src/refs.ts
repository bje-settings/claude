// Tier 0 (#164, #172): pull the references out of a unit's text and resolve
// each one against the tree, with no model call anywhere. `types.ts` is the
// contract; nothing here invents a shape it does not already declare.
//
// The port of the spike's `refs.ts`, minus everything that spawned `gh`:
// layer 1 moved the issue lookup into `lib/gh.ts` `issueStates`, so an issue's
// state arrives here as an answer the caller already has.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { run } from './lib/process.ts'
import type { IssueLookup, Ref, Resolution } from './types.ts'

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
/** A scoped package name (`@scope/name`, `@scope/name@1.2.3`). It has a slash
 *  and is not a path, and a repository with dependencies writes several. */
const SCOPED_PACKAGE_RE = /^@[\w.-]+\/[\w.-]+/

/** A repository or action pinned at a ref (`owner/name@v1.2.3`,
 *  `owner/name/sub@main`). The `@` is what separates it from a path: no file
 *  in this tree is named after one repository at one ref. */
const PINNED_REF_RE = /^[\w.-]+\/[\w./-]*@[\w./-]+$/

const looksLikePath = (value: string): boolean => {
  if (/\s/.test(value)) return false
  if (value.includes('://')) return false
  if (SCOPED_PACKAGE_RE.test(value)) return false
  if (PINNED_REF_RE.test(value)) return false
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

/** Fence info strings whose first line words are shell commands. */
const COMMAND_LANGS = new Set(['bash', 'sh', 'shell', 'zsh'])

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

/** The first word of each non-blank line of a shell block, after a `$ `
 *  prompt, leading `NAME=value` assignments and a leading `sudo` are stripped.
 *  A comment line has no command, so it is skipped rather than reported as one
 *  starting with `#`. Extraction only: nothing here runs, or ever will. */
const locateCommands = (blockContent: string): Located[] => {
  const located: Located[] = []
  let lineStart = 0
  for (const rawLine of blockContent.split('\n')) {
    const at = lineStart
    lineStart += rawLine.length + 1
    let rest = rawLine.trim()
    if (rest === '' || rest.startsWith('#')) continue
    if (rest.startsWith('$ ')) rest = rest.slice(2).trim()
    // A lone `$` is a transcript's empty prompt line, not a command called
    // `$`. It has to be skipped here rather than stripped above, because the
    // strip needs the whitespace a line holding only the prompt does not have.
    else if (rest === '$') continue
    rest = rest.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^sudo\s+/, '')
    // `rest` is never empty here: a blank line is skipped above, and each
    // strip requires whitespace after what it removes, which means a token
    // follows it. So the match always succeeds, and a guard for it would be a
    // branch no input can reach.
    const firstWord = /^(\S+)/.exec(rest) as RegExpExecArray
    located.push({
      at,
      ref: { kind: 'command', value: firstWord[1] as string, resolution: UNRESOLVED },
    })
  }
  return located
}

/** Wrapping punctuation around a token inside a code block: quotes and
 *  brackets on the left, those plus sentence punctuation on the right. A
 *  leading `.` is never stripped, since `../../lib/git.ts` starts with one,
 *  and a trailing `/` is never stripped, since it is what marks a directory
 *  reference. */
const TRIM_LEADING_RE = /^[('"[{`]+/
const TRIM_TRAILING_RE = /[)'"\]},;:.`]+$/

/** Syntax that survives the edge trims because it is not at an edge, and that
 *  no bare path contains. `import('../src/run.ts')` trims to
 *  `import('../src/run.ts`, which is not a path anybody wrote: the token is
 *  code around a path rather than a path, so it yields no ref at all. */
const CODE_TOKEN_SYNTAX_RE = /[()'"=`]/

/** Inside a code block almost every line carries slashes that are not paths
 *  (`and/or`, a URL path), so there a path must also end in an extension or a
 *  slash, or carry a glob or placeholder. In prose a backticked token is
 *  deliberate enough that {@link looksLikePath} alone is the rule. */
const CODE_PATH_SHAPE_RE = /\/$|\.[A-Za-z0-9]{1,5}$|[*<]/
const looksLikePathInCode = (value: string): boolean =>
  looksLikePath(value) && CODE_PATH_SHAPE_RE.test(value)

/** A `../`-rooted path inside a code block is written relative to whatever
 *  directory the example runs from, which is not the referencing file's, so
 *  there is nowhere to look for it. A shape, not an absence. */
const RELATIVE_EXAMPLE: Resolution = { status: 'unchecked', reason: 'pattern' }

/** The fence info strings, and the block kind, whose content is yaml. */
const YAML_LANGS = new Set(['yaml', 'yml'])

/** The value of each `uses:` key, as ranges over `text`. GitHub Actions
 *  resolves one against the repository and ref it names, or against the
 *  workflow's own repository at that ref, so an existence check in this
 *  checkout answers a question nobody asked. */
const usesRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(/\buses:[ \t]*(\S+)/g)) {
    const value = match[1] as string
    const at = match.index + (match[0] as string).length - value.length
    ranges.push([at, at + value.length])
  }
  return ranges
}

const inRanges = (at: number, ranges: ReadonlyArray<[number, number]>): boolean =>
  ranges.some(([from, to]) => at >= from && at < to)

/** Paths and file:line references written inside a code block, token by
 *  token. Narrower than the prose rule ({@link looksLikePathInCode}), and
 *  blind to whatever `skip` covers. */
const locatePathsInCode = (content: string, skip: ReadonlyArray<[number, number]>): Located[] => {
  const located: Located[] = []
  for (const match of content.matchAll(/\S+/g)) {
    const token = (match[0] as string).replace(TRIM_LEADING_RE, '').replace(TRIM_TRAILING_RE, '')
    if (token === '') continue
    if (inRanges(match.index, skip)) continue
    if (CODE_TOKEN_SYNTAX_RE.test(token)) continue
    const resolution = token.startsWith('../') ? RELATIVE_EXAMPLE : UNRESOLVED
    if (isFileLineToken(token)) {
      located.push({ at: match.index, ref: { kind: 'file_line', value: token, resolution } })
      continue
    }
    if (looksLikePathInCode(token)) {
      located.push({ at: match.index, ref: { kind: 'path', value: token, resolution } })
    }
  }
  return located
}

/** `https://...` up to the next whitespace or an enclosing bracket or quote,
 *  as ranges over `text`, so an issue match whose `#` falls inside one is
 *  dropped as part of the URL rather than read as a reference of its own. */
const urlRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) {
    ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

/** An `owner/repo` slug written immediately before a `#`: the reference is to
 *  another repository's issue, which this audit cannot resolve against the
 *  checkout it was given. */
const CROSS_REPO_RE = /[\w.-]+\/[\w.-]+$/

/** A `:` or `,` touching the `#`, as in a mermaid `classDef ... color:#000` or
 *  a CSS declaration. Deliberately NOT tolerant of a space between them: prose
 *  writes "#116, #129" and "blocked by: #123", and every one of those is an
 *  issue number of exactly the three digits a colour has. A style declaration
 *  writes no space there, so adjacency is what separates the two. The accepted
 *  cost is a deliberate false negative on "blocked by:#123". */
const COLOUR_PREFIX_RE = /[:,]$/

/**
 * `#123` anywhere in `text`, in prose or inside a code span alike, with four
 * exclusions: a `#` inside a URL is part of the URL; a `#` preceded by an
 * `owner/repo` slug names another repository's issue; a number with a leading
 * zero is no issue number, which is what keeps `#000` out; and a `#` touching
 * a preceding `:` or `,` with three or six digits after it is a colour.
 *
 * Two further exclusions fall out of the pattern itself: a hex colour
 * containing a letter never matches, because the pattern is built from `\d`
 * only, and an ATX heading never matches, because CommonMark requires a space
 * after the `#` while this pattern requires a digit.
 */
const locateIssues = (text: string): Located[] => {
  const ranges = urlRanges(text)
  const located: Located[] = []
  for (const match of text.matchAll(/#(\d+)\b/g)) {
    const start = match.index
    if (ranges.some(([from, to]) => start >= from && start < to)) continue
    const digits = match[1] as string
    if (digits.startsWith('0')) continue
    const before = text.slice(0, start)
    if (CROSS_REPO_RE.test(before)) continue
    if ((digits.length === 3 || digits.length === 6) && COLOUR_PREFIX_RE.test(before)) continue
    located.push({ at: start, ref: { kind: 'issue', value: `#${digits}`, resolution: UNRESOLVED } })
  }
  return located
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
  located.push(...locateIssues(text))
  return inSourceOrder(located)
}

/**
 * The references in one opaque block, for a caller that already holds the
 * block's text, info string and kind ({@link extractRefs} would need the text
 * wrapped back in a fence, which breaks on an info string like `c++` and on a
 * body containing a fence line of its own).
 *
 * A mermaid diagram yields nothing: its `#`s are colours and its arrows are
 * not paths, so every ref it could produce would be a false one.
 */
export const extractBlockRefs = (
  text: string,
  lang: string | null,
  kind: 'code' | 'frontmatter' | 'mermaid',
): Ref[] => {
  if (kind === 'mermaid') return []
  const located: Located[] = []
  if (kind === 'code' && COMMAND_LANGS.has((lang ?? '').toLowerCase())) {
    located.push(...locateCommands(text))
  }
  located.push(...locateScripts(text))
  const yaml = kind === 'frontmatter' || YAML_LANGS.has((lang ?? '').toLowerCase())
  located.push(...locatePathsInCode(text, yaml ? usesRanges(text) : []))
  located.push(...locateIssues(text))
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
  /** What the caller's one batched lookup said about a number. Nothing here
   *  reaches the network. */
  issueState: (n: number) => IssueLookup
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
 *  fact from "looked and absent". `*` and `<name>` are the literal spellings;
 *  `{` and `$` are the env-templated one a skill writes
 *  (`${CLAUDE_PLUGIN_ROOT}/bin/audit.ts`), each on its own because either
 *  character alone is enough to make the value a template; `NNN` and `...`
 *  are the prose spellings of the same thing. */
const isPattern = (value: string): boolean =>
  value.includes('*') ||
  value.includes('<') ||
  value.includes('{') ||
  value.includes('$') ||
  value.includes('NNN') ||
  value.includes('...')

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

  // A value with no extension may be a record named by its number, with the
  // file carrying a slug after it (`docs/adr/022` for `docs/adr/022-slug.md`).
  // Exactly one tracked path starting with the value and a separator is that
  // file; two or more is a prefix that names none of them in particular.
  if (extname(value) === '' && !value.endsWith('/')) {
    const named = ctx.tracked.filter(
      (tracked) => tracked.startsWith(`${value}-`) || tracked.startsWith(`${value}.`),
    )
    const only = named.length === 1 ? named[0] : undefined
    if (only !== undefined) return { status: 'found', repoPath: only }
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
/** An issue's resolution. `unavailable` is "could not ask", which is a
 *  different fact from "no such issue", and only the second is a finding. */
const resolveIssue = (ref: Ref, ctx: ResolveContext): Resolution => {
  const lookup = ctx.issueState(Number(ref.value.slice(1)))
  if (lookup === 'unavailable') return unchecked('unavailable')
  if (lookup === 'not_found') return { status: 'absent' }
  return { status: 'issue', state: lookup }
}

/**
 * `true` for a value `git check-ignore` cannot place: one that leaves the
 * repository when it is resolved against the root.
 *
 * git does not skip such a path. It abandons the whole batch with
 * `fatal: ... is outside repository` and status 128, and the batch is shared
 * by every absent ref in the run, so one `../`-rooted path written in prose
 * would cost every other answer and turn each correctly ignored path in the
 * repository into a headline finding.
 *
 * Nothing is lost by leaving it out: this repository's own ignore rules have
 * no opinion about a file outside its tree, so the answer would be "not
 * ignored" either way. The first segment is compared rather than the prefix,
 * so a file actually named `..foo` is still asked about.
 */
const escapesRoot = (value: string): boolean => posix.normalize(value).split('/')[0] === '..'

/** The value to ask `git check-ignore` about, or `null` for a ref that is not
 *  an absent path git can place. A script and an issue can be absent too, and
 *  neither is a path git has an opinion about. */
const ignorableValue = (ref: Ref): string | null => {
  if (ref.resolution.status !== 'absent') return null
  if (ref.kind === 'path') return escapesRoot(ref.value) ? null : ref.value
  if (ref.kind !== 'file_line') return null
  // Extraction only produces a value this pattern matches.
  const file = (FILE_LINE_RE.exec(ref.value) as RegExpExecArray)[1] as string
  return escapesRoot(file) ? null : file
}

/**
 * Rewrite every `absent` path this repository's own ignore rules exclude to
 * `ignored`.
 *
 * One batched `git check-ignore -z --stdin` for the whole run, asked after
 * everything has resolved rather than per ref: a repository with a build
 * directory writes dozens of these, and a child process each would cost more
 * than the audit itself.
 *
 * `run` directly rather than `lib/git.ts` `gitOut`, for two reasons that file
 * names itself: `gitOut` folds a non-zero exit into `null`, and check-ignore
 * exits **1** to say "none of these are ignored", which is an answer and not a
 * failure; and `runGit` carries no stdin, which is how the whole batch is sent
 * in one argv-free call.
 *
 * Answers why the question could not be asked, or `null` when it was. Only 0
 * and 1 are answers; anything else is a failure, and it is reported rather
 * than folded, because the refs it leaves saying `absent` are the audit's
 * headline finding and a reader has no other way to tell a repository with
 * nothing ignored from one git would not answer about.
 */
export const markIgnored = async (
  blocks: ReadonlyArray<{ refs: Ref[] }>,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> => {
  const asked = [
    ...new Set(blocks.flatMap((block) => block.refs.map(ignorableValue).filter((v) => v !== null))),
  ]
  if (asked.length === 0) return null
  const result = await run('git', ['check-ignore', '-z', '--stdin'], {
    cwd: root,
    env,
    stdin: asked.join('\0'),
  })
  // 1 is git's own "none of these are ignored", which needs no rewrite. Any
  // other non-zero status is a failure, including the 127 and 126 a child that
  // never started carries (`lib/process.ts`).
  if (result.status === 1) return null
  if (result.status !== 0)
    return `git check-ignore exited ${result.status}: ${result.stderr.trim()}`
  const ignored = new Set(result.stdout.split('\0').filter((entry) => entry !== ''))
  for (const block of blocks) {
    block.refs = block.refs.map((ref) => {
      const value = ignorableValue(ref)
      return value !== null && ignored.has(value)
        ? { ...ref, resolution: { status: 'ignored' } }
        : ref
    })
  }
  return null
}

/** Every issue number the refs name, deduplicated, for the one batched
 *  lookup. */
export const issueNumbers = (refs: readonly Ref[]): number[] => [
  ...new Set(refs.filter((ref) => ref.kind === 'issue').map((ref) => Number(ref.value.slice(1)))),
]

const resolveOne = (
  ref: Ref,
  ctx: ResolveContext,
  lineCounts: Map<string, number | null>,
): Resolution => {
  // A ref extraction already settled keeps its resolution: only extraction can
  // see which side of a fence a path was written on ({@link RELATIVE_EXAMPLE}).
  // `not_resolved_yet` is the sentinel for "nobody has looked yet".
  const { resolution } = ref
  if (resolution.status !== 'unchecked' || resolution.reason !== 'not_resolved_yet') {
    return resolution
  }
  if (ref.kind === 'file_line') return resolveFileLine(ref, ctx, lineCounts)
  if (ref.kind === 'script') return resolveScript(ref, ctx)
  // The contract for a command is extract-only: what a shell would find on
  // PATH is a fact about the machine, not about this repository.
  if (ref.kind === 'command') return unchecked('no_resolver')
  if (ref.kind === 'issue') return resolveIssue(ref, ctx)
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
