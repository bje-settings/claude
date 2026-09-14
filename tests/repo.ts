// Shared helpers for the TypeScript ports of tests/test_skills.py and
// tests/test_repo_layout.py (RFC 001 decision 10), kept in one file because
// both suites walk the same two directory trees. Node has no `rglob`, so the
// walk is written by hand; `root` is a parameter on the two walking
// functions, not a hardcoded global, so a test can exercise the filtering
// logic against a synthetic temporary tree as well as against the real one.
import { existsSync, readdirSync, statSync } from 'node:fs'
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
