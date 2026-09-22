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
  // `matchAll` rather than `match`, which answers `null` for a text holding no
  // word at all and would leave a branch here nothing could reach.
  for (const match of prose.toLowerCase().matchAll(/[a-z0-9]+(?:[-'_][a-z0-9]+)*/g)) {
    const word = match[0]
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

/**
 * The document-frequency ceiling for a token to be worth looking OTHER units
 * up by, as an absolute number of units. A token above it still WEIGHTS a
 * comparison (its `idf` is simply small); it just stops being used to find
 * candidates, because scanning a postings list holding a large share of the
 * corpus, once per unit, is most of the way back to the full pairwise
 * comparison this index exists to avoid.
 */
const POSTINGS_DF_CAP = 200

/** The same ceiling as a share of the corpus, so the rule holds on a small one
 *  too: a token in a quarter of 40 units is as unselective there as a token in
 *  200 of 20,000. */
const POSTINGS_DF_SHARE = 0.25

/** Below this the share rule would empty the index (a quarter of four units is
 *  one, and every token two units share sits above that), so a corpus of a
 *  handful of units keeps every token; scanning it is free at that size. */
const POSTINGS_DF_FLOOR = 8

const postingsDfCap = (corpusSize: number): number =>
  Math.max(POSTINGS_DF_FLOOR, Math.min(POSTINGS_DF_CAP, Math.floor(corpusSize * POSTINGS_DF_SHARE)))

/** The inverted index: each token below the cap, to the units carrying it. */
const postingsOf = (
  tokensByUnit: Map<string, string[]>,
  documentFrequency: Map<string, number>,
): Map<string, string[]> => {
  const cap = postingsDfCap(tokensByUnit.size)
  const postings = new Map<string, string[]>()
  for (const [id, tokens] of tokensByUnit) {
    for (const token of new Set(tokens)) {
      // Every token here was counted into `documentFrequency` first.
      if ((documentFrequency.get(token) as number) > cap) continue
      const list = postings.get(token)
      if (list === undefined) postings.set(token, [id])
      else list.push(id)
    }
  }
  return postings
}

/** The units sharing at least one indexed token with `id`, which is every unit
 *  the scoring below could possibly score above zero. */
const coOccurring = (
  id: string,
  tokensByUnit: Map<string, string[]>,
  postings: Map<string, string[]>,
): Set<string> => {
  const found = new Set<string>()
  // `id` is a key of `tokensByUnit`: every caller takes it from there.
  for (const token of new Set(tokensByUnit.get(id) as string[])) {
    for (const other of postings.get(token) ?? []) {
      if (other !== id) found.add(other)
    }
  }
  return found
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

/** How many units a token appears in. */
const documentFrequencies = (tokensByUnit: Map<string, string[]>): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const tokens of tokensByUnit.values()) {
    for (const token of new Set(tokens)) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

/** Each unit's L2-normalised TF-IDF vector, keyed by id.
 *
 *  The idf is smoothed (`+1` on both sides and on the result): a token in
 *  every unit still gets a small positive weight rather than exactly zero,
 *  which keeps a unit made entirely of very common tokens comparable at all
 *  instead of vanishing to a zero vector. */
const vectorsOf = (
  tokensByUnit: Map<string, string[]>,
  documentFrequency: Map<string, number>,
): Map<string, Map<string, number>> => {
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
  options: { threshold: number },
): PairCandidate[] => {
  const threshold = options.threshold

  // Sorted BEFORE the index is built, not after. Id order is what makes the
  // run deterministic twice over: which unit is the query side first decides
  // which pairs fill a cap up, and the order the postings lists are written in
  // decides which of two EQUALLY similar candidates is scored first, since the
  // sort below is stable. Built in document order instead, the same repository
  // spends a tight `--max-pairs` on a different pair depending on where its
  // units happen to sit in the file.
  //
  // Two arms and not three: ids are unique by construction (`split.ts`
  // disambiguates a collision with `#2`), so an equal-ids arm is a branch no
  // input can reach.
  const eligible = [...units]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((unit) => tokenize(unit.text).length >= MIN_TOKENS)

  const tokensByUnit = new Map<string, string[]>()
  const byId = new Map<string, Unit>()
  for (const unit of eligible) {
    tokensByUnit.set(unit.id, tokenize(unit.text))
    byId.set(unit.id, unit)
  }
  const documentFrequency = documentFrequencies(tokensByUnit)
  const vectors = vectorsOf(tokensByUnit, documentFrequency)
  const postings = postingsOf(tokensByUnit, documentFrequency)

  const seen = new Set<string>()
  const taken = new Map<string, number>()
  const countOf = (id: string): number => taken.get(id) ?? 0
  const pairs: PairCandidate[] = []

  for (const unit of eligible) {
    if (countOf(unit.id) >= MAX_PER_UNIT) continue
    const vector = vectors.get(unit.id) as Map<string, number>
    const scored: Array<{ other: Unit; similarity: number }> = []
    for (const otherId of coOccurring(unit.id, tokensByUnit, postings)) {
      // Every posting is an eligible unit's id.
      const other = byId.get(otherId) as Unit
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
      // Sorted rather than compared: which of the two was the query side is an
      // artefact of the loop, and a pair is named the same way whichever it was.
      const [a, b] = [unit.id, candidate.other.id].sort() as [string, string]
      pairs.push({ a, b, similarity: candidate.similarity })
    }
  }
  return pairs
}
