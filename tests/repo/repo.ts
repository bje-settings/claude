// Shared helpers for the TypeScript ports of tests/test_skills.py and
// tests/test_repo_layout.py (RFC 001 decision 10). They sit in one file
// because both suites walk the same two directory trees. Node has no
// `rglob`, so this file writes the walk by hand. `root` is a parameter on
// the two walking functions, not a hardcoded global. So a test can run the
// filter against a synthetic temporary tree, as well as against the real
// one.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const PLUGINS = path.join(ROOT, 'plugins')
export const LIB = path.join(ROOT, 'lib')
// This repo's own tooling: a root script (`scripts/sync-lib.ts`) and the
// skills that drive it (none today, #128 removed the only one, /publish).
// The convention and this file's checks stay for when a skill returns.
export const REPO_SKILLS = path.join(ROOT, '.claude', 'skills')
export const SKILL_ROOTS = [PLUGINS, REPO_SKILLS] as const
// The flow diagrams of every skill and of every subcommand a skill runs
// (ADR 004, .claude/rules/file-skill-md.md). They live here, not in the
// skill directory, because a skill directory ships to each user.
export const FLOWS = path.join(ROOT, 'docs', 'flows')
/** The flow directory for a repo-local skill, under FLOWS. */
export const REPO_FLOWS = '_repo'
/** The flow of the skill itself, in a skill's flow directory. */
export const SKILL_FLOW = '_skill-flow.md'

// This recursively finds every file named `name` under `dir`. It
// descends into directories without limit; it compares anything else by
// name. There is no try/catch, because a missing root is a real error
// here. Python's `Path.iterdir()` also raised on a missing directory, in
// the code this replaces. A caller for whom a missing root is not an
// error (skillsUnder's `optional` argument) checks existence itself
// before it calls in. This function does not swallow ENOENT for everyone.
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

// This is rooted at a named directory and walks to any depth. That is
// exactly what the shell spec this replaced did: `find "$ROOT/plugins"
// -path '*/skills/*' -name SKILL.md`. Walking from the repository root
// instead would descend into .claude/worktrees/, where a checkout of this
// same repository doubles every skill and makes the count meaningless.
// This is also why the second root is .claude/skills, never .claude: a
// fixed-depth glob would quietly stop checking a skill the day someone
// groups them into subdirectories.
//
// `alreadyUnderSkills` says whether `root` is already a skills/ directory,
// rather than one to search for `skills/` subdirectories under. This is
// pulled out of skillsUnder so a test can drive both arms directly.
// REPO_SKILLS has held no skill since #128, so the `true` arm can no
// longer be reached by a call to skillsUnder on the real constant.
export function filterUnderSkillsDir(
  files: string[],
  root: string,
  alreadyUnderSkills: boolean,
): string[] {
  if (alreadyUnderSkills) {
    // Already inside a skills/ directory, so every SKILL.md under it counts.
    return files
  }
  return files.filter((file) => {
    const relParts = path.relative(root, path.dirname(file)).split(path.sep)
    return relParts.includes('skills')
  })
}

// `optional` is for a root allowed not to exist at all. Git does not
// track an empty directory, so REPO_SKILLS disappears from the checkout
// the moment its last skill is deleted, the state #128 leaves it in. That
// is "no repo-local skills," not an error, so this function returns `[]`
// instead of throwing. PLUGINS is never optional: a missing plugins/ is a
// real error.
export function skillsUnder(root: string, optional = false): string[] {
  if (optional && !existsSync(root)) return []
  const files = findFilesNamed(root, 'SKILL.md').sort()
  return filterUnderSkillsDir(files, root, root === REPO_SKILLS)
}

export function skillFiles(): string[] {
  const found: string[] = []
  for (const root of SKILL_ROOTS) {
    found.push(...skillsUnder(root, root === REPO_SKILLS))
  }
  return found.sort()
}

// Directories directly under `root` (PLUGINS by default) that carry a
// manifest. This is ported from test_repo_layout.py's plugin_dirs(). A
// directory without .claude-plugin/ is not a plugin. A directory whose
// .claude-plugin entry exists, but is not itself a directory (a stray file
// with that name), is not one either. `root` is a parameter, defaulted to
// PLUGINS, so a test can run the filter against a synthetic tree, as well
// as the real one.
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

