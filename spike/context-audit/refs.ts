// Tier 0 of the context audit (#164): extract references from a unit's text
// with no model call, and resolve each one against the tree (or against
// GitHub, for an issue) with plain reads. `types.ts` is the contract; nothing
// here invents a shape it does not already declare.
//
// This is the spike's own tooling: node built-ins only, no dependency on the
// rest of the repository.

import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IssueLookup, IssueState, Ref, Resolution } from './types.ts'

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** What every extracted ref carries until {@link resolveRefs} runs. */
const UNRESOLVED: Resolution = { status: 'unchecked', reason: 'not_resolved_yet' }

/** A fenced code block: ``` optionally followed by a language, a newline,
 *  the content, and a closing fence alone on its line. The closing fence is
 *  anchored at both ends (a newline before it, nothing but blanks after it
 *  until the next newline or the end of the text), so a line such as
 *  `` see ``` for the fence `` does not close a block early. Non-greedy
 *  content, so a file with several blocks does not collapse into one match. */
const FENCE_RE = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g

/** An inline code span: a single backtick, content with no backtick or
 *  newline, a closing backtick. Matched against text with fenced blocks
 *  already blanked out, so a backtick inside a fenced block (a template
 *  literal, for instance) is never mistaken for one of these. This is a
 *  simplification of CommonMark's own rule (which allows multi-backtick
 *  delimiters); every path, file:line and script reference this audit cares
 *  about is written with a single pair, so the simpler rule is enough. */
const INLINE_CODE_RE = /`([^`\n]+)`/g

const COMMAND_LANGS = new Set(['bash', 'sh', 'shell', 'zsh'])

/** Extensions specific enough that a backticked token ending in one is a
 *  path reference and not a generic example. Deliberately narrower than
 *  "every extension a repository might contain": a broad extension like
 *  `.md` or `.json` also names a whole class of prose example, so those go
 *  through {@link KNOWN_BARE_FILENAMES} instead, by exact name rather than
 *  by suffix. */
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

/** Bare filenames worth treating as a path reference on their own, even
 *  though their extension is too generic to qualify by suffix alone. */
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
 * happens to name a path, such as `python3 tests/x.py out.xml 95`, where no
 * existence check on the whole string can ever succeed) and a value
 * containing `://` (a URL has slashes and is no path in the tree).
 *
 * Accepted: a value with a directory component, a glob or a `<placeholder>`
 * segment (still a path shape, resolved `unchecked` rather than tested for
 * existence), a narrowly-specific extension, or a well-known bare filename.
 */
const looksLikePath = (value: string): boolean => {
  if (/\s/.test(value)) return false
  if (value.includes('://')) return false
  if (value.includes('/')) return true
  if (value.includes('*') || value.includes('<')) return true
  if (KNOWN_BARE_FILENAMES.has(value)) return true
  return KNOWN_EXTENSIONS.has(extname(value))
}

/** Inside a code block almost every line carries slashes that are not paths
 *  (`and/or`, `git@github.com:owner/repo`, a URL path), so there a path must
 *  also end in an extension or a slash, or carry a glob or placeholder. In
 *  prose a backticked token is deliberate enough that {@link looksLikePath}
 *  alone is the rule. */
const CODE_PATH_SHAPE_RE = /\/$|\.[A-Za-z0-9]{1,5}$|[*<]/
const looksLikePathInCode = (value: string): boolean =>
  looksLikePath(value) && CODE_PATH_SHAPE_RE.test(value)

const FILE_LINE_RE = /^([^\s:]+):(\d+)(?:-(\d+))?$/

const isFileLineToken = (token: string): boolean => {
  const match = FILE_LINE_RE.exec(token)
  return match !== null && looksLikePath(match[1] as string)
}

/** pnpm and yarn subcommands that are real CLI operations rather than a
 *  package.json script name, so `pnpm install` is not read as a script
 *  called "install". `test` is deliberately absent: `pnpm test` and
 *  `yarn test` run the "test" script, so both are script references. `npm`
 *  needs no such list because only its explicit `npm run <name>` form is
 *  read as a script at all. */
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

