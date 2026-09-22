// The Jev client's own tests (#173). An injected `fetch`, so nothing here
// touches the network and nothing needs a key (`typesafe.test.ts` already
// covers the transport itself: retries, redaction, usage; this file covers
// what `lib/jev.ts` adds on top of it).

import { expect, it } from 'vitest'
import {
  batchSections,
  classifyRequest,
  createJevClient,
  EVIDENCE_QUESTION_ID,
  estimateTokens,
  evidenceRequest,
  PAIR_QUESTION_ID,
  pairRequest,
  parseClassification,
  shortId,
} from './jev.ts'

const KEY = 'sk-test-do-not-log-me'

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function unit(over: Partial<Parameters<typeof jevUnit>[0]> = {}): ReturnType<typeof jevUnit> {
  return jevUnit(over)
}

function jevUnit(over: {
  id?: string
  file?: string
  headingPath?: string[]
  leadIn?: string | null
  prev?: string | null
  next?: string | null
  text?: string
  refs?: { value: string }[]
}) {
  return {
    id: over.id ?? 'CLAUDE.md:1-1',
    file: over.file ?? 'CLAUDE.md',
    headingPath: over.headingPath ?? ['claude', 'Tests'],
    leadIn: over.leadIn ?? null,
    prev: over.prev ?? null,
    next: over.next ?? null,
    text: over.text ?? 'One command per language: `pnpm test` for TypeScript.',
    refs: over.refs ?? [],
  }
}

const CLASSIFICATION_ANSWERS_U0 = {
  kind__u0: {
    type: 'choice',
    choice: 'repo_fact',
    probabilities: { repo_fact: 1 },
    confidence: 0.9,
  },
  volatile__u0: { type: 'noul', noul: 0.1 },
  self_contained__u0: { type: 'noul', noul: 0.9 },
  evidence__u0: {
    type: 'choice',
    choice: 'config_value',
    probabilities: { config_value: 1 },
    confidence: 0.8,
  },
  multi_assertion__u0: { type: 'noul', noul: 0.05 },
}

it('classify of one unit sends the five per-unit questions and parses one Classification', async () => {
  const seen: { body?: string } = {}
  const client = createJevClient({
    apiKey: KEY,
    fetch: async (_url, init) => {
      seen.body = String(init?.body)
      return reply(200, {
        model: 'jev-1.13.0',
        answers: CLASSIFICATION_ANSWERS_U0,
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    },
  })

  const outcome = await client.classify([unit()], 'per_unit')

  const sent = JSON.parse(seen.body ?? '{}')
  expect(Object.keys(sent.questions)).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
  ])
  expect(outcome.failures).toEqual([])
  expect(outcome.classifications).toHaveLength(1)
  expect(outcome.classifications[0]?.unitId).toBe('CLAUDE.md:1-1')
  expect(outcome.classifications[0]?.kind.choice).toBe('repo_fact')
})

