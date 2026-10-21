// shepherd-pr, part of its tests: the first half of the Python replays, and the check of the capture.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import {
  ARRANGEMENTS,
  CAPTURE,
  DIVERGENCES,
  NOT_REPLAYED,
  REASONS,
  replay,
  replayable,
  replayFirstHalf,
  USAGE_TEXT,
} from './shepherd-pr.test-support.ts'

it.each(replayFirstHalf)('prints what the Python printed for %s', replay)

it('replays every captured case, and arranges only cases that exist', () => {
  expect(replayable.length + NOT_REPLAYED.size).toBe(Object.keys(CAPTURE).length)
  for (const name of [
    ...Object.keys(ARRANGEMENTS),
    ...USAGE_TEXT.keys(),
    ...Object.keys(REASONS),
  ]) {
    expect(Object.keys(CAPTURE)).toContain(name)
  }
  // Every case a divergence names is a case the capture actually holds. So
  // the test cannot record a row against a run that does not exist.
  for (const row of [...DIVERGENCES.sentences, DIVERGENCES.unchanged]) {
    for (const name of row.cases) expect(Object.keys(CAPTURE)).toContain(name)
  }
  // And the sentence that deliberately did not change is still in the
  // document, because it is output rather than prose.
  expect(CAPTURE[DIVERGENCES.unchanged.cases[0] ?? '']?.stdout).toContain(
    DIVERGENCES.unchanged.line,
  )
})
