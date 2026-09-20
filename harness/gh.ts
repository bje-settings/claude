// The in-process `gh` double: one reply registered per endpoint, a fail switch
// per endpoint, and an unhandled endpoint throwing rather than returning empty
// (ADR 001, "The command function is the test seam"). That last property is
// the one a stub binary on PATH cannot give, and it is the difference between
// a test proving a call was made correctly and a test passing because nothing
// was called.
//
// `GhClient` is declared here for now and moves to the root `lib/` at #125,
// where the real client is written against it; this file then imports it
// rather than declaring it. The endpoints are named after the operation the
// caller wants, not after gh's argv, so the interface survives gh changing a
// flag. Inputs and outputs stay plain JSON values: #125 and #127 refine them
// against the commands that actually consume them, and a domain type invented
// here would be invented from nothing.
//
// Failure is a thrown Error, not a result envelope. Three reasons, and #125's
// client is written to match: an unregistered endpoint has to throw anyway, so
// this keeps one shape for everything that goes wrong; an envelope would make
// every endpoint's return a union that every caller must narrow, including the
// callers that do not model failure at all; and the real client runs `gh` as a
// child process, where a non-zero exit with stderr is exactly an exception.
//
// There is no request log, no call counter and no call-order assertion here,
// deliberately: counting calls pins an implementation detail and turns a
// refactor red (ADR 001, RFC 001 "The testing seam").

/** Filters `gh pr list` applies server-side, as the plugins pass them today. */
export interface PullRequestQuery {
  state?: string
  base?: string
  head?: string
  limit?: number
}

/** Filters `gh run list` applies server-side. */
export interface RunQuery {
  branch?: string
  status?: string
  limit?: number
}

/** What each endpoint answers with. One entry per operation, so the reply map
 *  and the client cannot drift apart. */
export interface GhResults {
  /** Pull requests matching the query, projected as JSON rows. */
  listPullRequests: unknown[]
  /** The repository's own fields: default branch and `nameWithOwner`. */
  viewRepository: Record<string, unknown>
  /** Workflow runs matching the query, as JSON rows. */
  listRuns: unknown[]
  /** The log of a run's failed steps, as text. */
  readFailedRunLog: string
  /** Whatever the update printed. The verdict is that it did not throw. */
  updateBranch: string
  /** Whatever posting the comment printed. */
  addComment: string
  /** The checks as they stood when the watch returned. */
  watchChecks: unknown[]
}

export type GhEndpoint = keyof GhResults

/** The operations the plugins ask `gh` for. Implemented by the real client
 *  (#125) and by `createGhMock` here; a command takes one as an argument and
 *  never constructs it, which is what makes it swappable at all. */
export interface GhClient {
  listPullRequests(query?: PullRequestQuery): Promise<GhResults['listPullRequests']>
  viewRepository(): Promise<GhResults['viewRepository']>
  listRuns(query?: RunQuery): Promise<GhResults['listRuns']>
  readFailedRunLog(run: { run: string | number }): Promise<GhResults['readFailedRunLog']>
  updateBranch(pull: { pullRequest: number; rebase?: boolean }): Promise<GhResults['updateBranch']>
  addComment(comment: { pullRequest: number; body: string }): Promise<GhResults['addComment']>
  watchChecks(pull: { pullRequest: number; interval?: number }): Promise<GhResults['watchChecks']>
}

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