// The header comment's "copied VERBATIM from the spike" claim (and
// lib/README.md's "reviewed as a rubric change, not a refactor") is a claim
// about this exact prose, not about the option keys or the question ids
// every other test here already pins. Nothing else in this file would go red
// if one word of one criterion changed, so this test compares the full
// request `classifyRequest` builds against a literal copy of it. A drift here
// means the rubric changed and the pull request needs the review the header
// comment asks for; it does not mean this test is wrong.
it('the five per-unit judgment criteria are the rubric, verbatim', () => {
  const [request] = classifyRequest([unit({ id: 'CLAUDE.md:148-149' })], 'per_unit')

  expect(request?.questions).toEqual({
    kind__u0: {
      type: 'choice',
      instructions: {
        question: 'What kind of statement is `text`?',
        focus:
          'Judge the statement as written. Use the heading path and the lead-in only to understand what it refers to.',
      },
      criteria: {
        repo_fact: {
          what: 'States something that is true of this repository right now: what a file contains, how a tool is configured, what a command does, where something lives.',
          test: 'Someone could settle it by reading a file in this repository today.',
          not_for:
            'Telling the reader to do something, and reporting an event that already happened.',
          example:
            '"`pnpm test` runs vitest with coverage." "Coverage thresholds are 100 on four buckets."',
        },
        external_fact: {
          what: 'States something about the world outside this repository: a third-party tool, a language or runtime, a standard, a service, another organisation.',
          test: 'Nothing in this repository could settle it; you would have to consult the other thing.',
          not_for:
            'A statement about how this repository uses that outside thing, which is a repo_fact.',
          example: '"pnpm 10 blocks a dependency\'s lifecycle scripts by default."',
        },
        instruction: {
          what: 'Tells the reader what to do, what not to do, or what must happen. Imperative, or normative with words like MUST, NEVER, always, prefer, only.',
          test: 'A reader could obey it or disobey it.',
          not_for: 'A description of what something already does, with no direction to the reader.',
          example:
            '"Run `pnpm test` before opening a pull request." "NEVER commit with `--no-verify`."',
        },
        rationale: {
          what: 'Explains why something is the way it is: the reasoning, the trade-off, or the consequence that motivated a decision.',
          test: 'It answers "why", not "what".',
          not_for: 'The decision itself, stated without its reason.',
          example:
            '"A hook that runs everything gets slower as the repository grows, and the response is always to disable it."',
        },
        history: {
          what: 'Reports something that already happened: a merge, a release, a closed issue, a past round of work, a date.',
          test: 'It is about a past event, so it stays true forever and says nothing about the repository as it stands.',
          not_for:
            'A present fact about the repository, even one that has been true for a long time.',
          example: '"PR #139 merged as 81c1bf3." "Round 4 landed on 2026-09-14."',
        },
        pointer: {
          what: 'Sends the reader somewhere else for the content: a cross-reference, a link, a "see X", a statement that something is documented elsewhere.',
          test: 'Remove the destination and nothing is left.',
          not_for: 'A statement that happens to mention a file while making a claim about it.',
          example: '"`CONTRIBUTING.md` says how they install." "See the plugin-marketplaces docs."',
        },
        structural: {
          what: 'Organisational text that carries no claim of its own: a heading, a table header row, a label, a section title, or the line that introduces a list.',
          test: 'On its own it asserts nothing that could be true or false.',
          not_for: 'A short sentence that does make a claim.',
          example: '"### Tests" "| Directory | Contents | GitHub account |"',
        },
      },
    },
    volatile__u0: {
      type: 'noul',
      instructions:
        'Does `text` name a condition, deadline or pending change that will end, so that the statement stops being true once it does?',
      criteria: {
        true: {
          what: 'The statement names a condition, deadline, transition or plan that will end, so the statement stops being true when that condition does.',
          signals: [
            'until #138',
            'for now',
            'not yet',
            'today',
            'currently',
            'planned',
            'is being replaced',
            'is retiring',
            'no repos yet',
            'until then',
          ],
        },
        false: {
          what: 'The statement names no expiring condition of its own. It reads as true independently of any pending change.',
          note: 'A statement can still go out of date later. That is not what this question asks.',
        },
      },
    },
    self_contained__u0: {
      type: 'noul',
      instructions:
        'Is everything `text` talks about named inside `text` itself, with no word in it pointing at something named only in the lead-in or a neighbouring statement?',
      criteria: {
        true: {
          what: 'Every file, tool, rule or person the statement talks about is named inside the statement itself.',
          test: 'There is no "it", "this", "that", "these", "them", "both" or "the same" pointing at something the statement never names.',
          note: 'A pronoun whose referent appears earlier in the SAME statement is fine. "Name the domain it belongs to" names the skill and then says "it", so nothing points outside.',
        },
        false: {
          what: 'At least one thing the statement talks about is named only outside it.',
          signals: [
            'a pronoun standing in for something introduced by an earlier statement',
            'no subject at all: the statement starts with a participle or a verb whose actor is named elsewhere',
            '"the same", "that one", "both of them"',
            'a bare "the X" where X was introduced by the lead-in or the previous statement',
          ],
        },
      },
    },
    evidence__u0: {
      type: 'choice',
      instructions: {
        question: 'To decide whether `text` is still true, what would someone have to look at?',
        focus:
          'Pick the one kind of evidence that settles the main claim. If the statement asserts nothing that could be checked, or asserts something no file here could settle, pick nothing_local.',
      },
      criteria: {
        file_exists: {
          what: 'Knowing whether a path, directory or file is present would settle it. Nothing inside the file matters.',
          covers:
            'A cross-reference that sends the reader to a file: what can go wrong with it is that the file has moved or gone, which is a thing to look at.',
          example:
            '"Every skill directory carries a `FLOW.md` beside its `SKILL.md`." "See `.claude/rules/type-ts.md`."',
        },
        file_contents: {
          what: 'Settling it means reading the text or code inside a file of this repository: what a function does, what a document says, what a test asserts.',
          not_for:
            'A claim about one named setting or version (config_value). A direction to the reader, a heading, a reason, or a fact about a tool that is not part of this repository (nothing_local).',
          example: '"`tests/coverage_check.py` is stdlib-only."',
        },
        config_value: {
          what: 'Settling it means looking up one named setting, key, version, threshold or script in a manifest or configuration file.',
          example: '"The coverage threshold is 100." "The node floor is 22.18."',
        },
        github_state: {
          what: 'The main claim is about GitHub: whether an issue or pull request is open, what merged and when, what a ruleset or label says, who owns a repository.',
          not_for:
            'A claim about this repository\'s own files where an issue number appears only as a deadline or a cross-reference, as in "Python until #138" or "Python until #128, and the skills drive it". The claim is about the files and what they contain; the issue number is an aside, and choosing this option over the file would send the checker to the wrong place.',
          example: '"#138 is still open." "PR #162 merged as 7fbd778."',
        },
        nothing_local: {
          what: 'Nothing in this repository, and nothing on GitHub, could settle it.',
          covers: [
            'a direction to the reader: what to do, what never to do, what to prefer',
            'a heading, a label or a list lead-in, which asserts nothing at all',
            'a reason or an opinion: why a decision was made, what is easier to read',
            'a fact about a tool, language or standard that this repository only uses, such as how git, pnpm or node behave',
          ],
          example:
            '"Keep messages brief." "### Tests" "A squash-merged branch is not an ancestor of anything."',
        },
      },
    },
    multi_assertion__u0: {
      type: 'noul',
      instructions: 'Does `text` make more than one claim that could be true or false separately?',
      criteria: {
        true: {
          what: 'The statement makes more than one claim that could be true or false separately, so a checker would have to check each one.',
          signals: [
            'two clauses joined by "and" or a semicolon that each stand alone',
            'a list of several things inside one sentence',
            'a claim with a second, separable claim attached to it',
          ],
          example:
            '"lefthook.yml holds the steps; CONTRIBUTING.md says how they install." Either half can be wrong on its own.',
        },
        false: {
          what: 'One claim, however long and however much detail it carries.',
          note: 'A date, a count, a version, an identifier, a file name, or a reason introduced by "because" or "so" is part of the single claim it belongs to, not a second claim.',
          example:
            '"The 2.4 release shipped on 12 March as three commits." One event; the version, the date and the count describe it, so there is still one thing to check.',
        },
      },
    },
  })
})