// Relative import specifiers, read lexically, not parsed. Python's `ast`
// gave test_repo_layout.py a real parse for free. Node has no parser in
// its standard library, and the dependency rule says this repository's
// own tooling takes none. The trade is deliberate: a specifier written
// inside a comment or a string reads as an import here. That is a false
// positive a contributor can see and rephrase. A parser-shaped miss would
// instead be a rule that silently stopped holding.
//
// This regex has all three delimiters, with a backreference so the
// closing one matches the opening one. A template literal is how
// `await import(`...`)` is often written, and a check of only the two
// quote characters would be exactly the parser-shaped miss the paragraph
// above warns against. `require` is in the alternation for the same
// reason: reached through `createRequire`, it loads a module out of the
// plugin exactly as `import` does. `\b` keeps `createRequire` itself out.
// `import.meta.resolve` and `new URL(..., import.meta.url)` stay out on
// purpose, since they compute a path and load nothing, and no lexical
// rule can follow path arithmetic.
const IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`]+)\1/g

// Every import specifier in `file` that starts with `prefix`.
function importsStartingWith(file: string, prefix: string): string[] {
  const found: string[] = []
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    // Two mandatory capturing groups in a matching regular expression always
    // populate both positions; the cast is erased and adds no branch.
    const specifier = match[2] as string
    if (specifier.startsWith(prefix)) found.push(specifier)
  }
  return found
}

// A bare specifier such as `node:fs` or a dev dependency cannot reach
// across a plugin boundary. A `#` specifier can: `packageImports` below
// refuses it.
const relativeImports = (file: string): string[] => importsStartingWith(file, '.')

// Every `.ts` file under `dir`, at any depth. This function neither
// descends into a symlink nor collects it. `pluginSymlinks` refuses each
// link in a plugin, so the walk has no reason to follow one.
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

/**
 * Relative imports that leave the plugin they are written in.
 *
 * ADR 006: no import leaves a plugin. A plugin reaches `lib/` through its
 * own copies in `src/lib/`, which `scripts/sync-lib.ts` writes. The walk
 * reads those copies too, and their imports stay inside `src/lib/`. An
 * import that reaches the root `lib/` by `../../../lib` does not pass,
 * since the installed copy of a plugin has no such path.
 *
 * No file in a plugin may import `harness/`, a test file included. Tests
 * live under `tests/`, outside every plugin (ADR 004), and the harness
 * never ships.
 *
 * `root` is a parameter, defaulted to PLUGINS, so a test can run the rule
 * against synthetic trees, as well as against the real one.
 */
export function crossPluginImports(root: string = PLUGINS): string[] {
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    for (const file of tsFilesUnder(plugin)) {
      const where = path.relative(root, file)
      for (const specifier of relativeImports(file)) {
        const resolved = path.resolve(path.dirname(file), specifier)
        if (isInside(plugin, resolved)) continue
        violations.push(`${where}: imports ${specifier}, which resolves outside the plugin`)
      }
    }
  }
  return violations.sort()
}

/**
 * `#` imports in a file that ships.
 *
 * The `imports` map in the root `package.json` gives the tests short
 * names, such as `#lib/*` and `#harness/*`. Node, `tsc` and vitest all
 * read that map in this checkout, so such an import in a plugin passes
 * the type check and every test that runs it. An installed plugin has no
 * `package.json` above it, so node refuses the import there (ADR 004).
 * This rule reads every `.ts` file under each root, `lib/` included,
 * because `lib/` ships as the copies in each plugin.
 *
 * `roots` is a parameter, so a test can run the rule against a synthetic
 * tree. Each report names the path relative to the parent of its root.
 */
export function packageImports(roots: readonly string[] = [PLUGINS, LIB]): string[] {
  const violations: string[] = []
  for (const root of roots) {
    for (const file of tsFilesUnder(root)) {
      const where = path.relative(path.dirname(root), file)
      for (const specifier of importsStartingWith(file, '#')) {
        violations.push(`${where}: imports ${specifier}, which only this checkout resolves`)
      }
    }
  }
  return violations.sort()
}

