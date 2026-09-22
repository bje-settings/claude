// The audit's own Jev client (#173), built on `typesafe.ts`'s generic
// ask/usage transport. Absorbs the context-audit spike's `questions.ts`
// (#164): the five per-unit judgments, the pair and evidence checks, the
// per_unit/per_section batching, and the answer parsers. Question and
// criterion wording is copied VERBATIM from the spike: it was tuned against
// the live model and every measurement the spike made depends on it staying
// exactly as written.
//
// `plugins/audit/src/types.ts` (layer 2) left the judgment types out on
// purpose, for this file to define, because the client that produces them did
// not exist yet. They are exported here exactly as the spike's `types.ts` had
// them (`Classification`, `ChoiceAnswer`, `Usage`, `UnitKind`, `EvidenceNeed`,
// `PairVerdict`, `EvidenceVerdict`) plus this port's own `RequestShape` and
// `ClassifyOutcome`, both of which the spike defined in `questions.ts` and
// `cli.ts` respectively rather than in its own `types.ts`.
//
// `lib/` cannot import a plugin, so the `Unit` type the client's methods take
// is not `plugins/audit/src/types.ts`'s `Unit`. {@link JevUnit} is the
// minimal structural shape this file actually reads off a unit; the plugin's
// richer `Unit` satisfies it structurally, with no import in either
// direction, the same way `lib/gh.ts` and its callers stay decoupled.
//
// `judgePair` and `judgeEvidence` answer with the bare `ChoiceAnswer`, not the
// spike's `PairJudgment`/`EvidenceJudgment`: those wrapper types carry a
// candidate's ids and similarity, or a unit's source and excerpt, which are
// facts the plugin already has and this file has no reason to duplicate.
// Attaching the verdict to that context is the plugin's job (layer 5).
//
// This file ships. It imports only from `typesafe.ts`, the sibling transport,
// and stays inside the erasable subset (ADR 001).

import {
  type AnswerBag,
  type AnyQuestion,
  choice,
  createJev,
  type Entry,
  JevError,
  noul,
  type QuestionMap,
  type TypeSafeOptions,
} from './typesafe.ts'

export type { AnswerBag, Entry, TypeSafeOptions } from './typesafe.ts'
export { JevError } from './typesafe.ts'

/**
 * The minimal structural input every method here needs off a unit. The
 * plugin's own `Unit` (`plugins/audit/src/types.ts`) carries more fields
 * (`startLine`, `endLine`, `block`, `refs[].kind`, `refs[].resolution`, ...),
 * all of which satisfy this shape structurally with nothing extra to import
 * or cast: TypeScript admits a wider object wherever this narrower one is
 * asked for.
 */
export type JevUnit = {
  readonly id: string
  readonly file: string
  readonly headingPath: readonly string[]
  readonly leadIn: string | null
  readonly prev: string | null
  readonly next: string | null
  readonly text: string
  readonly refs: readonly { readonly value: string }[]
}

export type UnitKind =
  | 'repo_fact'
  | 'external_fact'
  | 'instruction'
  | 'rationale'
  | 'history'
  | 'pointer'
  | 'structural'

export type EvidenceNeed =
  | 'file_exists'
  | 'file_contents'
  | 'config_value'
  | 'github_state'
  | 'nothing_local'

/** A Choice answer in neutral form: the pick, its distribution over every option, and the API's confidence. */
export type ChoiceAnswer<T extends string> = {
  readonly choice: T
  readonly probabilities: Readonly<Record<T, number>>
  readonly confidence: number
}

/** Tier 1's per-unit judgments. Nouls are P(yes). */
export type Classification = {
  readonly unitId: string
  readonly kind: ChoiceAnswer<UnitKind>
  readonly volatile: number
  readonly selfContained: number
  readonly evidenceNeed: ChoiceAnswer<EvidenceNeed>
  readonly multiAssertion: number
}

export type PairVerdict = 'same_claim' | 'contradicts' | 'unrelated'

export type EvidenceVerdict = 'supports' | 'contradicts' | 'says_nothing'

/** What the model calls of a run spent. Structurally identical to
 *  `TypeSafeUsage`; named separately because the contract lives here, not in
 *  the generic transport. */
