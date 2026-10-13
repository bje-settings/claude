// Copy the root `lib/` into each plugin (ADR 006). Run it after each edit to
// `lib/`:
//
//   node scripts/sync-lib.ts           # write the copies
//   node scripts/sync-lib.ts --check   # write nothing, report each drift
//
// A plugin gets only the `lib/` files that its own `.ts` files import, and
// each file that those files import in turn. Each copy is byte-equal to its
// source in `lib/`. So the check is a byte compare.
//
// Exit codes and output are a contract:
//
// - Write mode: exit 0. Stdout has one line for each change, and nothing
//   when all copies match.
// - `--check`: exit 0 with no output when all copies match. Exit 1 when one
//   does not, with one line on stderr for each missing, extra or different
//   file, and for a `src/lib` that is not a directory. Stdout stays empty,
//   as for each failure (`lib/envelope.ts`).
// - Exit 2: a bad flag or a stray argument, a plugin imports a `lib/` file
//   that does not exist, or the node that runs it has no `import.meta.main`.
//
// This is a root script, not a plugin file. So it reads `lib/` by a
// repository path, and its tests drive it in process (`CLAUDE.md`).
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok, refused, renderText } from '../lib/envelope.ts'

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, '..')

// Import specifiers, read lexically, the same as `tests/repo/repo.ts`. A
// specifier in a comment also counts. Then the result is a copy that no code
// needs, which the check does not show, or a refusal (exit 2) when `lib/`
// does not hold the name.
const IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`]+)\1/g

/** One change between a plugin's `src/lib/` and the copies it must hold. */
export interface Drift {
  readonly kind: 'not-directory' | 'missing' | 'extra' | 'differs'
  /** The plugin directory name. */
  readonly plugin: string
  /** The file name under `src/lib/`. Empty for a `not-directory`. */
  readonly file: string
}

/** The byte compare. A copy matches only when each byte is equal. */
export const sameBytes = (a: Buffer, b: Buffer): boolean => a.equals(b)

/** Every relative specifier in `file`, resolved to an absolute path. */
const resolvedImports = (file: string): string[] => {
  const found: string[] = []
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    // Two capture groups in a match always both hold a value.
    const specifier = match[2] as string
    if (specifier.startsWith('.')) found.push(path.resolve(path.dirname(file), specifier))
  }
  return found
}

/** Every `.ts` file under `dir`, at any depth, but not under `skip`. A link
 *  is neither a file nor a directory here, so the walk does not follow it. */
const tsFilesUnder = (dir: string, skip: string): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && full !== skip) found.push(...tsFilesUnder(full, skip))
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

/** Every file under `dir`, at any depth, as a path relative to `dir`. */
const filesUnder = (dir: string, prefix = ''): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path.join(dir, entry.name), relative))
    else found.push(relative)
  }
  return found
}

/** The part of `target` below `dir`, or undefined when `target` is not in it. */
const below = (dir: string, target: string): string | undefined =>
  target.startsWith(dir + path.sep) ? path.relative(dir, target) : undefined

/**
 * The `lib/` files that one plugin needs, sorted: each file that a `.ts`
 * file of the plugin imports through `src/lib/`, then each file that those
 * import.
 *
 * The walk does not read `src/lib/` itself. A stale copy there must not
 * keep itself alive. A name that `lib/` does not hold is refused.
 */
export const libClosure = (root: string, plugin: string): Envelope<string[]> => {
  const pluginDir = path.join(root, 'plugins', plugin)
  const copyDir = path.join(pluginDir, 'src', 'lib')
  const libDir = path.join(root, 'lib')
  const queue: string[] = []
  for (const file of tsFilesUnder(pluginDir, copyDir)) {
    for (const target of resolvedImports(file)) {
      const name = below(copyDir, target)
      if (name !== undefined) queue.push(name)
    }
  }
  const needed = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (needed.has(file)) continue
    const source = path.join(libDir, file)
    if (lstatSync(source, { throwIfNoEntry: false })?.isFile() !== true) {
      return refused(`plugins/${plugin} imports lib/${file}, which lib/ does not hold`)
    }
    needed.add(file)
    for (const target of resolvedImports(source)) {
      const next = below(libDir, target)
      if (next !== undefined) queue.push(next)
    }
  }
  return ok([...needed].sort())
}

/** The plugins under `root`: each directory in `plugins/`. */
export const pluginNames = (root: string): string[] =>
  readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

/** Each change that would make the copies of every plugin match `lib/`. */
export const libDrift = (root: string): Envelope<Drift[]> => {
  const drift: Drift[] = []
  for (const plugin of pluginNames(root)) {
    const closure = libClosure(root, plugin)
    if (closure.outcome !== 'ok') return closure
    const copyDir = path.join(root, 'plugins', plugin, 'src', 'lib')
    const stat = lstatSync(copyDir, { throwIfNoEntry: false })
    if (stat !== undefined && !stat.isDirectory()) {
      drift.push({ kind: 'not-directory', plugin, file: '' })
    }
    const held = stat?.isDirectory() === true ? filesUnder(copyDir) : []
    for (const file of closure.value) {
      if (!held.includes(file)) drift.push({ kind: 'missing', plugin, file })
      else if (
        !sameBytes(
          readFileSync(path.join(copyDir, file)),
          readFileSync(path.join(root, 'lib', file)),
        )
      ) {
        drift.push({ kind: 'differs', plugin, file })
      }
    }
    for (const file of held) {
      if (!closure.value.includes(file)) drift.push({ kind: 'extra', plugin, file })
    }
  }
  return ok(drift)
}

/** One line of output for one drift. */
export const describeDrift = (drift: Drift): string => {
  const copy = path.posix.join('plugins', drift.plugin, 'src', 'lib', drift.file)
  switch (drift.kind) {
    case 'not-directory':
      return `${copy}: not a directory of copies`
    case 'missing':
      return `${copy}: missing, lib/${drift.file} is imported`
    case 'extra':
      return `${copy}: extra, no file in the plugin imports it`
    case 'differs':
      return `${copy}: differs from lib/${drift.file}`
  }
}

/** Make one drift go away: remove a link, a file or an extra copy, or write a copy. */
const applyDrift = (root: string, drift: Drift): void => {
  const copyDir = path.join(root, 'plugins', drift.plugin, 'src', 'lib')
  const copy = path.join(copyDir, drift.file)
  if (drift.kind === 'not-directory' || drift.kind === 'extra') {
    rmSync(copy)
    return
  }
  mkdirSync(path.dirname(copy), { recursive: true })
  writeFileSync(copy, readFileSync(path.join(root, 'lib', drift.file)))
}

const ARG_SPEC = { check: { type: 'boolean' } } as const

/**
 * The command function. With `--check` it writes nothing. Without it, it
 * first removes a `src/lib` that is not a directory, so the copies go into
 * a real directory. Then it writes each missing or different copy, and
 * removes each extra one.
 */
export const syncLib = (argv: readonly string[], root: string): Envelope<string> => {
  const options = parseArguments(argv, ARG_SPEC)
  if (options.outcome !== 'ok') return options
  const drift = libDrift(root)
  if (drift.outcome !== 'ok') return drift
  const lines = drift.value.map(describeDrift).join('\n')
  if (options.value.check) return lines === '' ? ok('') : failed(lines)
  for (const each of drift.value) applyDrift(root, each)
  return ok(lines)
}

/** What the entry writes to and sets its status on: `process` itself. */
export interface Host {
  readonly stdout: { write(text: string): unknown }
  readonly stderr: { write(text: string): unknown }
  exitCode?: number | string | null | undefined
}

/**
 * The thin entry. It runs the command only when node runs this file. An
 * import from a test passes `false`, so the import writes nothing. A node
 * with no `import.meta.main` passes `undefined`. Then the entry refuses,
 * because a silent exit 0 would read as "all copies match".
 */
export const entry = (
  isMain: boolean | undefined,
  argv: readonly string[],
  root: string,
  host: Host,
): void => {
  if (isMain === false) return
  if (isMain === undefined) {
    host.stderr.write(
      'sync-lib: this node has no import.meta.main; run it on node 22.18 or newer\n',
    )
    host.exitCode = 2
    return
  }
  const rendered = renderText(syncLib(argv, root))
  if (rendered.stdout !== '') host.stdout.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') host.stderr.write(`${rendered.stderr}\n`)
  host.exitCode = rendered.exitCode
}

entry(import.meta.main, process.argv.slice(2), ROOT, process)