/**
 * Every symlink in a plugin.
 *
 * A marketplace install copies the target of a link that stays in the
 * marketplace. An install from a local path, or from a `command` source in
 * copy mode, keeps only a link that resolves inside the plugin, and skips
 * the others (ADR 006). So a plugin holds real files only. This rule does
 * not read the target. A link inside the plugin is refused too, so no
 * install method has a link to decide on.
 */
export function pluginSymlinks(root: string = PLUGINS): string[] {
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    for (const file of filesUnder(plugin)) {
      if (!lstatSync(path.join(plugin, file)).isSymbolicLink()) continue
      violations.push(`${path.join(path.relative(root, plugin), file)} is a symlink`)
    }
  }
  return violations.sort()
}

/**
 * Every plugin that carries a top-level `bin/` directory.
 *
 * claude.ai refuses such a plugin outright, by marketplace sync and by
 * direct upload alike. So one `bin/` makes the plugin undistributable
 * through organization settings. The directory is also added to the Bash
 * tool's `PATH` while the plugin is enabled. The entry point lives in
 * `scripts/` instead (RFC 001 decision 16, #185,
 * `.claude/rules/type-ts.md`).
 *
 * This is the rule here whose failure mode sits furthest from a red test.
 * A reintroduced `bin/` breaks nothing in this repository. It is refused
 * later, on a machine that is not this one, by a service no test can ask.
 *
 * This follows the link, instead of reading it from the listing. A link
 * to a directory is dereferenced into the cache copy and installs as a
 * directory, so it is the same violation. A link that points at nothing or
 * at a file is not one.
 */
export function binDirectories(root: string = PLUGINS): string[] {
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    if (statSync(path.join(plugin, 'bin'), { throwIfNoEntry: false })?.isDirectory() !== true) {
      continue
    }
    violations.push(`${path.relative(root, plugin)}/bin is a directory, and claude.ai refuses one`)
  }
  return violations.sort()
}

// Every directory under `dir`, at any depth, as a path relative to `dir`.
// This walk does not go into a symlink. But the installer copies a linked
// directory as a real one, so a symlink to a directory is in the list by
// its own name. Then a guard can refuse a link named `fixtures` or
// `commands`.
function directoriesUnder(dir: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      found.push(relative, ...directoriesUnder(full, relative))
    } else if (
      entry.isSymbolicLink() &&
      statSync(full, { throwIfNoEntry: false })?.isDirectory() === true
    ) {
      found.push(relative)
    }
  }
  return found
}

// Every file under `dir`, at any depth, as a path relative to `dir`. This
// walk does not go into a symlink either. It lists each link as one file,
// by its own name, so a test file inside a linked directory is not seen.
function filesUnder(dir: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path.join(dir, entry.name), relative))
    else found.push(relative)
  }
  return found
}

/**
 * Test files, test helpers and fixtures inside a plugin or inside `lib/`.
 *
 * Claude Code copies a plugin's whole directory into each user's cache at
 * install, with the copies of `lib/` in `src/lib/`. It has no way to leave
 * a file out. So a file here ships to every user (ADR 004).
 * Tests, their helpers and their fixtures live under `tests/` instead.
 *
 * `roots` is a parameter, so a test can run the rule against a synthetic
 * tree. Each report names the path relative to the parent of its root.
 */
export function developmentFiles(roots: readonly string[] = [PLUGINS, LIB]): string[] {
  const violations: string[] = []
  for (const root of roots) {
    const name = path.basename(root)
    for (const dir of directoriesUnder(root)) {
      if (path.basename(dir) === 'fixtures') {
        violations.push(`${path.join(name, dir)} is a fixtures directory, and it would ship`)
      }
    }
    for (const file of filesUnder(root)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test-support.ts')) {
        violations.push(`${path.join(name, file)} is test code, and it would ship`)
      }
    }
  }
  return violations.sort()
}

// The paths below the repository root that `testsOutsideTests` does not
// walk: other checkouts of this repository, git's own store, and `tests/`,
// where a test belongs.
const NOT_WALKED = [path.join('.claude', 'worktrees'), '.git', 'tests']

