// The deterministic steps of `/gh:shepherd` for one GitHub stack (#469).
//
// Every action prints one JSON object: `{"action", "repo", "stack", "ok",
// "detail", ...}`. The agent that runs the loop decides which action comes
// next. This file only does the step (ruling 2 on #469).
//
// **Each layer is a `shepherd-pr` step.** A layer gets a `Shepherd` from
// `shepherd-pr.ts`, with a `report` in place of stdout and the rules of the
// stack base (ruling 4 on #469). So `state`, the update poll, and `wait`
// with its stall rule are the code that `shepherd-pr` runs, not a copy.
// This file holds the order of the layers and the stack verdicts.
//
// **No force push.** `update` asks GitHub to merge the base into each layer
// that is behind, bottom up (`gh pr update-branch` in MERGE mode). GitHub
// merges such a stack (the probe of ruling 3 on #469). `merge` is the one
// merge in the gh plugin: `gh stack merge`, which GitHub runs all or
// nothing, under the rules of the base.
//
// The command function is the seam (ADR 001). Its inputs are the arguments,
// the environment, an injected `gh`, the clock, the sleep, and the output
// writers. Its output is an exit status.
import type { MergeMethod, PullRequestStack } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import {
  directoryRefusal,
  layerReasons,
  NOT_OPEN,
  openLayers,
  readRequiredContexts,
  type ShepherdContext,
  type ShepherdExit,
  unreportedRequired,
} from '../shepherd.ts'
import {
  NUMBER_RE,
  readSettings,
  resolveRepository,
  Shepherd,
  seconds,
  type WorkerOptions,
  waitBoundOf,
} from './shepherd-pr.ts'

/** The merge methods, in the order `merge` takes the first one the base
 *  allows. A squash gives one commit for each layer, as the hand-run merge
 *  of #469 did. */
const METHOD_ORDER: readonly MergeMethod[] = ['squash', 'merge', 'rebase']

/** Checks states that let a stack merge. */
const GREEN = ['passed', 'none']

export const HELP = `The deterministic steps of /gh:shepherd for one GitHub stack.

Usage:
  gh.ts shepherd-stack <path> <stack> state
  gh.ts shepherd-stack <path> <stack> update
  gh.ts shepherd-stack <path> <stack> wait
  gh.ts shepherd-stack <path> <stack> merge

<stack> is the stack number, from shepherd-status. Every action prints one
JSON object: {"action", "repo", "stack", "ok", "detail", ...}. The open
layers are taken bottom first. A merged entry is no layer. Each layer is a
shepherd-pr step (see gh.ts shepherd-pr --help), judged by the rules of the
stack \`base\`, not of its own base.

  state     each open layer as shepherd-pr state reads it, with the review
            rules of the stack base, as {number, pr, reasons}. \`failing\`
            lists each layer whose \`reasons\` is not empty, and each closed
            entry ("is closed"). A reason is "is a draft", "needs an
            approval", "has unresolved review threads", or "required check
            <name> failed". \`ready\` is true when \`failing\` is empty.
  update    from the bottom up, for each layer whose head does not contain
            the tip of its base: gh pr update-branch in MERGE mode, then a
            read until the head moves, as shepherd-pr rebase does. Never
            --rebase, never a force push. \`updates\` lists each layer it
            read, with \`result\` \`current\` or the update report. \`result\`
            is \`updated\`, \`current\` (no layer was behind), or \`stopped\`:
            a layer did not move, and \`report\` says why. ok:false when a
            read failed, or gh refused the update (a conflict, often), with
            \`layer\` and gh's words.
  wait      shepherd-pr wait on each layer, bottom up, in one bound for the
            whole stack. A required check of the base with no row on a
            layer is pending, and \`report.unreported\` names each one when
            the bound ends. \`result\` is \`passed\` when every layer passed.
            Else it is the result of the first layer that did not pass
            (behind, failed, stalled, pending, merged), with \`layer\` and
            its whole \`report\`. ok:false when that wait did not complete.
  merge     gh stack merge <stack> --yes, with the first of squash, merge
            and rebase that both the repository and the rules of the base
            allow. It refuses first unless every layer is ready, current
            and green: \`result\` \`not_ready\`, with \`failing\` as in state,
            plus "is behind its base", "is out of sync with its branch",
            "checks are <state>", and "required check <name> has not
            reported". An empty \`failing\` is a base that allows no merge
            method, and \`detail\` says so. \`unread\` when a layer, its
            compare or the merge methods could not be read, so nothing was
            proven. Required checks that could not be read leave the
            rollup to decide. \`refused\` when GitHub refused the merge;
            \`reason\` is gh's own words. \`merged\` when every layer then
            reads MERGED, and \`accepted\` when GitHub took the merge but a
            layer is not merged yet (a merge queue, for one). \`layers\`
            gives each merge commit.

This command never force pushes, never enables auto-merge, and never
bypasses a check. Its writes are the branch updates and the stack merge.

Environment: the SHEPHERD_* variables of gh.ts shepherd-pr. The wait bound
is for the whole stack.

Exits 0 when the action ran and reported (including ok:false refusals), 2 on
a usage error, 1 when gh could not answer at all, and 3 on an internal error,
which is outside the documented set so a caller cannot mistake it for an
answer.`

