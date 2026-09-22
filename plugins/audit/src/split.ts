// A hand-rolled, line-based markdown splitter (#164, #171). No dependencies:
// node built-ins only, so tier 0 stays auditable by reading this one file. It
// trades full CommonMark generality for rules that are simple to verify by
// hand against the fixtures in split.test.ts.

import type { OpaqueBlock, SplitResult, SplitWarning, Unit } from './types.ts'

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
  const opaque: OpaqueBlock[] = []
  const warnings: SplitWarning[] = []
  const total = lines.length

  const headingStack: HeadingFrame[] = []
  let i = 1

  while (i <= total) {
    const line = lines[i - 1] ?? ''

    if (isBlank(line)) {
      i++
      continue
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      const read = readFence(lines, i, fence, file, 0)
      if (!read.closed) warnings.push({ file, line: i, kind: 'unclosed_fence' })
      opaque.push(read.block)
      i = read.endLine + 1
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

    const headerCells = matchTableHeader(line, lines[i] ?? null)
    if (headerCells) {
      // The header's own line and the separator under it are not units.
      const table = readTableRows(lines, i + 2, headerCells, file, headingStack)
      units.push(...table.units)
      i = table.next
      continue
    }

    if (matchListMarker(line)) {
      i = parseListBlock(lines, i, headingStack, null, file, units)
      continue
    }

    const paraStart = i
    const paraEnd = paragraphEnd(lines, i)
    const paraLines: string[] = []
    for (let k = paraStart; k <= paraEnd; k++) paraLines.push(lines[k - 1] ?? '')
    const joined = paraLines.join(' ').trim()

    // "Directly before a list" also matches across blank lines: a blank line
    // (or several) between a lead-in paragraph and the list it introduces is
    // still tolerated.
    let afterBlank = paraEnd + 1
    while (afterBlank <= total && isBlank(lines[afterBlank - 1] ?? '')) afterBlank++
    const afterLine = afterBlank <= total ? (lines[afterBlank - 1] ?? '') : null
    const nextIsList = afterLine !== null && matchListMarker(afterLine) !== null

    if (nextIsList && joined.endsWith(':')) {
      // A lead-in paragraph is never a unit; it becomes the leadIn for the
      // list that follows it.
      i = parseListBlock(lines, afterBlank, headingStack, joined, file, units)
      continue
    }

    const { text: paraText, map } = buildLineMap(paraLines, paraStart)
    for (const span of splitSentences(paraText)) {
      const text = paraText.slice(span.start, span.end)
      const startLine = map[span.start] ?? paraStart
      const endLine = map[span.end - 1] ?? paraEnd
      units.push({
        file,
        startLine,
        endLine,
        block: 'sentence',
        headingPath: headingStack.map((h) => h.text),
        leadIn: null,
        text,
        refs: [],
      })
    }
    i = paraEnd + 1
  }

  return { units: withNeighbours(assignIds(file, units)), opaque, warnings }
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
  topLeadIn: string | null,
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
      const leadIn = parent ? parent.text : topLeadIn
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

/** The last line of the hard-wrapped paragraph starting at `start`: the scan
 *  stops before the first line that opens a different kind of block, or at EOF. */
const paragraphEnd = (lines: string[], start: number): number => {
  let end = start
  while (end + 1 <= lines.length) {
    const next = lines[end] ?? ''
    if (isBlank(next) || matchHeading(next) || matchListMarker(next) || matchFenceOpen(next)) break
    end++
  }
  return end
}

const buildLineMap = (
  paraLines: string[],
  startLineNo: number,
): { text: string; map: number[] } => {
  let text = ''
  const map: number[] = []
  paraLines.forEach((line, idx) => {
    const lineNo = startLineNo + idx
    for (const ch of line) {
      text += ch
      map.push(lineNo)
    }
    if (idx < paraLines.length - 1) {
      text += ' '
      map.push(lineNo)
    }
  })
  return { text, map }
}

type FenceOpen = { char: string; length: number; info: string }

const matchFenceOpen = (line: string): FenceOpen | null => {
  const m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
  if (!m) return null
  const marker = m[2] ?? ''
  const info = m[3] ?? ''
  // A backtick fence's info string cannot itself contain a backtick.
  if (marker.startsWith('`') && info.includes('`')) return null
  return { char: marker[0] ?? '`', length: marker.length, info }
}

const findFenceClose = (lines: string[], start: number, fence: FenceOpen): number => {
  for (let i = start; i <= lines.length; i++) {
    const line = (lines[i - 1] ?? '').trim()
    const re = fence.char === '`' ? /^`{3,}$/ : /^~{3,}$/
    if (re.test(line) && line.length >= fence.length) return i
  }
  return -1
}

/**
 * The opaque block a fence opener on line `start` produces, and the line it
 * ends on (the last line of the file when nothing closes it, which
 * `closed: false` reports so the caller can warn).
 *
 * `strip` undoes a containing list item's own indentation, so a nested
 * block's text reads the way it would unnested.
 */
const readFence = (
  lines: string[],
  start: number,
  fence: FenceOpen,
  file: string,
  strip: number,
): { block: OpaqueBlock; endLine: number; closed: boolean } => {
  const close = findFenceClose(lines, start + 1, fence)
  const endLine = close > 0 ? close : lines.length
  const body = lines
    .slice(start, close > 0 ? close - 1 : lines.length)
    .map((l) => stripLeading(l, strip))
    .join('\n')
  const info = fence.info.trim()
  const lang = info.length > 0 ? (info.split(/\s+/)[0] ?? null) : null
  return {
    block: {
      file,
      startLine: start,
      endLine,
      kind: lang?.toLowerCase() === 'mermaid' ? 'mermaid' : 'code',
      lang,
      text: body,
      refs: [],
    },
    endLine,
    closed: close > 0,
  }
}

/** Removes up to `n` leading spaces, never more than the line actually has. */
const stripLeading = (line: string, n: number): string => {
  let cut = 0
  while (cut < n && line[cut] === ' ') cut++
  return line.slice(cut)
}

const matchTableHeader = (line: string, next: string | null): string[] | null => {
  if (next === null || !line.includes('|') || !isTableSeparator(next)) return null
  return splitTableRow(line)
}

const isTableSeparator = (line: string): boolean => {
  let s = line.trim()
  if (s === '') return false
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  const cells = s.split('|')
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

/** Splits a table row on unescaped, non-code-span pipes. */
const splitTableRow = (line: string): string[] => {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let openBackticks = 0
  let idx = 0
  while (idx < s.length) {
    const ch = s[idx]
    if (ch === '`') {
      let runLen = 1
      while (s[idx + runLen] === '`') runLen++
      if (openBackticks === 0) openBackticks = runLen
      else if (openBackticks === runLen) openBackticks = 0
      current += '`'.repeat(runLen)
      idx += runLen
      continue
    }
    if (ch === '\\' && s[idx + 1] === '|') {
      current += '|'
      idx += 2
      continue
    }
    if (ch === '|' && openBackticks === 0) {
      cells.push(current.trim())
      current = ''
      idx++
      continue
    }
    current += ch
    idx++
  }
  cells.push(current.trim())
  return cells
}