const ONE = unit({
  id: 'CLAUDE.md:148-149',
  text: 'One command per language: `pnpm test` for TypeScript.',
  refs: [{ value: 'pnpm test' }],
})

const TWO = unit({ id: 'CLAUDE.md:150-150', text: '`--locked` as in CI.' })

it('per_section sends one request per heading path, keyed by short id', () => {
  const other = unit({
    id: 'CLAUDE.md:199-199',
    text: 'lefthook, staged-only.',
    headingPath: ['claude', 'Git hooks'],
  })
  const requests = classifyRequest([ONE, TWO, other], 'per_section')

  expect(requests).toHaveLength(2)
  expect(requests[0]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    units: {
      u0: { text: ONE.text, refs: ['pnpm test'] },
      u1: { text: TWO.text },
    },
  })
  expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
    'kind__u1',
    'volatile__u1',
    'self_contained__u1',
    'evidence__u1',
    'multi_assertion__u1',
  ])
  expect(requests[1]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Git hooks'],
    units: { u2: { text: 'lefthook, staged-only.' } },
  })
})

it('per_section questions point at the unit by its backticked path', () => {
  const [request] = classifyRequest([ONE, TWO], 'per_section')
  const questions = request?.questions ?? {}
  const kind = questions.kind__u1 as unknown as { instructions: { question: string } }
  expect(kind.instructions.question).toBe('What kind of statement is `units.u1.text`?')
  const volatile = questions.volatile__u1 as unknown as { instructions: unknown }
  expect(String(volatile.instructions)).toMatch(/`units\.u1\.text`/)
})

