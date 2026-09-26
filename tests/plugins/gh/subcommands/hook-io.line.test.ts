// The pure parts of the SessionStart hook: the line, the response that
// carries it, and the origin URL parser. Each is a function of its
// arguments alone, so these tests start no process and build no repository.
import { expect, it } from 'vitest'
import { githubRepository, type StatusCounts, statusLine } from '#gh/subcommands/hook-io.ts'

const ZERO: StatusCounts = { behind: 0, prune: 0, dependencies: 0, alerts: 0 }

it('says nothing when every count is zero and nothing failed', () => {
  expect(statusLine(ZERO, 1, false)).toBeNull()
  expect(statusLine(ZERO, 5, false)).toBeNull()
})

it('writes each item alone, in its own words', () => {
  expect(statusLine({ ...ZERO, behind: 3 }, 1, false)).toBe('gh: [behind 3]')
  expect(statusLine({ ...ZERO, prune: 2 }, 1, false)).toBe('gh: [prune 2]')
  expect(statusLine({ ...ZERO, dependencies: 4 }, 1, false)).toBe('gh: [🤖 4]')
  expect(statusLine({ ...ZERO, alerts: 1 }, 1, false)).toBe('gh: [🛡️ 1]')
})

it('writes every item together, in the fixed order, with the warning last', () => {
  expect(statusLine({ behind: 1, prune: 2, dependencies: 3, alerts: 4 }, 1, true)).toBe(
    'gh: [behind 1] [prune 2] [🤖 3] [🛡️ 4] ⚠️',
  )
})

it('leaves out a zero count between two counts above zero', () => {
  expect(statusLine({ behind: 1, prune: 0, dependencies: 0, alerts: 4 }, 1, false)).toBe(
    'gh: [behind 1] [🛡️ 4]',
  )
})

it('writes the warning alone when something failed and no count is above zero', () => {
  expect(statusLine(ZERO, 1, true)).toBe('gh: ⚠️')
})

it('names the repository count only when there is more than one repository', () => {
  expect(statusLine({ ...ZERO, prune: 1 }, 2, false)).toBe('gh: 2 repos [prune 1]')
  expect(statusLine({ ...ZERO, prune: 1 }, 21, true)).toBe('gh: 21 repos [prune 1] ⚠️')
  expect(statusLine({ ...ZERO, prune: 1 }, 1, false)).toBe('gh: [prune 1]')
  expect(statusLine({ ...ZERO, prune: 1 }, 0, false)).toBe('gh: [prune 1]')
})

it('reads owner and name from every github.com URL form git accepts', () => {
  const forms = [
    'git@github.com:acme/widgets.git',
    'git@github.com:acme/widgets',
    'github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'ssh://git@github.com:22/acme/widgets',
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets/',
    'https://token@github.com/acme/widgets.git',
    'http://github.com/acme/widgets',
    'git://github.com/acme/widgets.git',
    'https://GitHub.com/acme/widgets.git',
  ]
  for (const url of forms) expect([url, githubRepository(url)]).toEqual([url, 'acme/widgets'])
})

it('keeps the dots, dashes and underscores a repository name can hold', () => {
  expect(githubRepository('git@github.com:bje-settings/claude.git')).toBe('bje-settings/claude')
  expect(githubRepository('https://github.com/acme/bje.co.git')).toBe('acme/bje.co')
  expect(githubRepository('https://github.com/acme/.github')).toBe('acme/.github')
  expect(githubRepository('https://github.com/a_b/c_d')).toBe('a_b/c_d')
})

it('answers null for a remote that is not on github.com', () => {
  const others = [
    '',
    '/srv/git/widgets.git',
    '../origin.git',
    'file:///srv/git/widgets.git',
    'git@gitlab.com:acme/widgets.git',
    'https://github.example.com/acme/widgets.git',
    'https://notgithub.com/acme/widgets.git',
    'https://github.com.evil.test/acme/widgets.git',
    'https://mirror.example/https://github.com/acme/widgets.git',
    'https://github.com/acme',
    'https://github.com/acme/widgets/tree/main',
    'git@github.com:acme/widgets.git\n',
  ]
  for (const url of others) expect([url, githubRepository(url)]).toEqual([url, null])
})
