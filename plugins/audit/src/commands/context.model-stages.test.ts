// context, part of its tests: the model stages.
// The file is one of several so that vitest can run them at the same time (#205).
// `context.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  type EvidenceVerdict,
  JevError,
  type JevUnit,
  jevFails,
  type PairVerdict,
  type UnitKind,
} from '../../../../harness/jev.ts'
import type { Unit } from '../types.ts'
import {
  audited,
  classified,
  isConfLine,
  modelled,
  picked,
  reportOf,
} from './context.test-support.ts'
import { type ContextEdges, runContext } from './context.ts'

it('reports a pair the model says contradicts, naming both units', async () => {
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.9),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: contradicts (1; 1 of 1 judged)',
      '  conf 0.90  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on failure.',
      '    b: The retry policy backs off exponentially every time.',
    ].join('\n'),
  )
})

it('compares no history or structural unit, whatever they look like', async () => {
  // A record of the past and a heading assert nothing about the repository as
  // it stands. So neither can be the duplicate or the contradiction a pair
  // finding is about. `judgePair` has no reply registered, so a candidate
  // that reached the model would throw rather than pass quietly.
  const audit = modelled('pairs', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('history') }),
        classified('CLAUDE.md:5-5'),
      ],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('reports a volatile unit whose cited issue has closed', async () => {
  // The unit names its own expiry. The issue it hangs that expiry on is no
  // longer open. That pairing is the finding; neither half is one alone.
  const audit = modelled(
    'expired',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## volatile and the issue it names is closed (1)',
      '  CLAUDE.md:3-3  The Python layer is retiring and stays only until `#164` lands.',
    ].join('\n'),
  )
})

it('never calls a history unit expired, whatever the issue it cites says', async () => {
  // A line about a past round cites a closed issue correctly. This
  // repository's own files are almost entirely that kind of line. Without the
  // `kind` field, the section would report every one of them.
  const audit = modelled(
    'history',
    {
      classify: {
        classifications: [
          classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('history'), volatile: 0.9 }),
        ],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('leaves a unit the model does not call volatile out of the section', async () => {
  // 0.8 is the spike's bar, tuned against the live model. The unit below it
  // says nothing about its own expiry. So the closed issue it cites is a
  // citation, not a deadline that has passed.
  const audit = modelled(
    'expired',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3', { volatile: 0.79 })],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('does not judge a volatile unit whose issue could not be looked up, and says how many', async () => {
  // The issue that closed may be the one the expiry hangs on, or it may not.
  // So the unit is neither reported nor quietly dropped. The count in the
  // heading stops a reader from taking "0 found" to mean "nothing is stale".
  const audit = modelled(
    'expired',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })],
        failures: [],
      },
    },
    { issueStates: { states: {}, unavailable: 'API rate limit exceeded' } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## volatile and the issue it names is closed (0; 1 volatile units not judged, issue lookup unavailable)',
  )
})

