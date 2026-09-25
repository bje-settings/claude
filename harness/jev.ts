// The in-process Jev double (#173), mirroring harness/gh.ts. It gives one
// reply registered per method, or a sequence of them for the two methods a
// stage calls repeatedly (#174). It has a fail switch on every method
// except `classify` (whose own promise never rejects; see `JevReplies`'s
// doc comment below). An unregistered method throws instead of returning
// empty (ADR 001, "The command function is the test seam"). A stub binary
// on PATH cannot give that last property. It is the difference between a
// test that proves a call was made correctly and a test that passes
// because nothing was called.
//
// `JevClient` and its judgment types moved to the root `lib/` at #173,
// where the real client is written against them. This file imports them
// back and re-exports them, so a test reaches the double and the interface
// it implements through one module. What stays here is only what does not
// ship: the double, its reply map, and its fail switch.
//
// Failure is a thrown Error, not a result envelope, for the same three
// reasons `harness/gh.ts` already committed to. First, an unregistered
// method must throw anyway, so this keeps one shape for everything that
// goes wrong. Second, an envelope would make every method's return a union
// that every caller must narrow, including callers that do not model
// failure at all. Third, the real client throws `JevError` for the same
// reasons `lib/gh.ts` throws `GhError`.
//
// There is no request log, no call counter, and no call-order assertion
// here, on purpose. A call count is an implementation detail, and a test
// that counts calls would turn a refactor red (ADR 001, RFC 001 "The
// testing seam").

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

/** The fail switch, for one method alone. It mirrors `harness/gh.ts`'s
 *  `ghFails`. A plain `Error` registered in its place would leave a
 *  command's own `error instanceof JevError && error.status === ...` branch
 *  unreachable from its tests. This is the same gap `ghFails` closes for
 *  `GhError`. `status` defaults to 0, `JevError`'s own status for a
 *  transport failure that never got a response. The fail switch stands for
 *  "this call did not work," not for a particular HTTP status. */
export function jevFails(message: string, status = 0): JevError {
  return new JevError(status, message, message)
}

/** What each method answers with, one entry per method. This keeps the
 *  reply map and the client aligned with each other (it mirrors
 *  `lib/gh.ts`'s `GhResults`). */
type JevResults = {
  classify: ClassifyOutcome
  judgePair: ChoiceAnswer<PairVerdict>
  judgeEvidence: ChoiceAnswer<EvidenceVerdict>
}

type JevMethod = keyof JevResults

/** One reply per method, or a failure in its place. A test that registers
 *  nothing for a method means "this must not be called".
 *
 *  `classify` has no fail switch. `lib/jev.ts`'s `classifyImpl` settles
 *  every request with `Promise.allSettled`. It folds a rejection into
 *  `ClassifyOutcome.failures`, instead of rejecting its own promise (see
 *  `ClassifyOutcome`'s doc comment). So `classify()` on the real client
 *  never rejects, and there is nothing here for a fail switch to model.
 *  This is the same reason `lib/gh.ts`'s `issueStates` never throws either.
 */
export type JevReplies = {
  classify?: JevResults['classify']
  judgePair?: JevResults['judgePair'] | Error
  judgeEvidence?: JevResults['judgeEvidence'] | Error
}

/** The two methods a stage calls more than once in a run. These are the
 *  two methods worth a sequence. `classify` is asked once, no matter how
 *  many units there are, so a sequence would have nothing to advance
 *  through. */
type SequencedMethod = 'judgePair' | 'judgeEvidence'

/** A sequence of replies for one method, in the order the calls take them.
 *
 *  This has the shape of `harness/pulls.ts`'s `GhSequences`, for the same
 *  reason and with the same rules. The last entry repeats, so a stage that
 *  makes one call more than the test expected reads the last answer,
 *  instead of falling off the end. An entry that is an `Error` throws, for
 *  that one call.
 *
 *  `createJevMock`'s one reply per method answers every call with the same
 *  value. This is the right double for a stage whose calls are
 *  interchangeable. But it cannot state one fact: that two judgments of the
 *  same kind came back with DIFFERENT confidences. A ranked findings list
 *  turns on this fact. A sequence gives that fact, with no state in the
 *  double beyond a cursor per method. */
export type JevSequences = { [K in SequencedMethod]?: readonly (JevResults[K] | Error)[] }

/** `usage()`'s one answer: zeros. The mock holds no state, so it has
 *  nothing here for a real total to add up against. A test that cares what
 *  a run spent must use `lib/jev.test.ts`'s transport instead, not this
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
 *  A method with no registration throws an error and names itself. If a
 *  command calls Jev where the test expected no call, the command fails
 *  loudly. It does not read an empty reply as an answer.
 */
function answer<K extends JevMethod>(replies: JevReplies, method: K): JevResults[K] {
  const registered = replies[method]
  if (registered === undefined) {
    throw new Error(`jev mock: no reply registered for ${method}`)
  }
  if (registered instanceof Error) {
    throw registered
  }
  // This cast is the price of one `answer` function for every method.
  // `JevReplies` pairs each key with its own result type, but TypeScript
  // cannot narrow an indexed access on a generic parameter past the two
  // guards above. A test enforces the pairing where it registers a reply,
  // which is where a mistake would happen.
  return registered as JevResults[K]
}

/** A `JevClient` that answers from `replies`, or from `sequences` where one
 *  is registered.
 *
 *  Precedence, highest first: the method's sequence, then its single reply,
 *  then the unregistered method's throw. Each level states a different
 *  fact, and a lower level never silently overrides a higher one.
 *
 *  Without a sequence, each method returns its registered reply on every
 *  call. The mock holds no state and has no conditional logic. So a test
 *  can measure only what a command does with the reply. A sequence adds
 *  one cursor per method and nothing else. The answer at each position was
 *  still written by the test.
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
