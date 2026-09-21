// Discovery, against real repositories: the port of `tests/gh/test_discover.py`
// and of the shell `discover_spec.sh` before it.
//
// Every "ok" example is also checked against `fixtures/python-cli-output.json`,
// which holds what `lib/discover.py` printed for the same state before any of
// this existed. The list this module answers with is what that script printed
// one path per line, so the two are the same contract seen from either side of
// the `print` (the script form itself lands with the entry point in layer 4).
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createGitFixtures } from '../../../harness/git.ts'
import { createSandbox, type Sandbox } from '../../../harness/sandbox.ts'
import { discoverRepos, gitUnavailable, toplevel } from './discover.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** What the Python printed, as the capture commit recorded it. */
interface PythonRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const PYTHON: Record<string, Record<string, PythonRun>> = JSON.parse(
  readFileSync(path.join(FIXTURES, 'python-cli-output.json'), 'utf8'),
)

function fixtures() {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  return { sandbox, git, env: sandbox.env }
}

/** One run's answer with the per-run detail replaced, the way
 *  `tests/gh/scenarios.py` normalises a report: the sandbox is a different
 *  directory every time and both of its spellings have to go, because macOS
 *  puts the temp directory behind a symlink. */
function normalise(roots: readonly string[], sandbox: Sandbox): string {
  const spellings = [realpathSync(sandbox.path), sandbox.path]
  return roots
    .map((root) => {
      let line = root
      for (const spelling of spellings) line = line.split(spelling).join('<sandbox>')
      return `${line}\n`
    })
    .join('')
}

/** The roots, or a failure of the test rather than of the assertion: every
 *  example below that reads `roots` has already said which outcome it expects. */
function roots(result: Awaited<ReturnType<typeof discoverRepos>>): string[] {
  if (result.outcome !== 'ok') throw new Error(`expected roots, got ${result.outcome}`)
  return result.roots
}

describe('the scope of a target', () => {
  it('yields the checkout root when the target is a repository', async () => {
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))

    const found = await discoverRepos(work, env)

    expect(roots(found)).toEqual([realpathSync(work)])
    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.repository?.stdout)
  })

  it('yields the checkout root when the target is a subdirectory of a repository', async () => {
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))
    mkdirSync(path.join(work, 'src', 'deep'), { recursive: true })

    const found = await discoverRepos(path.join(work, 'src', 'deep'), env)

    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.subdirectory?.stdout)
  })

  it('fans out over immediate subdirectories that are checkout roots', async () => {
    const { sandbox, git, env } = fixtures()
    git.createAt(sandbox.join('fan'), 'bbb')
    git.createAt(sandbox.join('fan'), 'aaa')
    mkdirSync(sandbox.join('fan', 'plain'))

    const found = await discoverRepos(sandbox.join('fan'), env)

    expect(roots(found).map((root) => path.basename(root))).toEqual(['aaa', 'bbb'])
    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.fan_out?.stdout)
  })

  it('does not recurse below one level', async () => {
    const { sandbox, git, env } = fixtures()
    git.createAt(sandbox.join('deep', 'nested'), 'x')

    const found = await discoverRepos(sandbox.join('deep'), env)

    expect(roots(found)).toEqual([])
    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.not_recursive?.stdout)
  })

  it('skips a subdirectory that is inside a repository but not its root', async () => {
    // A checkout root next to an entry that resolves to a subdirectory of
    // another repository: git reports that repository's root, which is not the
    // entry itself, so it must not count as a checkout of its own.
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))
    git.createAt(sandbox.join('fan'), 'real')
    mkdirSync(path.join(work, 'src'))
    symlinkSync(path.join(work, 'src'), sandbox.join('fan', 'inner'))

    const found = await discoverRepos(sandbox.join('fan'), env)

    expect(roots(found).map((root) => path.basename(root))).toEqual(['real'])
  })

  it('resolves symlinks so the comparison agrees with git', async () => {
    // git reports resolved paths; a logical path would never match and every
    // repository under a symlinked parent (like /tmp on macOS) would be
    // skipped.
    const { sandbox, git, env } = fixtures()
    git.createAt(sandbox.join('fan'), 'a')
    symlinkSync(sandbox.join('fan'), sandbox.join('link'))

    const found = await discoverRepos(sandbox.join('link'), env)

    expect(roots(found)).toHaveLength(1)
    expect(roots(found)[0]?.endsWith(path.join('fan', 'a'))).toBe(true)
  })

  it('skips a hidden directory', async () => {
    // The shell glob this replaces was "$target"/*/, which never matched one,
    // and the fan-out fixtures park their bare origins in a hidden directory
    // precisely because of that: finding them would make every fan-out scan
    // report the origins too.
    const { sandbox, git, env } = fixtures()
    git.createAt(sandbox.join('hidden'), 'visible')
    git.createAt(sandbox.join('hidden'), '.hidden')

    const found = await discoverRepos(sandbox.join('hidden'), env)

    expect(roots(found).map((root) => path.basename(root))).toEqual(['visible'])
    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.hidden_directory?.stdout)
  })

  it('yields nothing when there are no repositories', async () => {
    const { sandbox, env } = fixtures()
    mkdirSync(sandbox.join('empty'))

    const found = await discoverRepos(sandbox.join('empty'), env)

    expect(roots(found)).toEqual([])
    expect(normalise(roots(found), sandbox)).toBe(PYTHON.discover?.no_repositories?.stdout)
  })
})