it('reports a classify request that failed, and fails the run while still printing', async () => {
  // A model call that failed is the one thing this command calls its own
  // failure. The findings are still what a reader acts on, so they go to
  // stdout. The status alone says the run was incomplete. Nothing was
  // classified, so no unit is expired, and none counts as unjudged either. An
  // unlabelled unit is not a volatile one.
  const audit = modelled(
    'stale',
    {
      classify: {
        classifications: [],
        failures: [{ id: 'request 0', message: 'HTTP 500: boom' }],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const text = audit.stdout()
  expect(text).toContain('1 files, 2 units, 0 opaque')
  // A heading of 0 with nothing under it would read as "no unit expired". The
  // spike's line instead says the stage never judged one.
  expect(text).toContain(
    '## volatile and the issue it names is closed (0)\n  not judged: classify failed\n',
  )
  // This is not "0 of 0 judged". No label came back, so the two stages below
  // classify were never in a position to judge anything. A coverage line that
  // says they looked at nothing would read as a repository with no
  // candidates in it. `judgePair` would throw if the run reached it.
  expect(text).toContain('## pairs: skipped (classify_failed)')
  expect(text).toContain('## evidence: skipped (classify_failed)')
  // This is one entry, not two. The stage already said what went wrong. A `*`
  // beside it would count as a second failure for one fault, and as a second
  // model call in the envelope's count, for a call that was never made.
  expect(text).toContain(['## failures (1)', '  classify request 0: HTTP 500: boom'].join('\n'))
})

it('skips the stages below classify when no unit was classified at all', async () => {
  // The classify stage answered and labelled nothing; it did not say why. The
  // two stages below it read the labels to decide what to ask about. Without
  // any labels, the pair stage would compare history and structural units it
  // should leave out. The evidence stage would find no repository fact and
  // check nothing. Neither answer is worth what it costs, so neither stage
  // runs. `*` is the failure that says the whole stage came back empty.
  const audit = modelled(
    'ranked',
    { classify: { classifications: [], failures: [] } },
    {},
    // This is a sequence whose only entry throws. If the run reaches
    // `judgePair` at all, that is the defect this test exists to catch. An
    // unregistered method would say the same thing, but less deliberately.
    { judgePair: [new Error('judgePair must not be reached')] },
  )

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const report = reportOf(audit.stdout())
  expect(report.skipped).toEqual([
    { stage: 'pairs', reason: 'classify_failed' },
    { stage: 'evidence', reason: 'classify_failed' },
  ])
  expect(report.failures).toEqual([
    { stage: 'classify', id: '*', message: 'no unit was classified' },
  ])
  expect(report.pairCoverage).toEqual({ judged: 0, available: 0 })
  expect(report.evidenceCoverage).toEqual({ judged: 0, available: 0 })
})

it('prints a unit of exactly the line limit whole, and truncates the next character', async () => {
  // A limit is only pinned by the value that sits on it. The first two units
  // are findings of the same section: one of exactly 110 characters, one of
  // 111. If the comparison were relaxed by one, the first would be cut
  // although it fits. If it were tightened by one, the second would print
  // whole.
  //
  // The third unit puts an emoji across the cut itself. The emoji is two
  // UTF-16 code units, and the cut lands between them. So a slice by code
  // unit keeps the high half alone, which is not a character.
  const audit = modelled(
    'boundary',
    {
      classify: {
        classifications: [
          classified('CLAUDE.md:3-3', { volatile: 0.9 }),
          classified('CLAUDE.md:5-5', { volatile: 0.9 }),
          classified('CLAUDE.md:7-7', { volatile: 0.9 }),
        ],
        failures: [],
      },
      // The two sentences are near-identical by construction, so they are a
      // candidate pair as well; this test is about neither verdict.
      judgePair: picked<PairVerdict>('unrelated'),
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## volatile and the issue it names is closed (3)',
      '  CLAUDE.md:3-3  The retry note in this file stays here until #164 has closed, and this whole sentence runs to one hundred ten.',
      '  CLAUDE.md:5-5  The deploy note in this file stays here until #164 closes, and this whole sentence runs to one hundred elev...',
      '  CLAUDE.md:7-7  The rollout note in this file stays here until #164 closes, and this sentence carries an emoji right here:...',
    ].join('\n'),
  )
  // This is checked separately because the assertion above cannot check it. A
  // lone high half is invisible in a source literal, and an editor draws it
  // the same way as the whole emoji. `[...text]` walks code points, so a
  // surviving half comes out as itself.
  expect([...audit.stdout()].some((character) => character.codePointAt(0) === 0xd83d)).toBe(false)
})

it('calls a repository with nothing to classify neither failed nor skipped', async () => {
  // This is the other side of the guard, and the one a real checkout can
  // reach. A repository that holds no markdown at all has nothing to label.
  // That is not the same as a stage that was asked and came back empty.
  // Nothing failed, nothing was skipped, and `0 of 0 judged` is the honest
  // answer. Neither `judgePair` nor `judgeEvidence` has a reply registered, so
  // a stage that asked anything would throw.
  const audit = modelled('nounits', { classify: { classifications: [], failures: [] } })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  const text = audit.stdout()
  expect(text).toContain('0 files, 0 units, 0 opaque')
  expect(text).toContain('## pairs: contradicts (0; 0 of 0 judged)')
  expect(text).toContain('## evidence: contradicts (0; 0 of 0 judged)')
  expect(text).toContain('## failures (0)')
})

it('reports a pair the model says makes one claim twice, under its own heading', async () => {
  // Two verdicts are findings, and they are different findings. One is a line
  // to delete; the other is a disagreement to settle. A reader acts on them
  // separately.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.75),
  })

  await runContext([audit.work], audit.edges)

  const text = audit.stdout()
  expect(text).toContain('## pairs: contradicts (0; 1 of 1 judged)')
  expect(text).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.75  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
    ].join('\n'),
  )
})

