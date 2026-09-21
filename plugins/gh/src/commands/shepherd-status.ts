// What `/gh:shepherd` would work on in one repository: the port of
// `plugins/gh/scripts/gh-shepherd-status.py`.
//
// One JSON document on stdout and nothing changed. Every decision it makes
// about a pull request is a function in `../shepherd.ts`, with its own named
// test; what is here is the order the questions are asked in, and what each
// refusal says.
//
// The command function is the seam (ADR 001): arguments, the environment, an
// injected `gh` and the output writers in, an exit status out. Nothing is
// spawned and no `gh` is on PATH.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { GhError } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import {
  ciSeconds,
  directoryRefusal,
  isTruthy,
  oneLine,
  type ShepherdContext,
  type ShepherdExit,
  statusDocument,
} from '../shepherd.ts'

/** How far back the CI-duration sample reaches. Twenty runs is a few days on
 *  an active repository and still one API call. */
const RUN_SAMPLE = 20

/** The listing window for `dependencies` pull requests. A repository with more
 *  than this open at once has a bigger problem than the shepherd loop. */
const PR_LIMIT = 100

export const HELP = `What /gh:shepherd would work on in one repository.

Usage:
  gh.ts shepherd-status [path]

Prints one JSON document and changes nothing:

  repo                  owner/name
  default_branch        the branch pull requests are merged into
  ci_seconds            median wall time of recent completed workflow runs on
                        the default branch; 300 when there are none
  targets               open, non-draft pull requests labelled \`dependencies\`
                        that a human has already marked for auto-merge, in
                        the order the loop should take them
  skipped_no_automerge  \`dependencies\` pull requests without auto-merge. They
                        are reported, never enabled: auto-merge is the
                        human's signal that the pull request is wanted.

Ordering: gh-security's merge-risk:<band> label first (low, then unlabelled,
then medium, then high), oldest first within a band. Each target carries the
fields the loop needs to pick its next step, plus a \`checks\` summary reduced
from statusCheckRollup so the caller does not have to know both the CheckRun
and StatusContext shapes.

Exits 2 on a usage error, 1 when gh cannot answer for the repository, and 3 on
an internal error, which is outside the documented set so a caller cannot
mistake it for an answer.`

/**
 * What a `gh` failure says, and whether it was gh failing to exist.
 *
 * `gh is required` was a `shutil.which` preflight in the Python
 * (`gh-shepherd-status.py:151`). There is no preflight here (#158): the runner
 * answers 127 for a command that is not on PATH, so the first call that needs
 * gh reports the same fact in the same words, and 126 or any other status
 * keeps gh's own account instead.
 */
const ghRefusal = (error: unknown): { missing: boolean; detail: string } => {
  if (error instanceof GhError)
    return { missing: error.status === 127, detail: oneLine(error.detail) }
  throw error
}

/** The repository and its default branch, or the reason neither could be
 *  read. Half an answer is not an answer: the run listing needs the branch. */
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
  // Truthiness, as the Python reads both (`view.get(...) or None`): a
  // repository named `""` is gh answering nothing rather than gh answering a
  // name.
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

  const [first] = argv
  if (first === '-h' || first === '--help') {
    output.out.write(`${HELP}\n`)
    return 0
  }

  // The path as typed, or the caller's own directory. An empty argument is a
  // path, not an absent one, which is what `argv[0] if argv else` says.
  const target = first ?? context.cwd
  const refusal = directoryRefusal(target)
  if (refusal !== null) return refuse(refusal, 2)
  if ((await toplevel({ cwd: target, env: context.env })) === null) {
    return refuse(`not a git repository: ${target}`, 2)
  }

  // Resolved from the checkout, which is the one call of the four that names
  // no repository, because it is the call that answers what the repository is.
  const resolved = await resolveRepository(context.createGh({ cwd: target }))
  if ('problem' in resolved) {
    if (resolved.missing) return refuse('gh is required', 1)
    return refuse(`could not resolve the repository with gh: ${resolved.problem}`, 1)
  }

  const gh = context.createGh({ cwd: target, repository: resolved.repo })
  let pulls: unknown[]
  try {
    pulls = await gh.listPullRequests({
      state: 'open',
      label: 'dependencies',
      limit: PR_LIMIT,
    })
  } catch (error) {
    // Not "no pull requests": a listing that could not be read says nothing
    // about how many there are.
    return refuse(
      `could not list pull requests for ${resolved.repo}: ${ghRefusal(error).detail}`,
      1,
    )
  }

  // A run listing the repository cannot answer is not a failure: a repo with
  // no Actions at all is normal, and the loop only needs a wait bound.
  let runs: unknown[] = []
  try {
    runs = await gh.listRuns({
      branch: resolved.branch,
      status: 'completed',
      limit: RUN_SAMPLE,
    })
  } catch (error) {
    // A gh that would not answer is the case this arm exists for, and the
    // fallback is the whole handling of it. Anything else is not gh refusing
    // and is not this command's to swallow.
    if (!(error instanceof GhError)) throw error
  }

  const document = statusDocument(pulls, resolved.repo, resolved.branch, ciSeconds(runs))
  // `indent=2, ensure_ascii=False`: two spaces, and every character as
  // itself, which is what `JSON.stringify(value, null, 2)` writes.
  output.out.write(`${JSON.stringify(document, null, 2)}\n`)
  return 0
}

/**
 * `status`, with anything it did not expect reported rather than raised.
 *
 * Exit 3 is outside the documented set on purpose: a caller parsing the JSON
 * on stdout must not read a crash as an answer, and the agent gets a line
 * naming what broke instead of a stack trace it cannot act on. The line names
 * this command rather than the script file the Python named, because the file
 * is `bin/gh.ts` for every command now.
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
