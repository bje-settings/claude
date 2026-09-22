// Candidate pairing for the context audit (#164, #174): the units worth asking
// the model to compare, chosen with no model call. Lexical only (TF-IDF,
// cosine), which is cheap enough to run over every unit and precise enough to
// be worth a second look; deciding whether two units actually agree or
// contradict is the model's job, not this file's.
//
// The port of the spike's `candidates.ts`. Reached only through
// `commands/context.ts`, which is where its behaviour is asserted: a candidate
// is not an answer anybody consumes on its own.

import type { Unit } from './types.ts'

/** Two units worth comparing, `a < b` by id. */
export type PairCandidate = { a: string; b: string; similarity: number }

const DEFAULT_THRESHOLD = 0.5

/** How many pairs one unit may appear in, on either side. A unit that says
 *  nearly what a dozen others say is worth a second look a few times over,
 *  and the twelfth call buys nothing the first few did not. */
const MAX_PER_UNIT = 5

/** A unit shorter than this, in tokens, is never paired: there is not enough
 *  text for a shared-vocabulary match to mean anything, and a short line
 *  ("See below.") would otherwise pair with everything that happens to share
 *  one common word. */
const MIN_TOKENS = 4

/** A short, generic list: articles, conjunctions and the like. Domain words
 *  ("plugin", "test", "issue") are left in on purpose, because `idf` already
 *  discounts whatever turns out to be common in a given corpus; a longer
 *  hand-picked list here would be tuned to one repository's own prose. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'to',
  'was',
  'were',
  'which',
  'with',
])

/**
 * `text` as a token list: a backticked code span's content is kept as one
 * lowercased token (so `` `lib/git.ts` `` is a single term, not three), and
 * the remaining prose is lowercased, split on word boundaries and filtered
 * against {@link STOPWORDS}.
 */
const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  const prose = text.replace(/`([^`]+)`/g, (_, code: string) => {
    tokens.push(code.toLowerCase())
    return ' '
  })
  for (const word of prose.toLowerCase().match(/[a-z0-9]+(?:[-'_][a-z0-9]+)*/g) ?? []) {
    if (!STOPWORDS.has(word)) tokens.push(word)
  }
  return tokens
}

/** A table row's grouping key: same file, same heading path. Two rows with
 *  that key and identical text are one column value repeated down a table
 *  rather than duplicated content, so a pair between them is dropped whatever
 *  their similarity. Any other block kind gets `null`, which is never treated
 *  as equal to another `null`: two rows under DIFFERENT headings get different
 *  keys and so still pair. */
const tableGroup = (unit: Unit): string | null =>
  unit.block === 'table_row' ? `${unit.file}\u0000${unit.headingPath.join('>')}` : null

/** Two rows of one table holding the same value. */
const repeatedCell = (unit: Unit, other: Unit): boolean => {
  if (unit.text !== other.text) return false
  const group = tableGroup(unit)
  return group !== null && group === tableGroup(other)
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/** The dot product of two token-weight maps, iterating the smaller one: both
 *  vectors are already L2-normalised below, so this dot product IS the cosine
 *  similarity. */
const dot = (a: Map<string, number>, b: Map<string, number>): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) sum += weight * other
  }
  return sum
}

/** Each unit's L2-normalised TF-IDF vector, keyed by id.
 *
 *  The idf is smoothed (`+1` on both sides and on the result): a token in
 *  every unit still gets a small positive weight rather than exactly zero,
 *  which keeps a unit made entirely of very common tokens comparable at all
 *  instead of vanishing to a zero vector. */
const vectorsOf = (tokensByUnit: Map<string, string[]>): Map<string, Map<string, number>> => {
  const documentFrequency = new Map<string, number>()
  for (const tokens of tokensByUnit.values()) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const corpusSize = tokensByUnit.size
  const idf = new Map<string, number>()
  for (const [token, count] of documentFrequency) {
    idf.set(token, Math.log((corpusSize + 1) / (count + 1)) + 1)
  }

  const vectors = new Map<string, Map<string, number>>()
  for (const [id, tokens] of tokensByUnit) {
    const termFrequency = new Map<string, number>()
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    const weights = new Map<string, number>()
    let normSquared = 0
    for (const [token, count] of termFrequency) {
      // Every token counted here was counted into `documentFrequency` first.
      const weight = count * (idf.get(token) as number)
      weights.set(token, weight)
      normSquared += weight * weight
    }
    // A unit of at least four tokens has at least one non-zero weight, so the
    // norm is never zero and there is nothing to guard against here.
    const norm = Math.sqrt(normSquared)
    for (const [token, weight] of weights) weights.set(token, weight / norm)
    vectors.set(id, weights)
  }
  return vectors
}

/**
 * Candidate pairs of similar units, lexical only, chosen before any model
 * call.
 *
 * Never pairs a unit with itself, emits each pair once (`a < b` by id), skips
 * a unit under {@link MIN_TOKENS} tokens entirely, drops a cell repeated down
 * one table ({@link repeatedCell}), and lets no unit appear in more than
 * {@link MAX_PER_UNIT} pairs.
 */
export const candidatePairs = (
  units: readonly Unit[],
  opts: { threshold?: number } = {},
): PairCandidate[] => {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD

  const tokensByUnit = new Map<string, string[]>()
  const eligible: Unit[] = []
  for (const unit of units) {
    const tokens = tokenize(unit.text)
    if (tokens.length < MIN_TOKENS) continue
    tokensByUnit.set(unit.id, tokens)
    eligible.push(unit)
  }
  const vectors = vectorsOf(tokensByUnit)
  // Sorted for a deterministic processing order: which unit is the query side
  // first decides which pairs fill a cap up.
  eligible.sort((a, b) => (a.id < b.id ? -1 : 1))

  const seen = new Set<string>()
  const taken = new Map<string, number>()
  const countOf = (id: string): number => taken.get(id) ?? 0
  const pairs: PairCandidate[] = []

  for (const unit of eligible) {
    if (countOf(unit.id) >= MAX_PER_UNIT) continue
    const vector = vectors.get(unit.id) as Map<string, number>
    const scored: Array<{ other: Unit; similarity: number }> = []
    for (const other of eligible) {
      if (other.id === unit.id) continue
      if (seen.has(pairKey(unit.id, other.id))) continue
      const similarity = dot(vector, vectors.get(other.id) as Map<string, number>)
      if (similarity < threshold) continue
      if (repeatedCell(unit, other)) continue
      scored.push({ other, similarity })
    }
    scored.sort((x, y) => y.similarity - x.similarity)

    for (const candidate of scored) {
      // Both counts are re-read here rather than in `scored`: earlier turns of
      // this same loop change them.
      if (countOf(unit.id) >= MAX_PER_UNIT) break
      if (countOf(candidate.other.id) >= MAX_PER_UNIT) continue
      seen.add(pairKey(unit.id, candidate.other.id))
      taken.set(unit.id, countOf(unit.id) + 1)
      taken.set(candidate.other.id, countOf(candidate.other.id) + 1)
      const [a, b] =
        unit.id < candidate.other.id ? [unit.id, candidate.other.id] : [candidate.other.id, unit.id]
      pairs.push({ a, b, similarity: candidate.similarity })
    }
  }
  return pairs
}
