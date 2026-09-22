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

  const frontmatter = readFrontmatter(lines, file)
  if (frontmatter !== null) {
    opaque.push(frontmatter)
    i = frontmatter.endLine + 1
  }

  while (i <= total) {
    // i stays within 1..total by construction, so the index is always in range.
    const raw = lines[i - 1] as string
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
      const closed = skipHtmlComment(lines, i)
      if (closed.next < 0) {
        // Unclosed: end the comment at its own line rather than swallowing
        // everything after it, and say so.
        warnings.push({ file, line: i, kind: 'unclosed_comment' })
        i++
        continue
      }
      if (closed.trailing !== null) {
        // Prose after `-->` on the closing line is real content: rewrite that
        // line in place so the outer loop parses it fresh, at its own line number.
        lines[closed.next - 1] = closed.trailing
        i = closed.next
      } else {
        i = closed.next + 1
      }
      continue
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      const read = readFence(lines, i, fence, raw !== line, file, 0)
      if (!read.closed) warnings.push({ file, line: i, kind: 'unclosed_fence' })
      opaque.push(read.block)
      i = read.endLine + 1
      continue
    }

    const heading = matchHeading(line)
    if (heading) {
      // Stops at the top frame that is shallower than the new heading, or
      // when the stack empties: both are real outcomes, not a fallback, so
      // the loop reads the top fresh each time rather than defaulting a
      // missing one to level 0.
      while (true) {
        const top = headingStack[headingStack.length - 1]
        if (top === undefined || top.level < heading.level) break
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

    // A pipe line at EOF has no next line to check for a separator; `next`
    // is undefined rather than falling back to '', so that state reaches
    // matchTableHeader as "no next line" rather than as an empty one.
    const next = lines[i]
    const headerCells = next !== undefined ? matchTableHeader(line, stripBlockquote(next)) : null
    if (headerCells) {
      // The header's own line and the separator under it are not units.
      const table = readTableRows(lines, i + 2, headerCells, file, headingStack)
      units.push(...table.units)
      i = table.next
      continue
    }

    if (matchListMarker(line)) {
      i = parseListBlock(lines, i, headingStack, null, file, units, opaque, warnings)
      continue
    }

    const paraStart = i
    const paraEnd = paragraphEnd(lines, i)
    const paraLines: string[] = []
    // k stays within paraStart..paraEnd, and paraEnd never exceeds total.
    for (let k = paraStart; k <= paraEnd; k++)
      paraLines.push(stripBlockquote(lines[k - 1] as string))
    const joined = paraLines.join(' ').trim()

    // "Directly before a list" also matches across blank lines: a blank line
    // (or several) between a lead-in paragraph and the list it introduces is
    // still tolerated. Both loops stay within afterBlank <= total.
    let afterBlank = paraEnd + 1
    while (afterBlank <= total && isBlank(stripBlockquote(lines[afterBlank - 1] as string)))
      afterBlank++
    const afterRaw = afterBlank <= total ? stripBlockquote(lines[afterBlank - 1] as string) : null
    const nextIsList = afterRaw !== null && matchListMarker(afterRaw) !== null

    if (nextIsList && joined.endsWith(':')) {
      // A lead-in paragraph is never a unit; it becomes the leadIn for the
      // list that follows it.
      i = parseListBlock(lines, afterBlank, headingStack, joined, file, units, opaque, warnings)
      continue
    }

    const { text: paraText, map } = buildLineMap(paraLines, paraStart)
    for (const span of splitSentences(paraText)) {
      const text = paraText.slice(span.start, span.end)
      // Every kept span has end > start and end <= paraText.length, so both
      // offsets always land inside map, which buildLineMap sized to match.
      const startLine = map[span.start] as number
      const endLine = map[span.end - 1] as number
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

/** Strips one level of `>` blockquote marker; nested quoting is not modelled. */
const stripBlockquote = (line: string): string => {
  const m = line.match(/^(\s*)>\s?(.*)$/)
  // The trailing `.*` always matches, even against an empty remainder, so a
  // successful match always populates group 2; the cast is erased and adds
  // no branch.
  return m ? (m[2] as string) : line
}

/** The length of a line's leading run of spaces and tabs, without a regex
 *  match whose result would need a fallback for TypeScript's sake: `\s*`
 *  always matches, so that fallback could never actually fire. */
const leadingSpaces = (line: string): number => line.length - line.trimStart().length

// A line that is one comment and nothing else: the first `-->` is the end of
// the line. Plain string tests rather than a pattern, so a line carrying
// prose between two comments (`<!-- a --> text <!-- b -->`) is not swallowed
// whole.
const isHtmlCommentFull = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith('<!--') && trimmed.indexOf('-->', 4) === trimmed.length - 3
}

const isHtmlCommentOpen = (line: string): boolean =>
  line.trim().startsWith('<!--') && !line.includes('-->')

type CommentClose = { next: number; trailing: string | null }

/** `next < 0` means unclosed. `trailing` is non-blank prose after `-->` on the closing line, if any. */
const skipHtmlComment = (lines: string[], start: number): CommentClose => {
  let i = start + 1
  while (i <= lines.length) {
    // i stays within start+1..lines.length by construction.
    const raw = lines[i - 1] as string
    const idx = raw.indexOf('-->')
    if (idx >= 0) {
      const trailing = raw.slice(idx + 3)
      return { next: i, trailing: trailing.trim() === '' ? null : trailing }
    }
    i++
  }
  return { next: -1, trailing: null }
}

const isThematicBreak = (line: string): boolean =>
  /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)

/** YAML frontmatter, which counts only when line 1 is a bare `---` and some
 *  later line closes it with another. */
const readFrontmatter = (lines: string[], file: string): OpaqueBlock | null => {
  if ((lines[0] ?? '').trim() !== '---') return null
  for (let close = 2; close <= lines.length; close++) {
    // close stays within 2..lines.length, so close - 1 is always in range.
    if ((lines[close - 1] as string).trim() !== '---') continue
    return {
      file,
      startLine: 1,
      endLine: close,
      kind: 'frontmatter',
      lang: null,
      text: lines.slice(1, close - 1).join('\n'),
      refs: [],
    }
  }
  return null
}

const matchHeading = (line: string): { level: number; text: string } | null => {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  if (!m) return null
  // Two mandatory capturing groups: a successful match always populates
  // both, so the cast is erased and adds no branch.
  const marks = m[1] as string
  const rest = m[2] as string
  const text = rest.replace(/\s+#+\s*$/, '').trim()
  return { level: marks.length, text }
}

type ListMatch = { indent: number; content: string; contentColumn: number }

const matchListMarker = (line: string): ListMatch | null => {
  const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/)
  if (!m) return null
  // Four mandatory capturing groups: a successful match always populates
  // all of them, so each cast is erased and adds no branch.
  const indentStr = m[1] as string
  const marker = m[2] as string
  const gap = m[3] as string
  const content = m[4] as string
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
  opaque: OpaqueBlock[],
  warnings: SplitWarning[],
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

  // Pops while the top item is at least as deep as `indent`, reading the top
  // fresh on each pass rather than defaulting a missing one to -1: an empty
  // stack is a real stopping condition, not a fallback value.
  const popTo = (indent: number) => {
    while (true) {
      const top = stack[stack.length - 1]
      if (top === undefined || top.indent < indent) break
      stack.pop()
      finished.push(top)
    }
  }

  while (i <= total) {
    // i stays within 1..total by construction.
    const raw = lines[i - 1] as string
    const line = stripBlockquote(raw)

    if (isBlank(line)) {
      let peek = i + 1
      // Both loops stay within peek <= total.
      while (peek <= total && isBlank(stripBlockquote(lines[peek - 1] as string))) peek++
      const nextLine = peek <= total ? stripBlockquote(lines[peek - 1] as string) : null
      const innermostNow = stack[stack.length - 1]
      const listContinues =
        nextLine !== null &&
        (matchListMarker(nextLine) !== null ||
          (innermostNow !== undefined && leadingSpaces(nextLine) >= innermostNow.contentColumn))
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

    // Read once and shared by the fence check and the continuation check
    // below: both need "the item this line might belong to," and stack.length
    // > 0 would only be asking the same question through the array length.
    const top = stack[stack.length - 1]

    const fence = matchFenceOpen(line)
    if (fence && top !== undefined) {
      const read = readFence(lines, i, fence, raw !== line, file, top.contentColumn)
      if (!read.closed) warnings.push({ file, line: i, kind: 'unclosed_fence' })
      opaque.push(read.block)
      // The fence closes whatever item held it: continuation resumes as a
      // new paragraph rather than being folded back into the item's text.
      popTo(0)
      i = read.endLine + 1
      continue
    }

    if (top !== undefined && !matchHeading(line) && !isThematicBreak(line)) {
      const lineIndent = leadingSpaces(line)
      if (lineIndent >= top.contentColumn) {
        if (isHtmlCommentOpen(line) && skipHtmlComment(lines, i).next < 0) {
          // Unclosed: end it at its own line rather than folding the rest of
          // the file into the item's text, and say so, as the top level does.
          warnings.push({ file, line: i, kind: 'unclosed_comment' })
          i++
          continue
        }
        top.text += ` ${line.trim()}`
        top.endLine = i
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
    // end stays within start..lines.length - 1 by the loop guard above.
    const next = stripBlockquote(lines[end] as string)
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
  // Two mandatory capturing groups: a successful match always populates
  // both, so each cast is erased and adds no branch.
  const marker = m[2] as string
  const info = m[3] as string
  // A backtick fence's info string cannot itself contain a backtick.
  if (marker.startsWith('`') && info.includes('`')) return null
  // marker.length is always at least 3, so it always has a first character.
  return { char: marker[0] as string, length: marker.length, info }
}

/**
 * `quoted` is true when the fence opener was found on a blockquoted line: the
 * closer is then matched on the stripped line too, since `>` still prefixes
 * every line of the quoted fence body.
 */
const findFenceClose = (
  lines: string[],
  start: number,
  fence: FenceOpen,
  quoted: boolean,
): number => {
  for (let i = start; i <= lines.length; i++) {
    // i stays within start..lines.length by the loop guard above.
    const raw = lines[i - 1] as string
    const line = (quoted ? stripBlockquote(raw) : raw).trim()
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
 * block's text reads the way it would unnested. The `>` comes off first:
 * inside a blockquote it sits before that indentation, so stripping spaces
 * alone would leave the marker in the block's text.
 */
const readFence = (
  lines: string[],
  start: number,
  fence: FenceOpen,
  quoted: boolean,
  file: string,
  strip: number,
): { block: OpaqueBlock; endLine: number; closed: boolean } => {
  const close = findFenceClose(lines, start + 1, fence, quoted)
  const endLine = close > 0 ? close : lines.length
  const body = lines
    .slice(start, close > 0 ? close - 1 : lines.length)
    .map((l) => stripLeading(quoted ? stripBlockquote(l) : l, strip))
    .join('\n')
  const info = fence.info.trim()
  // A non-empty string always splits into at least one element, so the cast
  // is erased and adds no branch.
  const lang = info.length > 0 ? (info.split(/\s+/)[0] as string) : null
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
  // String.split always returns at least one element, even for '', so there
  // is no empty-array case here to guard against.
  return s.split('|').every((c) => /^:?-+:?$/.test(c.trim()))
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
    // i stays within start..lines.length by the loop guard above.
    const rowLine = stripBlockquote(lines[i - 1] as string)
    if (isBlank(rowLine) || !rowLine.includes('|')) break
    const cells = splitTableRow(rowLine)
    const text = headerCells
      .map((header, idx) => {
        const name = header.trim() === '' ? `col${idx + 1}` : header.trim()
        // A row can carry fewer cells than the header; a missing one reads
        // as empty rather than dropping the column.
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

// Called on every span before the caller's `end > start` filter runs, so a
// zero-length span (`start === end`) can reach here; the loop guards below,
// not a property of the filtered output, are what keep both reads in range.
const trimSpan = (text: string, span: Span): Span => {
  let { start, end } = span
  // start < end bounds the first read; end > start together with end never
  // exceeding text.length (every span's invariant) bounds the second.
  while (start < end && /\s/.test(text[start] as string)) start++
  while (end > start && /\s/.test(text[end - 1] as string)) end--
  return { start, end }
}

/**
 * Splits paragraph text into sentence spans. The rule: split at `.`, `?` or
 * `!` followed by whitespace and then an uppercase letter, a backtick, or
 * `[`, outside code spans and links, skipping the abbreviations in
 * `ABBREVIATIONS` (`e.g.`, `i.e.`, `etc.`, `vs.`).
 *
 * Called only on a paragraph's joined text, which always starts from a
 * non-blank line, so there is no blank-input case to guard against here.
 */
const splitSentences = (text: string): Span[] => {
  const mask = computeProtectedMask(text)
  const boundaries: { end: number; nextStart: number }[] = []
  const re = /[.?!]/g
  for (const m of text.matchAll(re)) {
    const idx = m.index
    if (mask[idx]) continue
    const after = idx + 1
    // The short-circuit above means text[after] is only read once after is
    // already known to be less than text.length.
    if (after >= text.length || !/\s/.test(text[after] as string)) continue
    let k = after
    // k < text.length is checked by the loop guard before each read.
    while (k < text.length && /\s/.test(text[k] as string)) k++
    if (k >= text.length) continue
    // The check above already ruled out k reaching text.length.
    const nextCh = text[k] as string
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