it('asks about the units that share a vocabulary, and about no others', async () => {
  // Three rules apply in one fixture, and each would cost model calls to get
  // wrong. Two units that say nearly the same thing are worth a comparison. A
  // unit about something else is not. A unit of three tokens is never
  // compared at all, however much vocabulary it shares, because there is not
  // enough of it for a shared word to mean anything.
  const audit = modelled('similar', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3'),
        classified('CLAUDE.md:5-5'),
        classified('CLAUDE.md:7-7'),
        classified('CLAUDE.md:9-9'),
      ],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.6),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: contradicts (1; 1 of 1 judged)',
      '  conf 0.60  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
    ].join('\n'),
  )
})

it('does not compare a cell value repeated down one table', async () => {
  // Two rows of one table that say the same thing are one value written twice
  // in a column, not a claim made twice. There is nothing to delete and
  // nothing to settle, so a model call on them buys nothing. `judgePair` has
  // no reply registered, so a candidate that reached it would throw.
  const audit = modelled('tables', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:8-8')],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('still compares the same cell written under two different headings', async () => {
  // This is the other half of the repeated-cell rule. One table that says
  // something twice is a column. Two tables that say the same thing show the
  // duplication the audit exists to find. If the run dropped every identical
  // row, it would hide that duplication.
  const audit = modelled('retables', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:13-13')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.81),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.81  CLAUDE.md:13-13  <>  CLAUDE.md:7-7',
    ].join('\n'),
  )
})

it('lets no unit be compared more than five times, whichever side it is on', async () => {
  // Seven units that all say nearly the same thing would need twenty-one
  // calls. The twenty-first buys nothing a reader did not already have from
  // the first few. The cap binds on both sides of a pair. A unit that sorts
  // last is never the query side, so without the second check, its own cap
  // would never bind at all.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('hub', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const pairs = reportOf(audit.stdout()).pairs
  const appearances = new Map<string, number>()
  for (const pair of pairs) {
    for (const id of [pair.a, pair.b]) appearances.set(id, (appearances.get(id) ?? 0) + 1)
  }
  expect(Math.max(...appearances.values())).toBe(5)
  expect(pairs.length).toBeLessThan(21)
})

it('spends a --max-pairs budget on the most similar candidates first', async () => {
  // The cap is a budget, and what it buys depends entirely on the order. The
  // run should spend its last call on the pair most likely to be a real
  // duplicate. The coverage line tells a reader the other two were never
  // asked about.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('same_claim', 0.7),
  })

  await runContext([audit.work, '--json', '--max-pairs', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.pairCoverage).toEqual({ judged: 1, available: 3 })
  expect(report.pairs.map((pair) => [pair.a, pair.b])).toEqual([['CLAUDE.md:3-3', 'CLAUDE.md:5-5']])
})

it('asks nothing when --pair-threshold is set above what any pair scores', async () => {
  // The threshold is how a caller trades false pairs against missed ones. It
  // must reach the scoring stage to do either. `judgePair` has no reply
  // registered, so a candidate that survived would throw.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0.9'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes 1 as a threshold too, which is the top of the range the flag names', async () => {
  // This is the other endpoint, and the parser is the whole of what this test
  // pins down. A pattern that admitted 0 up to just under 1 would refuse this
  // value with exit 2. A caller who asked for near-exact duplicates only would
  // be told their value was not a fraction. What the run then finds is the
  // existing 0.9 case.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  const envelope = await runContext([audit.work, '--json', '--pair-threshold', '1'], audit.edges)

  expect(envelope.outcome).toBe('ok')
  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes --pair-threshold 0 as a threshold, not as no threshold at all', async () => {
  // Zero is the other end of the range, and it is the value a falsy guard
  // loses. A run asked to keep every candidate its index finds must not
  // quietly fall back to the default. These six units score from 0.12 to
  // 0.18, all under the default of 0.5. So a fallback would report nothing at
  // all, instead of the five pairs the per-unit cap leaves room for.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('graded', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 5, available: 5 })
})

it('writes one JSON document and one newline, with the stages that ran unskipped', async () => {
  // This is what a caller who pipes `--json` parses. A second document, a
  // stray line of findings text, or a lost newline all reach a reader as a
  // broken stream. `skipped` must be empty on a run where every stage ran. A
  // reader who looks for the reason a section is thin must be able to tell
  // "none" from "not recorded".
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('contradicts', 0.9),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const stdout = audit.stdout()
  expect(stdout.endsWith('}\n')).toBe(true)
  expect(stdout.split('\n')).toHaveLength(2)
  const report = reportOf(stdout)
  expect(report.skipped).toEqual([])
  expect(report.pairs).toHaveLength(1)
})