export type Usage = {
  /** Logical calls: one per `ask`, however many times it was retried. */
  readonly requests: number
  /** HTTP attempts, retries included. */
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  /**
   * The sum of every call's own duration, backoff sleeps included and queue
   * wait excluded. With calls running concurrently this exceeds wall clock.
   */
  readonly requestMsSum: number
}

export type RequestShape = 'per_unit' | 'per_section'

/** One classify() request, ready for the transport's `ask(state, questions)`. */
export type JevRequest = { readonly state: unknown; readonly questions: QuestionMap }

/**
 * What `classify` answers with. A rejected request loses only the units it
 * covered (left out of `classifications`, one failure naming the request); a
 * parse failure on an answer that did arrive loses only that unit (one
 * failure per unit). Ported from the spike's `cli.ts` `classifyUnits`.
 */
export type ClassifyOutcome = {
  readonly classifications: Classification[]
  readonly failures: { readonly id: string; readonly message: string }[]
}

export type JevClient = {
  classify(units: readonly JevUnit[], shape: RequestShape): Promise<ClassifyOutcome>
  judgePair(a: JevUnit, b: JevUnit): Promise<ChoiceAnswer<PairVerdict>>
  judgeEvidence(
    unit: JevUnit,
    source: string,
    excerpt: string,
  ): Promise<ChoiceAnswer<EvidenceVerdict>>
  usage(): Usage
}

/**
 * Conservative on purpose: English prose runs nearer four characters to the
 * token, so three overestimates and the batcher stops early rather than
 * having a request refused for length.
 */
const CHARS_PER_TOKEN = 3

/**
 * Jev 1.13's limits are 64k for the whole request and 32k for the state plus
 * the longest single question (models.md). The spike measured no
 * question-count limit separately: 1,600 questions in one request were
 * accepted, and the 64k token budget refused first, as HTTP 400
 * `max_tokens_exceeded`. These sit well under both budgets: this port would
 * rather send two requests than discover the ceiling in production.
 */
const STATE_TOKEN_BUDGET = 20_000
const REQUEST_TOKEN_BUDGET = 40_000

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The key a unit is known by inside one request, and the stem of every
 * question id about it. Short because it appears in the state of a
 * `per_section` request once per unit, and the docs' own cookbooks use the
 * same `L014`/`B003` trick.
 */
export function shortId(index: number): string {
  return `u${index}`
}

//
// The five per-unit judgments.
//

/**
 * The kind rubric. `repo_fact` and `instruction` are the pair the audit
 * confuses most often, because a repository's CLAUDE.md states rules in both
 * moods within one sentence; `history` and `repo_fact` are the other pair,
 * because a line about a merged pull request looks like a fact about the
 * repository until you ask whether reading the repository today could settle
 * it.
 */
