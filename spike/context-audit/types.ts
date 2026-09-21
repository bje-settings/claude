// The contract between the POC's pieces (#164). Every module imports its
// shapes from here and from nowhere else, so the pieces can be written in
// parallel. Types only: nothing in this file has runtime meaning.

/** A reference found in a unit's text, and what the tree or GitHub says about it. */
export type RefKind = 'path' | 'file_line' | 'issue' | 'script' | 'command'

export type Ref = {
  kind: RefKind
  /** The text as written, without backticks: `lib/git.ts`, `CLAUDE.md:115`, `#138`, `pnpm test`. */
  value: string
  /**
   * true: the target exists (path on disk, line within the file, script in
   * package.json, issue found). false: looked for and absent. null: not
   * checked (no resolver for this kind, or the lookup was unavailable).
   */
  resolved: boolean | null
  /** For `issue`: OPEN or CLOSED. For `path`: the repo-relative path it resolved to. */
  detail: string | null
}

export type BlockKind = 'list_item' | 'sentence' | 'table_row'

/** One checkable unit of a markdown file. Never rewritten: `text` is the source, verbatim. */
export type Unit = {
  /** `<file>:<startLine>-<endLine>`, 1-indexed, lines inclusive. */
  id: string
  /** Path relative to the audited repository's root. */
  file: string
  startLine: number
  endLine: number
  block: BlockKind
  /** Headings above the unit, outermost first, without the `#` marks. */
  headingPath: string[]
  /** The parent list item's text, or the line ending in `:` that introduces the list. */
  leadIn: string | null
  /** The neighbouring units' text within the same section, for resolving "it" and "that". */
  prev: string | null
  next: string | null
  /** For a table row this is the JSON rendering `{header: cell}`; otherwise the markdown source. */
  text: string
  /** Filled by tier 0; the splitter leaves it empty. */
  refs: Ref[]
}

/** A block that never goes to the model: tier 0 reads its refs and nothing else does. */
export type OpaqueBlock = {
  file: string
  startLine: number
  endLine: number
  kind: 'code' | 'frontmatter' | 'mermaid'
  /** The fence's info string (`bash`, `ts`), or null. */
  lang: string | null
  text: string
  refs: Ref[]
}

export type SplitResult = { units: Unit[]; opaque: OpaqueBlock[] }

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

/** A Choice answer in neutral form: the pick, its distribution, and the API's confidence. */
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

/** Two units worth comparing, chosen by code before any model call. */
export type PairCandidate = { a: string; b: string; similarity: number }

export type PairJudgment = PairCandidate & { verdict: ChoiceAnswer<PairVerdict> }

export type EvidenceVerdict = 'supports' | 'contradicts' | 'says_nothing'

export type EvidenceJudgment = {
  unitId: string
  /** The repo-relative file the excerpt came from, and the excerpt itself. */
  source: string
  excerpt: string
  verdict: ChoiceAnswer<EvidenceVerdict>
}

/** What a run spent, so the spike can report cost and time. */
export type Usage = { requests: number; inputTokens: number; outputTokens: number; ms: number }

export type Report = {
  root: string
  files: string[]
  units: Unit[]
  opaque: OpaqueBlock[]
  classifications: Classification[]
  pairs: PairJudgment[]
  evidence: EvidenceJudgment[]
  usage: Usage
}
