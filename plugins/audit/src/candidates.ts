// Candidate pairing for the context audit (#164, #174): the units worth asking
// the model to compare, chosen with no model call. The port of the spike's
// `candidates.ts`.
//
// Reached only through `commands/context.ts`, which is where its behaviour is
// asserted: a candidate is not an answer anybody consumes on its own.

import type { Unit } from './types.ts'

/** Two units worth comparing, `a < b` by id. */
export type PairCandidate = { a: string; b: string; similarity: number }

/** Every pair of `units`, each once. */
export const candidatePairs = (units: readonly Unit[]): PairCandidate[] => {
  const pairs: PairCandidate[] = []
  for (const [index, unit] of units.entries()) {
    for (const other of units.slice(index + 1)) {
      const [a, b] = unit.id < other.id ? [unit.id, other.id] : [other.id, unit.id]
      pairs.push({ a, b, similarity: 1 })
    }
  }
  return pairs
}
