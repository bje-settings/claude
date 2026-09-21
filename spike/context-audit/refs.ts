// Tier 0 of the context audit (#164): extract references from a unit's text
// with no model call, and resolve each one against the tree (or against
// GitHub, for an issue) with plain reads. `types.ts` is the contract; nothing
// here invents a shape it does not already declare.
//
// This is the spike's own tooling: node built-ins only, no dependency on the
// rest of the repository.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Ref } from './types.ts'

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** A fenced code block: ``` optionally followed by a language, a newline,
 *  the content, and a closing fence on its own line. Non-greedy content so a
 *  file with several blocks does not collapse into one match. */
const FENCE_RE = /```([A-Za-z0-9_-]*)\n([\s\S]*?)\n```/g

/** An inline code span: a single backtick, content with no backtick or
 *  newline, a closing backtick. Matched against text with fenced blocks
 *  already removed, so a backtick inside a fenced block (a template literal,
 *  for instance) is never mistaken for one of these. This is a
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

/** Whether `value` reads as a path: it has a directory component, it is a
 *  glob or carries a `<placeholder>` segment (still a path shape, resolved
 *  to `null` rather than tested for existence), it ends in a
 *  narrowly-specific extension, or it is a well-known bare filename. */
const looksLikePath = (value: string): boolean => {
  // A code span with a space in it is a command line that happens to name a
  // path (`python3 tests/x.py out.xml 95`), and no existence check on the
  // whole string can succeed.
  if (/\s/.test(value)) return false
  // A URL has slashes and is no path in the tree.
  if (value.includes('://')) return false
  if (value.includes('/')) return true
  if (value.includes('*') || value.includes('<')) return true
  if (KNOWN_BARE_FILENAMES.has(value)) return true
  return KNOWN_EXTENSIONS.has(extname(value))
}

const FILE_LINE_RE = /^([^\s:]+):(\d+)(?:-(\d+))?$/

const isFileLineToken = (token: string): boolean => {
  const match = FILE_LINE_RE.exec(token)
  return match !== null && looksLikePath(match[1] as string)
}

/** pnpm and yarn subcommands that are real CLI operations rather than a
 *  package.json script name, so `pnpm install` is not read as a script
 *  called "install". `test` is deliberately absent: `pnpm test` and
 *  `yarn test` run the "test" script exactly as `npm test` does, so it is a
 *  script reference and not a built-in to skip. */
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

const scriptRef = (value: string): Ref => ({ kind: 'script', value, resolved: null, detail: null })

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
): Ref[] => {
  const pattern = requireRun
    ? new RegExp(`\\b${manager}\\s+run\\s+(${SCRIPT_NAME})`, 'g')
    : new RegExp(`\\b${manager}\\s+(run\\s+)?(${SCRIPT_NAME})`, 'g')
  const refs: Ref[] = []
  for (const match of text.matchAll(pattern)) {
    if (requireRun) {
      refs.push(scriptRef(`${manager} run ${match[1]}`))
      continue
    }
    const explicit = match[1] !== undefined
    const name = match[2] as string
    if (!explicit && builtins?.has(name)) continue
    refs.push(scriptRef(explicit ? `${manager} run ${name}` : `${manager} ${name}`))
  }
  return refs
}

/** Every `pnpm`/`npm`/`yarn` script invocation in `text`, wherever it
 *  appears: a whole fenced code block's content, or one inline code span's
 *  token. Never called on plain prose, so a sentence that happens to say
 *  "pnpm test" outside backticks is not extracted. */
const extractScripts = (text: string): Ref[] => [
  ...scriptsFromManager(text, 'pnpm', false, PNPM_BUILTINS),
  ...scriptsFromManager(text, 'npm', true, null),
  ...scriptsFromManager(text, 'yarn', false, YARN_BUILTINS),
]

/** One inline code span's content: a script invocation first (it is the
 *  only kind whose token contains whitespace), then a file:line, then a
 *  plain path. A token that is none of those is not a reference. */
const extractFromCodeSpan = (token: string): Ref[] => {
  const trimmed = token.trim()
  if (trimmed === '') return []
  const scripts = extractScripts(trimmed)
  if (scripts.length > 0) return scripts
  if (isFileLineToken(trimmed)) {
    return [{ kind: 'file_line', value: trimmed, resolved: null, detail: null }]
  }
  if (looksLikePath(trimmed)) {
    return [{ kind: 'path', value: trimmed, resolved: null, detail: null }]
  }
  return []
}

/** The first word of each non-blank line in a shell code block, after
 *  stripping a `$ ` prompt, leading `NAME=value` environment assignments and
 *  a leading `sudo`. A comment line (`#...`) has no command, so it is
 *  skipped rather than reported as one starting with `#`. Extraction only:
 *  nothing here runs, or ever will. */