/** A ref paired with where in the text it was found, so a caller can emit
 *  refs in source order however many passes produced them. */
type Located = { at: number; ref: Ref }

const scriptRef = (value: string): Ref => ({ kind: 'script', value, resolution: UNRESOLVED })

/** Script invocations for one manager. `requireRun` is `npm`'s rule (only
 *  the explicit `npm run <name>` form is a script; bare `npm <name>` is left
 *  alone because most bare npm subcommands, unlike pnpm's and yarn's, are
 *  not also valid script shorthands). Everywhere else the bare form is a
 *  script unless `builtins` says it is a real subcommand. */
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

/** Every `pnpm`/`npm`/`yarn` script invocation in `text`, wherever it
 *  appears: a whole fenced code block's content, or one inline code span's
 *  token. Never called on plain prose, so a sentence that happens to say
 *  "pnpm test" outside backticks is not extracted. */
const locateScripts = (text: string): Located[] => [
  ...scriptsFromManager(text, 'pnpm', false, PNPM_BUILTINS),
  ...scriptsFromManager(text, 'npm', true, null),
  ...scriptsFromManager(text, 'yarn', false, YARN_BUILTINS),
]

/** One inline code span's content: a script invocation first (it is the
 *  only kind whose token contains whitespace), then a file:line, then a
 *  plain path. A token that is none of those is not a reference. */
const locateInCodeSpan = (token: string): Located[] => {
  const trimmed = token.trim()
  if (trimmed === '') return []
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

/** The first word of each non-blank line in a shell code block, after
 *  stripping a `$ ` prompt, leading `NAME=value` environment assignments and
 *  a leading `sudo`. A comment line (`#...`) has no command, so it is
 *  skipped rather than reported as one starting with `#`. Extraction only:
 *  nothing here runs, or ever will. */
const locateCommands = (blockContent: string): Located[] => {
  const located: Located[] = []
  let lineStart = 0
  for (const rawLine of blockContent.split('\n')) {
    const at = lineStart
    lineStart += rawLine.length + 1
    let rest = rawLine.trim()
    if (rest === '' || rest.startsWith('#')) continue
    if (rest.startsWith('$ ')) rest = rest.slice(2).trim()
    else if (rest === '$') continue

    for (
      let assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
      assignment !== null;
      assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest)
    ) {
      rest = rest.slice(assignment[0].length)
    }
    rest = rest.replace(/^sudo\s+/, '')

    const firstWord = /^(\S+)/.exec(rest)
    if (firstWord === null) continue
    located.push({
      at,
      ref: { kind: 'command', value: firstWord[1] as string, resolution: UNRESOLVED },
    })
  }
  return located
}

/** Wrapping punctuation around a token inside a code block: quotes and
 *  brackets on the left, those plus sentence punctuation on the right.
 *  A leading `.` is never stripped, since `../../lib/git.ts` starts with
 *  one, and a trailing `/` is never stripped, since it is what marks a
 *  directory reference. */
