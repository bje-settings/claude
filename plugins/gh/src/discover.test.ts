// This suite tests discovery against real repositories. It is the port of
// `tests/gh/test_discover.py` and of the shell `discover_spec.sh` before it.
//
// The suite also checks every "ok" example against
// `fixtures/python-cli-output.json`. That file holds what `lib/discover.py`
// printed for the same state, before any of this existed. The list this
// module answers with matches what that script printed, one path per line.
// So the two are the same contract, seen from either side of the `print`.
// The script form itself lands with the entry point in layer 4.
//
// **#127 deleted the Python code this file ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree. The file and line references below point to what they held at
// `cd0d515`. Each reference stays because it shows where a rule came from.
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

/** This replaces the per-run detail in one run's answer, the way
 *  `tests/gh/scenarios.py` normalises a report. The sandbox is a different
 *  directory every time, so both of its spellings must go. macOS puts the
 *  temp directory behind a symlink. */
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

/** This returns the roots, or fails the test rather than the assertion.
 *  Every example below that reads `roots` has already said which outcome it
 *  expects. */
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
    // A checkout root sits next to an entry that resolves to a subdirectory
    // of another repository. git reports that repository's root, not the
    // entry itself. So the entry must not count as a checkout of its own.
    const { sandbox, git, env } = fixtures()
    const work = git.create(sandbox.join('r'))
    git.createAt(sandbox.join('fan'), 'real')
    mkdirSync(path.join(work, 'src'))
    symlinkSync(path.join(work, 'src'), sandbox.join('fan', 'inner'))

    const found = await discoverRepos(sandbox.join('fan'), env)

    expect(roots(found).map((root) => path.basename(root))).toEqual(['real'])
  })

  it('resolves symlinks so the comparison agrees with git', async () => {
    // git reports resolved paths. A logical path would never match, so every
    // repository under a symlinked parent (like `/tmp` on macOS) would be
    // skipped.
    const { sandbox, git, env } = fixtures()
    git.createAt(sandbox.join('fan'), 'a')
    symlinkSync(sandbox.join('fan'), sandbox.join('link'))

    const found = await discoverRepos(sandbox.join('link'), env)

    expect(roots(found)).toHaveLength(1)
    expect(roots(found)[0]?.endsWith(path.join('fan', 'a'))).toBe(true)
  })

  it('skips a hidden directory', async () => {
    // The shell glob this replaces was `"$target"/*/`, which never matched a
    // hidden directory. The fan-out fixtures use this fact: they park their
    // bare origins in a hidden directory for that reason. If discovery found
    // them, every fan-out scan would also report the origins.
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
    // This is the script form's own status for this case. The caller that
    // publishes an exit status uses this value.
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
    // repositories in it." The old code swallowed this error. It turned
    // into an empty list. The caller then reported "No git repositories
    // directly inside" with exit 0.
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
    // A missing git gives the same answer as a directory outside any
    // checkout. The Python's own test pins the same fact: discovery came
    // back with no repositories, not a crash.
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
    // This is the whole line the Python printed for that state. The `sync`
    // command builds that line from this answer.
    expect(PYTHON.sync?.missing_git?.stderr).toBe('missing git: not on PATH\n')
  })

  it("names a git that is on PATH and will not run, with node's own account", async () => {
    // This test uses a file on PATH with no execute bit. The PATH lookup
    // finds it, but the exec then fails. This is the shape of a broken
    // install.
    //
    // The file is deliberately not an empty file with the execute bit set.
    // It is also deliberately the only entry on PATH. On Linux, an empty
    // executable gives ENOEXEC. execvp then re-runs it through `/bin/sh`,
    // so it "succeeds" and prints nothing. Also, EACCES on one PATH entry
    // makes execvp keep searching rather than fail.
    //
    // A missing execute bit with nowhere else to look gives EACCES on both
    // platforms. That combination produces exit code 126 here.
    const { sandbox, env } = fixtures()
    const stubs = sandbox.join('broken-git')
    mkdirSync(stubs)
    writeFileSync(path.join(stubs, 'git'), '', { mode: 0o644 })

    const reason = await gitUnavailable({ ...env, PATH: stubs })

    expect(reason).not.toBeNull()
    expect(reason).not.toBe('not on PATH')
  })

  it('answers no root for a git that exits 0 and prints nothing', async () => {
    // `discover.py` folds an empty answer into `None` (`top or None`). Real
    // git always answers with a status. But a caller can choose which `git`
    // sits on PATH. If the code read "" as a checkout root, it would put an
    // empty path in the list.
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
