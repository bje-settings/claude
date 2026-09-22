// A hand-rolled, line-based markdown splitter (#164, #171). No dependencies:
// node built-ins only, so tier 0 stays auditable by reading this one file. It
// trades full CommonMark generality for rules that are simple to verify by
// hand against the fixtures in split.test.ts.

import type { SplitResult, Unit } from './types.ts'

/** Splits `source` (the contents of `file`) into checkable units. */
export const splitMarkdown = (file: string, source: string): SplitResult => {
  const headingPath: string[] = []
  const raw: Omit<Unit, 'id' | 'prev' | 'next'>[] = splitSentences(source).map((text) => ({
    file,
    startLine: 1,
    endLine: 1,
    block: 'sentence',
    headingPath,
    leadIn: null,
    text,
    refs: [],
  }))

  return { units: withNeighbours(assignIds(file, raw)), opaque: [], warnings: [] }
}

/** Splits paragraph text into sentence strings on `. ` `? ` `! ` boundaries. */
const splitSentences = (text: string): string[] => {
  if (text.trim() === '') return []
  return text.split(/(?<=[.?!]) (?=[A-Z])/)
}

/**
 * Assigns ids in document order: `<file>:<start>-<end>` for the first unit on
 * a span, `#2`, `#3`... for later units that share the same span (two
 * sentences on one source line, for instance).
 */
const assignIds = (
  file: string,
  units: Omit<Unit, 'id' | 'prev' | 'next'>[],
): Omit<Unit, 'prev' | 'next'>[] => {
  const seen = new Map<string, number>()
  return units.map((unit) => {
    const span = `${unit.startLine}-${unit.endLine}`
    const count = (seen.get(span) ?? 0) + 1
    seen.set(span, count)
    const id = count === 1 ? `${file}:${span}` : `${file}:${span}#${count}`
    return { ...unit, id }
  })
}

/** Fills prev/next from the neighbouring unit under the same heading path. */
const withNeighbours = (units: Omit<Unit, 'prev' | 'next'>[]): Unit[] => {
  return units.map((unit, idx) => {
    const prevUnit = units[idx - 1]
    const nextUnit = units[idx + 1]
    const samePath = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, k) => v === b[k])
    const prev = prevUnit && samePath(prevUnit.headingPath, unit.headingPath) ? prevUnit.text : null
    const next = nextUnit && samePath(nextUnit.headingPath, unit.headingPath) ? nextUnit.text : null
    return { ...unit, prev, next }
  })
}
