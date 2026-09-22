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

import { type GhClient, type GhEndpoint, GhError, type GhResults } from '../lib/gh.ts'

export type {
  CommentText,
  GhClient,
  GhEndpoint,
  GhResults,
  IssueState,
  MergedPullRequestQuery,
  PullRequestQuery,
  RunQuery,
  WatchResult,
} from '../lib/gh.ts'
export { GhError } from '../lib/gh.ts'

/** One reply per endpoint, or a failure in its place. Registering nothing for
 *  an endpoint is how a test says "this must not be called". */
export type GhReplies = { [K in GhEndpoint]?: GhResults[K] | Error }

/**
 * The fail switch: register it in place of an endpoint's reply and that
 * endpoint, and only that endpoint, fails with this message.
 *
 * A `GhError` and not a plain one, because that is what the real client throws
 * and the whole point of round 5's handoff fact 3 is that it carries gh's exit
 * status so a caller branches on a value rather than on prose. A command whose
 * test registered a plain `Error` could never reach its own
 * `error instanceof GhError && error.status === ...` arm, so the double would
 * make the command look covered while the branch that matters was unreachable.
 *
 * `status` defaults to 1, which is gh's own generic non-zero and the status a
 * test that does not care about the number should not have to name. The
 * `cause` is the message: the real client puts the whole `RunResult` there and
 * there is no run here, so it carries the one fact there is rather than
 * `undefined`.
 *
 * `detail` is the message too. On a real failure it is gh's own account
 * without the `gh <argv> failed: ` prefix, and a command reads it rather than
 * `message` for a one-line reason. A test writes the message it wants that
 * command to print, so here the two are the same string: a double whose
 * `detail` was empty, or absent, would make a command that reads it look
 * broken for a reason the real client never produces.
 */
export function ghFails(message: string, status: number | null = 1): GhError {
  return new GhError(message, status, { cause: message, detail: message })
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
    listMergedPullRequests: async () => answer(replies, 'listMergedPullRequests'),
    viewPullRequest: async () => answer(replies, 'viewPullRequest'),
    viewRepository: async () => answer(replies, 'viewRepository'),
    listRuns: async () => answer(replies, 'listRuns'),
    readFailedRunLog: async () => answer(replies, 'readFailedRunLog'),
    updateBranch: async () => answer(replies, 'updateBranch'),
    addComment: async () => answer(replies, 'addComment'),
    watchChecks: async () => answer(replies, 'watchChecks'),
    issueStates: async () => answer(replies, 'issueStates'),
  }
}
