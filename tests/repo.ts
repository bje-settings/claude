// Shared helpers for the TypeScript ports of tests/test_skills.py and
// tests/test_repo_layout.py (RFC 001 decision 10), kept in one file because
// both suites walk the same two directory trees. Node has no `rglob`, so the
// walk is written by hand; `root` is a parameter on the two walking
// functions, not a hardcoded global, so a test can exercise the filtering
// logic against a synthetic temporary tree as well as against the real one.
import { type Dirent, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const PLUGINS = path.join(ROOT, 'plugins')
export const REPO_SKILLS = path.join(ROOT, '.claude', 'skills')
export const SKILL_ROOTS = [PLUGINS, REPO_SKILLS] as const

// Recursively finds every file named `name` under `dir`. Directories are
// descended without limit; anything else is compared by name. No try/catch:
// a missing root is a real error here, exactly as Python's `Path.iterdir()`
// raising on a missing directory was in the code this replaces.
function findFilesNamed(dir: string, name: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findFilesNamed(full, name))
    } else if (entry.name === name) {
      found.push(full)
    }
  }
  return found
}

// Rooted at a named directory and walked to any depth, exactly what the shell
// spec this replaced did: `find "$ROOT/plugins" -path '*/skills/*' -name
// SKILL.md`. Walking from the repository root instead would descend into
// .claude/worktrees/, where a checkout of this same repository doubles every
// skill and makes the count meaningless. That is also why the second root
// is .claude/skills and never .claude: a fixed-depth glob would quietly stop
// checking a skill the day someone groups them into subdirectories.
export function skillsUnder(root: string): string[] {
  const files = findFilesNamed(root, 'SKILL.md').sort()
  if (root === REPO_SKILLS) {
    // Already inside a skills/ directory, so every SKILL.md under it counts.
    return files
  }
  return files.filter((file) => {
    const relParts = path.relative(root, path.dirname(file)).split(path.sep)
    return relParts.includes('skills')
  })
}

export function skillFiles(): string[] {
  const found: string[] = []
  for (const root of SKILL_ROOTS) {
    found.push(...skillsUnder(root))
  }
  return found.sort()
}

// Directories directly under `root` (PLUGINS by default) that carry a
// manifest, ported from test_repo_layout.py's plugin_dirs(). A directory
// without .claude-plugin/ is not a plugin; a directory whose .claude-plugin
// entry exists but is not itself a directory (a stray file with that name)
// is not one either. `root` is a parameter, defaulted to PLUGINS, so the
// filter can be exercised against a synthetic tree as well as the real one.
export function pluginDirs(root: string = PLUGINS): string[] {
  const dirs: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    const manifestDir = path.join(full, '.claude-plugin')
    if (existsSync(manifestDir) && statSync(manifestDir).isDirectory()) {
      dirs.push(full)
    }
  }
  return dirs.sort()
}

export function rel(p: string): string {
  return path.relative(ROOT, p)
}

// The symlink every plugin that needs the root lib carries, written exactly
// as it must appear: `plugins/<p>/src/lib -> ../../../lib` (ADR 001, RFC 001
// decision 4). The target is compared as a string rather than resolved,
// because it is the string Claude Code's installer classifies: a link into
// the same marketplace is dereferenced into the cache copy, and a link
// resolving outside it is skipped. A second spelling that happens to resolve
// to the same directory would install differently.
export const LIB_LINK_TARGET = path.join('..', '..', '..', 'lib')

// Relative import specifiers, read lexically rather than parsed. Python's
// `ast` gave test_repo_layout.py a real parse for free; node has no parser in
// its standard library, and the dependency rule is that this repository's own
// tooling takes none. The trade is deliberate: a specifier written inside a
// comment or a string is read as an import here, which is a false positive a
// contributor can see and rephrase, where a parser-shaped miss would be a
// rule that silently stopped holding.
// All three delimiters, with a backreference so the closing one matches the
// opening one: a template literal is how `await import(`...`)` is often
// written, and reading only the two quote characters would be exactly the
// parser-shaped miss this comment says the lexical trade avoids.
const IMPORT = /\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g