const KIND_CRITERIA: Record<UnitKind, Entry> = {
  repo_fact: {
    what: 'States something that is true of this repository right now: what a file contains, how a tool is configured, what a command does, where something lives.',
    test: 'Someone could settle it by reading a file in this repository today.',
    not_for: 'Telling the reader to do something, and reporting an event that already happened.',
    example:
      '"`pnpm test` runs vitest with coverage." "Coverage thresholds are 100 on four buckets."',
  },
  external_fact: {
    what: 'States something about the world outside this repository: a third-party tool, a language or runtime, a standard, a service, another organisation.',
    test: 'Nothing in this repository could settle it; you would have to consult the other thing.',
    not_for: 'A statement about how this repository uses that outside thing, which is a repo_fact.',
    example: '"pnpm 10 blocks a dependency\'s lifecycle scripts by default."',
  },
  instruction: {
    what: 'Tells the reader what to do, what not to do, or what must happen. Imperative, or normative with words like MUST, NEVER, always, prefer, only.',
    test: 'A reader could obey it or disobey it.',
    not_for: 'A description of what something already does, with no direction to the reader.',
    example: '"Run `pnpm test` before opening a pull request." "NEVER commit with `--no-verify`."',
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
    not_for: 'A present fact about the repository, even one that has been true for a long time.',
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
}

/**
 * Volatile is about what the text says about itself, not about how likely the
 * world is to change. That keeps it a literal question, which is the one kind
 * jev-1.13 is reliable on.
 */
const VOLATILE_CRITERIA = {
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
} as const

/**
 * An earlier version asked whether the statement could be "understood and
 * checked on its own, without the lead-in, the neighbours or the heading
 * path": three conditions folded into one question, plus the word "checked",
 * which dragged the evidence judgment in alongside self-containedness. What
 * is left is one literal test, on words that are in the text or are not.
 */
const SELF_CONTAINED_CRITERIA = {
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
} as const

/**
 * What a checker would have to go and look at. `config_value` and
 * `file_contents` are split on what the claim is about (a named setting
 * against the prose or code of a file) rather than on which file it lives in,
 * because every setting lives in some file and the other split would be
 * empty.
 */
const EVIDENCE_CRITERIA: Record<EvidenceNeed, Entry> = {
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
}

const MULTI_ASSERTION_CRITERIA = {
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
} as const

/**
 * The five questions about one unit. `at` is the state path the question
 * points at, in backticks, which is how the docs say to aim a question at
 * part of a structured state.
 */
function unitQuestions(at: string): Record<string, AnyQuestion> {
  return {
    kind: choice(
      {
        question: `What kind of statement is \`${at}\`?`,
        focus:
          'Judge the statement as written. Use the heading path and the lead-in only to understand what it refers to.',
      },
      KIND_CRITERIA,
    ),
    volatile: noul(
      `Does \`${at}\` name a condition, deadline or pending change that will end, so that the statement stops being true once it does?`,
      VOLATILE_CRITERIA,
    ),
    self_contained: noul(
      `Is everything \`${at}\` talks about named inside \`${at}\` itself, with no word in it pointing at something named only in the lead-in or a neighbouring statement?`,
      SELF_CONTAINED_CRITERIA,
    ),
    evidence: choice(
      {
        question: `To decide whether \`${at}\` is still true, what would someone have to look at?`,
        focus:
          'Pick the one kind of evidence that settles the main claim. If the statement asserts nothing that could be checked, or asserts something no file here could settle, pick nothing_local.',
      },
      EVIDENCE_CRITERIA,
    ),
    multi_assertion: noul(
      `Does \`${at}\` make more than one claim that could be true or false separately?`,
      MULTI_ASSERTION_CRITERIA,
    ),
  }
}

/**
 * `kind__u3`. This id is sent to the API, as the key the answer comes back
 * under; it is not hidden from the request. TypeSafe's own docs say a
 * question's id is for code to reference and is never shown to the model, so
 * it is free to be shaped for the parser alone.
 */
function questionId(judgment: string, sid: string): string {
  return `${judgment}__${sid}`
}

/** The unit as `per_unit` sends it: the contract's fields, minus what the model cannot use. */
function unitState(unit: JevUnit) {
  return {
    file: unit.file,
    heading_path: unit.headingPath,
    lead_in: unit.leadIn,
    prev: unit.prev,
    text: unit.text,
    next: unit.next,
    refs: unit.refs.map((ref) => ref.value),
  }
}

/**
 * The unit as `per_section` sends it. `prev` and `next` are dropped: the
 * neighbours are already siblings in the same state, so repeating them would
 * triple the section's size to say nothing new, and a large state full of
 * repeated detail is the failure mode the jaggedness page names.
 */
function sectionUnitState(unit: JevUnit) {
  const state: Record<string, unknown> = { text: unit.text }
  if (unit.leadIn !== null) state.lead_in = unit.leadIn
  if (unit.refs.length > 0) state.refs = unit.refs.map((ref) => ref.value)
  return state
}

/**
 * Units of one file under one heading path, in document order. `indexes` are
 * positions in the `units` array `batchSections` was called with, and are
 * always a contiguous run of that array: the scan below only ever extends the
 * section it is currently building with the next array position, and starts
 * a new section the moment the key changes, even if that key matches a
 * section from earlier. So the same heading path recurring later in the
 * array never reopens the earlier section and never merges units that are
 * not one another's neighbours in `units`.
 *
 * That guarantee is about the array actually passed in, not about the source
 * document: `batchSections` trusts `units` to already be in true document
 * order.
 */
export type Section = {
  readonly file: string
  readonly headingPath: readonly string[]
  readonly indexes: number[]
}

/**
 * Group units into sections, then split any section whose state would not fit
 * the budget. Splitting keeps document order, so a half section is still a
 * run of neighbours rather than a scatter. The token budgets below apply to
 * one section's own state, never to the whole run: a single unit that alone
 * exceeds `stateTokens` still becomes a one-unit section and is sent by
 * itself rather than dropped or merged.
 */
export function batchSections(
  units: readonly JevUnit[],
  budget: { stateTokens?: number; requestTokens?: number } = {},
): Section[] {
  const stateTokens = budget.stateTokens ?? STATE_TOKEN_BUDGET
  const requestTokens = budget.requestTokens ?? REQUEST_TOKEN_BUDGET
  // The five questions are rewritten per unit, so their cost grows with the
  // section exactly as the state does and has to be counted against the
  // request budget.
  const questionCost = estimateTokens(unitQuestions('units.u0.text'))

  const sections: Section[] = []
  let current: Section | null = null
  let stateSoFar = 0

  const key = (unit: JevUnit) => `${unit.file}\u0000${unit.headingPath.join('\u0000')}`
  let currentKey = ''

  for (const [index, unit] of units.entries()) {
    const cost = estimateTokens(sectionUnitState(unit))
    const nextState = stateSoFar + cost
    const nextCount = (current?.indexes.length ?? 0) + 1
    const fits =
      current !== null &&
      key(unit) === currentKey &&
      nextState <= stateTokens &&
      nextState + questionCost * nextCount <= requestTokens
    if (current !== null && fits) {
      // No gap check here: `current` is only ever created at this loop's own
      // `index`, or extended one array position later than that, so its last
      // entry is always `index - 1` by construction. A guard for anything
      // else would be a branch nothing in this function could ever take.
      current.indexes.push(index)
      stateSoFar += cost
      continue
    }
    current = { file: unit.file, headingPath: unit.headingPath, indexes: [index] }
    currentKey = key(unit)
    stateSoFar = cost
    sections.push(current)
  }
  return sections
}

/**
 * The classification requests for `units`, in either shape. The short id of a
 * unit is its index in `units`, so {@link parseClassification} must be handed
 * the same array.
 */
export function classifyRequest(
  units: readonly JevUnit[],
  shape: RequestShape,
  budget: { stateTokens?: number; requestTokens?: number } = {},
): JevRequest[] {
  if (shape === 'per_unit') {
    return units.map((unit, index) => {
      const questions: Record<string, AnyQuestion> = {}
      for (const [judgment, question] of Object.entries(unitQuestions('text'))) {
        questions[questionId(judgment, shortId(index))] = question
      }
      return { state: unitState(unit), questions }
    })
  }

  return batchSections(units, budget).map((section) => {
    const unitsById: Record<string, unknown> = {}
    const questions: Record<string, AnyQuestion> = {}
    for (const index of section.indexes) {
      // batchSections only ever emits positions of this same array.
      const unit = units[index] as JevUnit
      const sid = shortId(index)
      unitsById[sid] = sectionUnitState(unit)
      for (const [judgment, question] of Object.entries(unitQuestions(`units.${sid}.text`))) {
        questions[questionId(judgment, sid)] = question
      }
    }
    return {
      state: { file: section.file, heading_path: section.headingPath, units: unitsById },
      questions,
    }
  })
}

/**
 * A Noul answer's `noul` is P(yes), so anything outside `[0, 1]` is not a
 * probability and the response cannot be trusted. An array passes
 * `typeof x === 'object'` in JavaScript, so it is excluded explicitly rather
 * than accepted as a weird object with no `noul` property.
 */
function readNoul(bag: AnswerBag, id: string): number {
  const answer = bag[id]
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new Error(`no noul answer under ${id}`)
  }
  const value = (answer as { noul?: unknown }).noul
  if (typeof value !== 'number') {
    throw new Error(`no noul answer under ${id}`)
  }
  // A value is present, so a reader should be pointed at the value that is
  // wrong, not sent looking for a key that is not actually missing.
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`noul answer under ${id} is out of range: ${value}`)
  }
  return value
}