/** One unit per body row of a table, from `start` to the first line that is
 *  blank or carries no pipe. Each row's text is the header's own cell names
 *  paired with the row's values. */
const readTableRows = (
  lines: string[],
  start: number,
  headerCells: string[],
  file: string,
  headingStack: HeadingFrame[],
): { units: Omit<Unit, 'id' | 'prev' | 'next'>[]; next: number } => {
  const units: Omit<Unit, 'id' | 'prev' | 'next'>[] = []
  let i = start
  while (i <= lines.length) {
    const rowLine = lines[i - 1] ?? ''
    if (isBlank(rowLine) || !rowLine.includes('|')) break
    const cells = splitTableRow(rowLine)
    const text = headerCells
      .map((header, idx) => {
        const name = header.trim() === '' ? `col${idx + 1}` : header.trim()
        return `${name}: ${(cells[idx] ?? '').trim()}`
      })
      .join('\n')
    units.push({
      file,
      startLine: i,
      endLine: i,
      block: 'table_row',
      headingPath: headingStack.map((h) => h.text),
      leadIn: null,
      text,
      refs: [],
    })
    i++
  }
  return { units, next: i }
}

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.']

type Span = { start: number; end: number }

/** Marks offsets that fall inside an inline code span or a markdown link. */
const computeProtectedMask = (text: string): boolean[] => {
  const mask = new Array<boolean>(text.length).fill(false)
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      let runLen = 1
      while (text[i + runLen] === '`') runLen++
      let j = i + runLen
      let closeStart = -1
      while (j < text.length) {
        if (text[j] === '`') {
          let closeLen = 1
          while (text[j + closeLen] === '`') closeLen++
          if (closeLen === runLen) {
            closeStart = j
            break
          }
          j += closeLen
          continue
        }
        j++
      }
      if (closeStart >= 0) {
        for (let k = i; k < closeStart + runLen; k++) mask[k] = true
        i = closeStart + runLen
        continue
      }
      i += runLen
      continue
    }
    i++
  }

  const linkRe = /\[[^[\]]*\]\([^()]*\)/g
  for (const m of text.matchAll(linkRe)) {
    for (let k = m.index; k < m.index + m[0].length; k++) mask[k] = true
  }
  return mask
}

const isAbbreviation = (text: string, periodIndex: number): boolean =>
  ABBREVIATIONS.some(
    (a) => text.slice(periodIndex - a.length + 1, periodIndex + 1).toLowerCase() === a,
  )

const trimSpan = (text: string, span: Span): Span => {
  let { start, end } = span
  while (start < end && /\s/.test(text[start] ?? '')) start++
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--
  return { start, end }
}

/**
 * Splits paragraph text into sentence spans. The rule: split at `.`, `?` or
 * `!` followed by whitespace and then an uppercase letter, a backtick, or
 * `[`, outside code spans and links, skipping the abbreviations in
 * `ABBREVIATIONS` (`e.g.`, `i.e.`, `etc.`, `vs.`).
 */
const splitSentences = (text: string): Span[] => {
  if (text.trim() === '') return []
  const mask = computeProtectedMask(text)
  const boundaries: { end: number; nextStart: number }[] = []
  const re = /[.?!]/g
  for (const m of text.matchAll(re)) {
    const idx = m.index
    if (mask[idx]) continue
    const after = idx + 1
    if (after >= text.length || !/\s/.test(text[after] ?? '')) continue
    let k = after
    while (k < text.length && /\s/.test(text[k] ?? '')) k++
    if (k >= text.length) continue
    const nextCh = text[k] ?? ''
    if (!/[A-Z`[]/.test(nextCh)) continue
    if (text[idx] === '.' && isAbbreviation(text, idx)) continue
    boundaries.push({ end: after, nextStart: k })
  }

  const spans: Span[] = []
  let start = 0
  for (const b of boundaries) {
    spans.push({ start, end: b.end })
    start = b.nextStart
  }
  spans.push({ start, end: text.length })

  return spans.map((s) => trimSpan(text, s)).filter((s) => s.end > s.start)
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
