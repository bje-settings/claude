// What `/shepherd:merge` would work on in one repository. This is the port
// of the gh plugin's `scripts/gh-shepherd-status.py`.
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
// **The Python this ports was deleted at #127.** The gh plugin's
// `scripts/*.py`, its `lib/`, its `hooks/hook-io.py` and `tests/gh/` are
// gone from the tree. The file and line references below point at what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.
import { GhError, type RequiredReviews } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import {
  autoMergeBases,
  ciSeconds,
  directoryRefusal,
  isTruthy,
  oneLine,
  openLayers,
  readRequiredContexts,
  readReviewRules,
  readUnresolvedThreads,
  type ShepherdContext,
  type ShepherdExit,
  type StackRead,
  statusDocument,
  threadReads,
} from '../shepherd.ts'

/** How far back the CI-duration sample reaches. One push starts several
 *  workflows, and `ciSeconds` counts each head SHA once. So 100 runs give
 *  enough heads for a stable median, in one `gh run list` call (ruling 5
 *  on #463). */
const RUN_SAMPLE = 100

/** The listing window for open pull requests. A repository with more than
 *  this open at once needs a label to narrow the window, rather than a
 *  bigger number here. gh pages the request itself. */
const PR_LIMIT = 500

export const HELP = `What /shepherd:merge would work on in one repository.

Usage:
  shepherd.ts shepherd-status [path] [label] [--all]

Prints one JSON document and changes nothing:

  repo             owner/name
  default_branch   the branch pull requests are merged into
  ci_seconds       the median, over head commits, of the longest completed
                   workflow run of each, from the 100 newest runs on the
                   default branch; 300 when no head is usable
  targets          open, non-draft pull requests that a human has already
                   marked for auto-merge, in the order the loop should take
                   them. A label narrows this list to pull requests that
                   carry it. Without --all, a pull request that is not
                   ready by the review rules of its base is left out. Then
                   each GitHub stack that is ready, as {stack, base,
                   layers}: its number, the branch it merges into, and its
                   open layers, bottom first. With a label, a stack counts
                   when one of its open layers carries it
  not_ready        the pull requests left out, as {number, title, author,
                   reasons}. Each reason is "needs an approval" or "has
                   unresolved review threads". Empty with --all. Then each
                   stack left out, as {stack, base, layers, failing}.
                   \`failing\` lists each layer that is not ready, as
                   {number, reasons}

Each target carries \`approval\` (met, missing, not_required, or null) and
\`threads\` (resolved, unresolved, not_required, or null). The pull_request
rules of each base decide what is required: an approval count above 0, a
code owner review, an approval of the last push, or resolved review
threads. A reviewDecision can require an approval too. A read that fails is
null, and stderr names the branch or the pull request. It leaves nothing
out. When the rules fail, approval rests on reviewDecision alone. When the
threads fail, only threads is null.

Every open layer of a stack is judged by the rules of the stack base, not
of its own base, as GitHub merges it. A layer is not ready when it "is a
draft", "needs an approval", "has unresolved review threads", or when a
required check of the stack base failed ("required check <name> failed").
An entry that is "is closed" did not merge. A merged entry is no layer.
With --all, the approval and the threads count for nothing; a draft and a
failed required check still do. A required check that has not reported
yet is no reason: shepherd-stack wait waits for it. A stack read that
fails, in full or in part, leaves out each stack it could not read, and
stderr says why. It never puts a stack in not_ready. A layer of a stack is
never a pull request target too.

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

/** The number of a listed row, or `NaN` for a row with none. */
const numberOf = (row: unknown): number => Number((row as Record<string, unknown> | null)?.number)

/**
 * Each stack in scope, with the row of each open layer and the required
 * checks of its base (#469).
 *
 * A layer that the listing did not hold, because a label narrowed it, is
 * read by itself. A stack with a layer that could not be read is left out,
 * and stderr says why. So is a stack the listing could not read: a failed
 * read never decides a verdict. With a label, a stack is in scope when one
 * of its open layers carries it.
 */
const readStacks = async (
  gh: ReturnType<ShepherdContext['createGh']>,
  pulls: readonly unknown[],
  labelled: boolean,
  err: ShepherdContext['output']['err'],
): Promise<StackRead[]> => {
  const answer = await gh.listOpenStacks()
  if (answer.unavailable !== null) {
    err.write(`a stack may be left out: the stacks could not all be read: ${answer.unavailable}\n`)
  }
  const listed = new Map(pulls.map((row) => [numberOf(row), row]))
  const contexts = new Map<string, readonly string[] | null>()
  const reads: StackRead[] = []
  for (const stack of answer.rows) {
    const open = openLayers(stack)
    if (labelled && !open.some((number) => listed.has(number))) continue
    const rows = await layerRows(gh, listed, stack.number, open, err)
    if (rows === null) continue
    if (!contexts.has(stack.base)) {
      contexts.set(stack.base, await readRequiredContexts(gh, stack.base, err))
    }
    reads.push({ stack, rows, contexts: contexts.get(stack.base) ?? null })
  }
  return reads
}

/** The row of each open layer, from the listing or read by itself, or
 *  `null` when one could not be read. */
const layerRows = async (
  gh: ReturnType<ShepherdContext['createGh']>,
  listed: ReadonlyMap<number, unknown>,
  stack: number,
  open: readonly number[],
  err: ShepherdContext['output']['err'],
): Promise<Map<number, unknown> | null> => {
  const rows = new Map<number, unknown>()
  for (const number of open) {
    const row = listed.has(number) ? listed.get(number) : await readLayer(gh, number, stack, err)
    if (row === null) return null
    rows.set(number, row)
  }
  return rows
}

/** One layer the listing did not hold, or `null` when gh could not read
 *  it. stderr then names the stack it leaves out. */
const readLayer = async (
  gh: ReturnType<ShepherdContext['createGh']>,
  number: number,
  stack: number,
  err: ShepherdContext['output']['err'],
): Promise<unknown> => {
  try {
    return await gh.viewPullRequest({ pullRequest: number })
  } catch (error) {
    err.write(
      `stack #${stack} is left out: #${number} could not be read: ${ghRefusal(error).detail}\n`,
    )
    return null
  }
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

  // The stacks, with the rules of each stack base, and the threads of each
  // layer when those rules ask for them (#469).
  const stacks = await readStacks(gh, pulls, second !== undefined, output.err)
  for (const read of stacks) {
    const base = read.stack.base
    if (!rules.has(base)) rules.set(base, await readReviewRules(gh, base, output.err))
    if (rules.get(base)?.threadResolution !== true) continue
    for (const number of read.rows.keys()) {
      if (!threads.has(number)) {
        threads.set(number, await readUnresolvedThreads(gh, number, output.err))
      }
    }
  }

  const document = statusDocument(pulls, resolved.repo, resolved.branch, ciSeconds(runs), {
    rules,
    threads,
    all,
    stacks,
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
 * because the file is `scripts/shepherd.ts` for every command now.
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
    context.output.err.write(`shepherd.ts shepherd-status: internal error: ${account}\n`)
    return 3
  }
}
