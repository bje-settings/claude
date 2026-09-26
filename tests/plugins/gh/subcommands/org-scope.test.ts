// The `org-scope` command (#233), in process, over the `gh` double. The
// double answers `viewerEnterprises` with whatever a test registers, so each
// test names the enterprises the viewer can see and reads the verdict.
//
// The logins and slugs are invented. No real organization name goes here.
import { expect, it } from 'vitest'
import type { Output, Writer } from '#gh/lib/streams.ts'
import { HELP, runOrgScope } from '#gh/subcommands/org-scope.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'

const collector = (): Writer & { text: () => string } => {
  const chunks: string[] = []
  let silenced = false
  return {
    write: (text: string) => {
      chunks.push(text)
    },
    silence: () => {
      silenced = true
    },
    get silenced() {
      return silenced
    },
    text: () => chunks.join(''),
  }
}

/** Run the command over `replies`, and answer with its status and streams. */
const orgScope = async (
  argv: readonly string[],
  replies: GhReplies = {},
): Promise<{ status: number; stdout: string; stderr: string }> => {
  const out = collector()
  const err = collector()
  const output: Output = {
    out,
    err,
    silence: () => {
      out.silence()
      err.silence()
    },
  }
  const status = await runOrgScope(argv, { output, gh: createGhMock(replies) })
  return { status, stdout: out.text(), stderr: err.text() }
}

it('calls a source with the same owner as the target same-owner, whatever the case, and asks gh nothing', async () => {
  // No reply is registered, so a call to gh would throw.
  const result = await orgScope(['--target', 'Acme-One', 'acme-one', 'ACME-ONE'])

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'Acme-One',
    results: [
      { source: 'acme-one', scope: 'same-owner' },
      { source: 'ACME-ONE', scope: 'same-owner' },
    ],
  })
})

/** The viewer's enterprises: `acme-ent` with two organizations, and
 *  `zeta-ent` with one. */
const ENTERPRISES: GhReplies = {
  viewerEnterprises: {
    enterprises: [
      { slug: 'acme-ent', organizations: ['acme-one', 'acme-two'] },
      { slug: 'zeta-ent', organizations: ['zeta-one'] },
    ],
    unavailable: null,
  },
}

it('calls a source that one enterprise lists beside the target same-enterprise, and names the enterprise', async () => {
  const result = await orgScope(['--target', 'ACME-TWO', 'Acme-One'], ENTERPRISES)

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'ACME-TWO',
    results: [{ source: 'Acme-One', scope: 'same-enterprise', enterprise: 'acme-ent' }],
  })
})

it('calls a source in a different enterprise from the target outside', async () => {
  const result = await orgScope(['--target', 'zeta-one', 'acme-one'], ENTERPRISES)

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'zeta-one',
    results: [{ source: 'acme-one', scope: 'outside' }],
  })
})

it('calls every source outside when the target is a user account, which no enterprise lists', async () => {
  const result = await orgScope(['--target', 'some-user', 'acme-one'], ENTERPRISES)

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'some-user',
    results: [{ source: 'acme-one', scope: 'outside' }],
  })
})

it('calls a source in no enterprise the viewer can see outside', async () => {
  const result = await orgScope(['--target', 'acme-one', 'unseen-org'], ENTERPRISES)

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'acme-one',
    results: [{ source: 'unseen-org', scope: 'outside' }],
  })
})

it('calls every source but the same owner unknown when gh fails, with the reason on stderr', async () => {
  const result = await orgScope(['--target', 'acme-one', 'acme-two', 'ACME-ONE'], {
    viewerEnterprises: ghFails('gh: API rate limit exceeded'),
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe(
    'org-scope: the enterprise list could not be read: gh: API rate limit exceeded\n',
  )
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'acme-one',
    results: [
      { source: 'acme-two', scope: 'unknown' },
      { source: 'ACME-ONE', scope: 'same-owner' },
    ],
  })
})

it('calls a source unknown when the list is short, even when the rows read so far name both owners', async () => {
  const result = await orgScope(['--target', 'acme-one', 'acme-two', 'unseen-org'], {
    viewerEnterprises: {
      enterprises: [{ slug: 'acme-ent', organizations: ['acme-one', 'acme-two'] }],
      unavailable: 'enterprise acme-ent has more organizations than the 100 this reads',
    },
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe(
    'org-scope: the enterprise list could not be read: ' +
      'enterprise acme-ent has more organizations than the 100 this reads\n',
  )
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'acme-one',
    results: [
      { source: 'acme-two', scope: 'unknown' },
      { source: 'unseen-org', scope: 'unknown' },
    ],
  })
})

it('answers each of several sources on its own, in the order given', async () => {
  const result = await orgScope(
    ['--target', 'acme-one', 'acme-one', 'acme-two', 'zeta-one', 'some-user'],
    ENTERPRISES,
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({
    target: 'acme-one',
    results: [
      { source: 'acme-one', scope: 'same-owner' },
      { source: 'acme-two', scope: 'same-enterprise', enterprise: 'acme-ent' },
      { source: 'zeta-one', scope: 'outside' },
      { source: 'some-user', scope: 'outside' },
    ],
  })
})

it.each([
  ['no --target', ['acme-one'], 'org-scope: --target is required'],
  ['an empty --target', ['--target', '', 'acme-one'], 'org-scope: --target is required'],
  ['no source', ['--target', 'acme-one'], 'org-scope: name at least one source owner'],
  ['an empty source', ['--target', 'acme-one', ''], 'org-scope: a source owner is empty'],
  ['an unknown flag', ['--target', 'acme-one', '--nope', 'acme-two'], "Unknown option '--nope'"],
  ['--target with no value', ['--target'], "Option '--target <value>' argument missing"],
])(
  'refuses %s with exit 2, the reason and the usage on stderr, and nothing on stdout',
  async (_name, argv, reason) => {
    // No reply is registered, so a call to gh would throw.
    const result = await orgScope(argv)

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(reason)
    expect(result.stderr).toContain('usage: gh.ts org-scope --target <owner> <source-owner>...')
  },
)

it.each([['--help'], ['-h']])(
  'prints its help for %s with exit 0, and asks gh nothing',
  async (flag) => {
    const result = await orgScope([flag])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${HELP}\n`)
    expect(result.stderr).toBe('')
  },
)