it('a lead-in rides along only when the unit has one', () => {
  const led = unit({ id: 'a:1-1', text: 'ruff', leadIn: 'The required checks are:' })
  const [request] = classifyRequest([led], 'per_section')
  const state = (request as { state: { units: object } }).state
  expect(state.units).toEqual({
    u0: { text: 'ruff', lead_in: 'The required checks are:' },
  })
})

it('batchSections splits a section that does not fit', () => {
  const big = Array.from({ length: 6 }, (_, i) =>
    unit({ id: `CLAUDE.md:${i}-${i}`, text: 'x'.repeat(300), headingPath: ['one'] }),
  )
  // 300 characters is 100 tokens at the conservative estimate, so a 250-token
  // state budget holds two units and refuses the third.
  const sections = batchSections(big, { stateTokens: 250, requestTokens: 1_000_000 })
  expect(sections.map((section) => section.indexes)).toEqual([
    [0, 1],
    [2, 3],
    [4, 5],
  ])
})

it('batchSections splits when the repeated questions blow the request budget', () => {
  const many = Array.from({ length: 4 }, (_, i) =>
    unit({ id: `a:${i}-${i}`, text: 'short', headingPath: ['one'] }),
  )
  const sections = batchSections(many, { stateTokens: 1_000_000, requestTokens: 900 })
  expect(sections.length).toBeGreaterThan(1)
  expect(sections.flatMap((section) => section.indexes)).toEqual([0, 1, 2, 3])
})

it('a section landing exactly on stateTokens still includes the unit, and one token over splits it', () => {
  // `fits` requires `nextState <= stateTokens`: an off-by-one that used `<`
  // instead would start a new section one unit earlier than the budget
  // allows. u1's state costs 4 tokens, u2's costs 5 (JSON.stringify({text})
  // over CHARS_PER_TOKEN=3, both exact divisions so there is no rounding to
  // obscure the boundary), so their sum lands exactly on stateTokens: 9.
  const u1 = unit({ id: 'a:1-1', text: 'a', headingPath: ['one'] })
  const u2 = unit({ id: 'a:2-2', text: 'bb', headingPath: ['one'] })

  const onBudget = batchSections([u1, u2], { stateTokens: 9, requestTokens: 1_000_000 })
  expect(onBudget.map((section) => section.indexes)).toEqual([[0, 1]])

  const oneOver = batchSections([u1, u2], { stateTokens: 8, requestTokens: 1_000_000 })
  expect(oneOver.map((section) => section.indexes)).toEqual([[0], [1]])
})

it('the section key includes the file: a shared heading path across files still splits', () => {
  const lastOfA = unit({
    id: 'a.md:9-9',
    file: 'a.md',
    text: 'last unit of a.md',
    headingPath: ['Setup'],
  })
  const firstOfB = unit({
    id: 'b.md:1-1',
    file: 'b.md',
    text: 'first unit of b.md',
    headingPath: ['Setup'],
  })
  const sections = batchSections([lastOfA, firstOfB])
  expect(sections.map((section) => ({ file: section.file, indexes: section.indexes }))).toEqual([
    { file: 'a.md', indexes: [0] },
    { file: 'b.md', indexes: [1] },
  ])
})

it('units that share a key but are not neighbours in the array are not merged', () => {
  const first = unit({ id: 'a:1-1', text: 'first', headingPath: ['one'] })
  const between = unit({ id: 'a:2-2', text: 'between', headingPath: ['two'] })
  const later = unit({ id: 'a:3-3', text: 'later, same heading as first', headingPath: ['one'] })

  const sections = batchSections([first, between, later])

  expect(sections.map((section) => section.indexes)).toEqual([[0], [1], [2]])
})

it('a single unit over budget is still sent alone, never dropped or merged', () => {
  const oversized = unit({ id: 'a:1-1', text: 'x'.repeat(3_000), headingPath: ['one'] })
  const sections = batchSections([oversized], { stateTokens: 10, requestTokens: 10 })
  expect(sections).toEqual([{ file: 'CLAUDE.md', headingPath: ['one'], indexes: [0] }])
})

it('estimateTokens is conservative about prose', () => {
  expect(estimateTokens('abc')).toBe(1)
  expect(estimateTokens('a'.repeat(300))).toBe(100)
  expect(estimateTokens({ a: 'bb' })).toBe(Math.ceil('{"a":"bb"}'.length / 3))
})

