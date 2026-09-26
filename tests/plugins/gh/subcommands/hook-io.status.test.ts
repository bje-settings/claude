// The status check, in process, through `status <dir>`: discovery, the fetch,
// the local counts, the GitHub counts, the sum and the line. Git is real
// (`harness/git.ts`); `gh` is the injected double. Each test asserts the
// line the hook wrote and the account it left on stderr.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createGhMock, type GhClient, ghFails } from '#harness/gh.ts'
import { findOnPath } from '#harness/sandbox.ts'
import {
  createRig,
  githubRepo,
  hangingFetch,
  onGitHub,
  runHook,
  side,
  statusOf,
  wrappedGit,
} from './hook-io.test-support.ts'

const answering = (repositories: Record<string, ReturnType<typeof side>>): GhClient =>
  createGhMock({ repositoryStatus: { repositories, unavailable: null } })

it('says nothing about a clean checkout that GitHub has nothing on', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('fetches first, so behind counts what origin gained since the last fetch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: [behind 1]\n', stderr: '' })
})

it('shows the GitHub counts from the reply', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side(2, 3) }))

  expect(ran.stdout).toBe('gh: [🤖 3] [🛡️ 2]\n')
  expect(ran.stderr).toBe('')
})

it('shows every item together, in order', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  rig.git.branchWithWork(work, 'goner')
  rig.git.push(work, 'goner')
  rig.git.git(work, 'branch', '--set-upstream-to=origin/goner', 'goner')
  rig.git.git(rig.sandbox.join('r', 'origin.git'), 'branch', '-D', 'goner')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side(4, 5) }))

  expect(ran.stdout).toBe('gh: [behind 1] [prune 1] [🤖 5] [🛡️ 4]\n')
})

it('sums a folder of repositories, and names how many it checked', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  const a = onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/b')
  rig.git.remoteAdvance(a)

  const ran = await statusOf(rig, folder, answering({ 'acme/a': side(1, 2), 'acme/b': side(3, 4) }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: 2 repos [behind 1] [🤖 6] [🛡️ 4]\n', stderr: '' })
})

it('skips a repository whose remote is not on GitHub, and says nothing about it', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  const local = rig.git.createAt(folder, 'local')
  // Work that would count, in the repository that must not be read.
  rig.git.remoteAdvance(local)

  const ran = await statusOf(rig, folder, answering({ 'acme/a': side(0, 1) }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: [🤖 1]\n', stderr: '' })
})

it('asks GitHub nothing when no repository is on GitHub', async () => {
  const rig = createRig()
  const local = rig.git.create(rig.sandbox.join('r'))
  rig.git.remoteAdvance(local)

  // The double has no reply registered, so a call to it would fail, and the
  // failure would show as a warning.
  const ran = await statusOf(rig, local, createGhMock())

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('skips a repository with no origin at all, and says nothing about it', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  rig.git.removeOrigin(rig.git.createAt(folder, 'no-origin'))

  const ran = await statusOf(rig, folder, answering({ 'acme/a': side(1) }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: [🛡️ 1]\n', stderr: '' })
})

it('counts nothing behind when there is no local default branch to update', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.git(work, 'checkout', '-q', '-b', 'side')
  rig.git.git(work, 'branch', '-D', 'main')
  rig.git.remoteAdvance(work)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('still counts on a branch with no commit yet, where git names no current branch', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'goner')
  rig.git.push(work, 'goner')
  rig.git.git(work, 'branch', '--set-upstream-to=origin/goner', 'goner')
  rig.git.git(rig.sandbox.join('r', 'origin.git'), 'branch', '-D', 'goner')
  rig.git.git(work, 'checkout', '-q', '--orphan', 'empty')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: [prune 1]\n', stderr: '' })
})

it('counts a GitHub repository once, however many checkouts it has', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/widgets')
  onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/widgets')

  const ran = await statusOf(rig, folder, answering({ 'acme/widgets': side(1, 1) }))

  expect(ran.stdout).toBe('gh: 2 repos [🤖 1] [🛡️ 1]\n')
})

it('counts one repository once when two checkouts spell its name in different cases', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'Acme/Widgets')
  onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/widgets')

  const ran = await statusOf(rig, folder, answering({ 'acme/widgets': side(1, 1) }))

  expect(ran).toEqual({ status: 0, stdout: 'gh: 2 repos [🤖 1] [🛡️ 1]\n', stderr: '' })
})

it('finds a GitHub origin that only an insteadOf short name puts on github.com', async () => {
  const rig = createRig()
  const work = rig.git.create(rig.sandbox.join('r'))
  rig.git.git(work, 'config', 'remote.origin.url', 'gh:acme/widgets')
  rig.git.git(work, 'config', 'url.https://github.com/.insteadOf', 'gh:')
  // The fetch now names github.com. This refuses it before any connection.
  rig.git.git(work, 'config', 'protocol.https.allow', 'never')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side(0, 1) }))

  expect(ran.stdout).toBe('gh: [🤖 1] ⚠️\n')
  expect(ran.stderr).toMatch(/^.*\/work: git fetch failed: .*https.*\n$/)
})