interface StackOptions {
  readonly repo: string
  readonly stack: number
  readonly action: string
  readonly ciSeconds: number
  readonly logLines: number
  readonly context: ShepherdContext
  readonly gh: ReturnType<ShepherdContext['createGh']>
}

/** One layer that is not ready, and why. */
interface Failing {
  readonly number: number
  readonly reasons: readonly string[]
}

/** One action against one stack. */
class StackShepherd {
  readonly options: StackOptions

  constructor(options: StackOptions) {
    this.options = options
  }

  emit(ok: boolean, detail: string, extra: Record<string, unknown> = {}): void {
    const document = {
      action: this.options.action,
      repo: this.options.repo,
      stack: this.options.stack,
      ok,
      detail,
      ...extra,
    }
    this.options.context.output.out.write(`${JSON.stringify(document, null, 2)}\n`)
  }

  /** The stack, or `null` once this has reported why there is none. A
   *  read that came back short and does not hold the stack says so: it is
   *  not proof that the stack is gone. */
  async readStack(): Promise<PullRequestStack | null> {
    const answer = await this.options.gh.listOpenStacks()
    const found = answer.rows.find((stack) => stack.number === this.options.stack)
    if (found !== undefined) return found
    if (answer.unavailable !== null) {
      this.emit(false, `could not read stack #${this.options.stack}: ${answer.unavailable}`, {
        read_error: answer.unavailable,
      })
    } else {
      this.emit(false, `no open pull request is in stack #${this.options.stack}`)
    }
    return null
  }

  /** A `shepherd-pr` worker for one layer, whose report comes back to this
   *  action rather than to stdout. */
  layer(
    number: number,
    base: string,
    more: Partial<Pick<WorkerOptions, 'waitBound' | 'requiredContexts'>> = {},
  ): { worker: Shepherd; report: () => Record<string, unknown> } {
    let reported: Record<string, unknown> = {}
    const { repo, action, ciSeconds, logLines, context, gh } = this.options
    const worker = new Shepherd({
      repo,
      number,
      action,
      ciSeconds,
      logLines,
      context,
      gh,
      rulesBase: base,
      report: (document) => {
        reported = document
      },
      ...more,
    })
    return { worker, report: () => reported }
  }

  /** Each closed entry, as a layer that is not ready. */
  closed(stack: PullRequestStack): Failing[] {
    return stack.layers
      .filter((layer) => layer.state === 'CLOSED')
      .map((layer) => ({ number: layer.number, reasons: [NOT_OPEN] }))
  }

  async state(): Promise<void> {
    const stack = await this.readStack()
    if (stack === null) return
    const err = this.options.context.output.err
    const contexts = await readRequiredContexts(this.options.gh, stack.base, err)
    const layers: { number: number; pr: unknown; reasons: string[] }[] = []
    for (const number of openLayers(stack)) {
      const { worker } = this.layer(number, stack.base)
      const read = await worker.stateOf()
      if (read === null) {
        this.emit(false, `could not read #${number}: ${worker.readFailure()}`, {
          base: stack.base,
          layer: number,
        })
        return
      }
      const reasons = layerReasons(read.raw, read.pr.approval, read.pr.threads, contexts, false)
      layers.push({ number, pr: read.pr, reasons })
    }
    const failing = [
      ...layers
        .filter((layer) => layer.reasons.length > 0)
        .map(({ number, reasons }) => ({ number, reasons })),
      ...this.closed(stack),
    ]
    this.emit(true, 'read', {
      base: stack.base,
      layers,
      failing,
      ready: failing.length === 0,
    })
  }