const extractCommands = (blockContent: string): Ref[] => {
  const refs: Ref[] = []
  for (const rawLine of blockContent.split('\n')) {
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
    refs.push({ kind: 'command', value: firstWord[1] as string, resolved: null, detail: null })
  }
  return refs
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

/** `#123` anywhere in `text`, in prose or inside a code span alike, except
 *  where it falls inside a URL. Two further exclusions fall out of the
 *  pattern itself rather than needing their own check: a hex colour
 *  (`#a1b2` or `#fff`) never matches because it is built from `\d` only, so
 *  any hex digit outside 0-9 breaks the match; and an ATX heading
 *  (`# Title`, `## 123`) never matches either, because CommonMark requires a
 *  space after the `#`, and this pattern requires a digit immediately after
 *  it instead. A purely numeric hex colour (`#123456`) is the one case
 *  neither rule catches; it is rare enough in prose to leave unhandled here. */
const extractIssues = (text: string): Ref[] => {
  const ranges = urlRanges(text)
  const refs: Ref[] = []
  for (const match of text.matchAll(/#(\d+)\b/g)) {
    const start = match.index
    if (ranges.some(([from, to]) => start >= from && start < to)) continue
    refs.push({ kind: 'issue', value: `#${match[1]}`, resolved: null, detail: null })
  }
  return refs
}

/**
 * Every reference in `text`, unresolved (`resolved: null, detail: null`
 * throughout; {@link resolveRefs} fills them in). Order is not meaningful:
 * fenced blocks first, then inline code spans, then issue references over
 * the whole original text.
 */
export const extractRefs = (text: string): Ref[] => {
  const refs: Ref[] = []

  for (const fence of text.matchAll(FENCE_RE)) {
    const lang = (fence[1] ?? '').toLowerCase()
    const content = fence[2] ?? ''
    if (COMMAND_LANGS.has(lang)) refs.push(...extractCommands(content))
    refs.push(...extractScripts(content))
  }

  const withoutFences = text.replace(FENCE_RE, '')
  for (const span of withoutFences.matchAll(INLINE_CODE_RE)) {
    refs.push(...extractFromCodeSpan(span[1] as string))
  }

  refs.push(...extractIssues(text))

  return refs
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** What {@link resolveRefs} needs to answer each kind: the repository root, the
 *  repo-relative file the refs came from (for a path written relative to the
 *  file rather than to the root), and an issue lookup a caller injects so
 *  this module never reaches the network itself. */
export type ResolveContext = {
  root: string
  file: string
  issueState: (n: number) => string | null | undefined
  /** Every tracked path, repo-relative. When given, a path that is not found
   *  where it is written but is the tail of a tracked path (`src/fixtures/`,
   *  a bare `test_ft_fixtures.py`) resolves to `null` rather than `false`:
   *  prose names paths relative to a context the reader supplies, and that is
   *  not rot. */
  tracked?: string[]
}

/** `true` for a value this audit will never be able to check: `~/` and an
 *  absolute path both name somewhere outside the tree being audited, so
 *  whether they exist depends on the machine running the audit rather than
 *  on the repository. */
const isMachineSpecific = (value: string): boolean => value.startsWith('~/') || isAbsolute(value)

/** `true` for a glob or a `<placeholder>` segment: a path shape kept by
 *  {@link extractRefs} on purpose, but one an existence check would always
 *  fail, which is a different fact from "looked and absent". */
// `NNN` and `...` are the prose spellings of a placeholder.
const isPattern = (value: string): boolean =>
  value.includes('*') || value.includes('<') || value.includes('NNN') || value.includes('...')

const toRepoRelative = (root: string, absolutePath: string): string =>
  relative(root, absolutePath).split(sep).join('/')

/** A path's resolution: whether it exists (`null` when it cannot be
 *  checked at all), and the repo-relative path it resolved to. Root wins
 *  over file-relative, per the contract in `types.ts`. */
const resolvePathValue = (
  value: string,
  ctx: ResolveContext,
): { resolved: boolean | null; repoPath: string | null } => {
  if (isMachineSpecific(value) || isPattern(value)) return { resolved: null, repoPath: null }

  const fromRoot = join(ctx.root, value)
  if (existsSync(fromRoot)) return { resolved: true, repoPath: toRepoRelative(ctx.root, fromRoot) }

  const fromFile = join(dirname(join(ctx.root, ctx.file)), value)
  if (existsSync(fromFile)) {
    return { resolved: true, repoPath: toRepoRelative(ctx.root, fromFile) }
  }

  const tail = value.replace(/^\.\//, '').replace(/\/$/, '')
  const match = ctx.tracked?.find(
    (path) =>
      path === tail ||
      path.endsWith(`/${tail}`) ||
      path.includes(`/${tail}/`) ||
      path.startsWith(`${tail}/`),
  )
  if (match !== undefined) return { resolved: null, repoPath: match }

  return { resolved: false, repoPath: null }
}

const resolvePath = (ref: Ref, ctx: ResolveContext): Ref => {
  const { resolved, repoPath } = resolvePathValue(ref.value, ctx)
  return { ...ref, resolved, detail: repoPath }
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
  if (match === null) return { ...ref, resolved: false, detail: null }
  const pathPart = match[1] as string
  const needed = Number(match[3] ?? match[2])

  const { resolved, repoPath } = resolvePathValue(pathPart, ctx)
  if (resolved !== true || repoPath === null) return { ...ref, resolved, detail: null }

  let count = lineCounts.get(repoPath)
  if (count === undefined) {
    try {
      count = readFileSync(join(ctx.root, repoPath), 'utf8').split('\n').length
    } catch {
      count = null
    }
    lineCounts.set(repoPath, count)
  }
  return { ...ref, resolved: count !== null && count >= needed, detail: null }
}

/** The nearest `package.json` walking from `file`'s directory up to and
 *  including `root`, or `null` when none of those directories has one (or
 *  the one found does not parse), which resolveScript reads as "no
 *  package.json at all" per the contract. */
const findScripts = (ctx: ResolveContext): Record<string, unknown> | null => {
  const rootAbs = resolve(ctx.root)
  let dir = dirname(join(ctx.root, ctx.file))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { scripts?: unknown }
        if (typeof parsed.scripts === 'object' && parsed.scripts !== null) {
          return parsed.scripts as Record<string, unknown>
        }
        return {}
      } catch {
        return null
      }
    }
    if (resolve(dir) === rootAbs) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const scriptName = (value: string): string | null => {
  const match = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?(\S+)$/.exec(value)
  return match === null ? null : (match[1] as string)
}

const resolveScript = (
  ref: Ref,
  ctx: ResolveContext,
  scriptsCache: Map<string, Record<string, unknown> | null>,
): Ref => {
  let scripts = scriptsCache.get(ctx.file)
  if (scripts === undefined) {
    scripts = findScripts(ctx)
    scriptsCache.set(ctx.file, scripts)
  }
  if (scripts === null) return { ...ref, resolved: null, detail: null }
  const name = scriptName(ref.value)
  return { ...ref, resolved: name !== null && Object.hasOwn(scripts, name), detail: null }
}

const resolveIssue = (ref: Ref, ctx: ResolveContext): Ref => {
  const n = Number(ref.value.slice(1))
  const state = ctx.issueState(n)
  if (state === undefined) return { ...ref, resolved: null, detail: null }
  if (state === null) return { ...ref, resolved: false, detail: null }
  return { ...ref, resolved: true, detail: state }
}

/**
 * `refs`, each carrying `resolved` and `detail` (`types.ts`'s meaning for
 * both). `command` refs are untouched (`resolved: null` throughout): the
 * contract is extract-only, and there is no resolver for them.
 */
export const resolveRefs = (refs: Ref[], ctx: ResolveContext): Ref[] => {
  // Shared across every ref resolved in this call, not across calls: a
  // caller resolving a second file's refs builds a fresh one, which is
  // correct because `findScripts` and the line count both depend on `file`.
  const lineCounts = new Map<string, number | null>()
  const scriptsCache = new Map<string, Record<string, unknown> | null>()

  return refs.map((ref) => {
    switch (ref.kind) {
      case 'path':
        return resolvePath(ref, ctx)
      case 'file_line':
        return resolveFileLine(ref, ctx, lineCounts)
      case 'script':
        return resolveScript(ref, ctx, scriptsCache)
      case 'issue':
        return resolveIssue(ref, ctx)
      case 'command':
        return ref
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

/**
 * The GraphQL query for up to 100 issue/pull-request numbers in one round
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

/**
 * `buildIssueQuery`'s response, aligned back to `numbers` by alias index.
 * A number `gh api graphql` did not return a node for (deleted, or the
 * alias missing from a malformed reply) reads as `null`, the same as a
 * number that resolved to a node with no `state`: both are "looked up, and
 * this repository has nothing to say about it" rather than a crash. Pure
 * and exported so parsing is tested without a network call.
 */
export const parseIssueResponse = (
  data: unknown,
  numbers: number[],
): Map<number, string | null> => {
  const result = new Map<number, string | null>()
  const repository = asRecord(asRecord(data)?.data ?? data)?.repository
  const repositoryRecord = asRecord(repository)
  numbers.forEach((n, index) => {
    const node = asRecord(repositoryRecord?.[`i${index}`])
    const state = node?.state
    result.set(n, typeof state === 'string' ? state : null)
  })
  return result
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/**
 * Read-only. Every number's state, `OPEN` or `CLOSED`, batched at up to 100
 * per `gh api graphql` call (GitHub's own alias limit). `gh repo view`
 * supplies the owner and name so the caller only names a checkout, not a
 * repository slug. Run with `cwd: root`, so a direnv-scoped `gh` session
 * picks the right account from the checkout alone.
 *
 * Never throws: any failure (`gh` missing, not authenticated, offline, a
 * malformed reply) answers with an empty map, which is what makes every
 * number resolve to `null` (`resolved: null`, "unavailable") through
 * {@link ResolveContext.issueState} rather than aborting the whole audit
 * over one network call.
 */
export const ghIssueStates = (root: string, numbers: number[]): Map<number, string | null> => {
  const unique = [...new Set(numbers)]
  if (unique.length === 0) return new Map()

  try {
    const repoInfo = JSON.parse(
      execFileSync('gh', ['repo', 'view', '--json', 'owner,name'], { cwd: root, encoding: 'utf8' }),
    ) as { owner?: { login?: string }; name?: string }
    const owner = repoInfo.owner?.login
    const name = repoInfo.name
    if (owner === undefined || name === undefined) return new Map()

    const result = new Map<number, string | null>()
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100)
      const query = buildIssueQuery(owner, name, chunk)
      const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
        cwd: root,
        encoding: 'utf8',
      })
      for (const [n, state] of parseIssueResponse(JSON.parse(output), chunk)) result.set(n, state)
    }
    return result
  } catch {
    // A partial batch is discarded along with the rest: "gh failed" is one
    // outcome, not "gh failed after telling us about the first hundred".
    return new Map()
  }
}
