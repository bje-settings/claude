// The in-process `gh` double: one reply registered per endpoint, a fail switch
// per endpoint, and an unhandled endpoint throwing rather than returning empty
// (ADR 001, "The command function is the test seam"). That last property is
// the one a stub binary on PATH cannot give, and it is the difference between
// a test proving a call was made correctly and a test passing because nothing
// was called.
//
// `GhClient` and its query and result types moved to the root `lib/` at #125,
// where the real client is written against them, and this file imports them
// back and re-exports them so a test reaches the double and the interface it
// implements through one module. What stays here is only what does not ship:
// the double, its reply map and its fail switch.
//
// Failure is a thrown Error, not a result envelope. Three reasons, and the
// real client in `lib/gh.ts` is written to match: an unregistered endpoint has
// to throw anyway, so this keeps one shape for everything that goes wrong; an
// envelope would make every endpoint's return a union that every caller must
// narrow, including the callers that do not model failure at all; and the real
// client runs `gh` as a child process, where a non-zero exit with stderr is
// exactly an exception.
//
// There is no request log, no call counter and no call-order assertion here,
// deliberately: counting calls pins an implementation detail and turns a
// refactor red (ADR 001, RFC 001 "The testing seam").

import type { GhClient, GhEndpoint, GhResults } from '../lib/gh.ts'

export type {
  GhClient,
  GhEndpoint,
  GhResults,
  PullRequestQuery,
  RunQuery,
} from '../lib/gh.ts'

/** One reply per endpoint, or a failure in its place. Registering nothing for
 *  an endpoint is how a test says "this must not be called". */
export type GhReplies = { [K in GhEndpoint]?: GhResults[K] | Error }

/** The fail switch: register it in place of an endpoint's reply and that
 *  endpoint, and only that endpoint, fails with this message. */
export function ghFails(message: string): Error {
  return new Error(message)
}

/** The reply registered for one endpoint, or the failure it stands for.
 *
 *  An endpoint with no registration throws and names itself, so a command that
 *  reached for gh where the test expected no call fails loudly instead of
 *  reading an empty list as an answer.
 */
function answer<K extends GhEndpoint>(replies: GhReplies, endpoint: K): GhResults[K] {
  const registered = replies[endpoint]
  if (registered === undefined) {
    throw new Error(`gh mock: no reply registered for ${endpoint}`)
  }
  if (registered instanceof Error) {
    throw registered
  }
  // The cast is the price of one `answer` for every endpoint: `GhReplies` pairs
  // each key with its own result type, but TypeScript will not narrow an
  // indexed access on a generic parameter past the two guards above. The
  // pairing is enforced where a reply is registered, which is where a mistake
  // would be made.
  return registered as GhResults[K]
}

/** A `GhClient` answering from `replies`.
 *
 *  Each endpoint returns its registered reply on every call: the mock holds no
 *  state and has no conditional logic, so what a command does with the reply
 *  is the only thing a test built on it can be measuring.
 */
export function createGhMock(replies: GhReplies = {}): GhClient {
  return {
    listPullRequests: async () => answer(replies, 'listPullRequests'),
    viewRepository: async () => answer(replies, 'viewRepository'),
    listRuns: async () => answer(replies, 'listRuns'),
    readFailedRunLog: async () => answer(replies, 'readFailedRunLog'),
    updateBranch: async () => answer(replies, 'updateBranch'),
    addComment: async () => answer(replies, 'addComment'),
    watchChecks: async () => answer(replies, 'watchChecks'),
  }
}
