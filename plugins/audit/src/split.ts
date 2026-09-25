// A hand-rolled, line-based markdown splitter (#164, #171). It has no
// dependencies: it uses only node built-ins, so a reader can audit tier 0 in
// this one file. It trades full CommonMark generality for rules that are
// simple to verify by hand against the fixtures in tests/plugins/audit/split.test.ts.

import type { OpaqueBlock, SplitResult, SplitWarning, Unit } from './types.ts'

type HeadingFrame = { level: number; text: string }

/** A unit before `assignIds` and `withNeighbours` fill the remaining fields. */
type DraftUnit = Omit<Unit, 'id' | 'prev' | 'next'>

// The three outputs that grow, plus the file they all name. The code threads
// them as one value. Every helper that emits anything needs all four fields.
// A helper that emits into them has no other result to return.
type Sink = {
  file: string
  units: DraftUnit[]
  opaque: OpaqueBlock[]
  warnings: SplitWarning[]
}

// One list item under construction while the parser scans a list block. It
// stays mutable until the list block finishes, and then it becomes a Unit.
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
  const sink: Sink = { file, units: [], opaque: [], warnings: [] }
  const total = lines.length

  const headingStack: HeadingFrame[] = []
  let i = 1

  const frontmatter = readFrontmatter(lines, file)
  if (frontmatter !== null) {
    sink.opaque.push(frontmatter)
    i = frontmatter.endLine + 1
  }

  while (i <= total) {
    // i stays within 1..total by construction, so the index is always in range.
    const raw = lines[i - 1] as string
    const line = stripBlockquote(raw)

    if (isBlank(line) || isHtmlCommentFull(line)) {
      i++
      continue
    }

    if (isHtmlCommentOpen(line)) {
      const closed = skipHtmlComment(lines, i)
      if (closed.next < 0) {
        // Unclosed comment: end it at its own line. Do not swallow everything
        // after it. Report a warning.
        sink.warnings.push({ file, line: i, kind: 'unclosed_comment' })
        i++
        continue
      }
      if (closed.trailing !== null) {
        // Prose after `-->` on the closing line is real content. The code rewrites
        // that line in place, so the outer loop parses it fresh, at its own line
        // number.
        lines[closed.next - 1] = closed.trailing
        i = closed.next
      } else {
        i = closed.next + 1
      }
      continue
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      i = takeFence(sink, lines, i, fence, raw !== line, 0)
      continue
    }

    const heading = matchHeading(line)
    if (heading) {
      // The loop stops at the top frame that is shallower than the new heading.
      // It also stops when the stack empties. Both are real outcomes, not a
      // fallback. The loop reads the top value fresh each time. It does not
      // default a missing value to level 0.
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

    const headingPath = headingStack.map((h) => h.text)

    // A pipe line at EOF has no next line to check for a separator. As a
    // result, it can never open a table.
    const headerCells = i < total ? matchTableHeader(line, lineAt(lines, i + 1)) : null
    if (headerCells) {
      // The header's own line and the separator under it are not units.
      i = readTableRows(sink, lines, i + 2, headerCells, headingPath)
      continue
    }

    if (matchListMarker(line)) {
      i = parseListBlock(sink, lines, i, headingPath, null)
      continue
    }

    const paraStart = i
    const paraEnd = paragraphEnd(lines, i)
    const paraLines: string[] = []
    // k stays within paraStart..paraEnd, and paraEnd never exceeds total.
    for (let k = paraStart; k <= paraEnd; k++) paraLines.push(lineAt(lines, k))
    const joined = paraLines.join(' ').trim()

    // "Directly before a list" also matches across blank lines. A blank line, or
    // several, between a lead-in paragraph and the list it introduces is still
    // tolerated. Both loops stay within afterBlank <= total.
    let afterBlank = paraEnd + 1
    while (afterBlank <= total && isBlank(lineAt(lines, afterBlank))) afterBlank++
    const afterRaw = afterBlank <= total ? lineAt(lines, afterBlank) : null

    if (afterRaw !== null && matchListMarker(afterRaw) !== null && joined.endsWith(':')) {
      // A lead-in paragraph is never a unit; it becomes the leadIn for the
      // list that follows it.
      i = parseListBlock(sink, lines, afterBlank, headingPath, joined)
      continue
    }

    const { text: paraText, map } = buildLineMap(paraLines, paraStart)
    for (const span of splitSentences(paraText)) {
      // Every kept span has end > start and end <= paraText.length. Both offsets
      // always land inside map, which buildLineMap sized to match.
      sink.units.push({
        file,
        startLine: map[span.start] as number,
        endLine: map[span.end - 1] as number,
        block: 'sentence',
        headingPath,
        leadIn: null,
        text: paraText.slice(span.start, span.end),
        refs: [],
      })
    }
    i = paraEnd + 1
  }

  return {
    units: withNeighbours(assignIds(file, sink.units)),
    opaque: sink.opaque,
    warnings: sink.warnings,
  }
}