it('records every pair call that failed and keeps going, rather than ending the run', async () => {
  // One rejected call must not cost the other two, and each one must be
  // named. A stage that stopped at the first failure would report a clean
  // pair section it never earned. This is built as a real `JevError`, so
  // `message` and `body` differ the way they do on a live failure. A report
  // line that quoted only one of them would still read as complete.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: new JevError(529, 'the model is overloaded', 'request failed'),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '3 model calls failed' })
  const text = audit.stdout()
  expect(text).toContain('## pairs: contradicts (0; 0 of 3 judged)')
  expect(text).toContain(
    [
      '## failures (3)',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:5-5: HTTP 529: request failed the model is overloaded',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:7-7: HTTP 529: request failed the model is overloaded',
      '  pairs CLAUDE.md:5-5 <> CLAUDE.md:7-7: HTTP 529: request failed the model is overloaded',
    ].join('\n'),
  )
})

it('reports an answer that would not parse in its own words', async () => {
  // A rejected request and an answer that arrived but is not one this code
  // can read are different failures. Only the first has an HTTP status. A
  // report that prefixed both with one would send a reader to the transport,
  // to look for a parser's complaint.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: new Error('answer pair chose banana, which is not one of the options'),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  expect(audit.stdout()).toContain(
    [
      '## failures (1)',
      '  pairs CLAUDE.md:3-3 <> CLAUDE.md:5-5: answer pair chose banana, which is not one of the options',
    ].join('\n'),
  )
})

it('judges a repository fact against the head of the file it names', async () => {
  // The claim and the file it points at are the cheapest evidence the audit
  // has. The excerpt is bounded on purpose. Accuracy falls as unrelated state
  // grows, so the head of the file is a crude bound, not a retrieval
  // strategy.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.88),
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.evidenceCoverage).toEqual({ judged: 1, available: 1 })
  expect(
    report.evidence.map((entry) => [entry.unitId, entry.source, entry.excerpt.length]),
  ).toEqual([['CLAUDE.md:3-3', 'docs/retry.md', 6000]])
})

it('picks the first reference that is a readable file of this repository', async () => {
  // Four refs are no evidence, and the fifth is. The unit's own file would
  // judge a claim against itself. A `../` path resolves outside the audited
  // root, a tree this run has no business to read. A directory has no
  // contents to excerpt. A path that does not resolve at all names no file to
  // read. Each of these would otherwise be picked before the file the writer
  // actually pointed at.
  const audit = modelled('sources', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('says_nothing'),
  })
  // This file sits beside the audited root, not beside the sandbox.
  // `harness/git.ts` puts the checkout at `<root>/work`. So
  // `../outside/tool.ts`, written from the repository, resolves here and
  // nowhere else. Anywhere else, the ref is simply `absent`, and the skip
  // this test is named for is never reached.
  const outside = path.join(audit.work, '..', 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'tool.ts'), 'export const wait = 1000\n')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  // This is the premise, asserted so the test cannot pass for the wrong
  // reason. The `../` ref really does resolve to a file. That is what makes
  // the skip a decision, not an absence.
  expect(report.units[0]?.refs[1]).toEqual({
    kind: 'path',
    value: '../outside/tool.ts',
    resolution: { status: 'found', repoPath: '../outside/tool.ts' },
  })
  expect(report.evidence.map((entry) => entry.source)).toEqual(['docs/note.md'])
})

it('is not fooled into excerpting a binary file', async () => {
  // A NUL byte marks a file no judgment can be made against, and it is the
  // first ref the unit names. Without the check, the model would be asked to
  // compare a claim with six thousand characters of an image. This fixture is
  // written here rather than committed, because a fixture that holds a NUL
  // byte is a file no tool in this repository can read either.
  const audit = modelled('binary', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('says_nothing'),
  })
  mkdirSync(path.join(audit.work, 'assets'))
  writeFileSync(path.join(audit.work, 'assets', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0d]))

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidence.map((entry) => entry.source)).toEqual(['docs/note.md'])
})

it('spends a --max-evidence budget in document order, and says what it left', async () => {
  // The bound is what keeps a large repository's run finite. The coverage
  // line is the only thing between "one contradiction found" and a reader who
  // believes the other fact was checked and cleared.
  const audit = modelled('facts', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgeEvidence: picked<EvidenceVerdict>('supports'),
  })

  await runContext([audit.work, '--json', '--max-evidence', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.evidenceCoverage).toEqual({ judged: 1, available: 2 })
  expect(report.evidence.map((entry) => entry.source)).toEqual(['docs/one.md'])
})

