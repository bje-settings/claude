// This file reads merge proof out of a `gh pr list` result. It is the
// port of `plugins/gh/scripts/lib/prs.py`, which is itself the jq program
// that the shell version of gh-sync-repo ran.
//
// A pull request must meet three conditions before it counts as proof that
// a local branch has landed. A bare branch-name match is not evidence
// about your commits:
//
//   - its merge commit is on the default branch. A stacked pull request
//     keeps its parent branch as its base, so the base alone says nothing
//     (#348). A merge into a parent that never landed is not proof.
//   - it came from this repository, not from a fork. (A fork's PR head
//     ref is just a name like "patch-1". This name collides with local
//     branches easily.)
//   - every commit of the local branch is in its head: the same commit, or
//     a patch-equal one after a rebase (#351, #450). A branch that was
//     reused, or had a commit added after the merge, does not count as
//     landed
//
// The query asks for every base. {@link ownRows} drops forks, not the query.
// This keeps the row count real. The caller checks that count against the
// lookup limit. It stays the true number of pull requests the window
// returned. The first and last conditions need git, so `sync-repo` checks
// them. This file only reads the fields they need.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from
// the tree. The file and line references below point to what they held at
// `cd0d515`. Each stays because it says where a rule came from.

/**
 * One row, as far as this file reads it.
 *
 * Every field is optional and `unknown`, because these rows arrive from a
 * process boundary. `lib/gh.ts` proves only that the answer is a JSON
 * array, nothing more. A row might miss `headRefName`, or carry a number
 * where a string belongs. This file must answer for that shape, not assume
 * it away. A strict interface here would be a claim about someone else's
 * JSON that nothing checks.
 */
export interface PullRequestRow {
  readonly headRefName?: unknown
  readonly headRefOid?: unknown
  readonly isCrossRepository?: unknown
  readonly number?: unknown
  /** gh answers `{ oid }`. */
  readonly mergeCommit?: unknown
}

/** A full commit SHA, SHA-1 or SHA-256. A field from gh goes into a git argv
 *  only through this check, so an answer that starts with `-` can never
 *  read as a flag. */
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Whether `value` is a full commit SHA. */
export const isOid = (value: unknown): value is string =>
  typeof value === 'string' && OID.test(value)

/** The SHA of the row's merge commit, or `null` when the row has none that
 *  git can read. A row with no merge commit proves no merge. */
export const mergeCommitOf = (row: PullRequestRow): string | null => {
  const oid = (row.mergeCommit as { oid?: unknown } | null | undefined)?.oid
  return isOid(oid) ? oid : null
}

/** The ref that holds the row's head on GitHub, or `null` when the row has
 *  no number. GitHub keeps this ref after the merge (ruling 6, #450). */
export const pullRefOf = (row: PullRequestRow): string | null =>
  Number.isInteger(row.number) ? `refs/pull/${row.number}/head` : null

/**
 * Whether `value` is a row at all. This is the check `gh-sync-repo.py:316`
 * makes before any reader below touches a list.
 *
 * "Every reader below calls .get on a row. A payload that is a list of
 * something else is not an answer about merged pull requests, so it takes the
 * same route a failed query does rather than crashing here or, worse, being
 * read as an empty window."
 */
export const isPullRequestRow = (value: unknown): value is PullRequestRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The rows from this repository. This function drops forks.
 *
 *  This code reads a missing `isCrossRepository` as not a fork, so it
 *  keeps every such branch. `tests/gh/test_lib_prs.py` pins that
 *  behaviour by name. The Python reads the field for truth, not for
 *  `True` (`not row.get("isCrossRepository")`), and so does this file. A
 *  row with anything other than a false-like value still counts as a
 *  fork. This is the safe direction: a fork mistaken for a local branch
 *  means somebody's branch gets deleted.
 */
export const ownRows = (rows: readonly PullRequestRow[]): PullRequestRow[] =>
  rows.filter((row) => !row.isCrossRepository)

/** Does any row name this branch AT this commit? */
export const hasMatch = (rows: readonly PullRequestRow[], branch: string, sha: string): boolean =>
  rows.some((row) => row.headRefName === branch && row.headRefOid === sha)

/** Does any row name this branch, at any commit? */
export const namesBranch = (rows: readonly PullRequestRow[], branch: string): boolean =>
  rows.some((row) => row.headRefName === branch)
