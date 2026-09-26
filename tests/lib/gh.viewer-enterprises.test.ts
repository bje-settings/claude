// `viewerEnterprises` on the real `gh` client (#233). Nothing here spawns
// anything. The client takes the process runner as a parameter, so a
// stand-in answers each `gh api graphql` call, and the test reads the
// argv and the answer. `gh.test.ts` has the same seam for every other
// endpoint. This file is separate from it, so the endpoint's tests do not
// collide with other open changes to that file.
//
// The logins and slugs are invented. No real organization name goes here.
import { expect, it } from 'vitest'

import { createGhClient, type GhClient } from '#lib/gh.ts'
import type { Runner, RunResult } from '#lib/process.ts'

/** What the runner is to answer with. Everything not named is what a child
 *  that succeeded and said nothing would report. */
interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly status?: number | null
}

const asResult = (reply: Reply): RunResult => ({
  status: reply.status === undefined ? 0 : reply.status,
  signal: null,
  stdout: reply.stdout ?? '',
  stderr: reply.stderr ?? '',
  combined: `${reply.stdout ?? ''}${reply.stderr ?? ''}`,
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
})

/** A client whose runner answers each call from `replies` in order, and
 *  repeats the last reply once the list runs out. `args` holds the argv of
 *  each call. */
const clientAnswering = (
  replies: readonly Reply[],
): { gh: GhClient; args: (readonly string[])[] } => {
  const args: (readonly string[])[] = []
  const run: Runner = async (_command, argv) => {
    args.push(argv ?? [])
    return asResult(replies[Math.min(args.length - 1, replies.length - 1)] ?? {})
  }
  return { gh: createGhClient({ run }), args }
}

/** One page of `viewer.enterprises`, as gh prints it. */
const page = (
  nodes: readonly unknown[],
  info: { hasNextPage?: boolean; endCursor?: string | null } = {},
  errors?: readonly unknown[],
): Reply => ({
  stdout: JSON.stringify({
    data: {
      viewer: {
        enterprises: {
          nodes,
          pageInfo: { hasNextPage: info.hasNextPage ?? false, endCursor: info.endCursor ?? null },
        },
      },
    },
    ...(errors === undefined ? {} : { errors }),
  }),
})

/** One enterprise node, with one page of organizations. */
const enterprise = (slug: string, logins: readonly string[], more = false): unknown => ({
  slug,
  organizations: {
    nodes: logins.map((login) => ({ login })),
    pageInfo: { hasNextPage: more },
  },
})

it('asks gh api graphql for every enterprise the viewer is in, with the logins of its organizations', async () => {
  const { gh, args } = clientAnswering([page([enterprise('acme-ent', ['acme-one', 'acme-two'])])])

  const result = await gh.viewerEnterprises()

  expect(args[0]?.slice(0, 3)).toEqual(['api', 'graphql', '-f'])
  expect(args[0]?.[3]).toContain('viewer { enterprises(first: 100, after: $cursor)')
  expect(args[0]?.[3]).toContain('organizations(first: 100)')
  // The first page names no cursor. `after: null` is the first page.
  expect(args[0]?.some((word) => word.startsWith('cursor='))).toBe(false)
  expect(result).toEqual({
    enterprises: [{ slug: 'acme-ent', organizations: ['acme-one', 'acme-two'] }],
    unavailable: null,
  })
})