it('names the unit when an evidence call fails, not the file it was reading', async () => {
  // The unit is what a reader would have to check by hand. So it is what the
  // failure is filed under. `jevFails` stands for "this call did not work",
  // and it carries its message as the body too, which is why it reads twice.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: jevFails('the model is overloaded', 503),
  })

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope).toEqual({ outcome: 'failed', error: '1 model call failed' })
  const text = audit.stdout()
  expect(text).toContain('## evidence: contradicts (0; 0 of 1 judged)')
  expect(text).toContain(
    [
      '## failures (1)',
      '  evidence CLAUDE.md:3-3: HTTP 503: the model is overloaded the model is overloaded',
    ].join('\n'),
  )
})

it('ends with what the run spent, including the wall clock it was given', async () => {
  // These are four numbers a caller uses to decide whether to run this again.
  // A call retried twice is one request and three attempts. The summed
  // request time exceeds the wall clock whenever calls ran side by side. The
  // mock answers zeros, and the clock is the one the test handed over.
  const audit = modelled('pairs', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## usage: 0 requests (0 attempts), 0 input tokens, 0 ms summed request time, 1 ms wall clock',
  )
})

it('shortens a long finding to one readable line', async () => {
  // The findings are a list a reader scans. A unit's text is there to
  // recognise it by, not to read in full. A table row carries a newline
  // between its cells, and a paragraph can run for hundreds of characters.
  // Either would break the one-finding-per-line shape the list depends on.
  const audit = modelled(
    'long',
    {
      classify: {
        classifications: [classified('CLAUDE.md:7-7', { volatile: 0.9 })],
        failures: [],
      },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '  CLAUDE.md:7-7  Rule: The retry policy backs off exponentially on every network failure, and keeps doing so until `#164` la...',
  )
})

it('hands the client the plugin’s own unit, with no shape in between', async () => {
  // `lib/` cannot import a plugin. So the client takes the minimal structural
  // shape it reads off a unit, and the plugin's richer `Unit` satisfies it,
  // with no cast and no copy. The assignment below is the whole test. A field
  // renamed or narrowed on either side fails `tsc` here. It does not become a
  // wrong question at the API.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  const unit = reportOf(audit.stdout()).units[0] as Unit
  const asJevUnit: JevUnit = unit
  expect(asJevUnit.refs.map((ref) => ref.value)).toEqual(['lib/x.ts'])
})

it('finds the one distinctive pair in a large repository without comparing every pair', async () => {
  // Ten thousand units make a repository this audit is meant for. To compare
  // every pair of them would need fifty million dot products. The index
  // finds this pair by construction, from the shared tokens almost nothing
  // else carries. It never scans the postings list of the token everything
  // carries.
  //
  // Every unit is labelled, the way a real run's units would be. A classify
  // stage that came back empty is a stage that failed, and the pair stage
  // below it no longer runs at all. The units sit on every second line from
  // the third.
  const ids = Array.from({ length: 10_002 }, (_, n) => `CLAUDE.md:${3 + 2 * n}-${3 + 2 * n}`)
  const audit = modelled('absent', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })
  const lines = ['# Scale', '']
  for (let i = 0; i < 10_000; i++) lines.push(`commontoken bg${i}x bg${i}y bg${i}z`, '')
  for (const n of [0, 1]) {
    lines.push(
      `commontoken distinctivematch1 distinctivematch2 distinctivematch3 specialown${n}`,
      '',
    )
  }
  writeFileSync(path.join(audit.work, 'CLAUDE.md'), lines.join('\n'))

  const startedAt = Date.now()
  await runContext([audit.work, '--json'], audit.edges)
  const elapsedMs = Date.now() - startedAt

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 1, available: 1 })
  expect(elapsedMs).toBeLessThan(6000)
})

it('still compares two identical sentences, which are not table cells', async () => {
  // The repeated-cell rule is about table rows and nothing else. The same
  // sentence written twice in prose is the plainest duplicate there is. A
  // rule that dropped every identical text would drop exactly it.
  const audit = modelled('twins', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.95),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.95  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on failure.',
      '    b: The retry policy backs off exponentially on failure.',
    ].join('\n'),
  )
})

it('prints a refuted claim beside the file that refutes it', async () => {
  // The finding is only actionable with all three: which claim, which file,
  // and how sure the model was. The excerpt itself stays in the JSON report,
  // where a reader who wants it can look it up.
  const audit = modelled('evidence', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.88),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## evidence: contradicts (1; 1 of 1 judged)',
      '  conf 0.88  CLAUDE.md:3-3  against docs/retry.md',
      '    The retry helper described in `docs/retry.md` waits one second between attempts.',
    ].join('\n'),
  )
})

