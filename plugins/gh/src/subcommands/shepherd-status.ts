// What `/gh:shepherd` would work on in one repository. This is the port of
// `plugins/gh/scripts/gh-shepherd-status.py`.
//
// This command writes one JSON document on stdout and changes nothing.
// Every decision it makes about a pull request is a function in
// `../shepherd.ts`, with its own named test. What is here is the order the
// questions are asked in, and what each refusal says.
//
// The command function is the seam (ADR 001): arguments, the environment,
// an injected `gh` and the output writers go in, and an exit status comes
// out. Nothing is spawned, and no `gh` is on PATH.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from
// the tree. The file and line references below point at what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.
import { GhError, type RequiredReviews } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import {
  autoMergeBases,
  ciSeconds,
  directoryRefusal,
  isTruthy,
  oneLine,
  readReviewRules,
  readUnresolvedThreads,
  type ShepherdContext,
  type ShepherdExit,
  statusDocument,
  threadReads,
} from '../shepherd.ts'

/** How far back the CI-duration sample reaches. Twenty runs cover a few
 *  days on an active repository, and still cost one API call. */
const RUN_SAMPLE = 20

/** The listing window for open pull requests. A repository with more than
 *  this open at once needs a label to narrow the window, rather than a
 *  bigger number here. gh pages the request itself. */
const PR_LIMIT = 500

export const HELP = `What /gh:shepherd would work on in one repository.

Usage:
  gh.ts shepherd-status [path] [label] [--all]

Prints one JSON document and changes nothing:

  repo             owner/name
  default_branch   the branch pull requests are merged into
  ci_seconds       median wall time of recent completed workflow runs on the
                   default branch; 300 when there are none
  targets          open, non-draft pull requests that a human has already
                   marked for auto-merge, in the order the loop should take
                   them. A label narrows this list to pull requests that
                   carry it. Without --all, a pull request that is not
                   ready by the review rules of its base is left out
  not_ready        the pull requests left out, as {number, title, author,
                   reasons}. Each reason is "needs an approval" or "has
                   unresolved review threads". Empty with --all

Each target carries \`approval\` (met, missing, not_required, or null) and
\`threads\` (resolved, unresolved, not_required, or null). The pull_request
rules of each base decide what is required: an approval count above 0, a
code owner review, an approval of the last push, or resolved review
threads. A reviewDecision can require an approval too. A read that fails is
null, and stderr names the branch or the pull request. Then the verdict
rests on reviewDecision alone, and the read leaves nothing out.

Ordering: gh-security's merge-risk:<band> label first (low, then unlabelled,
then medium, then high), oldest first within a band. Each target carries the
fields the loop needs to pick its next step, plus a \`checks\` summary reduced
from statusCheckRollup so the caller does not have to know both the CheckRun
and StatusContext shapes.

Exits 2 on a usage error (a bad path, more than one label, or a flag other
than --all), 1 when gh cannot answer for the repository or the open window
is full, and 3 on an internal error, which is outside the documented set so
a caller cannot mistake it for an answer.`

/**
 * What a `gh` failure says, and whether gh itself was missing.
 *
 * `gh is required` was a `shutil.which` preflight in the Python
 * (`gh-shepherd-status.py:151`). There is no preflight here (#158). The
 * runner answers 127 for a command that is not on PATH, so the first call
 * that needs gh reports the same fact in the same words. 126, or any
 * other status, keeps gh's own account instead.
 */
const ghRefusal = (error: unknown): { missing: boolean; detail: string } => {
  if (error instanceof GhError)
    return { missing: error.status === 127, detail: oneLine(error.detail) }
  throw error
}

/** The repository and its default branch, or the reason neither could be
 *  read. Half an answer is not an answer: the run listing needs the
 *  branch. */
const resolveRepository = async (
  gh: ReturnType<ShepherdContext['createGh']>,
): Promise<{ repo: string; branch: string } | { problem: string; missing: boolean }> => {
  let view: Record<string, unknown>
  try {
    view = await gh.viewRepository()
  } catch (error) {
    const refusal = ghRefusal(error)
    return { problem: refusal.detail, missing: refusal.missing }
  }
  const name = view.nameWithOwner
  const branchRef = view.defaultBranchRef
  const branch =
    typeof branchRef === 'object' && branchRef !== null
      ? (branchRef as Record<string, unknown>).name
      : undefined
  // Truthiness, as the Python reads both (`view.get(...) or None`). A
  // repository named `""` means gh answered nothing, not that gh answered
  // a name.
  if (!isTruthy(name)) return { problem: 'gh answered without nameWithOwner', missing: false }
  if (!isTruthy(branch)) return { problem: 'gh answered without a default branch', missing: false }
  return { repo: String(name), branch: String(branch) }
}