it('warns, and does not skip in silence, when the origin cannot be read', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  const broken = onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/b')
  // A git that fails the origin read with a status other than "not set".
  const real = findOnPath('git', rig.sandbox.env.PATH) ?? 'git'
  const bin = rig.sandbox.join('bin-origin')
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\ncase "$(pwd -P)" in\n  */b) case " $* " in\n    *" remote.origin.url "*) echo "fatal: bad config" >&2; exit 128 ;;\n  esac ;;\nesac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  )

  const ran = await statusOf(rig, folder, answering({ 'acme/a': side(0, 1) }), {
    env: { ...rig.sandbox.env, PATH: `${bin}${path.delimiter}${rig.sandbox.env.PATH}` },
  })

  expect(ran.stdout).toBe('gh: [🤖 1] ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(broken)}: origin could not be read: fatal: bad config\n`)
})

it('warns when the rewritten URL of an origin that is not on github.com cannot be read', async () => {
  const rig = createRig()
  const local = rig.git.create(rig.sandbox.join('r'))
  const shim = rig.git.gitShim('remote get-url')

  const ran = await statusOf(rig, local, createGhMock(), {
    env: {
      ...rig.sandbox.env,
      PATH: `${shim.directory}${path.delimiter}${rig.sandbox.env.PATH}`,
      GIT_STUB_FAIL: shim.failing,
    },
  })

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(local)}: origin could not be read\n`)
})

it('still counts behind when the ref listing fails', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  const shim = rig.git.gitShim('for-each-ref --format=%(refname)')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: {
      ...rig.sandbox.env,
      PATH: `${shim.directory}${path.delimiter}${rig.sandbox.env.PATH}`,
      GIT_STUB_FAIL: shim.failing,
    },
  })

  expect(ran.stdout).toBe('gh: [behind 1] ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(work)}: branches could not be listed\n`)
})

it('warns, and still counts behind, when the branch listing fails', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  // A git that fails only the listing that marks the current branch.
  const real = findOnPath('git', rig.sandbox.env.PATH) ?? 'git'
  const bin = rig.sandbox.join('bin-branches')
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\ncase "$*" in\n  *'%(HEAD)'*) echo "fatal: bad ref" >&2; exit 128 ;;\nesac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  )

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: { ...rig.sandbox.env, PATH: `${bin}${path.delimiter}${rig.sandbox.env.PATH}` },
  })

  expect(ran.stdout).toBe('gh: [behind 1] ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(work)}: branches could not be listed\n`)
})

it('warns, and asks nothing more, when discovery does not finish in time', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  // Discovery runs git, which takes longer than 1 ms.
  const ran = await statusOf(rig, work, createGhMock(), { deadlineMs: 1 })

  expect(ran).toEqual({ status: 0, stdout: 'gh: ⚠️\n', stderr: `${work}: did not finish in 1 ms\n` })
})

it('warns, and keeps the local items, when the GitHub call fails', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await statusOf(
    rig,
    work,
    createGhMock({ repositoryStatus: ghFails('gh: API rate limit exceeded') }),
  )

  expect(ran.stdout).toBe('gh: [behind 1] ⚠️\n')
  expect(ran.stderr).toBe('GitHub: GhError: gh: API rate limit exceeded\n')
})

it('warns about the one field GitHub could not give, and keeps the others', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await statusOf(
    rig,
    work,
    createGhMock({
      repositoryStatus: {
        repositories: { 'acme/widgets': { ...side(0, 2), alerts: null } },
        unavailable: 'Resource not accessible by integration',
      },
    }),
  )

  expect(ran.stdout).toBe('gh: [🤖 2] ⚠️\n')
  expect(ran.stderr).toBe(
    'GitHub: Resource not accessible by integration\nacme/widgets: alerts could not be read\n',
  )
})