it('shortens both halves of a pair finding, which a table row would otherwise break', async () => {
  // The pair section is a list a reader scans, one finding per line. A
  // two-column table row carries a newline between its cells. Printed raw,
  // one finding becomes four lines, and anything that reads the text
  // line-wise mis-counts it. The other two sections use the same bound.
  const audit = modelled('longpair', {
    classify: {
      classifications: [classified('CLAUDE.md:7-7'), classified('CLAUDE.md:13-13')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (1; 1 of 1 judged)',
      '  conf 0.90  CLAUDE.md:13-13  <>  CLAUDE.md:7-7',
      '    a: Rule: The retry policy backs off exponentially on every network failure Why: A fixed delay hammers a servic...',
      '    b: Rule: The retry policy backs off exponentially on every network failure Why: A fixed delay hammers a servic...',
    ].join('\n'),
  )
})

it('lists the pairs of one verdict most confident first, not in the order they were judged', async () => {
  // The section is a review queue. The finding the model was surest of is the
  // one a reader should act on first. The stage judges in descending
  // SIMILARITY, which is a different order. So the two pairs below come back
  // in the opposite order to the one they must print in.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.41), picked<PairVerdict>('same_claim', 0.97)],
    },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## pairs: same_claim (2; 2 of 2 judged)',
      '  conf 0.97  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
      '    a: The retry policy backs off exponentially on every network failure.',
      '    b: The retry policy backs off on every network failure, without any delay.',
      '  conf 0.41  CLAUDE.md:7-7  <>  CLAUDE.md:9-9',
      '    a: Deploy previews expire after fourteen quiet days and are then removed.',
      '    b: Deploy previews expire after fourteen quiet days and are then removed.',
    ].join('\n'),
  )
})

it('leaves the JSON report in the order the stage judged, and ties in it too', async () => {
  // The findings text is a review queue, and the JSON report is a record. The
  // order a run made its calls in is part of what it records. So the text's
  // sort must not reach back into `report.pairs`. The two verdicts carry the
  // SAME confidence, which is the case an unstable or id-breaking sort gets
  // wrong. The pair judged first is the one with the lower id-sorted name. If
  // the run reorders by anything but the sort's own stability, that shows up
  // here.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.6), picked<PairVerdict>('same_claim', 0.6)],
    },
  )

  await runContext([audit.work, '--json'], audit.edges)

  const judged: Array<[string, string]> = [
    ['CLAUDE.md:7-7', 'CLAUDE.md:9-9'],
    ['CLAUDE.md:3-3', 'CLAUDE.md:5-5'],
  ]
  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual(judged)

  const second = modelled(
    'ranked2',
    { classify: { classifications: ids.map((id) => classified(id)), failures: [] } },
    {},
    {
      judgePair: [picked<PairVerdict>('same_claim', 0.6), picked<PairVerdict>('same_claim', 0.6)],
    },
  )
  await runContext([second.work], second.edges)

  expect(second.stdout().split('\n').filter(isConfLine)).toEqual([
    '  conf 0.60  CLAUDE.md:7-7  <>  CLAUDE.md:9-9',
    '  conf 0.60  CLAUDE.md:3-3  <>  CLAUDE.md:5-5',
  ])
})

it('lists refuted claims most confident first as well', async () => {
  // The same rule in the evidence section. The stage judges in document order,
  // so the second fact is the one that must print first.
  const audit = modelled(
    'facts',
    {
      classify: {
        classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
        failures: [],
      },
    },
    {},
    {
      judgeEvidence: [
        picked<EvidenceVerdict>('contradicts', 0.32),
        picked<EvidenceVerdict>('contradicts', 0.88),
      ],
    },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## evidence: contradicts (2; 2 of 2 judged)',
      '  conf 0.88  CLAUDE.md:5-5  against docs/two.md',
      '    The guide in `docs/two.md` explains when a caller should give up.',
      '  conf 0.32  CLAUDE.md:3-3  against docs/one.md',
      '    The note in `docs/one.md` records how long the helper waits.',
    ].join('\n'),
  )
})