it('estimateTokens treats a value JSON.stringify cannot render as zero-length text', () => {
  // JSON.stringify(undefined) is the actual value `undefined`, not a string,
  // which is the `?? ''` branch: not the same as estimateTokens('undefined').
  expect(estimateTokens(undefined)).toBe(0)
})

it('shortId is the unit index', () => {
  expect(shortId(0)).toBe('u0')
  expect(shortId(11)).toBe('u11')
})

it('pairRequest carries both units and one question', () => {
  const b = unit({
    id: 'plugins/gh/README.md:310-310',
    file: 'plugins/gh/README.md',
    headingPath: ['gh', 'Requirements'],
    text: 'It needs node 22.18 or newer.',
  })

  const request = pairRequest(ONE, b)

  expect(request.state).toEqual({
    statement_a: {
      file: 'CLAUDE.md',
      heading_path: ['claude', 'Tests'],
      text: 'One command per language: `pnpm test` for TypeScript.',
    },
    statement_b: {
      file: 'plugins/gh/README.md',
      heading_path: ['gh', 'Requirements'],
      text: 'It needs node 22.18 or newer.',
    },
  })
  expect(Object.keys(request.questions)).toEqual([PAIR_QUESTION_ID])
  const question = request.questions[PAIR_QUESTION_ID] as unknown as {
    type: string
    criteria: object
    instructions: { question: string }
  }
  expect(question.type).toBe('choice')
  expect(Object.keys(question.criteria)).toEqual(['same_claim', 'contradicts', 'unrelated'])
  expect(question.instructions.question).toMatch(/`statement_a`/)
})

// PAIR_QUESTION_ID is the literal string sent to the API as the answer key;
// every other test reaches it only through the exported constant, which
// would still equal itself if the two ids (this one and
// EVIDENCE_QUESTION_ID) were swapped. Pinning the literal value here is what
// would catch that swap.
it('the pair question id is the literal string "pair"', () => {
  expect(PAIR_QUESTION_ID).toBe('pair')
})

it('the pair criteria are the rubric, verbatim', () => {
  const request = pairRequest(ONE, TWO)

  expect(request.questions).toEqual({
    pair: {
      type: 'choice',
      instructions: {
        question: 'How does `statement_b` relate to `statement_a`?',
        focus:
          'Compare what the two assert. They come from different places in the documentation, so the same subject is expected; the question is whether either is redundant or wrong.',
      },
      criteria: {
        same_claim: {
          what: 'Both statements assert the same thing about the same subject.',
          test: 'One of the two could be deleted and no information would be lost. A reader who had only one would know everything both say.',
          not_for:
            'Two statements about one subject that assert different things, even when both are true.',
          example:
            '"The node floor is 22.18." against "This needs node 22.18 or newer." Same subject, same assertion, either one suffices.',
        },
        contradicts: {
          what: 'Both statements are about the same subject and they cannot both be true.',
          test: 'Acting on one would violate the other.',
          not_for: 'Statements that differ in detail or scope but can hold at once.',
          example: '"Coverage is gated at 100." against "Coverage is gated at 95."',
        },
        unrelated: {
          what: 'Either the two statements are about different subjects, or they are about the same subject and assert different things that are both true at once.',
          test: 'Deleting either one would lose something.',
          example:
            '"`lefthook.yml` holds the steps." against "`CONTRIBUTING.md` says how the hooks install." Both about git hooks, neither redundant.',
        },
      },
    },
  })
})

it('judgePair sends the pair request and answers with the verdict alone', async () => {
  const seen: { body?: string } = {}
  const client = createJevClient({
    apiKey: KEY,
    fetch: async (_url, init) => {
      seen.body = String(init?.body)
      return reply(200, {
        model: 'x',
        answers: {
          [PAIR_QUESTION_ID]: {
            type: 'choice',
            choice: 'same_claim',
            probabilities: { same_claim: 0.8, contradicts: 0.05, unrelated: 0.15 },
            confidence: 0.72,
          },
        },
        usage: {},
      })
    },
  })

  const verdict = await client.judgePair(ONE, TWO)

  const sent = JSON.parse(seen.body ?? '{}')
  expect(Object.keys(sent.questions)).toEqual([PAIR_QUESTION_ID])
  expect(verdict).toEqual({
    choice: 'same_claim',
    probabilities: { same_claim: 0.8, contradicts: 0.05, unrelated: 0.15 },
    confidence: 0.72,
  })
})