  async update(): Promise<void> {
    const stack = await this.readStack()
    if (stack === null) return
    const updates: Record<string, unknown>[] = []
    for (const number of openLayers(stack)) {
      const { worker, report } = this.layer(number, stack.base)
      const pull = await worker.readPr()
      if (pull === null) {
        this.emit(false, `could not read #${number}: ${worker.readFailure()}`, {
          layer: number,
          updates,
        })
        return
      }
      // The compare decides, as in `shepherd-pr wait`. A compare that could
      // not be read gives no verdict, and stderr says why.
      const read = await worker.withBehind(pull)
      if (read.behind === null) {
        this.emit(
          false,
          `the compare of #${number} could not be read; nothing was updated past it`,
          {
            layer: number,
            updates,
          },
        )
        return
      }
      if (!read.behind) {
        updates.push({ number, result: 'current' })
        continue
      }
      await worker.update(false)
      const done = report()
      updates.push({ number, report: done })
      if (done.ok !== true) {
        this.emit(false, `#${number}: ${String(done.detail)}`, { layer: number, updates })
        return
      }
      // A layer that did not move holds the layers above it back. `wait`
      // then reads it again.
      if (done.result !== 'moved') {
        this.emit(true, `#${number}: ${String(done.detail)}`, {
          result: 'stopped',
          layer: number,
          report: done,
          updates,
        })
        return
      }
    }
    const moved = updates.some((update) => update.result !== 'current')
    this.emit(
      true,
      moved ? 'every layer that was behind now holds its base' : 'no layer is behind',
      {
        result: moved ? 'updated' : 'current',
        updates,
      },
    )
  }

  async wait(): Promise<void> {
    const stack = await this.readStack()
    if (stack === null) return
    const { context, ciSeconds } = this.options
    const bound = waitBoundOf(context.env, context.output.err, ciSeconds)
    const started = context.now()
    const spent = (): number => seconds(context.now() - started)
    // A required check with no row on a layer is pending, so `merge` does
    // not refuse a stack that `wait` called passed.
    const requiredContexts = await readRequiredContexts(
      this.options.gh,
      stack.base,
      context.output.err,
    )
    for (const number of openLayers(stack)) {
      // One bound for the stack. A layer that comes late still gets a bound
      // of 1 s, so it reports. The stack can then go past its bound by 1 s.
      const waitBound = Math.max(1, bound - spent())
      const { worker, report } = this.layer(number, stack.base, { waitBound, requiredContexts })
      await worker.wait()
      const done = report()
      if (done.ok !== true) {
        this.emit(false, `#${number}: ${String(done.detail)}`, { layer: number, report: done })
        return
      }
      if (done.result !== 'passed') {
        this.emit(true, `#${number}: ${String(done.detail)}`, {
          result: done.result,
          layer: number,
          bound,
          waited: spent(),
          report: done,
        })
        return
      }
    }
    this.emit(true, 'checks passed on every layer', {
      result: 'passed',
      bound,
      waited: spent(),
      layers: openLayers(stack),
    })
  }

