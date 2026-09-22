// Tier 0 (#164, #172): pull the references out of a unit's text and resolve
// each one against the tree, with no model call anywhere. `types.ts` is the
// contract; nothing here invents a shape it does not already declare.
//
// The port of the spike's `refs.ts`, minus everything that spawned `gh`:
// layer 1 moved the issue lookup into `lib/gh.ts` `issueStates`, so an issue's
// state arrives here as an answer the caller already has.

import { existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'

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

/** A ref paired with where in the text it was found, so a caller can emit refs
 *  in source order however many passes produced them. */
type Located = { at: number; ref: Ref }

/** One inline code span's content. A token that is not a path is not a
 *  reference. */
const locateInCodeSpan = (token: string): Located[] => {
  const trimmed = token.trim()
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
}

const unchecked = (reason: 'machine_specific' | 'pattern'): Resolution => ({
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

  return { status: 'absent' }
}

/** `refs`, each carrying the `Resolution` `types.ts` declares. Order is
 *  preserved. */
export const resolveRefs = (refs: Ref[], ctx: ResolveContext): Ref[] =>
  refs.map((ref) => ({ ...ref, resolution: resolvePathValue(ref.value, ctx) }))