it('evidenceRequest is the citation check, exactly', () => {
  const request = evidenceRequest(ONE, 'package.json', '"test": "vitest run --coverage"')

  expect(request.state).toEqual({
    claim: 'One command per language: `pnpm test` for TypeScript.',
    source: 'package.json',
    excerpt: '"test": "vitest run --coverage"',
  })
  expect(Object.keys(request.questions)).toEqual([EVIDENCE_QUESTION_ID])
  const question = request.questions[EVIDENCE_QUESTION_ID] as unknown as { criteria: object }
  expect(Object.keys(question.criteria)).toEqual(['supports', 'contradicts', 'says_nothing'])
})

it('the evidence question id is the literal string "relation"', () => {
  expect(EVIDENCE_QUESTION_ID).toBe('relation')
})

it('the evidence-verdict criteria are the rubric, verbatim', () => {
  const request = evidenceRequest(ONE, 'package.json', 'excerpt text')

  expect(request.questions).toEqual({
    relation: {
      type: 'choice',
      instructions: {
        question: 'How does `excerpt` relate to `claim`?',
        focus:
          'Judge only what `excerpt` contains. Do not use anything you know about the file it came from.',
      },
      criteria: {
        supports: 'The excerpt states the claim, or directly implies that it is true.',
        contradicts: 'The excerpt states the opposite of the claim, or implies that it is false.',
        says_nothing: 'The excerpt does not address what the claim asserts, either way.',
      },
    },
  })
})

it('judgeEvidence sends the evidence request and answers with the verdict alone', async () => {
  const seen: { body?: string } = {}
  const client = createJevClient({
    apiKey: KEY,
    fetch: async (_url, init) => {
      seen.body = String(init?.body)
      return reply(200, {
        model: 'x',
        answers: {
          [EVIDENCE_QUESTION_ID]: {
            type: 'choice',
            choice: 'supports',
            probabilities: { supports: 0.97, contradicts: 0.01, says_nothing: 0.02 },
            confidence: 0.95,
          },
        },
        usage: {},
      })
    },
  })

  const verdict = await client.judgeEvidence(ONE, 'package.json', '"test": "vitest run --coverage"')

  const sent = JSON.parse(seen.body ?? '{}')
  expect(sent.state).toEqual({
    claim: ONE.text,
    source: 'package.json',
    excerpt: '"test": "vitest run --coverage"',
  })
  expect(verdict.choice).toBe('supports')
  expect(verdict.confidence).toBe(0.95)
})

it("usage() passes through the transport's own totals", async () => {
  const client = createJevClient({
    apiKey: KEY,
    fetch: async () =>
      reply(200, { model: 'x', answers: classificationReply(0), usage: { input_tokens: 5 } }),
  })

  expect(client.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
  await client.classify([unit()], 'per_unit')
  expect(client.usage().requests).toBe(1)
  expect(client.usage().inputTokens).toBe(5)
})

it('per_unit sends one request per unit, with that unit as the whole state', () => {
  const requests = classifyRequest([ONE, TWO], 'per_unit')

  expect(requests).toHaveLength(2)
  expect(requests[0]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    lead_in: null,
    prev: null,
    text: 'One command per language: `pnpm test` for TypeScript.',
    next: null,
    refs: ['pnpm test'],
  })
  expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
  ])
  expect(Object.keys(requests[1]?.questions ?? {})).toEqual([
    'kind__u1',
    'volatile__u1',
    'self_contained__u1',
    'evidence__u1',
    'multi_assertion__u1',
  ])
})

