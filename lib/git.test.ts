// Tests the git helpers against real repositories. git is never mocked
// (ADR 001, RFC 001 "The testing seam"). Every fixture here is a real
// checkout with a real local bare origin, built by `harness/git.ts`.
//
// `sandbox.env` is passed on every call that asks about a repository. It is
// never left to the ambient environment. This keeps a developer's own
// `GIT_CONFIG_GLOBAL` (this workspace exports one from direnv) out of a
// fixture. Without it, a `GIT_DIR` or a `GIT_INDEX_FILE` could replace the
// repository the call named.
//
// git exports both `GIT_DIR` and `GIT_INDEX_FILE` into every child of a git
// hook. A pre-commit hook is one place this suite runs (`harness/README.md`,
// "The git builders"). `GIT_DIR` outranks both `cwd` and `git -C` for every
// ref and object lookup. `RepoOptions` requires `env` as well as `cwd` for
// that reason. This is a rule the compiler checks, not a habit of the test
// suite.
//
// The `GIT_DIR` test below proves the rule against two real checkouts. It
// does not just state the rule in prose.
//
// **The Python code this ports was deleted at #127.**
// `plugins/gh/scripts/*.py`, its `lib/`, and `plugins/gh/hooks/hook-io.py`
// are gone from the tree. The file and line references below point to what
// they held at commit `cd0d515`. Each reference stays because it shows
// where a rule came from. The deletion did not change anything here.
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
  // This is the distinction `gh-sync-repo.py:196` to `205` makes. Every
  // git call fails either way. To report the first case as "not a git
  // repository" would send the reader to inspect a perfectly fine checkout.
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
  // Both entry points, in their shortest form. `--version` asks nothing of
  // a repository. It is the one question with the same answer, wherever it
  // is asked from.
  await expect(gitOut(['--version'])).resolves.toMatch(/^git version /)
  await expect(gitOk(['--version'])).resolves.toBe(true)
  await expect(gitLines(['--version'])).resolves.toHaveLength(1)
  await expect(runGit(['--version'])).resolves.toMatchObject({ status: 0 })
})

it('strips git trailing newlines and keeps its leading columns', async () => {
  // `status --porcelain` encodes staged and unstaged status in the first
  // two characters. A full trim would turn " M file" into "M file". A
  // reader who counts columns would then read the wrong status.
  const { git, work, env } = repository()
  git.dirty(work)

  const status = await gitOut(['status', '--porcelain', '--untracked-files=no'], { cwd: work, env })

  expect(status).toBe(' M file.txt')
})

it('answers null when git failed, and the empty string when git said nothing', async () => {
  // Both values occur, and they are different facts: "the probe could not
  // run" against "the working tree is clean" (`gh-sync-repo.py:231`).
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
  // A failed probe must not look like "nothing is merged". That would
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

  // Compared against git's own answer from the root. git resolves
  // symlinks, and the sandbox sits under one on macOS. So the literal path
  // is not what comes back.
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
  // A clone that never fetched one. The fallbacks belong to the callers.
  // The two callers use different fallbacks, so they are not in this file.
  const { git, work, env } = repository()
  git.forgetOriginHead(work)

  expect(await defaultBranch({ cwd: work, env })).toBeNull()
})

it('passes a ref that does not carry the origin prefix through unchanged', async () => {
  // `hook-io.py:196`: this reports the ref as it reads. It does not change
  // the ref with a prefix strip that does not apply.
  const { git, work, env } = repository()
  git.git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main')

  expect(await defaultBranch({ cwd: work, env })).toBe('refs/heads/main')
})

it('reads an empty answer as no answer for all three questions with a name for an answer', async () => {
  // A comment here used to call this case unreachable, but CI on #159
  // reached it. Real git refuses `rev-parse --show-toplevel` in a bare
  // repository with status 128. It does not answer empty. But the git
  // these helpers run is whatever the caller put on PATH. A checkout root,
  // the branch HEAD is on, and the ref `origin/HEAD` names are each a name
  // or nothing. So `""` means git said nothing, and every caller folded
  // that case by hand.
  //
  // This git is built here, not in `harness/git.ts`, because it is a
  // fixture for this file alone. It carries a `#!/bin/sh` line because an
  // empty executable is ENOEXEC on Linux, but macOS runs it through the
  // shell. Those are two different platform behaviors, both
  // covered here.
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
  // This proves the hazard that `RepoOptions` requires `env` for. It does
  // not just argue the point. `GIT_DIR` outranks both `cwd` and `git -C`
  // for everything the git directory holds. So a helper called from inside
  // a hook, and that uses the ambient environment, answers about the
  // hook's own repository. This test uses two real checkouts, with one
  // branch that exists in only one of them. The environment is the only
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
  // `%B` prints the whole commit message. git adds its own newline after
  // the message's own newline. A single-newline strip would leave one
  // behind, so a caller that compares against a subject line would miss.
  const { work, env } = repository()

  await expect(gitOut(['log', '-1', '--format=%B'], { cwd: work, env })).resolves.not.toMatch(/\n$/)
})

it('answers null rather than rejecting when node refuses the argv outright', async () => {
  // This is the caller-level half of the runner's "never rejects" contract.
  // No helper here has a `try`, so a rejection would surface as a node
  // internal stack trace. That would come from a function whose whole
  // documented answer is `null`.
  const { work, env } = repository()

  await expect(gitOut(['rev-parse\u0000--show-toplevel'], { cwd: work, env })).resolves.toBeNull()
})