/**
 * `criteria` is the record the question was built from, so its keys are the
 * only options that could ever be chosen: nothing outside this function has
 * to keep a separate options list in sync with it.
 */
function readChoice<T extends string>(
  bag: AnswerBag,
  id: string,
  criteria: Record<T, Entry>,
): ChoiceAnswer<T> {
  const options = Object.keys(criteria) as T[]
  const answer = bag[id]
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new Error(`no choice answer under ${id}`)
  }
  const raw = answer as { choice?: unknown; probabilities?: unknown; confidence?: unknown }
  if (
    typeof raw.choice !== 'string' ||
    typeof raw.confidence !== 'number' ||
    // Same range check readNoul applies to `noul`: a probability is a
    // probability whichever field carries it, so NaN or a value outside
    // [0, 1] is no more trustworthy here than it is there.
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1 ||
    typeof raw.probabilities !== 'object' ||
    raw.probabilities === null ||
    Array.isArray(raw.probabilities)
  ) {
    throw new Error(`no choice answer under ${id}`)
  }
  if (!options.includes(raw.choice as T)) {
    throw new Error(`answer ${id} chose ${raw.choice}, which is not one of the options`)
  }
  const rawProbabilities = raw.probabilities as Record<string, unknown>
  // Jev omits a zero-probability option from the map rather than sending an
  // explicit 0, so an option missing from the response reads as 0, EXCEPT the
  // chosen option itself: an answer that names its own choice but carries no
  // probability for it (or a non-finite one) is not one this code can trust,
  // so that case is refused rather than silently defaulted.
  const probabilities = {} as Record<T, number>
  for (const option of options) {
    const value = rawProbabilities[option]
    if (value === undefined) {
      if (option === raw.choice) {
        throw new Error(`answer ${id} has no probability for its own choice ${raw.choice}`)
      }
      probabilities[option] = 0
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`answer ${id} has a non-finite probability for ${option}`)
    }
    if (value < 0 || value > 1) {
      throw new Error(`answer ${id} has a probability out of range for ${option}: ${value}`)
    }
    probabilities[option] = value
  }
  return { choice: raw.choice as T, probabilities, confidence: raw.confidence }
}