// Every file under `dir`, as a path relative to `top`. This walk skips
// NOT_WALKED, and a `node_modules` directory at any depth. It does not go
// into a symlink, for the reason `directoriesUnder` gives.
function repositoryFiles(top: string, dir: string = top): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.relative(top, path.join(dir, entry.name))
    if (NOT_WALKED.includes(relative) || entry.name === 'node_modules') continue
    if (entry.isDirectory()) found.push(...repositoryFiles(top, path.join(dir, entry.name)))
    else found.push(relative)
  }
  return found
}

/**
 * Test files and test helpers outside `tests/`.
 *
 * vitest collects only the `.test.ts` files under `tests/`. So a test
 * file in any other place never runs, and no test fails. A test helper
 * goes beside the tests that use it. `developmentFiles` refuses both in a
 * plugin or in `lib/`, because they would ship. This rule refuses them in
 * every other place too, for example `harness/` or the repository root
 * (ADR 004).
 *
 * `root` is a parameter, so a test can run the rule against a synthetic
 * tree. Each report names the path relative to `root`.
 */
export function testsOutsideTests(root: string = ROOT): string[] {
  const violations: string[] = []
  for (const file of repositoryFiles(root)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test-support.ts')) {
      violations.push(`${file} is test code outside tests/`)
    }
  }
  return violations.sort()
}

/** The directory names Claude Code gives a meaning to at a plugin's root
 *  (plugins-reference, "Standard layout"; `evals/` is the default of
 *  `experimental.evals`). */
export const RESERVED_DIRECTORIES: readonly string[] = [
  'agents',
  'bin',
  'commands',
  'evals',
  'hooks',
  'monitors',
  'output-styles',
  'skills',
  'themes',
  'workflows',
]

/**
 * Directories that use the name of a plugin component but are not that
 * component (ADR 004).
 *
 * Below the plugin root, no directory may take a reserved name: it would
 * read as a component that Claude Code does not load. At the root,
 * `commands/` is refused too, because new plugins use `skills/` (the
 * docs call `commands/` the legacy form). `binDirectories` refuses a root
 * `bin/` for its own reason.
 */
export function reservedDirectoryNames(root: string = PLUGINS): string[] {
  const violations: string[] = []
  for (const plugin of pluginDirs(root)) {
    const where = path.relative(root, plugin)
    for (const dir of directoriesUnder(plugin)) {
      const name = path.basename(dir)
      if (!RESERVED_DIRECTORIES.includes(name)) continue
      if (dir === 'commands') {
        violations.push(`${where}/commands is the legacy component; use skills/`)
      } else if (dir !== name) {
        violations.push(`${path.join(where, dir)} uses the name of a plugin component`)
      }
    }
  }
  return violations.sort()
}

/**
 * The flow directory for one SKILL.md. `plugins/<p>/skills/<s>/SKILL.md`
 * maps to `docs/flows/<p>/<s>/`, and `.claude/skills/<s>/SKILL.md` maps to
 * `docs/flows/_repo/<s>/`. The roots are parameters, so a test can run
 * both arms: no repo-local skill exists today.
 */
export function flowDirFor(
  skill: string,
  roots: { plugins: string; repoSkills: string; flows: string } = {
    plugins: PLUGINS,
    repoSkills: REPO_SKILLS,
    flows: FLOWS,
  },
): string {
  const dir = path.dirname(skill)
  if (isInside(roots.repoSkills, dir)) {
    return path.join(roots.flows, REPO_FLOWS, path.relative(roots.repoSkills, dir))
  }
  // `<p>/skills/<s>`: the plugin name, then the path below `skills/`.
  const parts = path.relative(roots.plugins, dir).split(path.sep)
  return path.join(roots.flows, parts[0] as string, ...parts.slice(2))
}

// A call to a plugin's dispatcher with a subcommand, as a SKILL.md spells
// it out: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" sync`. The
// subcommand starts with a lowercase letter, so a pattern such as `*)` in
// `allowed-tools` and a flag such as `--route` are not subcommands.
const SUBCOMMAND_CALL = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.ts" ([a-z][\w-]*)/g

/** The dispatcher subcommands a SKILL.md runs, each once, sorted. */
export function subcommandsRun(text: string): string[] {
  return [...new Set([...text.matchAll(SUBCOMMAND_CALL)].map((match) => match[1] as string))].sort()
}
