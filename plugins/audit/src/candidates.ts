// This file pairs candidates for the context audit (#164, #174). It finds
// which units the model should compare, without any model call. The method
// is lexical only, TF-IDF and cosine similarity. This is cheap enough to run
// over every unit. It is precise enough to be worth a second look. Whether
// two units actually agree or contradict is the model's job, not this
// file's job.
//
// This is the port of the spike's `candidates.ts`. Tests reach it only
// through `subcommands/context.ts`. That is where its behaviour is checked. A
// candidate is not an answer anybody consumes on its own.

import type { Unit } from './types.ts'

/** Two units to compare, `a < b` by id. */
export type PairCandidate = { a: string; b: string; similarity: number }

/** How many pairs one unit may appear in, on either side. A unit that says
 *  nearly what a dozen others say is worth a second look, a few times over.
 *  The twelfth call buys nothing the first few did not. */
const MAX_PER_UNIT = 5

/** A unit shorter than this, in tokens, is never paired. There is not
 *  enough text for a shared-vocabulary match to mean anything. Without this
 *  floor, a short line, such as "See below.", would pair with anything that
 *  shares one common word. */
const MIN_TOKENS = 4

/** A short, generic list: articles, conjunctions and the like. Domain
 *  words, such as "plugin", "test", and "issue", stay on purpose. `idf`
 *  already discounts whatever is common in a given corpus. A longer
 *  hand-picked list here would fit only one repository's own prose. */
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
 * `text` as a token list. A backticked code span's content becomes one
 * lowercased token. For example, `` `lib/git.ts` `` is a single term, not
 * three. The remaining prose is lowercased, split on word boundaries, and
 * filtered against {@link STOPWORDS}.
 */
const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  const prose = text.replace(/`([^`]+)`/g, (_, code: string) => {
    tokens.push(code.toLowerCase())
    return ' '
  })
  // This uses `matchAll`, not `match`. `match` answers `null` for a text
  // that holds no word at all. That would leave a branch here that nothing
  // could reach.
  for (const match of prose.toLowerCase().matchAll(/[a-z0-9]+(?:[-'_][a-z0-9]+)*/g)) {
    const word = match[0]
    if (!STOPWORDS.has(word)) tokens.push(word)
  }
  return tokens
}

/** A table row's group key: same file, same heading path. Two rows with
 *  that key and identical text are one column value, repeated down a table.
 *  This is not duplicated content. So the audit drops a pair between them,
 *  whatever their similarity.
 *
 *  Any other block kind gets `null`. The audit never treats one `null` as
 *  equal to another. So two rows under DIFFERENT headings get different
 *  keys, and can still pair. */
const tableGroup = (unit: Unit): string | null =>
  unit.block === 'table_row' ? `${unit.file}\u0000${unit.headingPath.join('>')}` : null

/** Two rows of one table that hold the same value. */
const repeatedCell = (unit: Unit, other: Unit): boolean => {
  if (unit.text !== other.text) return false
  const group = tableGroup(unit)
  return group !== null && group === tableGroup(other)
}

/**
 * The document-frequency ceiling for a token, as an absolute count of
 * units. Below this ceiling, the audit uses the token to look up other
 * units. A token above the ceiling still weights a comparison, since its
 * `idf` is simply small. The audit no longer uses it to find candidates.
 *
 * The reason: a postings list that covers a large share of the corpus
 * takes a long time to scan. The audit repeats that scan once per unit.
 * That comes close to the full pairwise comparison this index exists to
 * avoid.
 */
const POSTINGS_DF_CAP = 200

/** The same ceiling, as a share of the corpus. This makes the rule hold on
 *  a small corpus too. A token in a quarter of 40 units is as unselective
 *  there as a token in 200 of 20,000. */
const POSTINGS_DF_SHARE = 0.25

/** Below this floor, the share rule would empty the index. A quarter of
 *  four units is one, and every token that two units share sits above
 *  that. So a corpus of a handful of units keeps every token. At that
 *  size, a full scan is free. */
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

/** The units that share at least one indexed token with `id`. This is every
 *  unit that the code below could score above zero. */
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

/** The dot product of two token-weight maps. It iterates over the smaller
 *  one. Both vectors are already L2-normalised below. So this dot product
 *  IS the cosine similarity. */
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
 *  The idf is smoothed: `+1` on both sides and on the result. A token in
 *  every unit still gets a small positive weight, not exactly zero. This
 *  keeps a unit made entirely of very common tokens comparable at all.
 *  Otherwise it would vanish to a zero vector. */
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
      // `documentFrequency` already counted every token here.
      const weight = count * (idf.get(token) as number)
      weights.set(token, weight)
      normSquared += weight * weight
    }
    // A unit of at least four tokens has at least one non-zero weight. So
    // the norm is never zero. There is nothing to guard against here.
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
 * It never pairs a unit with itself. It emits each pair once, `a < b` by
 * id. It skips a unit under {@link MIN_TOKENS} tokens entirely. It drops a
 * cell repeated down one table ({@link repeatedCell}). It lets no unit
 * appear in more than {@link MAX_PER_UNIT} pairs.
 */
export const candidatePairs = (
  units: readonly Unit[],
  options: { threshold: number },
): PairCandidate[] => {
  // Sorted BEFORE the index is built, not after, so id order makes the run
  // deterministic twice over. First, which unit is the query side decides
  // which pairs fill a cap. Second, the order in which the postings lists
  // are written decides which of two EQUALLY similar candidates scores
  // first. This is because the sort below is stable. Built in document
  // order instead, the same repository would spend a tight `--max-pairs` on
  // a different pair. That pair depends on where its units happen to sit in
  // the file.
  //
  // Two arms, and not three. Ids are unique by construction: `split.ts`
  // disambiguates a collision with `#2`. So an equal-ids arm is a branch no
  // input can reach.
  // One pass: the eligibility test and the index want the same tokens. So
  // the code tokenizes a unit's text once, not once for each.
  const eligible: Unit[] = []
  const tokensByUnit = new Map<string, string[]>()
  const byId = new Map<string, Unit>()
  for (const unit of [...units].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const tokens = tokenize(unit.text)
    if (tokens.length < MIN_TOKENS) continue
    eligible.push(unit)
    tokensByUnit.set(unit.id, tokens)
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
      if (similarity < options.threshold) continue
      if (repeatedCell(unit, other)) continue
      scored.push({ other, similarity })
    }
    scored.sort((x, y) => y.similarity - x.similarity)

    for (const candidate of scored) {
      // The code re-reads both counts here, rather than in `scored`, because
      // earlier turns of this same loop change them.
      if (countOf(unit.id) >= MAX_PER_UNIT) break
      if (countOf(candidate.other.id) >= MAX_PER_UNIT) continue
      seen.add(pairKey(unit.id, candidate.other.id))
      taken.set(unit.id, countOf(unit.id) + 1)
      taken.set(candidate.other.id, countOf(candidate.other.id) + 1)
      // Sorted, rather than compared. Which of the two was the query side is
      // an artefact of the loop. A pair is named the same way, whichever
      // one it was.
      const [a, b] = [unit.id, candidate.other.id].sort() as [string, string]
      pairs.push({ a, b, similarity: candidate.similarity })
    }
  }
  return pairs
}