it('leaves a volatile unit alone while the issue it names is still open', async () => {
  // This is the other half of the expired rule. A unit that is volatile and
  // not history is not a finding on its own. The deadline has to pass, and an
  // OPEN issue says it has not. Without this rule, the section reports every
  // volatile unit that cites any issue at all.
  const audit = modelled(
    'expired',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'OPEN' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## volatile and the issue it names is closed (0)')
})

it('does not report a volatile unit when one of the issues it cites is unanswerable', async () => {
  // One issue has closed, and the other could not be looked up. The model is
  // not asked WHICH issue the expiry hangs on. If the run published the
  // finding, it would guess that the closed issue was the one that mattered.
  // So the unit is counted in the heading instead.
  const audit = modelled(
    'partial',
    {
      classify: { classifications: [classified('CLAUDE.md:3-3', { volatile: 0.9 })], failures: [] },
    },
    { issueStates: { states: { '164': 'CLOSED' }, unavailable: null } },
  )

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    '## volatile and the issue it names is closed (0; 1 volatile units not judged, issue lookup unavailable)',
  )
})

it('spends the pair budget across query units, not on the first unit that has a candidate', async () => {
  // `candidatePairs` ranks each unit's own candidates and emits them in id
  // order. So the strongest pair in a repository can come out last. The
  // budget is worth nothing unless the whole list is ranked before it is cut.
  // Here the weaker pair is emitted first, and the stronger one must be the
  // one call that is made.
  const ids = [3, 5, 7, 9].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked2', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work, '--json', '--max-pairs', '1'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.pairCoverage).toEqual({ judged: 1, available: 2 })
  expect(report.pairs.map((pair) => [pair.a, pair.b])).toEqual([['CLAUDE.md:7-7', 'CLAUDE.md:9-9']])
})

it('keeps a unit’s most similar candidates when its cap binds, and drops the weakest', async () => {
  // There are six candidates and room for five, so one is dropped. Which one
  // is dropped is the whole question: the cap must spend its places on the
  // strongest. The weakest candidate here is not the last one the index
  // reaches. So an unranked cap would keep it and drop a stronger pair
  // instead.
  const ids = [3, 5, 7, 9, 11, 13, 15].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('graded', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json', '--pair-threshold', '0.1'], audit.edges)

  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual([
    ['CLAUDE.md:11-11', 'CLAUDE.md:15-15'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:3-3'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:5-5'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:7-7'],
    ['CLAUDE.md:11-11', 'CLAUDE.md:9-9'],
  ])
})

it('compares a unit of exactly four tokens, the shortest length that pairs at all', async () => {
  // The floor is four, and a floor is only pinned by the value that sits on
  // it. Three tokens is refused elsewhere; this test checks the other side.
  const audit = modelled('fourtokens', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
    judgePair: picked<PairVerdict>('same_claim', 0.9),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 1, available: 1 })
})

it('compares no structural unit, which asserts nothing that could be contradicted', async () => {
  // A heading or a table header names things; it does not claim anything
  // about them. So it can be neither the duplicate nor the contradiction a
  // pair finding is about. `judgePair` has no reply registered, so a
  // candidate that reached the model would throw rather than pass quietly.
  const audit = modelled('pairs', {
    classify: {
      classifications: [
        classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('structural') }),
        classified('CLAUDE.md:5-5'),
      ],
      failures: [],
    },
  })

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('## pairs: contradicts (0; 0 of 0 judged)')
})

it('asks for evidence about a repository fact and about nothing else', async () => {
  // Only a claim about this repository can be checked against this
  // repository's files. An instruction or a rule is not that kind of claim.
  // `judgeEvidence` has no reply registered, so a unit that reached the model
  // would throw. `available` is the other half of the test: a kind counted
  // but never judged would read as a budget that ran out.
  const audit = modelled('evidence', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3', { kind: picked<UnitKind>('instruction') })],
      failures: [],
    },
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidenceCoverage).toEqual({ judged: 0, available: 0 })
})

it('takes the excerpt from a file a line reference names, not only a bare path', async () => {
  // `docs/retry.md:3` names a file as surely as `docs/retry.md` does, and a
  // writer who cited a line meant that file to be the evidence.
  const audit = modelled('fileline', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
    judgeEvidence: picked<EvidenceVerdict>('contradicts', 0.75),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).evidence.map((entry) => entry.source)).toEqual(['docs/retry.md'])
})

