// A hand-rolled, line-based markdown splitter for the context-audit spike
// (#164). No dependencies: node built-ins only, so tier 0 stays auditable by
// reading this one file. It trades full CommonMark generality for rules that
// are simple to verify by hand against the fixtures in split.test.ts and
// against this repository's own CLAUDE.md files.

import type { OpaqueBlock, SplitResult, Unit } from './types.ts'

type HeadingFrame = { level: number; text: string }

// One line item under construction while a list block is being scanned. Kept
// mutable until popped, at which point it becomes a frozen Unit.
type OpenItem = {
  indent: number
  contentColumn: number
  text: string
  startLine: number
  endLine: number
  leadIn: string | null
}

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.']

/** Splits `source` (the contents of `file`) into checkable units. */
export const splitMarkdown = (file: string, source: string): SplitResult => {
  const lines = splitLines(source)
  const units: Omit<Unit, 'prev' | 'next'>[] = []
  const opaque: OpaqueBlock[] = []
  const total = lines.length

  if (total === 0 || (total === 1 && lines[0] === '')) {
    return { units: [], opaque: [] }
  }

  const headingStack: HeadingFrame[] = []
  let i = 1

  // YAML frontmatter only counts on line 1, closed by the next bare `---`.
  const first = lines[0] ?? ''
  if (first.trim() === '---') {
    let close = -1
    for (let j = 2; j <= total; j++) {
      if ((lines[j - 1] ?? '').trim() === '---') {
        close = j
        break
      }
    }
    if (close > 0) {
      opaque.push({
        file,
        startLine: 1,
        endLine: close,
        kind: 'frontmatter',
        lang: null,
        text: lines.slice(1, close - 1).join('\n'),
        refs: [],
      })
      i = close + 1
    }
  }

  while (i <= total) {
    const raw = lines[i - 1] ?? ''
    const line = stripBlockquote(raw)

    if (isBlank(line)) {
      i++
      continue
    }

    if (isHtmlCommentFull(line)) {
      i++
      continue
    }

    if (isHtmlCommentOpen(line)) {
      i = skipHtmlComment(lines, i)
      continue
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      const close = findFenceClose(lines, i + 1, fence)
      const endLine = close > 0 ? close : total
      const bodyStart = i + 1
      const bodyEnd = close > 0 ? close - 1 : total
      const body = bodyEnd >= bodyStart ? lines.slice(bodyStart - 1, bodyEnd).join('\n') : ''
      const info = fence.info.trim()
      const lang = info.length > 0 ? (info.split(/\s+/)[0] ?? null) : null
      opaque.push({
        file,
        startLine: i,
        endLine,
        kind: lang?.toLowerCase() === 'mermaid' ? 'mermaid' : 'code',
        lang,
        text: body,
        refs: [],
      })
      i = endLine + 1
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

    if (isThematicBreak(line)) {
      i++
      continue
    }

    const headerCells = matchTableHeader(line, lines[i] ? stripBlockquote(lines[i] ?? '') : null)
    if (headerCells) {
      i += 2
      while (i <= total) {
        const rowLineRaw = lines[i - 1] ?? ''
        const rowLine = stripBlockquote(rowLineRaw)
        if (isBlank(rowLine) || !rowLine.includes('|')) break
        const cells = splitTableRow(rowLine)
        const obj: Record<string, string> = {}
        headerCells.forEach((header, idx) => {
          obj[header] = cells[idx] ?? ''
        })
        units.push({
          id: makeId(file, i, i),
          file,
          startLine: i,
          endLine: i,
          block: 'table_row',
          headingPath: headingStack.map((h) => h.text),
          leadIn: null,
          text: JSON.stringify(obj),
          refs: [],
        })
        i++
      }
      continue
    }

    if (matchListMarker(line)) {
      i = parseListBlock(lines, i, headingStack, null, file, units, opaque)
      continue
    }

    // Paragraph: accumulate hard-wrapped lines until a line that starts a
    // different kind of block, or EOF.
    const paraStart = i
    let paraEnd = i
    while (paraEnd + 1 <= total) {
      const nextRaw = lines[paraEnd] ?? ''
      const next = stripBlockquote(nextRaw)
      if (
        isBlank(next) ||
        matchHeading(next) ||
        matchFenceOpen(next) ||
        matchListMarker(next) ||
        isThematicBreak(next) ||
        isHtmlCommentOpen(next) ||
        isHtmlCommentFull(next)
      ) {
        break
      }
      paraEnd++
    }

    const paraLines: string[] = []
    for (let k = paraStart; k <= paraEnd; k++) paraLines.push(stripBlockquote(lines[k - 1] ?? ''))
    const joined = paraLines.join(' ').trim()

    // "Directly before a list" tolerates the blank line CommonMark requires
    // between a paragraph and the list that follows it.
    let afterBlank = paraEnd + 1
    while (afterBlank <= total && isBlank(stripBlockquote(lines[afterBlank - 1] ?? '')))
      afterBlank++
    const afterRaw = afterBlank <= total ? stripBlockquote(lines[afterBlank - 1] ?? '') : null
    const nextIsList = afterRaw !== null && matchListMarker(afterRaw) !== null

    if (nextIsList && joined.endsWith(':')) {
      // A lead-in paragraph is never a unit; it becomes the leadIn for the
      // list that follows it.
      i = parseListBlock(lines, afterBlank, headingStack, joined, file, units, opaque)
      continue
    }

    const { text: paraText, map } = buildLineMap(paraLines, paraStart)
    for (const span of splitSentences(paraText)) {
      const text = paraText.slice(span.start, span.end)
      const startLine = map[span.start] ?? paraStart
      const endLine = map[span.end - 1] ?? paraEnd
      units.push({
        id: makeId(file, startLine, endLine),
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

  return { units: withNeighbours(units), opaque }
}

const makeId = (file: string, startLine: number, endLine: number): string =>
  `${file}:${startLine}-${endLine}`

/** Splits on \n, \r\n and bare \r, without dropping a trailing empty line's count. */
const splitLines = (source: string): string[] => {
  if (source === '') return []
  return source.split(/\r\n|\r|\n/)
}

const isBlank = (line: string): boolean => line.trim() === ''

/** Strips one level of `>` blockquote marker; nested quoting is not modelled. */
const stripBlockquote = (line: string): string => {
  const m = line.match(/^(\s*)>\s?(.*)$/)
  return m ? (m[2] ?? '') : line
}

const isHtmlCommentFull = (line: string): boolean => /^<!--.*-->$/.test(line.trim())

const isHtmlCommentOpen = (line: string): boolean =>
  line.trim().startsWith('<!--') && !line.includes('-->')

const skipHtmlComment = (lines: string[], start: number): number => {
  let i = start + 1
  while (i <= lines.length) {
    if ((lines[i - 1] ?? '').includes('-->')) return i + 1
    i++
  }
  return i
}

const isThematicBreak = (line: string): boolean =>
  /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)

const matchHeading = (line: string): { level: number; text: string } | null => {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  if (!m) return null
  const marks = m[1] ?? ''
  const rest = m[2] ?? ''
  const text = rest.replace(/\s+#+\s*$/, '').trim()
  return { level: marks.length, text }
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

/** Removes up to `n` leading spaces, never more than the line actually has. */
const stripLeading = (line: string, n: number): string => {
  let cut = 0
  while (cut < n && line[cut] === ' ') cut++
  return line.slice(cut)
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

const parseListBlock = (
  lines: string[],
  start: number,
  headingStack: HeadingFrame[],
  topLeadIn: string | null,
  file: string,
  units: Omit<Unit, 'prev' | 'next'>[],
  opaque: OpaqueBlock[],
): number => {
  const stack: OpenItem[] = []
  const headingPath = headingStack.map((h) => h.text)
  const total = lines.length
  let i = start

  const finish = (item: OpenItem) => {
    units.push({
      id: makeId(file, item.startLine, item.endLine),
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

  const popTo = (indent: number) => {
    // Popped items come off deepest-first (LIFO); finish them in the reverse
    // order so units still land in document order (shallower item started
    // earlier in the source).
    const popped: OpenItem[] = []
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) {
      const item = stack.pop()
      if (item) popped.push(item)
    }
    for (let k = popped.length - 1; k >= 0; k--) {
      const item = popped[k]
      if (item) finish(item)
    }
  }

  while (i <= total) {
    const raw = lines[i - 1] ?? ''
    const line = stripBlockquote(raw)

    if (isBlank(line)) {
      let peek = i + 1
      while (peek <= total && isBlank(stripBlockquote(lines[peek - 1] ?? ''))) peek++
      const nextLine = peek <= total ? stripBlockquote(lines[peek - 1] ?? '') : null
      const innermostNow = stack[stack.length - 1]
      const nextIndent = nextLine !== null ? (nextLine.match(/^\s*/)?.[0] ?? '').length : -1
      const listContinues =
        nextLine !== null &&
        (matchListMarker(nextLine) !== null ||
          (!!innermostNow && nextIndent >= innermostNow.contentColumn))
      if (listContinues) {
        i = peek
        continue
      }
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

    const fence = matchFenceOpen(line)
    if (fence && stack.length > 0) {
      const close = findFenceClose(lines, i + 1, fence)
      const endLine = close > 0 ? close : total
      const bodyStart = i + 1
      const bodyEnd = close > 0 ? close - 1 : total
      // Undo the list item's own indentation, so the block's text reads the
      // way it would if the fence were not nested.
      const strip = stack[stack.length - 1]?.contentColumn ?? 0
      const body =
        bodyEnd >= bodyStart
          ? lines
              .slice(bodyStart - 1, bodyEnd)
              .map((l) => stripLeading(l, strip))
              .join('\n')
          : ''
      const info = fence.info.trim()
      const lang = info.length > 0 ? (info.split(/\s+/)[0] ?? null) : null
      opaque.push({
        file,
        startLine: i,
        endLine,
        kind: lang?.toLowerCase() === 'mermaid' ? 'mermaid' : 'code',
        lang,
        text: body,
        refs: [],
      })
      // The fence closes whatever item held it: continuation resumes as a
      // new paragraph rather than being folded back into the item's text.
      popTo(0)
      i = endLine + 1
      continue
    }

    const innermost = stack[stack.length - 1]
    if (innermost && !matchHeading(line) && !isThematicBreak(line)) {
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
  return i
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

/** Splits paragraph text into sentence spans per the spike's splitting rule. */
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

const trimSpan = (text: string, span: Span): Span => {
  let { start, end } = span
  while (start < end && /\s/.test(text[start] ?? '')) start++
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--
  return { start, end }
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