/** The command, with everything it did not expect still to be caught. */
const status = async (argv: readonly string[], context: ShepherdContext): Promise<ShepherdExit> => {
  const { output } = context
  const refuse = (line: string, code: ShepherdExit): ShepherdExit => {
    output.err.write(`${line}\n`)
    return code
  }

  // `-h`/`--help` is read in any position, as `sync-repo.ts` and `sync.ts`
  // do. A path or a label can never collide with it: neither one is ever
  // this exact word.
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      output.out.write(`${HELP}\n`)
      return 0
    }
  }
  // `--all` is read in any position too. Any other word that starts with a
  // dash is a flag this command does not know, not a path or a label.
  const all = argv.includes('--all')
  const words = argv.filter((arg) => arg !== '--all')
  const flag = words.find((arg) => arg.startsWith('-'))
  if (flag !== undefined) return refuse(`unknown flag: ${flag}`, 2)
  if (words.length > 2) return refuse('one label per run', 2)
  const [first, second] = words

  // The path as typed, or the caller's own directory. An empty argument is
  // a path, not an absent one. This is what `argv[0] if argv else` says.
  const target = first ?? context.cwd
  const refusal = directoryRefusal(target)
  if (refusal !== null) return refuse(refusal, 2)
  if ((await toplevel({ cwd: target, env: context.env })) === null) {
    return refuse(`not a git repository: ${target}`, 2)
  }

  // Resolved from the checkout. Of the three calls, this is the one that
  // names no repository, because it is the call that answers what the
  // repository is.
  const resolved = await resolveRepository(context.createGh({ cwd: target }))
  if ('problem' in resolved) {
    if (resolved.missing) return refuse('gh is required', 1)
    return refuse(`could not resolve the repository with gh: ${resolved.problem}`, 1)
  }

  const gh = context.createGh({ cwd: target, repository: resolved.repo })
  let pulls: unknown[]
  try {
    // The label is left out of the query when none is given. `lib/gh.ts`
    // already drops an absent filter, and the caller (the skill) sends at
    // most one label.
    pulls = await gh.listPullRequests(
      second === undefined
        ? { state: 'open', limit: PR_LIMIT }
        : { state: 'open', label: second, limit: PR_LIMIT },
    )
  } catch (error) {
    // Not "no pull requests". A listing that could not be read says
    // nothing about how many there are.
    return refuse(
      `could not list pull requests for ${resolved.repo}: ${ghRefusal(error).detail}`,
      1,
    )
  }

  // A saturated window is a window, not an answer. A repository with more
  // open pull requests than the limit would silently drop the oldest
  // rows. This refuses instead, and names the fix.
  if (pulls.length >= PR_LIMIT) {
    return refuse(
      `more than ${PR_LIMIT} open pull requests for ${resolved.repo}; use a label to narrow ` +
        'the window',
      1,
    )
  }

  // A run listing the repository cannot answer is not a failure. A repo
  // with no Actions at all is normal, and the loop only needs a wait
  // bound.
  let runs: unknown[] = []
  try {
    runs = await gh.listRuns({
      branch: resolved.branch,
      status: 'completed',
      limit: RUN_SAMPLE,
    })
  } catch (error) {
    // A gh that would not answer is the case this arm exists for. The
    // fallback is the whole handling of it. Anything else is not gh
    // refusing, and is not this command's to swallow.
    if (!(error instanceof GhError)) throw error
  }

  // One read of the review rules for each base, then one read of the
  // threads for each pull request whose base asks for resolved threads
  // (#465). A read that fails is not a failure of the command. Its pull
  // requests fall back to `reviewDecision`, so a failed read never empties
  // the queue.
  const rules = new Map<string, RequiredReviews | null>()
  for (const base of autoMergeBases(pulls)) {
    rules.set(base, await readReviewRules(gh, base, output.err))
  }
  const threads = new Map<number, number | null>()
  for (const number of threadReads(pulls, rules)) {
    threads.set(number, await readUnresolvedThreads(gh, number, output.err))
  }

  const document = statusDocument(pulls, resolved.repo, resolved.branch, ciSeconds(runs), {
    rules,
    threads,
    all,
  })
  // `indent=2, ensure_ascii=False`: two spaces, and every character as
  // itself. This is what `JSON.stringify(value, null, 2)` writes.
  output.out.write(`${JSON.stringify(document, null, 2)}\n`)
  return 0
}

/**
 * `status`, with anything it did not expect reported rather than raised.
 *
 * Exit 3 is outside the documented set on purpose. A caller that parses
 * the JSON on stdout must not read a crash as an answer. The agent gets a
 * line that names what broke, instead of a stack trace it cannot act on.
 * The line names this command, not the script file the Python named,
 * because the file is `scripts/gh.ts` for every command now.
 */
export const runShepherdStatus = async (
  argv: readonly string[],
  context: ShepherdContext,
): Promise<ShepherdExit> => {
  try {
    return await status(argv, context)
  } catch (error) {
    const account =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : `${typeof error}: ${String(error)}`
    context.output.err.write(`gh.ts shepherd-status: internal error: ${account}\n`)
    return 3
  }
}
