// A hand-rolled, line-based markdown splitter (#164, #171). No dependencies:
// node built-ins only, so tier 0 stays auditable by reading this one file. It
// trades full CommonMark generality for rules that are simple to verify by
// hand against the fixtures in split.test.ts.

import type { SplitResult, Unit } from './types.ts'

type HeadingFrame = { level: number; text: string }

// One list item under construction while a list block is being scanned. Kept
// mutable until the list block finishes, at which point it becomes a Unit.
type OpenItem = {
  indent: number
  contentColumn: number
  text: string
  startLine: number
  endLine: number
  leadIn: string | null
}

/** Splits `source` (the contents of `file`) into checkable units. */
export const splitMarkdown = (file: string, source: string): SplitResult => {
  const lines = splitLines(source)
  const units: Omit<Unit, 'id' | 'prev' | 'next'>[] = []
  const total = lines.length

  const headingStack: HeadingFrame[] = []
  let i = 1

  while (i <= total) {
    const line = lines[i - 1] ?? ''

    if (isBlank(line)) {
      i++
      continue
    }

    const heading = matchHeading(line)
    if (heading) {
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= heading.level
      ) {
        headingStack.pop()
      }
      headingStack.push({ level: heading.level, text: heading.text })
      i++
      continue
    }

    if (matchListMarker(line)) {
      i = parseListBlock(lines, i, headingStack, file, units)
      continue
    }

    for (const text of splitSentences(line)) {
      units.push({
        file,
        startLine: i,
        endLine: i,
        block: 'sentence',
        headingPath: headingStack.map((h) => h.text),
        leadIn: null,
        text,
        refs: [],
      })
    }
    i++
  }

  return { units: withNeighbours(assignIds(file, units)), opaque: [], warnings: [] }
}

/** Splits on \n, \r\n and bare \r, without dropping a trailing empty line's count. */
const splitLines = (source: string): string[] => {
  if (source === '') return []
  return source.split(/\r\n|\r|\n/)
}

const isBlank = (line: string): boolean => line.trim() === ''

const matchHeading = (line: string): { level: number; text: string } | null => {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  if (!m) return null
  const marks = m[1] ?? ''
  const rest = m[2] ?? ''
  const text = rest.replace(/\s+#+\s*$/, '').trim()
  return { level: marks.length, text }
}

type ListMatch = { indent: number; content: string; contentColumn: number }

const matchListMarker = (line: string): ListMatch | null => {
  const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/)
  if (!m) return null
  const indentStr = m[1] ?? ''
  const marker = m[2] ?? ''
  const gap = m[3] ?? ''
  const content = m[4] ?? ''
  return {
    indent: indentStr.length,
    content: content.trim(),
    contentColumn: indentStr.length + marker.length + gap.length,
  }
}

/**
 * Scans a list block starting at `start`, pushing one `list_item` unit per
 * item onto `units`. Returns the line to resume the outer loop from.
 */
const parseListBlock = (
  lines: string[],
  start: number,
  headingStack: HeadingFrame[],
  file: string,
  units: Omit<Unit, 'id' | 'prev' | 'next'>[],
): number => {
  const stack: OpenItem[] = []
  // Items are finished (popped) in an order driven by list structure, not by
  // where they started in the source: a sibling can close before its parent
  // does. Collect them here and sort by startLine at the end, so units still
  // come out in true document order regardless of pop order.
  const finished: OpenItem[] = []
  const headingPath = headingStack.map((h) => h.text)
  const total = lines.length
  let i = start

  const popTo = (indent: number) => {
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) {
      const item = stack.pop()
      if (item) finished.push(item)
    }
  }

  while (i <= total) {
    const line = lines[i - 1] ?? ''

    if (isBlank(line)) {
      break
    }

    const marker = matchListMarker(line)
    if (marker) {
      // Closes any open item at this depth or deeper: a same-indent line is
      // a sibling of the item it replaces, not its continuation.
      popTo(marker.indent)
      const parent = stack[stack.length - 1]
      const leadIn = parent ? parent.text : null
      stack.push({
        indent: marker.indent,
        contentColumn: marker.contentColumn,
        text: marker.content,
        startLine: i,
        endLine: i,
        leadIn,
      })
      i++
      continue
    }

    const innermost = stack[stack.length - 1]
    if (innermost) {
      const lineIndent = (line.match(/^\s*/)?.[0] ?? '').length
      if (lineIndent >= innermost.contentColumn) {
        innermost.text += ` ${line.trim()}`
        innermost.endLine = i
        i++
        continue
      }
    }

    popTo(0)
    break
  }

  popTo(0)

  finished.sort((a, b) => a.startLine - b.startLine)
  for (const item of finished) {
    units.push({
      file,
      startLine: item.startLine,
      endLine: item.endLine,
      block: 'list_item',
      headingPath,
      leadIn: item.leadIn,
      text: item.text,
      refs: [],
    })
  }

  return i
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