export function parseClassification(
  units: readonly JevUnit[],
  answers: AnswerBag,
): Classification[] {
  return units.map((unit, index) => {
    const sid = shortId(index)
    return {
      unitId: unit.id,
      kind: readChoice(answers, questionId('kind', sid), KIND_CRITERIA),
      volatile: readNoul(answers, questionId('volatile', sid)),
      selfContained: readNoul(answers, questionId('self_contained', sid)),
      evidenceNeed: readChoice(answers, questionId('evidence', sid), EVIDENCE_CRITERIA),
      multiAssertion: readNoul(answers, questionId('multi_assertion', sid)),
    }
  })
}

//
// Pairs.
//

/**
 * The verdict's whole design is the boundary between `same_claim` and
 * `unrelated`. Two units about one subject that say different, compatible
 * things are the common case in a repository's documentation (one names the
 * threshold, the other names the reporter) and calling them the same claim
 * would report every such pair as a duplicate. So `unrelated` explicitly owns
 * that case, and `same_claim` is defined by the deletion test.
 */
const PAIR_CRITERIA: Record<PairVerdict, Entry> = {
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
}

/** The id of the pair question. One question, one request. */
export const PAIR_QUESTION_ID = 'pair'

function pairSide(unit: JevUnit) {
  return { file: unit.file, heading_path: unit.headingPath, text: unit.text }
}

export function pairRequest(a: JevUnit, b: JevUnit): JevRequest {
  return {
    state: { statement_a: pairSide(a), statement_b: pairSide(b) },
    questions: {
      [PAIR_QUESTION_ID]: choice(
        {
          question: 'How does `statement_b` relate to `statement_a`?',
          focus:
            'Compare what the two assert. They come from different places in the documentation, so the same subject is expected; the question is whether either is redundant or wrong.',
        },
        PAIR_CRITERIA,
      ),
    },
  }
}

/**
 * Just the verdict: unlike the spike's `parsePair`, there is no
 * `PairCandidate` to fold in here, since that type stays in the plugin
 * (see this file's header).
 */
export function parsePair(answers: AnswerBag): ChoiceAnswer<PairVerdict> {
  return readChoice(answers, PAIR_QUESTION_ID, PAIR_CRITERIA)
}

//
// Evidence.
//

/**
 * The citation-check cookbook's three options, kept verbatim in meaning: the
 * unit is the claim, the excerpt is the section, and `says_nothing` is what
 * separates a wrong excerpt from a wrong claim.
 */