it('parseClassification reads a canned response into the contract type', () => {
  const answers = {
    kind__u0: {
      type: 'choice',
      choice: 'repo_fact',
      probabilities: { repo_fact: 0.7, instruction: 0.3 },
      confidence: 0.62,
    },
    volatile__u0: { type: 'noul', noul: 0.12 },
    self_contained__u0: { type: 'noul', noul: 0.88 },
    evidence__u0: {
      type: 'choice',
      choice: 'config_value',
      probabilities: { config_value: 0.9, file_contents: 0.1 },
      confidence: 0.85,
    },
    multi_assertion__u0: { type: 'noul', noul: 0.04 },
  }

  const [parsed] = parseClassification([ONE], answers)

  expect(parsed?.unitId).toBe('CLAUDE.md:148-149')
  expect(parsed?.kind.choice).toBe('repo_fact')
  expect(parsed?.kind.confidence).toBe(0.62)
  // Options the response left out come back as 0, so the record is total.
  expect(parsed?.kind.probabilities).toEqual({
    repo_fact: 0.7,
    external_fact: 0,
    instruction: 0.3,
    rationale: 0,
    history: 0,
    pointer: 0,
    structural: 0,
  })
  expect(parsed?.volatile).toBe(0.12)
  expect(parsed?.selfContained).toBe(0.88)
  expect(parsed?.evidenceNeed.choice).toBe('config_value')
  expect(parsed?.multiAssertion).toBe(0.04)
})

const GOOD_ANSWERS = {
  kind__u0: { type: 'choice', choice: 'repo_fact', probabilities: { repo_fact: 1 }, confidence: 1 },
  volatile__u0: { type: 'noul', noul: 0 },
  self_contained__u0: { type: 'noul', noul: 0 },
  evidence__u0: {
    type: 'choice',
    choice: 'config_value',
    probabilities: { config_value: 1 },
    confidence: 1,
  },
  multi_assertion__u0: { type: 'noul', noul: 0 },
}

it('parseClassification refuses an answer of the wrong type or an unknown option', () => {
  expect(() =>
    parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul' } }),
  ).toThrow(/no noul answer/)
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, kind__u0: undefined })).toThrow(
    /no choice answer/,
  )
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { ...GOOD_ANSWERS.kind__u0, choice: 'invented' },
    }),
  ).toThrow(/not one of the options/)
})

it('a noul outside 0 to 1 is refused, not clamped, and reported as out of range', () => {
  expect(() =>
    parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul', noul: 1.5 } }),
  ).toThrow(/out of range: 1\.5/)
})

it('a non-finite noul is reported as out of range too, not as missing', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      volatile__u0: { type: 'noul', noul: Number.NaN },
    }),
  ).toThrow(/out of range/)
})

it('a negative noul is refused too, not just one above 1', () => {
  // readNoul's range check is `value < 0 || value > 1`: every other test of
  // this branch uses a value above 1, so a regression that dropped the lower
  // half of the check (a plausible "simplify the condition" mistake) would
  // pass unnoticed without this.
  expect(() =>
    parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul', noul: -0.1 } }),
  ).toThrow(/out of range: -0\.1/)
})

it('an array does not pass readChoice as an object', () => {
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, kind__u0: ['repo_fact'] })).toThrow(
    /no choice answer/,
  )
})

it('an array does not pass readNoul as an object', () => {
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: [0.5] })).toThrow(
    /no noul answer/,
  )
})

it('a choice missing the probability for its own answer is refused, not defaulted to 0', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { type: 'choice', choice: 'repo_fact', probabilities: {}, confidence: 1 },
    }),
  ).toThrow(/no probability for its own choice repo_fact/)
})

it('a non-finite probability on a non-chosen option is refused', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: {
        type: 'choice',
        choice: 'repo_fact',
        probabilities: { repo_fact: 1, instruction: Number.NaN },
        confidence: 1,
      },
    }),
  ).toThrow(/non-finite probability for instruction/)
})

it('a NaN confidence is refused, not passed through as a valid number', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { ...GOOD_ANSWERS.kind__u0, confidence: Number.NaN },
    }),
  ).toThrow(/no choice answer/)
})

it('a negative confidence is refused too, not just one above 1', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { ...GOOD_ANSWERS.kind__u0, confidence: -0.01 },
    }),
  ).toThrow(/no choice answer/)
})

it('a negative probability is refused too, not just one above 1', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: {
        type: 'choice',
        choice: 'repo_fact',
        probabilities: { repo_fact: -1 },
        confidence: 1,
      },
    }),
  ).toThrow(/probability out of range for repo_fact: -1/)
})

