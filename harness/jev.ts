// The in-process Jev double (#173), mirroring harness/gh.ts: one reply
// registered per method, or a sequence of them for the two methods a stage
// calls repeatedly (#174), a fail switch on every method except `classify`
// (whose own promise never rejects, see `JevReplies`'s doc comment below), an
// unregistered method throwing rather than returning empty (ADR 001, "The
// command function is the test seam"). That last property is the one a stub
// binary on PATH cannot give, and it is the difference between a test proving
// a call was made correctly and a test passing because nothing was called.
//
// `JevClient` and its judgment types moved to the root `lib/` at #173, where
// the real client is written against them, and this file imports them back
// and re-exports them so a test reaches the double and the interface it
// implements through one module. What stays here is only what does not ship:
// the double, its reply map and its fail switch.
//
// Failure is a thrown Error, not a result envelope, for the same three
// reasons `harness/gh.ts` already committed to: an unregistered method has to
// throw anyway, so this keeps one shape for everything that goes wrong; an
// envelope would make every method's return a union every caller must
// narrow, including callers that do not model failure at all; and the real
// client throws `JevError` for the same reasons `lib/gh.ts` throws `GhError`.
//
// There is no request log, no call counter and no call-order assertion here,
// deliberately: counting calls pins an implementation detail and turns a
// refactor red (ADR 001, RFC 001 "The testing seam").

import {
  type ChoiceAnswer,
  type ClassifyOutcome,
  type EvidenceVerdict,
  type JevClient,
  JevError,
  type PairVerdict,
  type Usage,
} from '../lib/jev.ts'

export type {
  ChoiceAnswer,
  Classification,
  ClassifyOutcome,
  EvidenceNeed,
  EvidenceVerdict,
  JevClient,
  JevRequest,
  JevUnit,
  PairVerdict,
  RequestShape,
  UnitKind,
  Usage,
} from '../lib/jev.ts'
export { JevError } from '../lib/jev.ts'

/** The fail switch, for one method alone, mirroring `harness/gh.ts`'s
 *  `ghFails`. A plain `Error` registered in its place would make a command's
 *  own `error instanceof JevError && error.status === ...` arm unreachable
 *  from its tests, the same gap `ghFails` exists to close for `GhError`.
 *  `status` defaults to 0, `JevError`'s own status for a transport failure
 *  that never got a response, since the fail switch stands for "this call
 *  did not work" rather than for a particular HTTP status. */
export function jevFails(message: string, status = 0): JevError {
  return new JevError(status, message, message)
}

/** What each method answers with, one entry per method, so the reply map and
 *  the client cannot drift apart (mirrors `lib/gh.ts`'s `GhResults`). */
type JevResults = {
  classify: ClassifyOutcome
  judgePair: ChoiceAnswer<PairVerdict>
  judgeEvidence: ChoiceAnswer<EvidenceVerdict>
}

type JevMethod = keyof JevResults

/** One reply per method, or a failure in its place. Registering nothing for a
 *  method is how a test says "this must not be called". `classify` has no
 *  fail switch: `lib/jev.ts`'s `classifyImpl` settles every request with
 *  `Promise.allSettled` and folds a rejection into `ClassifyOutcome.failures`
 *  rather than rejecting its own promise (see `ClassifyOutcome`'s doc
 *  comment), so `classify()` on the real client never rejects and there is
 *  nothing for a fail switch to model here: the same reason `lib/gh.ts`'s
 *  `issueStates` never throws either. */
export type JevReplies = {
  classify?: JevResults['classify']
  judgePair?: JevResults['judgePair'] | Error
  judgeEvidence?: JevResults['judgeEvidence'] | Error
}

/** The two methods a stage calls more than once in a run, and so the two a
 *  sequence is worth having for. `classify` is asked once however many units
 *  there are, so a sequence would have nothing to advance through. */
type SequencedMethod = 'judgePair' | 'judgeEvidence'

/** A sequence of replies for one method, in the order the calls take them.
 *
 *  The shape of `harness/pulls.ts`'s `GhSequences`, for the same reason and
 *  with the same rules: the last entry repeats, so a stage that makes one call
 *  more than the test expected reads the last answer rather than falling off
 *  the end, and an entry that is an `Error` is thrown for that call alone.
 *
 *  `createJevMock`'s one reply per method answers every call with the same
 *  value, which is the right double for a stage whose calls are
 *  interchangeable. It cannot state the one fact a ranked findings list turns
 *  on: that two judgments of the same kind came back with DIFFERENT
 *  confidences. A sequence is that fact, with no state in the double beyond a
 *  cursor per method. */
export type JevSequences = { [K in SequencedMethod]?: readonly (JevResults[K] | Error)[] }

/** `usage()`'s one answer: zeros. The mock holds no state, so there is
 *  nothing here for a real total to accumulate against; a test that cares
 *  what a run spent belongs against `lib/jev.test.ts`'s transport, not this
 *  double. */
const ZERO_USAGE: Usage = {
  requests: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  requestMsSum: 0,
}

/** The reply registered for one method, or the failure it stands for.
 *
 *  A method with no registration throws and names itself, so a command that
 *  reached for Jev where the test expected no call fails loudly instead of
 *  reading an empty reply as an answer.
 */
function answer<K extends JevMethod>(replies: JevReplies, method: K): JevResults[K] {
  const registered = replies[method]
  if (registered === undefined) {
    throw new Error(`jev mock: no reply registered for ${method}`)
  }
  if (registered instanceof Error) {
    throw registered
  }
  // The cast is the price of one `answer` for every method: `JevReplies`
  // pairs each key with its own result type, but TypeScript will not narrow
  // an indexed access on a generic parameter past the two guards above. The
  // pairing is enforced where a reply is registered, which is where a
  // mistake would be made.
  return registered as JevResults[K]
}

/** A `JevClient` answering from `replies`, or from `sequences` where one is
 *  registered.
 *
 *  Precedence, highest first: the method's sequence, then its single reply,
 *  then the unregistered method's throw. Each level is a different fact a test
 *  is stating, and a lower one never silently overrides a higher one.
 *
 *  Without a sequence each method returns its registered reply on every call:
 *  the mock holds no state and has no conditional logic, so what a command
 *  does with the reply is the only thing a test built on it can be measuring.
 *  A sequence adds one cursor per method and nothing else; the answer at each
 *  position was still written by the test.
 */
export function createJevMock(replies: JevReplies = {}, sequences: JevSequences = {}): JevClient {
  // One cursor per method, which is the whole of this double's state.
  const taken = new Map<SequencedMethod, number>()

  /** The next entry of `method`'s sequence, or `undefined` when it has none.
   *  The last entry repeats. */
  const fromSequence = <K extends SequencedMethod>(method: K): JevResults[K] | undefined => {
    const registered = sequences[method]
    if (registered === undefined) return undefined
    if (registered.length === 0) {
      throw new Error(`jev mock: the sequence registered for ${method} is empty`)
    }
    const position = Math.min(taken.get(method) ?? 0, registered.length - 1)
    taken.set(method, position + 1)
    const reply = registered[position] as JevResults[K] | Error
    if (reply instanceof Error) throw reply
    return reply
  }

  return {
    classify: async () => answer(replies, 'classify'),
    judgePair: async () => fromSequence('judgePair') ?? answer(replies, 'judgePair'),
    judgeEvidence: async () => fromSequence('judgeEvidence') ?? answer(replies, 'judgeEvidence'),
    usage: () => ZERO_USAGE,
  }
}