const EVIDENCE_VERDICT_CRITERIA: Record<EvidenceVerdict, Entry> = {
  supports: 'The excerpt states the claim, or directly implies that it is true.',
  contradicts: 'The excerpt states the opposite of the claim, or implies that it is false.',
  says_nothing: 'The excerpt does not address what the claim asserts, either way.',
}

export const EVIDENCE_QUESTION_ID = 'relation'

export function evidenceRequest(unit: JevUnit, source: string, excerpt: string): JevRequest {
  return {
    state: { claim: unit.text, source, excerpt },
    questions: {
      [EVIDENCE_QUESTION_ID]: choice(
        {
          question: 'How does `excerpt` relate to `claim`?',
          focus:
            'Judge only what `excerpt` contains. Do not use anything you know about the file it came from.',
        },
        EVIDENCE_VERDICT_CRITERIA,
      ),
    },
  }
}

/** Just the verdict, for the reason given on {@link parsePair}. */
export function parseEvidence(answers: AnswerBag): ChoiceAnswer<EvidenceVerdict> {
  return readChoice(answers, EVIDENCE_QUESTION_ID, EVIDENCE_VERDICT_CRITERIA)
}

//
// The client.
//

const CLASSIFICATION_JUDGMENTS = [
  'kind',
  'volatile',
  'self_contained',
  'evidence',
  'multi_assertion',
] as const

/**
 * `JevError`'s own account when it is the rejection reason, or the plain
 * message otherwise. Every failure this function sees was thrown from this
 * file: a rejected request rejects with `typesafe.ts`'s `JevError` (every
 * throw site in `request()`/`ask()` is one), and a caught parse failure is
 * always a plain `Error` from `readChoice` or `readNoul`. There is no third
 * shape to account for, so unlike the spike's `cli.ts` version this has no
 * `String(error)` fallback: that branch nothing here could ever take.
 */
function failureMessage(error: unknown): string {
  if (error instanceof JevError)
    return `HTTP ${error.status}: ${error.message} ${error.body}`.trim()
  return (error as Error).message
}

/**
 * Ported from the spike's `cli.ts` `classifyUnits`: one request per shape's
 * own grouping, settled independently (`Promise.allSettled`), so one bad
 * request never costs the others. A rejected request's answers never land in
 * `bag`, so every unit it covered is silently absent from `classifications`
 * rather than individually failed; the one failure recorded for it names the
 * request, not each unit, because the request is what actually failed. A
 * unit whose answers DID arrive but do not parse (a malformed choice, an
 * out-of-range noul) gets its own failure, named by the unit, since that
 * unit alone is what is wrong.
 */
async function classifyImpl(
  transport: { ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<AnswerBag> },
  units: readonly JevUnit[],
  shape: RequestShape,
): Promise<ClassifyOutcome> {
  const requests = classifyRequest(units, shape)
  const results = await Promise.allSettled(requests.map((r) => transport.ask(r.state, r.questions)))
  const bag: AnswerBag = {}
  const failures: { id: string; message: string }[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') Object.assign(bag, result.value)
    else failures.push({ id: `request ${i}`, message: failureMessage(result.reason) })
  })

  const classifications: Classification[] = []
  units.forEach((unit, i) => {
    if (!(`kind__u${i}` in bag)) return
    const own: AnswerBag = {}
    for (const judgment of CLASSIFICATION_JUDGMENTS)
      own[`${judgment}__u0`] = bag[`${judgment}__u${i}`]
    try {
      classifications.push(...parseClassification([unit], own))
    } catch (error) {
      failures.push({ id: unit.id, message: failureMessage(error) })
    }
  })
  return { classifications, failures }
}

/** A `JevClient` over the `typesafe.ts` transport (`createJev`). */
export function createJevClient(options: TypeSafeOptions): JevClient {
  const transport = createJev(options)
  return {
    classify: (units, shape) => classifyImpl(transport, units, shape),
    judgePair: async (a, b) => {
      const request = pairRequest(a, b)
      return parsePair(await transport.ask(request.state, request.questions))
    },
    judgeEvidence: async (unit, source, excerpt) => {
      const request = evidenceRequest(unit, source, excerpt)
      return parseEvidence(await transport.ask(request.state, request.questions))
    },
    // TypeSafeUsage and Usage are structurally identical; no cast needed.
    usage: () => transport.usage(),
  }
}
