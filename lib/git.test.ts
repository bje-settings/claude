// The git helpers against real repositories. git is never mocked (ADR 001,
// RFC 001 "The testing seam"), so every fixture here is an actual checkout
// with an actual local bare origin, built by `harness/git.ts`.
//
// `sandbox.env` is passed on every call that asks about a repository, never
// left to the ambient environment. It is what keeps a developer's own
// `GIT_CONFIG_GLOBAL` (this workspace exports one from direnv) out of a
// fixture, and what keeps a `GIT_DIR` or a `GIT_INDEX_FILE` from displacing
// the repository the call named: git exports both into every child of a git
// hook, and a pre-commit hook is one of the places this suite runs
// (`harness/README.md`, "The git builders"). That is also why `RepoOptions`
// requires the object rather than defaulting it.
import { mkdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createGitFixtures } from '../harness/git.ts'
import { createSandbox } from '../harness/sandbox.ts'
import {
  currentBranch,
  defaultBranch,
  gitLines,
  gitOk,
  gitOut,
  hasRef,
  runGit,
  toplevel,
} from './git.ts'

/** A checkout with its origin, and the sandbox it lives in. */
const repository = () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  return { sandbox, git, work, env: sandbox.env }
}

it('reports a git that is not on PATH apart from a git that said no', async () => {
  // The distinction `gh-sync-repo.py:196` to `205` makes: every git call
  // fails either way, and reporting the first of them as "not a git
  // repository" sends the reader to inspect a checkout that is fine.
  const { sandbox, work } = repository()

  const missing = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: work,
    env: { ...sandbox.env, PATH: sandbox.pathWithout('git') },
  })
  const refused = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: sandbox.join('r'),
    env: sandbox.env,
  })

  expect(missing.startFailure?.code).toBe('ENOENT')
  expect(missing.status).toBe(127)
  expect(refused.startFailure).toBeNull()
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain('not a git repository')
})

it('runs git in this checkout when it is given no options at all', async () => {
  // Both entry points in their shortest form. `--version` asks nothing of a
  // repository, so it is the one question that is the same answer wherever it
  // is asked from.
  await expect(gitOut(['--version'])).resolves.toMatch(/^git version /)
  await expect(gitOk(['--version'])).resolves.toBe(true)
  await expect(gitLines(['--version'])).resolves.toHaveLength(1)
  await expect(runGit(['--version'])).resolves.toMatchObject({ status: 0 })
})

it('strips git trailing newlines and keeps its leading columns', async () => {
  // `status --porcelain` encodes staged and unstaged in the first two
  // characters, so a full trim would turn " M file" into "M file" and a
  // reader counting columns into a liar.
  const { git, work, env } = repository()
  git.dirty(work)

  const status = await gitOut(['status', '--porcelain', '--untracked-files=no'], { cwd: work, env })

  expect(status).toBe(' M file.txt')
})

it('answers null when git failed, and the empty string when git said nothing', async () => {
  // Both are used, and they are different facts: "the probe could not be run"
  // against "the working tree is clean" (`gh-sync-repo.py:231`).
  const { sandbox, work, env } = repository()
  mkdirSync(sandbox.join('plain'))

  await expect(gitOut(['status', '--porcelain'], { cwd: work, env })).resolves.toBe('')
  await expect(
    gitOut(['rev-parse', '--show-toplevel'], { cwd: sandbox.join('plain'), env }),
  ).resolves.toBeNull()
})

it('reports whether git succeeded, without its output', async () => {
  const { work, env } = repository()

  await expect(
    gitOk(['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: work, env }),
  ).resolves.toBe(true)
  await expect(
    gitOk(['show-ref', '--verify', '--quiet', 'refs/heads/absent'], { cwd: work, env }),
  ).resolves.toBe(false)
})

it('answers with the lines of a listing, dropping the empty ones', async () => {
  const { git, work, env } = repository()
  git.branch(work, 'feature')

  const branches = await gitLines(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
    cwd: work,
    env,
  })

  expect(branches).toEqual(['feature', 'main'])
})

it('answers null for a listing that could not be read', async () => {
  // A failed probe must not masquerade as "nothing is merged", which would
  // silently reduce the merge proof to one signal (`gh-sync-repo.py:465`).
  const { sandbox, env } = repository()
  mkdirSync(sandbox.join('plain'))

  await expect(
    gitLines(['for-each-ref', '--format=%(refname:short)'], { cwd: sandbox.join('plain'), env }),
  ).resolves.toBeNull()
})

it('finds the checkout root from inside it, and none outside one', async () => {
  const { sandbox, work } = repository()
  const inside = `${work}/nested`
  mkdirSync(inside)
  mkdirSync(sandbox.join('plain'))

  // Compared against git's own answer from the root: git resolves symlinks
  // and the sandbox sits under one on macOS, so the literal path is not what
  // comes back.
  const root = await toplevel({ cwd: work, env: sandbox.env })
  expect(await toplevel({ cwd: inside, env: sandbox.env })).toBe(root)
  expect(root).not.toBeNull()
  expect(await toplevel({ cwd: sandbox.join('plain'), env: sandbox.env })).toBeNull()
})

it('names the branch HEAD is on, says HEAD when it is detached, null outside a repository', async () => {
  const { sandbox, git, work, env } = repository()
  mkdirSync(sandbox.join('plain'))

  expect(await currentBranch({ cwd: work, env })).toBe('main')

  git.git(work, 'checkout', '--detach')
  expect(await currentBranch({ cwd: work, env })).toBe('HEAD')
  expect(await currentBranch({ cwd: sandbox.join('plain'), env })).toBeNull()
})

it('reads the default branch from the cached origin/HEAD', async () => {
  const { work, env } = repository()

  expect(await defaultBranch({ cwd: work, env })).toBe('main')
})

it('answers null when no origin/HEAD is cached', async () => {
  // A clone that never fetched one. The fallbacks are the caller's, and they
  // differ between the two callers, which is why they are not here.
  const { git, work, env } = repository()
  git.forgetOriginHead(work)

  expect(await defaultBranch({ cwd: work, env })).toBeNull()
})

it('passes a ref that does not carry the origin prefix through unchanged', async () => {
  // `hook-io.py:196`: the ref is reported as it reads rather than mangled by
  // a prefix strip that did not apply.
  const { git, work, env } = repository()
  git.git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main')

  expect(await defaultBranch({ cwd: work, env })).toBe('refs/heads/main')
})

it('says whether a ref exists, in either namespace', async () => {
  const { work, env } = repository()

  expect(await hasRef('refs/heads/main', { cwd: work, env })).toBe(true)
  expect(await hasRef('refs/remotes/origin/main', { cwd: work, env })).toBe(true)
  expect(await hasRef('refs/heads/never-created', { cwd: work, env })).toBe(false)
})
