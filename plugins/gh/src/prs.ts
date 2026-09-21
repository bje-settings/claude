// Reading merge proof out of a `gh pr list` result: the port of
// `plugins/gh/scripts/lib/prs.py`, which is itself the jq program the shell
// version of gh-sync-repo ran.
//
// Three things are required of a pull request before it counts as proof that a
// local branch has landed, because a bare branch-name match is not evidence
// about your commits:
//
//   - it merged into the default branch, not into some other branch
//   - it came from this repository, not from a fork (a fork's PR head ref is
//     just a name like "patch-1", which collides with local branches
//     trivially)
//   - its head commit is exactly where the local branch still points, so a
//     branch that was reused or committed to after the merge is not treated as
//     landed
//
// The base is filtered server-side by `--base`, so only the last two live
// here. Forks are dropped by {@link ownRows} rather than by the query, so the
// row count the caller checks against the lookup limit stays the real number
// of pull requests the window returned.

/**
 * One row, as far as this file reads it.
 *
 * Every field is optional and `unknown`, because these rows arrive from a
 * process boundary: `lib/gh.ts` proves the answer is a JSON array and nothing
 * more, so a row missing `headRefName`, or carrying a number where a string
 * belongs, is a shape this file has to answer about rather than assume away. A
 * strict interface here would be a claim about someone else's JSON that
 * nothing checks.
 */
export interface PullRequestRow {
  readonly headRefName?: unknown
  readonly headRefOid?: unknown
  readonly isCrossRepository?: unknown
}

/**
 * Whether `value` is a row at all, which is the check
 * `gh-sync-repo.py:316` makes before any of the readers below touch a list.
 *
 * "Every reader below calls .get on a row. A payload that is a list of
 * something else is not an answer about merged pull requests, so it takes the
 * same route a failed query does rather than crashing here or, worse, being
 * read as an empty window."
 */
export const isPullRequestRow = (value: unknown): value is PullRequestRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The rows from this repository, dropping forks.
 *
 *  A missing `isCrossRepository` is not a fork: treating it as one would keep
 *  every branch, which `tests/gh/test_lib_prs.py` pins by name. The Python
 *  reads the field for truth rather than for `True` (`not
 *  row.get("isCrossRepository")`) and so does this, so a row carrying anything
 *  other than a false-like value is still treated as a fork, which is the safe
 *  direction: a fork mistaken for a local branch is somebody's branch deleted.
 */
export const ownRows = (rows: readonly PullRequestRow[]): PullRequestRow[] =>
  rows.filter((row) => !row.isCrossRepository)

/** Does any row name this branch AT this commit? */
export const hasMatch = (rows: readonly PullRequestRow[], branch: string, sha: string): boolean =>
  rows.some((row) => row.headRefName === branch && row.headRefOid === sha)

/** Does any row name this branch, at any commit? */
export const namesBranch = (rows: readonly PullRequestRow[], branch: string): boolean =>
  rows.some((row) => row.headRefName === branch)