describe('a target that is not a list of roots', () => {
  it('answers not-a-directory for a path that is not there', async () => {
    const { sandbox, env } = fixtures()

    expect(await discoverRepos(sandbox.join('nope'), env)).toEqual({
      outcome: 'not-a-directory',
    })
    // The script form's own status for it, for the caller that publishes one.
    expect(PYTHON.discover?.not_a_directory?.status).toBe(1)
  })

  it('answers not-a-directory for a path that is a file', async () => {
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))

    expect(await discoverRepos(path.join(work, 'file.txt'), env)).toEqual({
      outcome: 'not-a-directory',
    })
  })

  it('answers unreadable, not an empty list, for a directory it cannot list', async () => {
    // "A directory that cannot be listed is not a directory with no
    // repositories in it." Swallowed, the error became an empty list and the
    // caller reported "No git repositories directly inside" and exit 0.
    const { sandbox, env } = fixtures()
    const blocked = sandbox.join('blocked')
    mkdirSync(blocked)
    chmodSync(blocked, 0o000)
    try {
      const found = await discoverRepos(blocked, env)

      expect(found.outcome).toBe('unreadable')
      expect(found.outcome === 'unreadable' && found.reason).toContain(blocked)
    } finally {
      chmodSync(blocked, 0o700)
    }
  })
})

describe('toplevel', () => {
  it('answers the checkout root for a directory inside one', async () => {
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))

    expect(await toplevel(work, env)).toBe(realpathSync(work))
  })

  it('answers null outside any checkout', async () => {
    const { sandbox, env } = fixtures()
    mkdirSync(sandbox.join('plain'))

    expect(await toplevel(sandbox.join('plain'), env)).toBeNull()
  })

  it('answers null when git cannot be run, rather than raising', async () => {
    // A missing git is the same answer as a directory outside any checkout,
    // and the Python's own test pins the same thing: discovery came back with
    // no repositories rather than a crash.
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))
    const withoutGit = { ...env, PATH: sandbox.pathWithout('git') }

    expect(await toplevel(work, withoutGit)).toBeNull()
    expect(roots(await discoverRepos(work, withoutGit))).toEqual([])
    expect(PYTHON.discover?.missing_git?.stdout).toBe('')
  })
})

describe('gitUnavailable', () => {
  it('says nothing is wrong when git answers', async () => {
    const { env } = fixtures()

    expect(await gitUnavailable(env)).toBeNull()
  })

  it('names a git that is not on PATH, which is what the caller reports', async () => {
    const { sandbox, env } = fixtures()

    expect(await gitUnavailable({ ...env, PATH: sandbox.pathWithout('git') })).toBe('not on PATH')
    // The whole line the Python printed for that state, which the sync command
    // builds from this answer.
    expect(PYTHON.sync?.missing_git?.stderr).toBe('missing git: not on PATH\n')
  })

  it("names a git that is on PATH and will not run, with node's own account", async () => {
    // A file on PATH without the execute bit: the PATH lookup finds it and the
    // exec then fails, which is the shape of a broken install. Deliberately
    // NOT an empty file with the bit set, and deliberately the only entry on
    // PATH: on Linux an empty executable is ENOEXEC, which execvp re-runs
    // through /bin/sh, so it "succeeds" and prints nothing, and EACCES on one
    // PATH entry makes execvp keep searching rather than fail. A missing
    // execute bit with nowhere else to look answers EACCES on both platforms,
    // which is the 126 this reports.
    const { sandbox, env } = fixtures()
    const stubs = sandbox.join('broken-git')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'git'), '', { mode: 0o644 })

    const reason = await gitUnavailable({ ...env, PATH: stubs })

    expect(reason).not.toBeNull()
    expect(reason).not.toBe('not on PATH')
  })

  it('answers no root for a git that exits 0 and prints nothing', async () => {
    // `discover.py` folds an empty answer into None (`top or None`). Real git
    // answers with a status instead, but a `git` on PATH is something a caller
    // can choose, and reading "" as a checkout root puts an empty path in the
    // list.
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))
    const stubs = sandbox.join('silent-git')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const silent = { ...env, PATH: `${stubs}${path.delimiter}${env.PATH ?? ''}` }

    expect(await toplevel(work, silent)).toBeNull()
    expect(roots(await discoverRepos(work, silent))).toEqual([])
  })
})
