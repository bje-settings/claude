// shepherd-pr, part of its tests: the second half of the Python replays.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { it } from 'vitest'
import { asRoot, replay, replayAsAUser, replaySecondHalf } from './shepherd-pr.test-support.ts'

it.each(replaySecondHalf)('prints what the Python printed for %s', replay)
it.skipIf(asRoot).each(replayAsAUser)('prints what the Python printed for %s', replay)