function relativeImports(file: string): string[] {
  const found: string[] = []
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    // Two mandatory capturing groups in a matching regular expression always
    // populate both positions; the cast is erased and adds no branch.
    const specifier = match[2] as string
    // A bare specifier is `node:fs` or a dev dependency, neither of which can
    // reach across a plugin boundary.
    if (specifier.startsWith('.')) found.push(specifier)
  }
  return found
}

// Every `.ts` file under `dir`, at any depth. A symlink is neither descended
// nor collected: `src/lib` is a directory of the root lib's files, and
// walking into it would report the shared library's own imports as the
// plugin's.
function tsFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...tsFilesUnder(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found.sort()
}

function isInside(dir: string, target: string): boolean {
  return target.startsWith(dir + path.sep)
}

// The one entry named `name` directly inside `dir`, or undefined. Read from a
// listing rather than by stat-ing the path, so a link whose target does not
// exist is still seen: a wrong symlink target is exactly what this checks for,
// and an existence test would skip the case it exists to catch.
function childEntry(dir: string, name: string): Dirent | undefined {
  return readdirSync(dir, { withFileTypes: true }).find((entry) => entry.name === name)
}

/**
 * Relative imports that leave the plugin they are written in.
 *
 * ADR 001: the `src/lib` symlink is the only path out of a plugin, and
 * nothing else imports across a plugin boundary. An import through `src/lib`
 * passes without a special case, because the link is a directory inside the
 * plugin and the specifier resolves inside it; an import that reaches the
 * root `lib/` by `../../../lib` does not, and that is the point, since the
 * installed copy of a plugin has no such path.
 *
 * A test file may additionally import `harness/`, which is where the shared
 * harness lives and which never ships (ADR 001, RFC 001 decision 10).
 *
 * `root` is a parameter, defaulted to PLUGINS, so the rule is exercised
 * against synthetic trees as well as against the real one: no plugin carries
 * the symlink until #126, so against this repository alone every branch below
 * would stay unrun.
 */
export function crossPluginImports(root: string = PLUGINS): string[] {
  const harness = path.join(path.dirname(root), 'harness')
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    for (const file of tsFilesUnder(plugin)) {
      const where = path.relative(root, file)
      for (const specifier of relativeImports(file)) {
        const resolved = path.resolve(path.dirname(file), specifier)
        if (isInside(plugin, resolved)) continue
        if (file.endsWith('.test.ts') && isInside(harness, resolved)) continue
        violations.push(`${where}: imports ${specifier}, which resolves outside the plugin`)
      }
    }
  }
  return violations.sort()
}

/**
 * Every `plugins/<p>/src/lib` that is not the committed symlink.
 *
 * A plugin with no `src/lib` is not a violation: a plugin needs the root lib
 * only when it imports it. A plugin that has one must reach it the way the
 * installer understands, because a real directory there would be a second
 * copy of the shared library, and any other link target is the case the
 * three-way rule skips rather than dereferences (ADR 001).
 */
export function libLinkViolations(root: string = PLUGINS): string[] {
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    const where = path.relative(root, plugin)
    // Followed rather than read from the listing, which is the one place in
    // this file that wants `stat` semantics: a `src` that is itself a symlink
    // must be looked through, since skipping it would let a plugin hide a real
    // copy of the shared library one link away from where the rule looks. A
    // listing entry answers from `lstat` and would report such a `src` as
    // neither a directory nor a file. Everything that is not a directory once
    // followed, including a link pointing at nothing or at a file, is the same
    // "no src here" as a plugin that has none: asking `readdirSync` about it
    // would abort the whole rule with an fs error instead of reporting.
    if (statSync(path.join(plugin, 'src'), { throwIfNoEntry: false })?.isDirectory() !== true) {
      continue
    }
    const lib = childEntry(path.join(plugin, 'src'), 'lib')
    if (lib === undefined) continue
    if (!lib.isSymbolicLink()) {
      violations.push(`${where}/src/lib is not a symlink`)
      continue
    }
    const target = readlinkSync(path.join(plugin, 'src', 'lib'))
    if (target !== LIB_LINK_TARGET) {
      violations.push(`${where}/src/lib points at ${target}, not ${LIB_LINK_TARGET}`)
    }
  }
  return violations.sort()
}