  async merge(): Promise<void> {
    const stack = await this.readStack()
    if (stack === null) return
    const { gh, context } = this.options
    const contexts = await readRequiredContexts(gh, stack.base, context.output.err)
    const failing: Failing[] = []
    for (const number of openLayers(stack)) {
      const { worker } = this.layer(number, stack.base)
      const read = await worker.stateOf()
      if (read === null) {
        this.emit(false, `could not read #${number}: ${worker.readFailure()}`, {
          result: 'unread',
          layer: number,
        })
        return
      }
      const pr = read.pr
      if (pr.behind === null) {
        this.emit(false, `the compare of #${number} could not be read`, {
          result: 'unread',
          layer: number,
        })
        return
      }
      const reasons = layerReasons(read.raw, pr.approval, pr.threads, contexts, false)
      if (pr.behind) reasons.push('is behind its base')
      if (pr.inSync === false) reasons.push('is out of sync with its branch')
      if (!GREEN.includes(pr.checks.state)) reasons.push(`checks are ${pr.checks.state}`)
      for (const name of unreportedRequired(read.raw, contexts)) {
        reasons.push(`required check ${name} has not reported`)
      }
      if (reasons.length > 0) failing.push({ number, reasons })
    }
    failing.push(...this.closed(stack))
    if (failing.length > 0) {
      this.emit(false, 'refused: not every layer is ready, current and green', {
        result: 'not_ready',
        base: stack.base,
        failing,
      })
      return
    }
    const allowed = await gh.mergeMethods({ branch: stack.base })
    if (allowed.methods === null) {
      this.emit(
        false,
        `the merge methods of ${stack.base} could not be read: ${allowed.unavailable}`,
        {
          result: 'unread',
        },
      )
      return
    }
    const methods = allowed.methods
    const method = METHOD_ORDER.find((name) => methods.includes(name))
    if (method === undefined) {
      this.emit(false, `refused: ${stack.base} allows no merge method`, {
        result: 'not_ready',
        base: stack.base,
        failing,
      })
      return
    }
    const answer = await gh.mergeStack({ stack: this.options.stack, method })
    if (!answer.accepted) {
      // gh's own words, which the agent copies into its skip. GitHub
      // applied the rules of the base and merged nothing.
      this.emit(true, `GitHub refused the merge: ${answer.output}`, {
        result: 'refused',
        method,
        reason: answer.output,
      })
      return
    }
    const layers: Record<string, unknown>[] = []
    for (const number of openLayers(stack)) {
      const { worker } = this.layer(number, stack.base)
      const pull = await worker.readPr()
      layers.push(
        pull === null
          ? { number, state: null, mergeCommit: null, read_error: worker.readFailure() }
          : { number, state: pull.state, mergeCommit: pull.mergeCommit },
      )
    }
    const merged = layers.every((layer) => layer.state === 'MERGED')
    this.emit(
      true,
      merged ? 'merged' : 'GitHub accepted the merge; not every layer reads merged yet',
      {
        result: merged ? 'merged' : 'accepted',
        method,
        output: answer.output,
        layers,
      },
    )
  }
}

/** The action each name runs, which is also the set the usage advertises. */
const HANDLERS: Record<string, (worker: StackShepherd) => Promise<void>> = {
  state: (worker) => worker.state(),
  update: (worker) => worker.update(),
  wait: (worker) => worker.wait(),
  merge: (worker) => worker.merge(),
}

/** The command, with everything it did not expect still to be caught. */
const shepherdStack = async (
  argv: readonly string[],
  context: ShepherdContext,
): Promise<ShepherdExit> => {
  const { output } = context
  const refuse = (line: string, code: ShepherdExit): ShepherdExit => {
    output.err.write(`${line}\n`)
    return code
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    output.out.write(`${HELP}\n`)
    return 0
  }
  const [target = '', stack = '', action = ''] = argv
  if (argv.length !== 3) return refuse(HELP, 2)
  const refusal = directoryRefusal(target)
  if (refusal !== null) return refuse(refusal, 2)
  if (!NUMBER_RE.test(stack)) return refuse(`not a stack number: ${stack}`, 2)
  if ((await toplevel({ cwd: target, env: context.env })) === null) {
    return refuse(`not a git repository: ${target}`, 2)
  }
  const { ciSeconds, logLines } = readSettings(context.env, output.err)
  // `Object.hasOwn`, for `shepherd-pr`'s reason: a plain lookup reads
  // `constructor` as an action.
  const handler = Object.hasOwn(HANDLERS, action) ? HANDLERS[action] : undefined
  if (handler === undefined) {
    output.err.write(`unknown action: ${action}\n`)
    return refuse(HELP, 2)
  }
  const repo = await resolveRepository(target, context)
  if (typeof repo !== 'string') return refuse(repo.refusal, 1)
  await handler(
    new StackShepherd({
      repo,
      stack: Number(stack),
      action,
      ciSeconds,
      logLines,
      context,
      // The checkout is the `cwd` of every call: `gh stack merge` reads the
      // repository from it.
      gh: context.createGh({ cwd: target, repository: repo }),
    }),
  )
  return 0
}

/** `shepherdStack`, with anything it did not expect reported rather than
 *  raised, as exit 3. */
export const runShepherdStack = async (
  argv: readonly string[],
  context: ShepherdContext,
): Promise<ShepherdExit> => {
  try {
    return await shepherdStack(argv, context)
  } catch (error) {
    const account =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : `${typeof error}: ${String(error)}`
    context.output.err.write(`gh.ts shepherd-stack: internal error: ${account}\n`)
    return 3
  }
}