const TRIM_LEADING_RE = /^[('"[{`]+/
const TRIM_TRAILING_RE = /[)'"\]},;:.`]+$/

/** Paths and file:line references written inside a code block, token by
 *  token. Narrower than the prose rule ({@link looksLikePathInCode}). */
const locatePathsInCode = (content: string): Located[] => {
  const located: Located[] = []
  for (const match of content.matchAll(/\S+/g)) {
    const token = (match[0] as string).replace(TRIM_LEADING_RE, '').replace(TRIM_TRAILING_RE, '')
    if (token === '') continue
    if (isFileLineToken(token)) {
      located.push({
        at: match.index,
        ref: { kind: 'file_line', value: token, resolution: UNRESOLVED },
      })
      continue
    }
    if (looksLikePathInCode(token)) {
      located.push({ at: match.index, ref: { kind: 'path', value: token, resolution: UNRESOLVED } })
    }
  }
  return located
}

/** `https://...` (or `http://...`) up to the next whitespace or an
 *  enclosing bracket/quote, as ranges over `text`, so an issue match whose
 *  `#` falls inside one can be dropped as part of the URL rather than a
 *  reference of its own. */
const urlRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) {
    const start = match.index
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

/** An `owner/repo` slug written immediately before a `#`: the reference is
 *  to another repository's issue, which this audit cannot resolve against
 *  the checkout it was given. */
const CROSS_REPO_RE = /[\w.-]+\/[\w.-]+$/

/** A `:` or `,` touching the `#`, as in a mermaid `classDef ... color:#000`
 *  or a CSS declaration. Deliberately NOT tolerant of a space between them:
 *  prose writes "#116, #129, #140" and "blocked by: #123", and every one of
 *  those is an issue number of exactly the three digits a colour has. A
 *  style declaration writes no space there, so adjacency is what separates
 *  the two. */
const COLOUR_PREFIX_RE = /[:,]$/

/** `#123` anywhere in `text`, in prose or inside a code span alike, with
 *  four exclusions. A `#` inside a URL is part of the URL. A `#` preceded by
 *  an `owner/repo` slug names another repository's issue. A number with a
 *  leading zero (or 0 itself) is no issue number, which is what keeps a
 *  numeric hex colour such as `#000` out. And a `#` touching a preceding `:`
 *  or `,` with three or six digits after it is a colour in a style
 *  declaration, whatever those digits are.
 *
 * Two further exclusions fall out of the pattern itself: a hex colour
 * containing a letter (`#a1b2c3`, `#fff`) never matches, because the pattern
 * is built from `\d` only; and an ATX heading (`# Title`, `## 123`) never
 * matches either, because CommonMark requires a space after the `#` while
 * this pattern requires a digit. */
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
 * Every reference in `text`, unresolved (`{status: 'unchecked', reason:
 * 'not_resolved_yet'}` throughout; {@link resolveRefs} fills them in).
 *
 * Order is the order the references appear in `text`, and it is stable: a
 * consumer that takes "the first resolved ref" of a unit therefore takes the
 * first one the writer wrote. Refs found inside one fenced block or one code
 * span share that block's offset and keep their own relative order.
 */
export const extractRefs = (text: string): Ref[] => {
  const located: Located[] = []

  for (const fence of text.matchAll(FENCE_RE)) {
    const lang = (fence[1] ?? '').toLowerCase()
    const content = fence[2] ?? ''
    // The content starts on the line after the opening fence.
    const base = fence.index + (fence[0] as string).indexOf('\n') + 1
    const offset = (entries: Located[]) => entries.map((e) => ({ at: base + e.at, ref: e.ref }))
    if (COMMAND_LANGS.has(lang)) located.push(...offset(locateCommands(content)))
    located.push(...offset(locateScripts(content)))
  }

  // Fenced blocks are blanked rather than removed, so every offset below is
  // still an offset into the original `text`.
  const withoutFences = text.replace(FENCE_RE, (block) => ' '.repeat(block.length))
  for (const span of withoutFences.matchAll(INLINE_CODE_RE)) {
    const base = span.index + 1
    for (const entry of locateInCodeSpan(span[1] as string)) {
      located.push({ at: base + entry.at, ref: entry.ref })
    }
  }

  located.push(...locateIssues(text))

  return inSourceOrder(located)
}

/**
 * The references in one opaque block, for a caller holding the block's text,
 * info string and kind already ({@link extractRefs} would need the text
 * wrapped back in a fence, which breaks on an info string like `c++` and on
 * a body that contains a fence line of its own).
 *
 * - `mermaid`: nothing. A diagram's `#`s are colours and its arrows are not
 *   paths, so every ref it could yield would be a false one.
 * - `code`, `frontmatter`: scripts, paths, file:line references and issue
 *   numbers; commands as well when `lang` names a shell.
 *
 * Source order, as {@link extractRefs}.
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
  located.push(...locatePathsInCode(text))
  located.push(...locateIssues(text))
  return inSourceOrder(located)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One `package.json`, read once: its `scripts` object, or why there is
 *  none to read. */
export type PackageJsonEntry =
  | { found: true; scripts: Record<string, unknown> }
  | { found: false; reason: 'none' | 'unreadable' }

/** Absolute `package.json` path to what reading it produced. A caller that
 *  shares one across a run parses each `package.json` once instead of once
 *  per {@link resolveRefs} call. */
export type PackageJsonCache = Map<string, PackageJsonEntry>

/** What {@link resolveRefs} needs to answer each kind: the repository root, the
 *  repo-relative file the refs came from (for a path written relative to the
 *  file rather than to the root), and an issue lookup a caller injects.
 *  `resolveRefs` itself never reaches the network; {@link ghIssueStates},
 *  exported from this same module, is the piece that does, and a caller
 *  wires its answers in through {@link ResolveContext.issueState}. */
export type ResolveContext = {
  root: string
  file: string
  issueState: (n: number) => IssueLookup
  /** Every tracked path, repo-relative. When given, a path that is not found
   *  where it is written but ends a tracked path at a segment boundary
   *  resolves `tail_match` rather than `absent`: prose names paths relative
   *  to a context the reader supplies, and that is not rot. */
  tracked?: string[]
  /** Shared across calls by a caller that has one; a private one is used
   *  when it is absent. */
  packageJson?: PackageJsonCache
}

const unchecked = (
  reason: 'not_resolved_yet' | 'no_resolver' | 'machine_specific' | 'pattern' | 'unavailable',
): Resolution => ({ status: 'unchecked', reason })

/** `true` for a value this audit will never be able to check: `~/` and an
 *  absolute path both name somewhere outside the tree being audited, so
 *  whether they exist depends on the machine running the audit rather than
 *  on the repository. */
const isMachineSpecific = (value: string): boolean => value.startsWith('~/') || isAbsolute(value)

/** `true` for a glob or a placeholder: a path shape {@link extractRefs} keeps
 *  on purpose, but one an existence check would always fail, which is a
 *  different fact from "looked and absent". `*` and `<name>` are the literal
 *  spellings; `NNN` and `...` are the prose spellings of the same thing. */
const isPattern = (value: string): boolean =>
  value.includes('*') || value.includes('<') || value.includes('NNN') || value.includes('...')

const toRepoRelative = (root: string, absolutePath: string): string =>
  relative(root, absolutePath).split(sep).join('/')

/**
 * A path's resolution.
 *
 * A path is looked for under the audited root first and only then relative to
 * the referencing file's own directory: prose in this repository names paths
 * from the root far more often than from the file, so when both exist the
 * root's is the one meant.
 *
 * Failing both, `tracked` (when supplied) can still absolve the path: a
 * `tail_match` is a tracked path the written value ENDS, at a segment
 * boundary, or for a value written with a trailing slash a tracked path that
 * contains it as whole segments. A bare prefix or a mid-path substring is
 * not enough, and a single-segment directory reference (`skills/`, `bin/`)
 * is too generic to absolve anything, so it resolves `unchecked` instead.
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

  const isDirectoryRef = value.endsWith('/')
  const tail = value.replace(/^\.\//, '').replace(/\/$/, '')
  if (isDirectoryRef && !tail.includes('/')) return unchecked('pattern')

  const witness = ctx.tracked?.find(
    (path) =>
      path === tail ||
      path.endsWith(`/${tail}`) ||
      (isDirectoryRef && `/${path}`.includes(`/${tail}/`)),
  )
  if (witness !== undefined) return { status: 'tail_match', witness }

  return { status: 'absent' }
}

const resolvePath = (ref: Ref, ctx: ResolveContext): Ref => ({
  ...ref,
  resolution: resolvePathValue(ref.value, ctx),
})

/** A file's line count the way `wc -l` counts it: a trailing newline ends the
 *  last line rather than starting an empty one. */
const countLines = (contents: string): number => {
  if (contents === '') return 0
  const lines = contents.split('\n').length
  return contents.endsWith('\n') ? lines - 1 : lines
}

const resolveFileLine = (
  ref: Ref,
  ctx: ResolveContext,
  lineCounts: Map<string, number | null>,
): Ref => {
  const match = FILE_LINE_RE.exec(ref.value)
  // Extraction only produces values this pattern matches; kept as a
  // defensive fallback rather than a throw, since a resolver has no good
  // reason to crash on a ref it did not itself generate the shape of.
  if (match === null) return { ...ref, resolution: { status: 'absent' } }
  const pathPart = match[1] as string
  // The END of a range: `15-25` on a 20-line file overruns the file.
  const needed = Number(match[3] ?? match[2])

  const resolution = resolvePathValue(pathPart, ctx)
  if (resolution.status !== 'found') return { ...ref, resolution }
  const repoPath = resolution.repoPath as string

  let count = lineCounts.get(repoPath)
  if (count === undefined) {
    try {
      count = countLines(readFileSync(join(ctx.root, repoPath), 'utf8'))
    } catch {
      // The path exists but is not a readable file (a directory, say): the
      // line count could not be taken, which is not "the line is missing".
      count = null
    }
    lineCounts.set(repoPath, count)
  }
  if (count === null) return { ...ref, resolution: unchecked('unavailable') }
  if (count < needed) {
    return { ...ref, resolution: { status: 'line_out_of_range', repoPath, lines: count } }
  }
  return { ...ref, resolution: { status: 'found', repoPath } }
}

const readPackageJson = (path: string): PackageJsonEntry => {
  if (!existsSync(path)) return { found: false, reason: 'none' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: unknown }
    if (typeof parsed.scripts === 'object' && parsed.scripts !== null) {
      return { found: true, scripts: parsed.scripts as Record<string, unknown> }
    }
    return { found: true, scripts: {} }
  } catch {
    return { found: false, reason: 'unreadable' }
  }
}

/** The nearest `package.json` walking from `file`'s directory up to and
 *  including `root`. A `package.json` that does not parse stops the walk:
 *  the answer is "could not read the manifest that governs this file", not
 *  "look further up". */
const findScripts = (ctx: ResolveContext, cache: PackageJsonCache): PackageJsonEntry => {
  const rootAbs = resolve(ctx.root)
  let dir = dirname(join(ctx.root, ctx.file))
  for (;;) {
    const candidate = join(dir, 'package.json')
    let entry = cache.get(candidate)
    if (entry === undefined) {
      entry = readPackageJson(candidate)
      cache.set(candidate, entry)
    }
    if (entry.found || entry.reason === 'unreadable') return entry
    if (resolve(dir) === rootAbs) return entry
    const parent = dirname(dir)
    if (parent === dir) return entry
    dir = parent
  }
}

const scriptName = (value: string): string | null => {
  const match = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?(\S+)$/.exec(value)
  return match === null ? null : (match[1] as string)
}

const resolveScript = (ref: Ref, ctx: ResolveContext, cache: PackageJsonCache): Ref => {
  const entry = findScripts(ctx, cache)
  if (!entry.found) {
    // No manifest at all means there is nothing to resolve against; one that
    // does not parse means the question could not be asked. Neither is a
    // missing script, and the two are not the same finding.
    return {
      ...ref,
      resolution: unchecked(entry.reason === 'none' ? 'no_resolver' : 'unavailable'),
    }
  }
  const name = scriptName(ref.value)
  if (name !== null && Object.hasOwn(entry.scripts, name)) {
    return { ...ref, resolution: { status: 'found', repoPath: null } }
  }
  return { ...ref, resolution: { status: 'absent' } }
}

const resolveIssue = (ref: Ref, ctx: ResolveContext): Ref => {
  const lookup = ctx.issueState(Number(ref.value.slice(1)))
  if (lookup === 'unavailable') return { ...ref, resolution: unchecked('unavailable') }
  if (lookup === 'not_found') return { ...ref, resolution: { status: 'absent' } }
  return { ...ref, resolution: { status: 'issue', state: lookup } }
}

/**
 * `refs`, each carrying the `Resolution` `types.ts` declares. Order is
 * preserved. Nothing here reaches the network: an issue's state comes from
 * {@link ResolveContext.issueState}, which the caller supplies.
 *
 * A `command` ref resolves `{status: 'unchecked', reason: 'no_resolver'}`:
 * the contract for commands is extract-only.
 */
export const resolveRefs = (refs: Ref[], ctx: ResolveContext): Ref[] => {
  // Line counts are keyed by repo-relative path, so they are safe to share
  // across the refs of one call. `package.json` reads are keyed by absolute
  // path, so a caller may share them across every call of a run.
  const lineCounts = new Map<string, number | null>()
  const packageJson = ctx.packageJson ?? new Map<string, PackageJsonEntry>()

  return refs.map((ref) => {
    switch (ref.kind) {
      case 'path':
        return resolvePath(ref, ctx)
      case 'file_line':
        return resolveFileLine(ref, ctx, lineCounts)
      case 'script':
        return resolveScript(ref, ctx, packageJson)
      case 'issue':
        return resolveIssue(ref, ctx)
      case 'command':
        return { ...ref, resolution: unchecked('no_resolver') }
      default: {
        // Exhaustiveness check: a new `RefKind` must add a case above rather
        // than silently falling through to "unresolved".
        const exhaustive: never = ref.kind
        throw new Error(`refs.ts: unhandled ref kind ${String(exhaustive)}`)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// GitHub issue and pull request state
// ---------------------------------------------------------------------------

/** How many numbers go into one `gh api graphql` call. A conservative batch
 *  size rather than a documented limit: GitHub rejects a query by node count
 *  and complexity, not by a fixed number of aliases, and 100 `state` fields
 *  are far below either. */
const ISSUE_BATCH = 100

/**
 * The GraphQL query for a batch of issue/pull-request numbers in one round
 * trip: one aliased `issueOrPullRequest` field per number, each asking for
 * `state` under both possible types (`gh` cannot tell the caller in advance
 * which of the two a number is). Pure and exported so the query shape is
 * tested without a network call.
 */
export const buildIssueQuery = (owner: string, name: string, numbers: number[]): string => {
  const fields = numbers
    .map(
      (n, index) =>
        `i${index}: issueOrPullRequest(number: ${n}) { ` +
        `... on Issue { state } ... on PullRequest { state } }`,
    )
    .join('\n    ')
  return `query {\n  repository(owner: "${owner}", name: "${name}") {\n    ${fields}\n  }\n}`
}

const ISSUE_STATES = new Set<string>(['OPEN', 'CLOSED', 'MERGED'])

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/**
 * `buildIssueQuery`'s response, aligned back to `numbers` by alias index.
 * A number the reply has no node for (a number nothing in this repository
 * uses, a deleted item, an alias missing from a malformed reply) reads as
 * `not_found`, the same as a node carrying no recognised `state`: both are
 * "asked, and this repository has nothing to say about it". `unavailable`
 * is never produced here, because a parsed reply IS an answer. Pure and
 * exported so parsing is tested without a network call.
 */
export const parseIssueResponse = (
  data: unknown,
  numbers: number[],
): Map<number, IssueState | 'not_found'> => {
  const result = new Map<number, IssueState | 'not_found'>()
  const repository = asRecord(asRecord(data)?.data ?? data)?.repository
  const repositoryRecord = asRecord(repository)
  numbers.forEach((n, index) => {
    const state = asRecord(repositoryRecord?.[`i${index}`])?.state
    result.set(
      n,
      typeof state === 'string' && ISSUE_STATES.has(state) ? (state as IssueState) : 'not_found',
    )
  })
  return result
}

/** One chunk's outcome: the states it answered with, or why it could not be
 *  read at all. */
export type IssueChunkOutcome =
  | { ok: true; states: Map<number, IssueState | 'not_found'> }
  | { ok: false; reason: string }

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

const firstLine = (value: string): string | null => {
  const line = value.split('\n').find((candidate) => candidate.trim() !== '')
  return line === undefined ? null : line.trim()
}

const graphqlErrors = (body: unknown): string | null => {
  const errors = asRecord(body)?.errors
  if (!Array.isArray(errors)) return null
  const messages = errors
    .map((entry) => asRecord(entry)?.message)
    .filter((message): message is string => typeof message === 'string')
  return messages.length === 0 ? null : messages.join('; ')
}

/**
 * What a failed `gh api graphql` call actually said.
 *
 * `gh` exits 1 when ANY alias in the query errors, but still prints a body
 * whose `data` carries every alias that did resolve, with the failed ones
 * `null`. One unusable number would otherwise discard the whole chunk, so a
 * body with a `repository` object in it is read as an answer, and only a
 * reply with no usable body at all is a failure.
 *
 * Pure and exported so both branches are tested without a network call:
 * `error` is the shape `execFileSync` throws (`stdout`, `stderr`, `message`).
 */
export const parseIssueChunkFailure = (error: unknown, numbers: number[]): IssueChunkOutcome => {
  const record = asRecord(error)
  const stdout = textOf(record?.stdout)
  let body: unknown
  try {
    body = stdout.trim() === '' ? undefined : JSON.parse(stdout)
  } catch {
    body = undefined
  }
  if (asRecord(asRecord(asRecord(body)?.data)?.repository) !== undefined) {
    return { ok: true, states: parseIssueResponse(body, numbers) }
  }
  const reason =
    graphqlErrors(body) ??
    firstLine(textOf(record?.stderr)) ??
    firstLine(typeof record?.message === 'string' ? record.message : '') ??
    'gh api graphql failed'
  return { ok: false, reason }
}

/** Every number's state, with the reason when some chunk could not be read
 *  at all. `unavailable` is a sentence for the report, never a per-number
 *  verdict: a number missing from `states` was in a chunk that failed. */
export type IssueStates = {
  states: Map<number, IssueState | 'not_found'>
  unavailable: string | null
}

/**
 * Read-only. Every number's state, batched at {@link ISSUE_BATCH} numbers per
 * `gh api graphql` call. `gh repo view` supplies the owner and name so the
 * caller only names a checkout, not a repository slug. Run with `cwd: root`,
 * so a direnv-scoped `gh` session picks the right account from the checkout
 * alone.
 *
 * Never throws. A chunk that answered is kept even when `gh` exited non-zero
 * over one bad number in it (see {@link parseIssueChunkFailure}); a chunk
 * that could not be read at all contributes its reason to `unavailable` and
 * leaves its numbers out of `states`, which a caller reads as
 * `IssueLookup.unavailable`.
 */
export const ghIssueStates = (root: string, numbers: number[]): IssueStates => {
  const unique = [...new Set(numbers)]
  if (unique.length === 0) return { states: new Map(), unavailable: null }

  let owner: string | undefined
  let name: string | undefined
  try {
    const repoInfo = JSON.parse(
      execFileSync('gh', ['repo', 'view', '--json', 'owner,name'], {
        cwd: root,
        encoding: 'utf8',
        // stderr captured rather than inherited, so a failure reads back as
        // this function's `unavailable` reason instead of printing itself.
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as { owner?: { login?: string }; name?: string }
    owner = repoInfo.owner?.login
    name = repoInfo.name
  } catch (error) {
    const record = asRecord(error)
    const reason =
      firstLine(textOf(record?.stderr)) ??
      firstLine(typeof record?.message === 'string' ? record.message : '') ??
      'gh repo view failed'
    return { states: new Map(), unavailable: `gh repo view failed: ${reason}` }
  }
  if (owner === undefined || name === undefined) {
    return { states: new Map(), unavailable: 'gh repo view returned no owner or name' }
  }

  const states = new Map<number, IssueState | 'not_found'>()
  const failures: string[] = []
  for (let i = 0; i < unique.length; i += ISSUE_BATCH) {
    const chunk = unique.slice(i, i + ISSUE_BATCH)
    const query = buildIssueQuery(owner, name, chunk)
    let outcome: IssueChunkOutcome
    try {
      const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
        cwd: root,
        encoding: 'utf8',
        // `gh` writes a line per bad alias here and still exits 1 with a
        // usable body; capturing stderr keeps that noise out of the caller's
        // output and hands it to `parseIssueChunkFailure` instead.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      outcome = { ok: true, states: parseIssueResponse(JSON.parse(output), chunk) }
    } catch (error) {
      outcome = parseIssueChunkFailure(error, chunk)
    }
    if (outcome.ok) for (const [n, state] of outcome.states) states.set(n, state)
    else failures.push(outcome.reason)
  }
  return { states, unavailable: failures.length === 0 ? null : failures.join('; ') }
}
