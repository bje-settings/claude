// Candidate pairing for the context audit (#164): find units worth asking a
// model to compare, with no model call. Lexical only (TF-IDF, cosine), which
// is cheap enough to run over every unit and precise enough to be worth a
// second look; deciding whether two units actually agree or contradict is
// tier 1's job, not this file's.
//
// This is the spike's own tooling: node built-ins only, no dependency on the
// rest of the repository.

import type { PairCandidate, Unit } from './types.ts'

const DEFAULT_THRESHOLD = 0.5
const DEFAULT_MAX_PER_UNIT = 5

/** A unit shorter than this, in tokens, is never paired: there is not enough
 *  text for a shared-vocabulary match to mean anything, and a short
 *  structural line ("See below.") would otherwise pair with everything that
 *  happens to share one common word. */
const MIN_TOKENS = 4

/**
 * The document-frequency ceiling for a token to drive candidate lookup.
 * `candidatePairs` still WEIGHTS a token above this cap (its `idf` is just
 * small), it only stops using it to find OTHER units to compare against: a
 * token in a quarter of the corpus has a postings list nearly as long as the
 * corpus itself, and scanning it for every query unit is most of the way
 * back to the full O(n^2) comparison this module exists to avoid.
 */
const POSTINGS_DF_CAP = 200

/** A short, generic list: articles, conjunctions and the like. Domain words
 *  ("plugin", "test", "issue") are left in on purpose, because `idf` already
 *  discounts whatever turns out to be common in a given corpus; a longer
 *  hand-picked list here would be tuned to this repository's own prose. */
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

/** A table_row unit's grouping key: same file, same heading path. Two rows
 *  with that key and identical text are the same column value repeated
 *  down a table, not duplicated content, so a pair between them is dropped
 *  regardless of similarity. Any other block kind (or two rows from
 *  different tables) gets `null`, which never equals another `null` here. */
const tableGroup = (unit: Unit): string | null =>
  unit.block === 'table_row' ? `${unit.file}\u0000${unit.headingPath.join('>')}` : null

/** The dot product of two token-weight maps, iterating the smaller one:
 *  both vectors are already L2-normalised by the caller, so this dot
 *  product IS the cosine similarity. */
const dot = (a: Map<string, number>, b: Map<string, number>): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) sum += weight * other
  }
  return sum
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/**
 * Candidate pairs of similar units, lexical only, chosen before any model
 * call. Built from an inverted index over tokens below {@link POSTINGS_DF_CAP},
 * so scoring stays proportional to the vocabulary actually shared between
 * units rather than to every pair in the corpus: for n = 5,000 short units
 * this compares each unit against its co-occurring neighbours, not against
 * the other 4,999.
 *
 * Never pairs a unit with itself, emits each pair once (`a < b` by id), skips
 * a unit under {@link MIN_TOKENS} tokens entirely, and drops a pair whose two
 * texts are identical AND both rows of the same table in the same file
 * ({@link tableGroup}) since a repeated cell value is not duplication.
 */
export const candidatePairs = (
  units: Unit[],
  opts: { threshold?: number; maxPerUnit?: number } = {},
): PairCandidate[] => {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const maxPerUnit = opts.maxPerUnit ?? DEFAULT_MAX_PER_UNIT

  const eligible = units.filter((unit) => tokenize(unit.text).length >= MIN_TOKENS)
  // Sorted for a deterministic processing order: which unit is the "query"
  // side first affects which pairs fill up first when `maxPerUnit` is tight.
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const tokensByUnit = new Map<string, string[]>()
  const unitsById = new Map<string, Unit>()
  for (const unit of eligible) {
    tokensByUnit.set(unit.id, tokenize(unit.text))
    unitsById.set(unit.id, unit)
  }

  const documentFrequency = new Map<string, number>()
  for (const tokens of tokensByUnit.values()) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const corpusSize = eligible.length
  // Smoothed idf (`+1` on both sides and on the result): a token in every
  // unit still gets a small positive weight rather than exactly zero, which
  // keeps a unit made entirely of very common tokens comparable at all
  // instead of vanishing to a zero vector.
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
      const weight = count * (idf.get(token) ?? 0)
      weights.set(token, weight)
      normSquared += weight * weight
    }
    const norm = Math.sqrt(normSquared) || 1
    for (const [token, weight] of weights) weights.set(token, weight / norm)
    vectors.set(id, weights)
  }

  const postings = new Map<string, string[]>()
  for (const [id, tokens] of tokensByUnit) {
    for (const token of new Set(tokens)) {
      if ((documentFrequency.get(token) ?? 0) > POSTINGS_DF_CAP) continue
      const list = postings.get(token)
      if (list === undefined) postings.set(token, [id])
      else list.push(id)
    }
  }

  const coOccurring = (id: string): Set<string> => {
    const found = new Set<string>()
    for (const token of new Set(tokensByUnit.get(id) ?? [])) {
      for (const other of postings.get(token) ?? []) {
        if (other !== id) found.add(other)
      }
    }
    return found
  }

  const seenPairs = new Set<string>()
  const pairCount = new Map<string, number>()
  const countOf = (id: string): number => pairCount.get(id) ?? 0
  const result: PairCandidate[] = []

  for (const unit of eligible) {
    if (countOf(unit.id) >= maxPerUnit) continue
    const vector = vectors.get(unit.id) as Map<string, number>

    const scored: { id: string; similarity: number }[] = []
    for (const otherId of coOccurring(unit.id)) {
      if (seenPairs.has(pairKey(unit.id, otherId))) continue
      const similarity = dot(vector, vectors.get(otherId) as Map<string, number>)
      if (similarity < threshold) continue

      const other = unitsById.get(otherId) as Unit
      if (unit.text === other.text) {
        const group = tableGroup(unit)
        if (group !== null && group === tableGroup(other)) continue
      }
      scored.push({ id: otherId, similarity })
    }
    scored.sort((x, y) => y.similarity - x.similarity)

    for (const candidate of scored) {
      if (countOf(unit.id) >= maxPerUnit) break
      if (countOf(candidate.id) >= maxPerUnit) continue
      const key = pairKey(unit.id, candidate.id)
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      pairCount.set(unit.id, countOf(unit.id) + 1)
      pairCount.set(candidate.id, countOf(candidate.id) + 1)
      const [a, b] = unit.id < candidate.id ? [unit.id, candidate.id] : [candidate.id, unit.id]
      result.push({ a, b, similarity: candidate.similarity })
    }
  }

  return result
}
