// The detection and the run, the way `tests/gh/test_lib_install.py` holds
// them, minus the Yarn and npm rows the pnpm-only ruling retires.
//
// These run the REAL pnpm from PATH rather than a stub binary: the point of
// the install path is that `pnpm install --frozen-lockfile` reads a lock file
// pnpm wrote, and a stub would prove neither half. CI has pnpm through
// `pnpm/action-setup`, which the vitest jobs already run.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { corepackEnv, createPackageFixtures } from '../../../harness/packages.ts'
import { createSandbox } from '../../../harness/sandbox.ts'
import { INSTALL_COMMAND, installCommand, installDeps, LOCKFILES, NO_LOCKFILE } from './install.ts'

/** A project directory inside a sandbox, and the environment its children
 *  run under. */
function project() {
  const sandbox = createSandbox()
  const root = sandbox.join('project')
  mkdirSync(root)
  return { sandbox, root }
}

/** A real repository carrying a real pnpm project, for the arms that need pnpm
 *  to actually install something. */
function installable() {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const packages = createPackageFixtures(sandbox, git)
  const work = git.create(sandbox.join('r'))
  packages.jsProject(work)
  return { sandbox, git, packages, work, env: corepackEnv(sandbox.env) }
}

describe('installCommand', () => {
  it('selects pnpm for a pnpm-lock.yaml', () => {
    const { root } = project()
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '{}\n')

    expect(installCommand(root)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  })

  it('selects nothing for no lock file', () => {
    const { root } = project()

    expect(installCommand(root)).toBeNull()
  })

  it('selects nothing for a yarn or npm lock file, which are not watched', () => {
    // The pnpm-only ruling, as the one assertion that says what was dropped:
    // "a checkout on another package manager is synced as a repository with
    // no dependencies to install".
    const { root } = project()
    writeFileSync(path.join(root, 'yarn.lock'), '\n')
    writeFileSync(path.join(root, 'package-lock.json'), '{}\n')

    expect(installCommand(root)).toBeNull()
  })

  it('names one lock file and one command, and they agree with each other', () => {
    expect(LOCKFILES).toEqual(['pnpm-lock.yaml'])
    expect(INSTALL_COMMAND[0]).toBe('pnpm')
  })

  it('hands back a copy, so a caller cannot edit the command everyone shares', () => {
    const { root } = project()
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '{}\n')

    const command = installCommand(root)
    command?.push('--force')

    expect(INSTALL_COMMAND).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  })
})

describe('installDeps', () => {
  it('reports no lock file rather than failing', async () => {
    const { sandbox, root } = project()

    const result = await installDeps(root, sandbox.env)

    expect(result).toEqual({ status: NO_LOCKFILE, log: '' })
  })

  it('runs the real pnpm and succeeds on a lock file pnpm wrote', async () => {
    const { work, env } = installable()

    const result = await installDeps(work, env)

    expect(result.status).toBe(0)
  })

  it("answers with pnpm's own status and transcript when the lock file is broken", async () => {
    const { git, packages, work, env } = installable()
    packages.remoteBreakLock(work)
    git.git(work, 'fetch', '-q', 'origin')
    git.git(work, 'merge', '-q', '--ff-only', 'origin/main')

    const result = await installDeps(work, env)

    expect(result.status).not.toBe(0)
    expect(result.status).not.toBe(NO_LOCKFILE)
    // The transcript is what the caller's one-line reason is taken from, so it
    // has to carry pnpm's own words whichever stream pnpm wrote them on.
    expect(result.log).not.toBe('')
  })

  it('reports a package manager that is not installed, rather than throwing', async () => {
    const { sandbox, root } = project()
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '{}\n')
    const empty = sandbox.join('empty')
    mkdirSync(empty)

    const result = await installDeps(root, { ...sandbox.env, PATH: empty })

    // 127 and this wording are what a shell prints for a missing command, and
    // what the shell version reported, so the caller's one-line reason reads
    // the same as it always did.
    expect(result).toEqual({ status: 127, log: 'pnpm: command not found' })
  })

  it('reports a package manager that is present and cannot be run, as 126', async () => {
    // Present but unrunnable is not "command not found": a file on PATH
    // without the execute bit fails with a different errno, and reporting it
    // as missing sends the reader looking for an install that is already
    // there.
    const { sandbox, root } = project()
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '{}\n')
    const stubs = sandbox.join('stubs')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'pnpm'), '#!/bin/sh\necho installed\n', { mode: 0o644 })

    const result = await installDeps(root, { ...sandbox.env, PATH: stubs })

    expect(result.status).toBe(126)
    expect(result.log.startsWith('pnpm: ')).toBe(true)
    expect(result.log).not.toContain('command not found')
  })
})
