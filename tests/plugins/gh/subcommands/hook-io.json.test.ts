// The status check, in process, through `status --json [dir]` (#496): the
// report that the hooks module draws. `hook-io.status.test.ts` covers the
// check itself through the text output. This file covers the shape of the
// report and the arguments of the JSON mode.
import { expect, it } from 'vitest'
import { USAGE } from '#gh/subcommands/hook-io.ts'
import { createGhMock, type GhClient } from '#harness/gh.ts'
import { createRig, githubRepo, onGitHub, runHook, side } from './hook-io.test-support.ts'

const answering = (repositories: Record<string, ReturnType<typeof side>>): GhClient =>
  createGhMock({ repositoryStatus: { repositories, unavailable: null } })

const ZERO = { behind: 0, prune: 0, pullRequests: 0, dependencies: 0, alerts: 0 }

it('writes the report of one repository, with its owner/name', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await runHook(
    rig,
    ['status', '--json', work],
    answering({ 'acme/widgets': side(4, 2, [], 3) }),
  )

  expect(ran.status).toBe(0)
  expect(ran.stderr).toBe('')
  expect(ran.stdout.endsWith('\n')).toBe(true)
  expect(ran.stdout.slice(0, -1)).not.toContain('\n')
  expect(JSON.parse(ran.stdout)).toEqual({
    counts: { behind: 1, prune: 0, pullRequests: 3, dependencies: 2, alerts: 4 },
    repos: 1,
    repository: 'acme/widgets',
    problems: [],
  })
})

it('writes the report of a folder as sums, with no repository name', async () => {
  const rig = createRig()
  const folder = rig.sandbox.join('folder')
  onGitHub(rig, rig.git.createAt(folder, 'a'), 'acme/a')
  onGitHub(rig, rig.git.createAt(folder, 'b'), 'acme/b')

  const ran = await runHook(
    rig,
    ['status', '--json', folder],
    createGhMock({
      repositoryStatus: {
        repositories: { 'acme/a': side(1, 2), 'acme/b': { ...side(3, 4), alerts: null } },
        unavailable: null,
      },
    }),
  )

  expect(ran.status).toBe(0)
  expect(JSON.parse(ran.stdout)).toEqual({
    counts: { ...ZERO, dependencies: 6, alerts: 1 },
    repos: 2,
    repository: null,
    problems: ['alerts could not be read in 1 repo'],
  })
  expect(ran.stderr).toBe('acme/b: alerts could not be read\n')
})

it('writes a report also when there is nothing to show', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')

  const ran = await runHook(rig, ['status', '--json'], answering({ 'acme/widgets': side() }), {
    cwd: () => work,
  })

  expect(ran).toEqual({
    status: 0,
    stdout: `${JSON.stringify({ counts: ZERO, repos: 1, repository: 'acme/widgets', problems: [] })}\n`,
    stderr: '',
  })
})

it('writes zero counts and the dependency problems when a tool is missing', async () => {
  const rig = createRig()
  const work = githubRepo(rig, rig.sandbox.join('r'), 'acme/widgets')
  rig.git.remoteAdvance(work)

  const ran = await runHook(rig, ['status', '--json', work], createGhMock(), {
    env: { ...rig.sandbox.env, PATH: rig.sandbox.join('no-bin') },
  })

  expect(ran).toEqual({
    status: 0,
    stdout: `${JSON.stringify({
      counts: ZERO,
      repos: 0,
      repository: null,
      problems: ['git not found on PATH', 'GitHub CLI (gh) not found on PATH'],
    })}\n`,
    stderr: 'git not found on PATH\nGitHub CLI (gh) not found on PATH\n',
  })
})

it('answers too many arguments after --json with the usage line and exit 2', async () => {
  const rig = createRig()

  for (const argv of [
    ['status', '--json', 'a', 'b'],
    ['status', 'a', '--json'],
  ]) {
    const ran = await runHook(rig, argv, createGhMock())
    expect([argv, ran]).toEqual([argv, { status: 2, stdout: '', stderr: USAGE }])
  }
})