function classificationReply(index: number, kindChoice: 'repo_fact' | 'instruction' = 'repo_fact') {
  return {
    [`kind__u${index}`]: {
      type: 'choice',
      choice: kindChoice,
      probabilities: { [kindChoice]: 1 },
      confidence: 0.9,
    },
    [`volatile__u${index}`]: { type: 'noul', noul: 0.1 },
    [`self_contained__u${index}`]: { type: 'noul', noul: 0.9 },
    [`evidence__u${index}`]: {
      type: 'choice',
      choice: 'config_value',
      probabilities: { config_value: 1 },
      confidence: 0.8,
    },
    [`multi_assertion__u${index}`]: { type: 'noul', noul: 0.05 },
  }
}

it('a rejected request loses only its own units, and the failure names the request', async () => {
  // per_unit sends one request per unit, so a failure on the first request
  // must not cost the second unit's own request, made in parallel.
  let calls = 0
  const client = createJevClient({
    apiKey: KEY,
    maxRetries: 0,
    fetch: async () => {
      calls += 1
      if (calls === 1) return reply(400, 'refused: bad question')
      return reply(200, { model: 'x', answers: classificationReply(1), usage: {} })
    },
  })

  const outcome = await client.classify([unit({ id: 'a' }), unit({ id: 'b' })], 'per_unit')

  expect(outcome.classifications).toHaveLength(1)
  expect(outcome.classifications[0]?.unitId).toBe('b')
  // '400' alone would also match the JevError's own default message ("...HTTP
  // 400"), which failureMessage's template string carries regardless of
  // whether it also appends error.body; asserting the response's own text is
  // what actually pins that the append happens.
  expect(outcome.failures).toEqual([
    { id: 'request 0', message: expect.stringContaining('refused: bad question') },
  ])
})

it('classify(units, "per_section") batches both units into one request and splits the answers back out', async () => {
  // Every other client.classify() call in this file passes 'per_unit'; shape
  // is otherwise only exercised at the classifyRequest() builder level. This
  // proves createJevClient actually forwards `shape` through to the request
  // it sends, rather than silently always building per_unit requests.
  //
  // u0 and u1 are given DIFFERENT `kind` choices on purpose: identical
  // answers for both units would let a swapped-index bug (unit 'a' reading
  // u1's bag entries, unit 'b' reading u0's) pass, since `unitId` comes from
  // the `units` array itself regardless of which bag entries were pulled for
  // it. Asserting the choice by unitId, not just which ids are present, is
  // what would catch that swap.
  const seen: { body?: string } = {}
  const client = createJevClient({
    apiKey: KEY,
    fetch: async (_url, init) => {
      seen.body = String(init?.body)
      return reply(200, {
        model: 'x',
        answers: {
          ...classificationReply(0, 'repo_fact'),
          ...classificationReply(1, 'instruction'),
        },
        usage: {},
      })
    },
  })

  const outcome = await client.classify([unit({ id: 'a' }), unit({ id: 'b' })], 'per_section')

  const sent = JSON.parse(seen.body ?? '{}')
  // One request, not two: both units share the default heading path.
  expect(sent.state.units).toEqual(
    expect.objectContaining({ u0: expect.anything(), u1: expect.anything() }),
  )
  expect(outcome.failures).toEqual([])
  expect(outcome.classifications).toHaveLength(2)
  expect(outcome.classifications.map((c) => c.unitId).sort()).toEqual(['a', 'b'])
  const byId = new Map(outcome.classifications.map((c) => [c.unitId, c]))
  expect(byId.get('a')?.kind.choice).toBe('repo_fact')
  expect(byId.get('b')?.kind.choice).toBe('instruction')
})

it('a parse failure on an answer that arrived records one failure naming the unit', async () => {
  const client = createJevClient({
    apiKey: KEY,
    fetch: async () =>
      reply(200, {
        model: 'x',
        // A malformed volatile answer: out of range.
        answers: { ...classificationReply(0), volatile__u0: { type: 'noul', noul: 7 } },
        usage: {},
      }),
  })

  const outcome = await client.classify([unit({ id: 'bad-unit' })], 'per_unit')

  expect(outcome.classifications).toEqual([])
  expect(outcome.failures).toEqual([
    { id: 'bad-unit', message: expect.stringMatching(/out of range/) },
  ])
})

it('a probability of 42 is refused, not accepted as a raw score', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: {
        type: 'choice',
        choice: 'repo_fact',
        probabilities: { repo_fact: 42 },
        confidence: 1,
      },
    }),
  ).toThrow(/probability out of range for repo_fact: 42/)
})
