// The contract between the audit plugin's pieces (#164, #171). Every module
// imports its shapes from here and from nowhere else, so the pieces can be
// written in parallel. Types only: nothing in this file has runtime meaning.
//
// The judgment types, Classification, ChoiceAnswer, Usage, and the verdict
// unions, are not here. `lib/jev.ts` defines them beside the client that
// produces them (#173). `report.ts` and `commands/context.ts` import them
// from there. They are not re-exported here. A second name for one type
// would be a second thing to keep in step.

export type RefKind = 'path' | 'file_line' | 'issue' | 'script' | 'command'

export type IssueState = 'OPEN' | 'CLOSED' | 'MERGED'

/** What an issue lookup says about one number. `unavailable` is "could not ask", never "absent". */
export type IssueLookup = IssueState | 'not_found' | 'unavailable'

/**
 * What the tree or GitHub says about a ref. One status field, so a reader can
 * never pair a path with the wrong meaning of `null`.
 */
export type Resolution =
  /** Never looked for, and why: a reader must be able to tell this from "fine". */
  | {
      status: 'unchecked'
      reason: 'not_resolved_yet' | 'no_resolver' | 'machine_specific' | 'pattern' | 'unavailable'
    }
  /** Looked for and not there: the finding the audit exists to report. */
  | { status: 'absent' }
  /** Exists. `repoPath` is the path relative to the audited root, null for a script. */
  | { status: 'found'; repoPath: string | null }
  /**
   * Not where it is written. But the written path is the tail of exactly
   * the tracked paths named by `witness` (the first of them). Prose names
   * paths relative to a context the reader supplies. So this is neither
   * found nor absent.
   */
  | { status: 'tail_match'; witness: string }
  /** The file exists and is shorter than the line the ref names. */
  | { status: 'line_out_of_range'; repoPath: string; lines: number }
  | { status: 'issue'; state: IssueState }
  /** A path that exists only as a file this repository's own .gitignore excludes. */
  | { status: 'ignored' }

/** A reference found in a unit's text. */
export type Ref = {
  kind: RefKind
  /** The text as written, without backticks: `lib/git.ts`, `CLAUDE.md:115`, `#138`, `pnpm test`. */
  value: string
  resolution: Resolution
}

export type BlockKind = 'list_item' | 'sentence' | 'table_row'

/**
 * One checkable unit of a markdown file. Never paraphrased. The audit joins
 * hard-wrapped lines with one space, and removes list, quote and table
 * markers. But the words are always the source's own.
 */
export type Unit = {
  /**
   * Unique within a run: `<file>:<startLine>-<endLine>`, 1-indexed and
   * inclusive. The audit appends `#<n>` (n from 2) for the second and later
   * units that share one span. Two sentences on one source line are an
   * example.
   */
  id: string
  /** Path relative to the root the audit was given. */
  file: string
  startLine: number
  endLine: number
  block: BlockKind
  /** Headings above the unit, outermost first, without the `#` marks. */
  headingPath: string[]
  /**
   * For a nested list item, its parent item's text. For a top-level item,
   * the whole paragraph that ends in `:` and introduces the list. A lead-in
   * paragraph is never a unit of its own.
   */
  leadIn: string | null
  /**
   * The text of the unit before and after this one, in document order. This
   * applies only when it shares this unit's `headingPath`. It is null at a
   * section's edge.
   */
  prev: string | null
  next: string | null
  /** For a table row, the cells as `header: cell` lines; otherwise the normalised source. */
  text: string
  /** Empty from the splitter; tier 0 fills it. */
  refs: Ref[]
}

/** A block that never goes to the model: tier 0 reads its refs and nothing else does. */
export type OpaqueBlock = {
  file: string
  startLine: number
  endLine: number
  kind: 'code' | 'frontmatter' | 'mermaid'
  /** The fence's info string's first word (`bash`, `ts`), or null. */
  lang: string | null
  text: string
  refs: Ref[]
}

/** Something the splitter could not read as written, so the file's unit count is not to be trusted. */
export type SplitWarning = {
  file: string
  line: number
  kind: 'unclosed_fence' | 'unclosed_comment'
}

export type SplitResult = { units: Unit[]; opaque: OpaqueBlock[]; warnings: SplitWarning[] }