it('warns about each field that came back empty, even with no reason given', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await statusOf(
    rig,
    work,
    createGhMock({
      repositoryStatus: {
        repositories: {
          'acme/widgets': { alerts: 3, dependencies: null, mergedPullRequests: null },
        },
        unavailable: null,
      },
    }),
  )

  expect(ran.stdout).toBe('gh: [🛡️ 3] ⚠️\n')
  expect(ran.stderr).toBe(
    'acme/widgets: dependency pull requests could not be read\n' +
      'acme/widgets: merged pull requests could not be read\n',
  )
})

it('warns about a repository the reply left out', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/gone')

  const ran = await statusOf(rig, folder, answering({ 'acme/a': side(0, 1) }))

  expect(ran.stdout).toBe('gh: 2 repos [🤖 1] ⚠️\n')
  expect(ran.stderr).toBe('acme/gone: GitHub gave no answer\n')
})

it('gives one line for a repository GitHub could not resolve, not two', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/gone')

  const ran = await statusOf(
    rig,
    work,
    createGhMock({
      repositoryStatus: {
        repositories: {},
        unavailable: "Could not resolve to a Repository with the name 'acme/gone'.",
      },
    }),
  )

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe("GitHub: Could not resolve to a Repository with the name 'acme/gone'.\n")
})

it('warns, and keeps the GitHub counts, when a fetch is still open at the deadline', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  hangingFetch(rig, work)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side(0, 2) }), {
    deadlineMs: 3_000,
  })

  expect(ran.stdout).toBe('gh: [🤖 2] ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(work)}: did not finish in 3000 ms\n`)
})

it('warns when GitHub is still open at the deadline', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  const never: GhClient = { ...createGhMock(), repositoryStatus: () => new Promise(() => {}) }

  const ran = await statusOf(rig, work, never, { deadlineMs: 3_000 })

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe('GitHub: did not finish in 3000 ms\n')
})

it('warns, and counts from the cached refs, when the fetch fails', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.branchWithWork(work, 'landed')
  rig.git.push(work, 'landed')
  rig.git.git(work, 'branch', '--set-upstream-to=origin/landed', 'landed')
  rig.git.mergeCommit(work, 'landed')
  // The GitHub URL now maps to a path with no repository behind it.
  rig.git.git(
    work,
    'config',
    `url.${rig.sandbox.join('nowhere.git')}.insteadOf`,
    'https://github.com/acme/widgets.git',
  )
  rig.git.git(work, 'config', '--unset', `url.${rig.sandbox.join('r', 'origin.git')}.insteadOf`)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran.stdout).toBe('gh: [prune 1] ⚠️\n')
  expect(ran.stderr).toMatch(/^.*\/work: git fetch failed: fatal: .+\n$/)
})

it('warns when the default branch cannot be resolved', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.git(work, 'checkout', '-q', '-b', 'side')
  rig.git.git(work, 'branch', '-D', 'main')
  rig.git.forgetOriginHead(work)
  // git 2.48 and later can make `origin/HEAD` again on a fetch. This keeps
  // the state the test is about.
  rig.git.git(work, 'config', 'remote.origin.followRemoteHEAD', 'never')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  expect(ran.stdout).toBe('gh: ⚠️\n')
  // Discovery names each root by its real path, the way git reports it.
  expect(ran.stderr).toBe(`${realpathSync(work)}: no default branch\n`)
})

it('warns, and does not fall back to main, when origin/HEAD cannot be read', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  // origin/HEAD is set, and a local main exists. A fallback to main would
  // count behind 1 with no warning.
  const PATH = wrappedGit(
    rig,
    'bin-symbolic',
    `  *'symbolic-ref'*) echo "fatal: bad ref" >&2; exit 128 ;;`,
  )

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: { ...rig.sandbox.env, PATH },
  })

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(work)}: default branch could not be read\n`)
})

it('warns when git cannot say whether a local main exists', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)
  rig.git.forgetOriginHead(work)
  rig.git.git(work, 'config', 'remote.origin.followRemoteHEAD', 'never')
  const PATH = wrappedGit(
    rig,
    'bin-show-ref',
    `  *'show-ref --verify --quiet refs/heads/main'*) echo "fatal: bad ref" >&2; exit 128 ;;`,
  )

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: { ...rig.sandbox.env, PATH },
  })

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(work)}: default branch could not be read\n`)
})

