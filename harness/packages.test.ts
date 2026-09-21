// What the package-manager builders actually build, asserted the way
// `git.test.ts` asserts the git ones and the gh plugin's Python fixture test
// asserted the Python originals before it was deleted at #127: a builder that
// quietly stopped producing its state would make every install test built on
// it pass for the wrong reason.
//
// These run the real pnpm from PATH. That is the point: the port's install
// path is `pnpm install --frozen-lockfile` against a lock file pnpm wrote, and
// a hand-written lock file would prove neither half of it.
//
// The Python this ports, `tests/gh/conftest.py` and the stub `gh` at
// `tests/gh/bin/gh`, was deleted at #127. It is named below anyway, without
// line numbers, because saying where each rule came from is what makes the
// rule arguable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createGitFixtures, type GitFixtures } from './git.ts'
import { COREPACK_HOME, corepackHome, createPackageFixtures, LOCKFILE } from './packages.ts'
import { createSandbox } from './sandbox.ts'

/** A sandbox, its git builders, its package builders, and one repository. */
function fixtures() {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const packages = createPackageFixtures(sandbox, git)
  const work = git.create(sandbox.join('r'))
  return { sandbox, git, packages, work }
}

/** What origin holds for `file` on the default branch: the half of a builder's
 *  claim a local read cannot see. */
function atOrigin(git: GitFixtures, work: string, file: string): string {
  git.git(work, 'fetch', '-q', 'origin')
  return git.git(work, 'show', `origin/main:${file}`)
}

/** The files the range between the local branch and origin's touched, which is
 *  the question the port asks before it installs anything. */
function changedByOrigin(git: GitFixtures, work: string): string[] {
  git.git(work, 'fetch', '-q', 'origin')
  return git
    .git(work, 'diff', '--name-only', 'main', 'origin/main')
    .split('\n')
    .filter((line) => line !== '')
}

describe('jsProject', () => {
  it('commits and pushes a pnpm project whose lock file pnpm itself wrote', () => {
    const { git, packages, work } = fixtures()

    packages.jsProject(work)

    // Written by pnpm, not by this harness: the version header is pnpm's own,
    // and a hand-written file would not carry it.
    expect(readFileSync(path.join(work, LOCKFILE), 'utf8')).toContain('lockfileVersion')
    // Tracked and pushed, so a clone of the origin has it too, which is what
    // every builder below then changes.
    expect(atOrigin(git, work, LOCKFILE)).toContain('lockfileVersion')
    expect(git.git(work, 'status', '--porcelain')).toBe('')
    expect(JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8'))).toEqual({
      name: 'fixture',
      version: '1.0.0',
    })
  })

  it('declares no dependency, so the install it sets up reaches no registry', () => {
    const { packages, work } = fixtures()

    packages.jsProject(work)

    const manifest = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8')) as {
      dependencies?: unknown
    }
    expect(manifest.dependencies).toBeUndefined()
  })
})

describe('remoteUpdateLock', () => {
  it('moves the lock file at origin and leaves the work tree where it was', () => {
    const { git, packages, work } = fixtures()
    packages.jsProject(work)
    const before = readFileSync(path.join(work, LOCKFILE), 'utf8')

    packages.remoteUpdateLock(work)

    expect(atOrigin(git, work, LOCKFILE)).not.toBe(before)
    // The state the port's install arm needs: a range that touches the one
    // lock file it watches.
    expect(changedByOrigin(git, work)).toContain(LOCKFILE)
    expect(readFileSync(path.join(work, LOCKFILE), 'utf8')).toBe(before)
    expect(git.git(work, 'status', '--porcelain')).toBe('')
  })

  it('records a real dependency, on a directory inside the repository', () => {
    const { git, packages, work } = fixtures()
    packages.jsProject(work)

    packages.remoteUpdateLock(work)

    const manifest = JSON.parse(atOrigin(git, work, 'package.json')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({ 'local-dep': 'file:./local-dep' })
    expect(atOrigin(git, work, LOCKFILE)).toContain('local-dep')
  })
})

describe('remoteBreakLock', () => {
  it('pushes a lock file no package manager can parse', () => {
    const { git, packages, work } = fixtures()
    packages.jsProject(work)

    packages.remoteBreakLock(work)

    expect(atOrigin(git, work, LOCKFILE)).toBe('not: [valid')
    expect(changedByOrigin(git, work)).toContain(LOCKFILE)
  })
})

describe('remoteDropLockfile', () => {
  it('deletes the lock file at origin, which is still a lock-file change', () => {
    const { git, packages, work } = fixtures()
    packages.jsProject(work)

    packages.remoteDropLockfile(work)

    git.git(work, 'fetch', '-q', 'origin')
    expect(git.tryGit(work, 'show', `origin/main:${LOCKFILE}`).status).not.toBe(0)
    expect(changedByOrigin(git, work)).toEqual([LOCKFILE])
  })
})

describe('a pnpm that will not answer', () => {
  it('throws rather than leaving a project with no lock file in it', () => {
    const { sandbox, packages, work } = fixtures()
    // Not `pathWithout('pnpm')`: that helper links the tools it knows by name
    // and pnpm is not one of them. An empty directory is the same fact with
    // nothing else on it.
    const empty = sandbox.join('no-tools')
    mkdirSync(empty)
    sandbox.env.PATH = empty

    expect(() => packages.jsProject(work)).toThrow(/ENOENT/)
  })

  it('reports what pnpm itself said when pnpm runs and refuses', () => {
    const { packages, work } = fixtures()
    // A workspace file pnpm has to read and cannot parse. It fails inside
    // pnpm rather than before it, which is the arm that carries pnpm's
    // account of itself into the message.
    writeFileSync(path.join(work, 'pnpm-workspace.yaml'), 'packages: [\n')

    expect(() => packages.jsProject(work)).toThrow(/fixture: pnpm install/)
  })
})

describe('the corepack cache location', () => {
  it('prefers an explicit COREPACK_HOME, as corepack does', () => {
    expect(corepackHome({ COREPACK_HOME: '/explicit' }, 'darwin', '/home/me')).toBe('/explicit')
  })

  it('reads an empty COREPACK_HOME as unset rather than as a path', () => {
    expect(corepackHome({ COREPACK_HOME: '' }, 'linux', '/home/me')).toBe(
      path.join('/home/me', '.cache', 'node', 'corepack'),
    )
  })

  it('uses the platform default on macOS', () => {
    expect(corepackHome({}, 'darwin', '/Users/me')).toBe(
      path.join('/Users/me', 'Library', 'Caches', 'node', 'corepack'),
    )
  })

  it('uses LOCALAPPDATA on Windows, and the home directory when it is unset', () => {
    expect(corepackHome({ LOCALAPPDATA: '/AppData' }, 'win32', '/Users/me')).toBe(
      path.join('/AppData', 'node', 'corepack'),
    )
    expect(corepackHome({}, 'win32', '/Users/me')).toBe(path.join('/Users/me', 'node', 'corepack'))
  })

  it('follows XDG_CACHE_HOME elsewhere, and falls back to ~/.cache', () => {
    expect(corepackHome({ XDG_CACHE_HOME: '/cache' }, 'linux', '/home/me')).toBe(
      path.join('/cache', 'node', 'corepack'),
    )
    expect(corepackHome({}, 'linux', '/home/me')).toBe(
      path.join('/home/me', '.cache', 'node', 'corepack'),
    )
  })

  it('resolves the real one at import time, before any sandbox moved HOME', () => {
    expect(path.isAbsolute(COREPACK_HOME)).toBe(true)
  })
})