it('carries on when the file a claim names is tracked but not on disk', async () => {
  // `docs/adr/022` resolves against the TRACKED list; it does not read the
  // file itself. So git can name a file the working tree does not hold: a
  // staged deletion, a `git mv` in flight, a sparse checkout. The read must not
  // throw out of the command. That would discard the tier 0 findings and
  // every model call this run has already paid for. `judgeEvidence` has no
  // reply registered, so a unit that still reached the model would throw.
  const audit = modelled('missing', {
    classify: { classifications: [classified('CLAUDE.md:3-3')], failures: [] },
  })
  rmSync(path.join(audit.work, 'docs', 'adr', '022-retry.md'))

  const envelope = await runContext([audit.work, '--json'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  const report = reportOf(audit.stdout())
  expect(report.evidence).toEqual([])
  expect(report.evidenceCoverage).toEqual({ judged: 0, available: 1 })
  expect(report.failures).toEqual([])
})

it('builds no Jev client at all when --no-jev is given and there is a key to spend', async () => {
  // The factory is the assertion. A client that is never constructed marks
  // the difference between a run that spends nothing and one that merely
  // happens to make no call. `scripts/audit.ts` builds the REAL client from
  // whatever key is in the environment. So this is the only place the rule
  // can be held.
  const audit = modelled('paths', {})
  const edges: ContextEdges = {
    ...audit.edges,
    createJev: () => {
      throw new Error('the Jev client was constructed')
    },
  }

  await runContext([audit.work, '--json', '--no-jev'], edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_jev' },
    { stage: 'pairs', reason: 'no_jev' },
    { stage: 'evidence', reason: 'no_jev' },
  ])
})

it('reads an empty TYPESAFE_API_KEY as no key, and builds no client for it either', async () => {
  // An exported variable with nothing in it is what a half-finished setup
  // leaves behind. It is no more a key to spend than an absent one.
  const audit = audited('paths')
  audit.sandbox.env.TYPESAFE_API_KEY = ''
  const edges: ContextEdges = {
    ...audit.edges,
    createJev: () => {
      throw new Error('the Jev client was constructed')
    },
  }

  await runContext([audit.work, '--json'], edges)

  expect(reportOf(audit.stdout()).skipped).toEqual([
    { stage: 'classify', reason: 'no_key' },
    { stage: 'pairs', reason: 'no_key' },
    { stage: 'evidence', reason: 'no_key' },
  ])
})

it('judges no pair at all when --max-pairs is zero, and says how many it passed over', async () => {
  // A budget of nothing is a caller who asks for tier 0 plus the labels. It
  // still has to report what it did not reach. `judgePair` has no reply
  // registered, so a call that happened would throw.
  const ids = [3, 5, 7].map((line) => `CLAUDE.md:${line}-${line}`)
  const audit = modelled('ranked', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
  })

  const envelope = await runContext([audit.work, '--json', '--max-pairs', '0'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(reportOf(audit.stdout()).pairCoverage).toEqual({ judged: 0, available: 3 })
})

it('judges no claim at all when --max-evidence is zero, and says how many it passed over', async () => {
  const audit = modelled('facts', {
    classify: {
      classifications: [classified('CLAUDE.md:3-3'), classified('CLAUDE.md:5-5')],
      failures: [],
    },
  })

  const envelope = await runContext([audit.work, '--json', '--max-evidence', '0'], audit.edges)

  expect(envelope).toEqual({ outcome: 'ok', value: '' })
  expect(reportOf(audit.stdout()).evidenceCoverage).toEqual({ judged: 0, available: 2 })
})

it('breaks a tie between two equally similar candidates by id, not by position in the file', async () => {
  // Two candidates score EXACTLY the same against one unit, because their
  // text is the same. Which of them is judged first is then decided by the
  // order the index was built in. A budget that stops between them buys
  // whichever came first. If the index is built in document order, the same
  // repository answers differently once a unit moves up the file. If it is
  // built in id order, as the spike builds it, the answer belongs to the
  // repository, not to the layout.
  //
  // Both halves of the expected list are load-bearing, and they pin different
  // things. `12-12 <> 3-3` is the identical pair, which the index emits LAST
  // but which stands first here. That is the descending-similarity sort; if
  // the test deleted this pair, this line would move to the end. The two
  // equally scoring pairs behind it are in id order. If the index were built
  // in document order, they would swap.
  const ids = ['3-3', '5-5', '7-7', '10-10', '12-12'].map((line) => `CLAUDE.md:${line}`)
  const audit = modelled('ties', {
    classify: { classifications: ids.map((id) => classified(id)), failures: [] },
    judgePair: picked<PairVerdict>('unrelated'),
  })

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).pairs.map((pair) => [pair.a, pair.b])).toEqual([
    ['CLAUDE.md:12-12', 'CLAUDE.md:3-3'],
    ['CLAUDE.md:10-10', 'CLAUDE.md:12-12'],
    ['CLAUDE.md:10-10', 'CLAUDE.md:3-3'],
  ])
})