it('warns, and does not wait, when an origin read is still open at the deadline', async () => {
  const rig = createRig()
  const local = rig.git.create(rig.sandbox.join('r'))
  const sleep = findOnPath('sleep', rig.sandbox.env.PATH) ?? 'sleep'
  // The origin is not on github.com, so the hook asks for the rewritten
  // URL, and that call does not answer.
  const PATH = wrappedGit(rig, 'bin-get-url', `  *'remote get-url'*) exec '${sleep}' 60 ;;`)

  const ran = await statusOf(rig, local, createGhMock(), {
    env: { ...rig.sandbox.env, PATH },
    deadlineMs: 1_000,
  })

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe(`${realpathSync(local)}: did not finish in 1000 ms\n`)
})

it('warns when the local default branch cannot be compared with origin', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.forgetOriginHead(work)
  rig.git.dropRemoteBranches(work)
  // With no fetch refspec, the fetch still succeeds, and brings back no
  // remote-tracking branch.
  rig.git.git(work, 'config', '--unset-all', 'remote.origin.fetch')

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }))

  // The local `main` is the fallback default. With no `origin/main`, neither
  // behind nor prune has an answer.
  expect(ran.stdout).toBe('gh: ⚠️\n')
  const root = realpathSync(work)
  expect(ran.stderr).toBe(
    `${root}: behind could not be counted\n${root}: branches could not be listed\n`,
  )
})

it('warns about a folder it cannot list', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  rig.git.createAt(folder, 'a')
  chmodSync(folder, 0o300)
  try {
    const ran = await statusOf(rig, folder, createGhMock())

    expect(ran.stdout).toBe('gh: ⚠️\n')
    expect(ran.stderr).toMatch(/^.*folder: EACCES: .+\n$/)
  } finally {
    chmodSync(folder, 0o700)
  }
})

it('warns about a path that is not a directory', async () => {
  const rig = createRig()

  const ran = await statusOf(rig, rig.sandbox.join('missing'), createGhMock())

  expect(ran.stdout).toBe('gh: ⚠️\n')
  expect(ran.stderr).toBe(`${rig.sandbox.join('missing')}: not a directory\n`)
})

it('says nothing about a folder that holds no repository', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('empty')
  mkdirSync(path.join(folder, 'plain'), { recursive: true })

  const ran = await statusOf(rig, folder, createGhMock())

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' })
})

it('asks about the directory it was given, whatever GIT_DIR and GH_REPO name', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  const other = rig.git.create(rig.sandbox.join('other'))
  rig.git.remoteAdvance(work)
  const seen: NodeJS.ProcessEnv[] = []
  const gh = answering({ 'acme/widgets': side() })

  const ran = await statusOf(rig, work, gh, {
    env: { ...rig.sandbox.env, GIT_DIR: path.join(other, '.git'), GH_REPO: 'acme/other' },
    createGh: (env) => {
      seen.push(env)
      return gh
    },
  })

  expect(ran.stdout).toBe('gh: [behind 1]\n')
  expect(seen.map((env) => [env.GIT_DIR, env.GH_REPO])).toEqual([[undefined, undefined]])
})

it('names a missing git in the line, and checks nothing', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('git') },
  })

  expect(ran).toEqual({
    status: 0,
    stdout: 'gh: ⚠️ git not found on PATH\n',
    stderr: 'git not found on PATH\n',
  })
})

it('names a missing GitHub CLI in the line, and checks nothing', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await statusOf(rig, work, answering({ 'acme/widgets': side() }), {
    env: { ...rig.sandbox.env, PATH: rig.sandbox.pathWithout('gh') },
  })

  expect(ran).toEqual({
    status: 0,
    stdout: 'gh: ⚠️ GitHub CLI (gh) not found on PATH\n',
    stderr: 'GitHub CLI (gh) not found on PATH\n',
  })
})

it('names both missing tools in one line', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await statusOf(rig, work, createGhMock(), {
    env: { ...rig.sandbox.env, PATH: rig.sandbox.join('no-bin') },
  })

  expect(ran).toEqual({
    status: 0,
    stdout: 'gh: ⚠️ git and GitHub CLI (gh) not found on PATH\n',
    stderr: 'git and GitHub CLI (gh) not found on PATH\n',
  })
})

it('answers about its own directory when no directory is named', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await runHook(rig, ['status'], answering({ 'acme/widgets': side() }), {
    cwd: () => work,
  })

  expect(ran).toEqual({ status: 0, stdout: 'gh: [behind 1]\n', stderr: '' })
})