/** Splits on \n, \r\n and bare \r. It does not drop a trailing empty line's count. */
const splitLines = (source: string): string[] => {
  if (source === '') return []
  return source.split(/\r\n|\r|\n/)
}

const isBlank = (line: string): boolean => line.trim() === ''

/** Strips one level of `>` blockquote marker. This function does not model nested quoting. */
const stripBlockquote = (line: string): string => {
  const m = line.match(/^(\s*)>\s?(.*)$/)
  // The trailing `.*` always matches, even against an empty remainder. So a
  // successful match always populates group 2. The cast is erased and adds
  // no branch.
  return m ? (m[2] as string) : line
}

/** The 1-based line `no`, unquoted. Every caller has already bounded `no` to
 *  1..lines.length, so the cast is erased and adds no branch. */
const lineAt = (lines: string[], no: number): string => stripBlockquote(lines[no - 1] as string)

/** The length of a line's leading run of spaces and tabs. The regex match
 *  needs no fallback for TypeScript's sake. `\s*` always matches, so the
 *  fallback could never fire. */
const leadingSpaces = (line: string): number => line.length - line.trimStart().length

// A line that is one comment and nothing else: the first `-->` is the end of
// the line. It uses plain string tests, not a pattern. This way the parser
// does not swallow prose between two comments, for example
// `<!-- a --> text <!-- b -->`.
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
  return { level: marks.length, text: rest.replace(/\s+#+\s*$/, '').trim() }
}

type ListMatch = { indent: number; content: string; contentColumn: number }

const matchListMarker = (line: string): ListMatch | null => {
  const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/)
  if (!m) return null
  // Four mandatory capturing groups. A successful match always populates all
  // of them, so each cast is erased and adds no branch.
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
 * Scans a list block that starts at `start`. It pushes one `list_item` unit
 * per item onto the sink. It returns the line to resume the outer loop from.
 */
const parseListBlock = (
  sink: Sink,
  lines: string[],
  start: number,
  headingPath: string[],
  topLeadIn: string | null,
): number => {
  const stack: OpenItem[] = []
  // The order in which items finish, that is, when they are popped, depends
  // on list structure. It does not depend on where they started in the
  // source. A sibling can close before its parent does. This code collects
  // finished items here and sorts them by startLine at the end. Units then
  // come out in true document order, regardless of pop order.
  const finished: OpenItem[] = []
  const total = lines.length
  let i = start

  // Pops the stack while the top item is at least as deep as `indent`. It
  // reads the top value fresh on each pass. It does not default a missing
  // value to -1. An empty stack is a real stopping condition, not a
  // fallback value.
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
      while (peek <= total && isBlank(lineAt(lines, peek))) peek++
      const nextLine = peek <= total ? lineAt(lines, peek) : null
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
      // This closes any open item at this depth or deeper. A same-indent
      // line is a sibling of the item it replaces, not its continuation.
      popTo(marker.indent)
      const parent = stack[stack.length - 1]
      stack.push({
        indent: marker.indent,
        contentColumn: marker.contentColumn,
        text: marker.content,
        startLine: i,
        endLine: i,
        leadIn: parent ? parent.text : topLeadIn,
      })
      i++
      continue
    }

    // The code reads it once and shares it between the fence check and the
    // continuation check below. Both checks need "the item this line might
    // belong to." A check of stack.length > 0 would only ask the same
    // question through the array length.
    const top = stack[stack.length - 1]

    const fence = matchFenceOpen(line)
    if (fence && top !== undefined) {
      const resume = takeFence(sink, lines, i, fence, raw !== line, top.contentColumn)
      // The fence closes whatever item held it. Continuation resumes as a
      // new paragraph. It is not folded back into the item's text.
      popTo(0)
      i = resume
      continue
    }

    if (top !== undefined && !matchHeading(line) && !isThematicBreak(line)) {
      const lineIndent = leadingSpaces(line)
      if (lineIndent >= top.contentColumn) {
        if (isHtmlCommentOpen(line) && skipHtmlComment(lines, i).next < 0) {
          // Unclosed comment: end it at its own line. Do not fold the rest
          // of the file into the item's text. Report the warning, as the
          // top level does.
          sink.warnings.push({ file: sink.file, line: i, kind: 'unclosed_comment' })
          i++
          continue
        }
        top.text += ` ${line.trim()}`
        top.endLine = i
        i++
        continue
      }
    }

    break
  }

  popTo(0)

  finished.sort((a, b) => a.startLine - b.startLine)
  for (const item of finished) {
    sink.units.push({
      file: sink.file,
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

/** The last line of the hard-wrapped paragraph that starts at `start`. The
 *  scan stops before the first line that opens a different kind of block, or
 *  at EOF. */
const paragraphEnd = (lines: string[], start: number): number => {
  let end = start
  while (end + 1 <= lines.length) {
    const next = lineAt(lines, end + 1)
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

/** The paragraph's joined text, with one map entry per character; each entry
 *  gives the source line that character came from. */
const buildLineMap = (
  paraLines: string[],
  startLineNo: number,
): { text: string; map: number[] } => {
  let text = ''
  const map: number[] = []
  paraLines.forEach((line, idx) => {
    // Every line but the last carries the joining space, which belongs to the
    // line before it.
    const chunk = idx < paraLines.length - 1 ? `${line} ` : line
    text += chunk
    // Indexed by UTF-16 code unit, not code point. `text`'s length and every
    // offset that splitSentences reads from it (`.length`, match indices) are
    // code units too. A surrogate pair must still cost exactly one map entry
    // per unit. Otherwise later offsets drift off the end of map.
    for (let k = 0; k < chunk.length; k++) map.push(startLineNo + idx)
  })
  return { text, map }
}

type FenceOpen = { char: string; length: number; info: string }

const matchFenceOpen = (line: string): FenceOpen | null => {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
  if (!m) return null
  // Two mandatory capturing groups: a successful match always populates
  // both, so each cast is erased and adds no branch.
  const marker = m[1] as string
  const info = m[2] as string
  // A backtick fence's info string cannot itself contain a backtick.
  if (marker.startsWith('`') && info.includes('`')) return null
  // marker.length is always at least 3, so it always has a first character.
  return { char: marker[0] as string, length: marker.length, info }
}

/**
 * `quoted` is true when the fence opener sits on a blockquoted line. Then
 * the closer must also match on the stripped line. This is because `>`
 * still prefixes every line of the quoted fence body.
 */
const findFenceClose = (
  lines: string[],
  start: number,
  fence: FenceOpen,
  quoted: boolean,
): number => {
  const re = fence.char === '`' ? /^`{3,}$/ : /^~{3,}$/
  for (let i = start; i <= lines.length; i++) {
    // i stays within start..lines.length by the loop guard above.
    const raw = lines[i - 1] as string
    const line = (quoted ? stripBlockquote(raw) : raw).trim()
    if (re.test(line) && line.length >= fence.length) return i
  }
  return -1
}

/**
 * Pushes the opaque block that a fence opener on line `start` produces. It
 * warns when nothing closes the fence; the block then ends at the last line
 * of the file. It returns the line the caller resumes from. It serves both
 * fence sites, at the top level and inside a list item, which differ only
 * in `strip`.
 *
 * `strip` undoes the indentation of the list item that contains the fence.
 * A nested block's text then reads the way it would if it were not nested.
 * The `>` comes off first. Inside a blockquote it sits before that
 * indentation. If the code stripped spaces alone, the marker would stay in
 * the block's text.
 */
const takeFence = (
  sink: Sink,
  lines: string[],
  start: number,
  fence: FenceOpen,
  quoted: boolean,
  strip: number,
): number => {
  const close = findFenceClose(lines, start + 1, fence, quoted)
  const closed = close > 0
  const endLine = closed ? close : lines.length
  const body = lines
    .slice(start, closed ? close - 1 : lines.length)
    .map((l) => stripLeading(quoted ? stripBlockquote(l) : l, strip))
    .join('\n')
  const info = fence.info.trim()
  // A non-empty string always splits into at least one element, so the cast
  // is erased and adds no branch.
  const lang = info.length > 0 ? (info.split(/\s+/)[0] as string) : null
  if (!closed) sink.warnings.push({ file: sink.file, line: start, kind: 'unclosed_fence' })
  sink.opaque.push({
    file: sink.file,
    startLine: start,
    endLine,
    kind: lang?.toLowerCase() === 'mermaid' ? 'mermaid' : 'code',
    lang,
    text: body,
    refs: [],
  })
  return endLine + 1
}

/** Removes up to `n` leading spaces, never more than the line actually has. */
const stripLeading = (line: string, n: number): string => {
  let cut = 0
  while (cut < n && line[cut] === ' ') cut++
  return line.slice(cut)
}

const matchTableHeader = (line: string, next: string): string[] | null => {
  if (!line.includes('|') || !isTableSeparator(next)) return null
  return splitTableRow(line)
}

// A separator row has no cell content, so its trailing pipe is
// unconditional. Unlike a body row, it can never end in an escaped `\|`.
const isTableSeparator = (line: string): boolean => {
  let s = line.trim()
  if (s === '') return false
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // String.split always returns at least one element, even for '', so there
  // is no empty-array case here to guard against.
  return s.split('|').every((c) => /^:?-+:?$/.test(c.trim()))
}

/** The number of consecutive backticks that start at `from`. */
const backtickRun = (text: string, from: number): number => {
  let n = 0
  while (text[from + n] === '`') n++
  return n
}

/** Splits a table row on unescaped, non-code-span pipes. */
const splitTableRow = (line: string): string[] => {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  // A trailing `\|` is an escaped pipe inside the last cell, not a terminator.
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let openBackticks = 0
  let idx = 0
  while (idx < s.length) {
    const ch = s[idx]
    if (ch === '`') {
      const runLen = backtickRun(s, idx)
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

/** One unit per body row of a table. This runs from `start` to the first
 *  line that is blank or carries no pipe. Each row's text pairs the
 *  header's own cell names with the row's values. It returns the line to
 *  resume from. */
const readTableRows = (
  sink: Sink,
  lines: string[],
  start: number,
  headerCells: string[],
  headingPath: string[],
): number => {
  let i = start
  while (i <= lines.length) {
    const rowLine = lineAt(lines, i)
    if (isBlank(rowLine) || !rowLine.includes('|')) break
    const cells = splitTableRow(rowLine)
    const text = headerCells
      .map((header, idx) => {
        const name = header.trim() === '' ? `col${idx + 1}` : header.trim()
        // A row can carry fewer cells than the header. A missing one reads
        // as empty; it does not drop the column.
        return `${name}: ${(cells[idx] ?? '').trim()}`
      })
      .join('\n')
    sink.units.push({
      file: sink.file,
      startLine: i,
      endLine: i,
      block: 'table_row',
      headingPath,
      leadIn: null,
      text,
      refs: [],
    })
    i++
  }
  return i
}

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.']

type Span = { start: number; end: number }

/** Marks offsets that fall inside an inline code span or a markdown link. */
const computeProtectedMask = (text: string): boolean[] => {
  const mask = new Array<boolean>(text.length).fill(false)
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const runLen = backtickRun(text, i)
      let j = i + runLen
      let closeStart = -1
      while (j < text.length) {
        if (text[j] === '`') {
          const closeLen = backtickRun(text, j)
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

// The code calls this on every span before the caller's `end > start`
// filter runs. So a zero-length span (`start === end`) can reach here. The
// loop guards keep both reads in range. `start < end` bounds the first
// read. `end > start`, with end no greater than text.length (every span's
// invariant), bounds the second read.
const trimSpan = (text: string, span: Span): Span => {
  let { start, end } = span
  while (start < end && /\s/.test(text[start] as string)) start++
  while (end > start && /\s/.test(text[end - 1] as string)) end--
  return { start, end }
}

/**
 * Splits paragraph text into sentence spans. The rule: the code splits at
 * `.`, `?` or `!` when whitespace follows. It also requires an uppercase
 * letter, a backtick, or `[` right after that whitespace. It works outside
 * code spans and links. It skips the abbreviations in `ABBREVIATIONS`
 * (`e.g.`, `i.e.`, `etc.`, `vs.`).
 *
 * The code calls this function only on a paragraph's joined text. That text
 * always starts from a non-blank line, so there is no blank-input case to
 * guard against here.
 */
const splitSentences = (text: string): Span[] => {
  const mask = computeProtectedMask(text)
  const spans: Span[] = []
  let start = 0
  for (const m of text.matchAll(/[.?!]/g)) {
    const idx = m.index
    if (mask[idx]) continue
    const after = idx + 1
    // The short-circuit above means text[after] is only read once after is
    // already known to be less than text.length.
    if (after >= text.length || !/\s/.test(text[after] as string)) continue
    let k = after
    // The loop guard checks k < text.length before each read.
    while (k < text.length && /\s/.test(text[k] as string)) k++
    if (k >= text.length) continue
    // The check above already shows that k cannot reach text.length.
    const nextCh = text[k] as string
    if (!/[A-Z`[]/.test(nextCh)) continue
    if (text[idx] === '.' && isAbbreviation(text, idx)) continue
    spans.push({ start, end: after })
    start = k
  }
  spans.push({ start, end: text.length })

  return spans.map((s) => trimSpan(text, s)).filter((s) => s.end > s.start)
}

/**
 * Assigns ids in document order. The first unit on a span gets
 * `<file>:<start>-<end>`. Later units that share the same span get `#2`,
 * `#3`, and so on. This happens, for example, when two sentences sit on one
 * source line.
 */
const assignIds = (file: string, units: DraftUnit[]): Omit<Unit, 'prev' | 'next'>[] => {
  const seen = new Map<string, number>()
  return units.map((unit) => {
    const span = `${unit.startLine}-${unit.endLine}`
    const count = (seen.get(span) ?? 0) + 1
    seen.set(span, count)
    const id = count === 1 ? `${file}:${span}` : `${file}:${span}#${count}`
    return { ...unit, id }
  })
}

const samePath = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, k) => v === b[k])

/** Fills prev/next from the neighbouring unit under the same heading path. */
const withNeighbours = (units: Omit<Unit, 'prev' | 'next'>[]): Unit[] => {
  return units.map((unit, idx) => {
    const prevUnit = units[idx - 1]
    const nextUnit = units[idx + 1]
    const prev = prevUnit && samePath(prevUnit.headingPath, unit.headingPath) ? prevUnit.text : null
    const next = nextUnit && samePath(nextUnit.headingPath, unit.headingPath) ? nextUnit.text : null
    return { ...unit, prev, next }
  })
}
