// The contract between the POC's pieces (#164). Every module imports its
// shapes from here and from nowhere else, so the pieces can be written in
// parallel. Types only: nothing in this file has runtime meaning.

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
   * Not where it is written, but the written path is the tail of exactly the
   * tracked paths named by `witness` (the first of them). Prose names paths
   * relative to a context the reader supplies, so this is neither found nor absent.
   */
  | { status: 'tail_match'; witness: string }
  /** The file exists and is shorter than the line the ref names. */
  | { status: 'line_out_of_range'; repoPath: string; lines: number }
  | { status: 'issue'; state: IssueState }

/** A reference found in a unit's text. */
export type Ref = {
  kind: RefKind
  /** The text as written, without backticks: `lib/git.ts`, `CLAUDE.md:115`, `#138`, `pnpm test`. */
  value: string
  resolution: Resolution
}

export type BlockKind = 'list_item' | 'sentence' | 'table_row'

/**
 * One checkable unit of a markdown file. Never paraphrased: hard-wrapped lines
 * are joined with one space and list, quote and table markers are removed, but
 * the words are the source's own.
 */
export type Unit = {
  /**
   * Unique within a run. `<file>:<startLine>-<endLine>`, 1-indexed and
   * inclusive, with `#<n>` appended (n from 2) for the second and later units
   * that share one span, as two sentences on one source line do.
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
   * For a nested list item, its parent item's text. For a top-level item, the
   * whole paragraph ending in `:` that introduces the list. A lead-in paragraph
   * is never a unit of its own.
   */
  leadIn: string | null
  /**
   * The text of the unit before and after this one in document order, when it
   * shares this unit's `headingPath`; null at a section's edge.
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

export type UnitKind =
  | 'repo_fact'
  | 'external_fact'
  | 'instruction'
  | 'rationale'
  | 'history'
  | 'pointer'
  | 'structural'

export type EvidenceNeed =
  | 'file_exists'
  | 'file_contents'
  | 'config_value'
  | 'github_state'
  | 'nothing_local'

/** A Choice answer in neutral form: the pick, its distribution over every option, and the API's confidence. */
export type ChoiceAnswer<T extends string> = {
  choice: T
  probabilities: Record<T, number>
  confidence: number
}

/** Tier 1's per-unit judgments. Nouls are P(yes). */
export type Classification = {
  unitId: string
  kind: ChoiceAnswer<UnitKind>
  volatile: number
  selfContained: number
  evidenceNeed: ChoiceAnswer<EvidenceNeed>
  multiAssertion: number
}

export type PairVerdict = 'same_claim' | 'contradicts' | 'unrelated'

/** Two units worth comparing, chosen by code before any model call. `a` and `b` are unit ids. */
export type PairCandidate = { a: string; b: string; similarity: number }

export type PairJudgment = PairCandidate & { verdict: ChoiceAnswer<PairVerdict> }

export type EvidenceVerdict = 'supports' | 'contradicts' | 'says_nothing'

export type EvidenceJudgment = {
  unitId: string
  /** The file the excerpt came from, relative to the audited root, and the excerpt itself. */
  source: string
  excerpt: string
  verdict: ChoiceAnswer<EvidenceVerdict>
}

/** What the model calls of a run spent. */
export type Usage = {
  /** Logical calls: one per `ask`, however many times it was retried. */
  requests: number
  /** HTTP attempts, retries included. */
  attempts: number
  inputTokens: number
  outputTokens: number
  /**
   * The sum of every call's own duration, backoff sleeps included and queue
   * wait excluded. With calls running concurrently this exceeds wall clock.
   */
  requestMsSum: number
}

export type Stage = 'classify' | 'pairs' | 'evidence'

export type SkippedStage = { stage: Stage; reason: 'no_jev' | 'classify_failed' }

/** A model call that failed; the run carries on and reports it. */
export type StageFailure = { stage: Stage; id: string; message: string }

/** How much of a stage's work was done, so "0 found" can be told from "0 looked at". */
export type Coverage = { judged: number; available: number }

export type Report = {
  root: string
  files: string[]
  units: Unit[]
  opaque: OpaqueBlock[]
  warnings: SplitWarning[]
  /** `ok`, or why no issue state could be read. */
  issueLookup: string
  /** Stages that did not run at all, and why. */
  skipped: SkippedStage[]
  classifications: Classification[]
  pairs: PairJudgment[]
  pairCoverage: Coverage
  evidence: EvidenceJudgment[]
  /** `available` counts repo_fact units; those with no readable source file are in neither `judged` nor a failure. */
  evidenceCoverage: Coverage
  failures: StageFailure[]
  usage: Usage
  wallClockMs: number
}
