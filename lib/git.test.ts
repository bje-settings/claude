// The git helpers against real repositories. git is never mocked (ADR 001,
// RFC 001 "The testing seam"), so every fixture here is an actual checkout
// with an actual local bare origin, built by `harness/git.ts`.
//
// `sandbox.env` is passed on every call that asks about a repository, never
// left to the ambient environment. It is what keeps a developer's own
// `GIT_CONFIG_GLOBAL` (this workspace exports one from direnv) out of a
// fixture, and what keeps a `GIT_DIR` or a `GIT_INDEX_FILE` from displacing
// the repository the call named: git exports both into every child of a git
// hook, a pre-commit hook is one of the places this suite runs
// (`harness/README.md`, "The git builders"), and `GIT_DIR` outranks both
// `cwd` and `git -C` for every ref and object lookup. `RepoOptions` requires
// `env` as well as `cwd` for that reason, so this is the compiler's rule here
// and not the suite's habit, and the `GIT_DIR` test below proves it against
// two real checkouts rather than asserting it in prose.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree; the
// file and line references below are to what they held at `cd0d515`, kept
// because each says where a rule came from. Nothing here changed with the
// deletion.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

it('reads an empty answer as no answer for all three questions with a name for an answer', async () => {
  // The arm a comment here used to call unreachable, and CI on #159 reached:
  // real git refuses `rev-parse --show-toplevel` in a bare repository with
  // status 128 rather than answering empty, but the git these helpers run is
  // whatever the caller put on PATH. A checkout root, the branch HEAD is on
  // and the ref `origin/HEAD` names are each a name or nothing, so `""` is
  // git saying nothing and every caller was folding it by hand.
  //
  // The git is built here rather than in `harness/git.ts` because it is this
  // file's own fixture, and it carries a `#!/bin/sh` line because an empty
  // executable is ENOEXEC on Linux and is run by the shell on macOS, which
  // are two different experiments.
  const { sandbox, work } = repository()
  const bin = sandbox.stubPath(sandbox.join('silent-git'))
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = sandbox.env

  await expect(gitOut(['rev-parse', '--show-toplevel'], { cwd: work, env })).resolves.toBe('')
  await expect(toplevel({ cwd: work, env })).resolves.toBeNull()
  await expect(currentBranch({ cwd: work, env })).resolves.toBeNull()
  await expect(defaultBranch({ cwd: work, env })).resolves.toBeNull()
})

it('says whether a ref exists, in either namespace', async () => {
  const { work, env } = repository()

  expect(await hasRef('refs/heads/main', { cwd: work, env })).toBe(true)
  expect(await hasRef('refs/remotes/origin/main', { cwd: work, env })).toBe(true)
  expect(await hasRef('refs/heads/never-created', { cwd: work, env })).toBe(false)
})

it('reads the refs of the repository GIT_DIR names, not the one the call named', async () => {
  // The hazard `RepoOptions` requires `env` for, proven rather than argued.
  // `GIT_DIR` outranks both `cwd` and `git -C` for everything the git
  // directory holds, so a helper called from inside a hook with the ambient
  // environment answers about the hook's repository. Two real checkouts, one
  // branch that exists in only one of them, and the environment is the only
  // thing that differs between the two calls.
  const { sandbox, git, work, env } = repository()
  const other = git.create(sandbox.join('other'))
  git.branch(other, 'only-over-there')

  await expect(hasRef('refs/heads/only-over-there', { cwd: work, env })).resolves.toBe(false)
  await expect(
    hasRef('refs/heads/only-over-there', { cwd: work, env: { ...env, GIT_DIR: `${other}/.git` } }),
  ).resolves.toBe(true)
})

it('strips every trailing newline from what git printed, not just the last', async () => {
  // `%B` is the whole commit message, which git ends with its own newline on
  // top of the message's, so a single-newline strip would leave one behind
  // and every caller comparing against a subject would miss.
  const { work, env } = repository()

  await expect(gitOut(['log', '-1', '--format=%B'], { cwd: work, env })).resolves.not.toMatch(/\n$/)
})

it('answers null rather than rejecting when node refuses the argv outright', async () => {
  // The caller-level half of the runner's "never rejects" contract: no helper
  // here has a `try`, so a rejection would surface as a node-internals stack
  // trace out of a function whose whole documented answer is `null`.
  const { work, env } = repository()

  await expect(gitOut(['rev-parse\u0000--show-toplevel'], { cwd: work, env })).resolves.toBeNull()
})
