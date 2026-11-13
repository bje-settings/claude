// The deterministic steps of `/shepherd:merge` for one GitHub stack (#469).
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
// merge in the shepherd plugin: `gh stack merge`, which GitHub runs all or
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
  argumentRefusal,
  dropWords,
  NUMBER_RE,
  pollQueue,
  type QueueDrop,
  type QueueResult,
  queueResult,
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

export const HELP = `The deterministic steps of /shepherd:merge for one GitHub stack.

Usage:
  shepherd.ts shepherd-stack <path> <stack> state
  shepherd.ts shepherd-stack <path> <stack> update
  shepherd.ts shepherd-stack <path> <stack> wait
  shepherd.ts shepherd-stack <path> <stack> merge
  shepherd.ts shepherd-stack <path> <stack> queue [<since>]
  shepherd.ts shepherd-stack <path> <stack> queue-wait [<since>]

<stack> is the stack number, from shepherd-status. Every action prints one
JSON object: {"action", "repo", "stack", "ok", "detail", ...}. The open
layers are taken bottom first. A merged entry is no layer. Each layer is a
shepherd-pr step (see shepherd.ts shepherd-pr --help), judged by the rules of the
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
            rollup to decide. \`refused\` when gh stack merge exited with
            a status other than 0; \`reason\` is gh's own words, or why gh
            could not run or was killed. \`merged\` when every layer then
            reads MERGED, and \`accepted\` when GitHub took the merge but a
            layer is not merged yet (a merge queue, for one). \`layers\`
            gives each merge commit.
  queue     shepherd-pr queue on each layer that is not closed, bottom
            first, a merged one included, with the same <since>. \`layers\`
            gives each read, as {number, result, entry, drop, enqueued_at,
            left_at, queue_seconds}. \`result\` is merged (every layer
            merged); removed (a layer dropped); queued (a layer can still
            move in the queue); or not_queued (no layer is in the queue,
            and none dropped). On removed, \`layer\` and \`drop\` name the
            layer to fix. The queue removes a stack as one unit, and every
            layer above a dropped layer goes with it (stack_invalidated).
            So it is the oldest drop of another class, the bottom one of a
            tie. When every drop is stack_invalidated, it is the oldest of
            those. \`queue_seconds\` is the longest time of a layer. \`gone\`
            (ok:true) when no open pull request is in the stack: after a
            merge, read each layer of the merge report with shepherd-pr
            merged. ok:false when a read failed, with \`layer\`.
  queue-wait reads as queue does, with the poll and the bound of
            shepherd-pr queue-wait, until the result is merged, removed or
            not_queued. The layers come from the first read, so a stack
            that merges in full during the wait reads merged. \`pending\`
            at the bound. A bound that arrives on a failed read is
            ok:false.

This command never force pushes, never enables auto-merge, never bypasses a
check, and never removes a layer from a queue. Its writes are the branch
updates and the stack merge.

Environment: the SHEPHERD_* variables of shepherd.ts shepherd-pr. The wait bound
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

/** One layer's queue read, as `queue` and `queue-wait` report it. */
export interface LayerQueue {
  readonly number: number
  readonly result: QueueResult
  readonly drop: QueueDrop | null
  readonly [field: string]: unknown
}

/** What a queue read of a whole stack found. */
export type StackQueueResult = 'merged' | 'removed' | 'queued' | 'not_queued'

/**
 * The verdict of the queue over the layers of a stack (#503), bottom first.
 * `merged` when every layer merged. `removed` when a layer dropped: the
 * queue removes a stack as one unit, and `stack_invalidated` drops each
 * layer above a dropped layer. So `first` is the layer to fix: of the
 * layers whose drop is not `stack_invalidated`, the one whose drop is the
 * oldest, the bottom one of a tie. When every drop is
 * `stack_invalidated`, it is the oldest of those. `queued` while a
 * layer can still move in the queue. `not_queued` when no layer is in the
 * queue and none dropped, so nothing will move.
 */
export const stackQueueResult = (
  layers: readonly LayerQueue[],
): { readonly result: StackQueueResult; readonly first: LayerQueue | null } => {
  if (layers.every((layer) => layer.result === 'merged')) return { result: 'merged', first: null }
  const dropped = layers.filter((layer) => layer.result === 'removed')
  if (dropped.length > 0) {
    // A `stack_invalidated` layer went with another layer, so it is never
    // the cause while a layer with another class dropped.
    const caused = dropped.filter((layer) => layer.drop?.class !== 'stack_invalidated')
    const at = (layer: LayerQueue): number => Date.parse((layer.drop as QueueDrop).createdAt)
    const pool = caused.length > 0 ? caused : dropped
    const first = pool.reduce((best, layer) => (at(layer) < at(best) ? layer : best))
    return { result: 'removed', first }
  }
  const open = layers.some((layer) => layer.result === 'queued' || layer.result === 'waiting')
  return { result: open ? 'queued' : 'not_queued', first: null }
}

/** The longest time in the queue of any layer, or null when none is known. */
const longest = (layers: readonly LayerQueue[]): number | null => {
  const times = layers
    .map((layer) => layer.queue_seconds)
    .filter((time): time is number => typeof time === 'number')
  return times.length === 0 ? null : Math.max(...times)
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

  /**
   * The stack for a queue action, or `null` once this has reported why
   * there is none. A stack with no open pull request is gone from the
   * list of open stacks. After a merge through the queue, that is the
   * common case, so it is an answer (`gone`), not a failure.
   */
  async queueStack(): Promise<PullRequestStack | null> {
    const answer = await this.options.gh.listOpenStacks()
    const found = answer.rows.find((stack) => stack.number === this.options.stack)
    if (found !== undefined) return found
    if (answer.unavailable !== null) {
      this.emit(false, `could not read stack #${this.options.stack}: ${answer.unavailable}`, {
        read_error: answer.unavailable,
      })
      return null
    }
    this.emit(
      true,
      `no open pull request is in stack #${this.options.stack}; read each layer of the ` +
        'merge report with shepherd-pr merged',
      { result: 'gone' },
    )
    return null
  }

  /**
   * One queue read of each layer that is not closed, bottom first. A
   * layer that already merged stays in the read. `enqueued` holds the
   * newest `enqueuedAt` each layer showed, across the reads of one call.
   * A read that failed is `null`, with the layer and gh's words in
   * `failure`.
   */
  async readLayers(
    stack: PullRequestStack,
    since: string,
    enqueued: Map<number, string | null>,
    failure: { layer: number; detail: string },
  ): Promise<LayerQueue[] | null> {
    const layers: LayerQueue[] = []
    for (const layer of stack.layers.filter((entry) => entry.state !== 'CLOSED')) {
      const { worker } = this.layer(layer.number, stack.base)
      const facts = await worker.queueRead(since)
      if (facts === null) {
        failure.layer = layer.number
        failure.detail = worker.readFailure()
        return null
      }
      if (facts.entry !== null) enqueued.set(layer.number, facts.entry.enqueuedAt)
      const fields = worker.queueFields(facts, enqueued.get(layer.number) ?? (since || null))
      const { pr: _pr, ...kept } = fields
      layers.push({ number: layer.number, ...kept, result: queueResult(facts), drop: facts.drop })
    }
    return layers
  }

  /** The report of a queue read of the whole stack. */
  stackQueueFields(layers: readonly LayerQueue[]): Record<string, unknown> {
    const { result, first } = stackQueueResult(layers)
    return {
      result,
      layer: first?.number ?? null,
      drop: first?.drop ?? null,
      queue_seconds: longest(layers),
      layers,
    }
  }

  /** The detail of a queue read of the whole stack. */
  stackQueueDetail(layers: readonly LayerQueue[]): string {
    const { result, first } = stackQueueResult(layers)
    if (first !== null) {
      return `#${first.number} is the layer to fix: ${dropWords(first.drop as QueueDrop)}`
    }
    if (result === 'merged') return 'every layer merged'
    if (result === 'queued') return 'the stack is in the queue'
    return 'no layer is in the queue, and none dropped'
  }

  async queue(since: string): Promise<void> {
    const stack = await this.queueStack()
    if (stack === null) return
    const failure = { layer: 0, detail: '' }
    const layers = await this.readLayers(stack, since, new Map(), failure)
    if (layers === null) {
      this.emit(false, `could not read the queue of #${failure.layer}: ${failure.detail}`, {
        layer: failure.layer,
      })
      return
    }
    this.emit(true, this.stackQueueDetail(layers), {
      base: stack.base,
      ...this.stackQueueFields(layers),
    })
  }

  /**
   * Read the queue of every layer until the stack merges, a layer drops,
   * no layer is in the queue, or the bound passes, with the poll of
   * `shepherd-pr queue-wait`. The layers come from the first read, so a
   * stack that merges in full during the wait still reads `merged`.
   */
  async queueWait(since: string): Promise<void> {
    const stack = await this.queueStack()
    if (stack === null) return
    const enqueued = new Map<number, string | null>()
    const failure = { layer: 0, detail: '' }
    const first = await this.readLayers(stack, since, enqueued, failure)
    if (first === null) {
      this.emit(false, `could not read the queue of #${failure.layer}: ${failure.detail}`, {
        layer: failure.layer,
      })
      return
    }
    const polled = await pollQueue(
      this.options.context,
      first,
      () => this.readLayers(stack, since, enqueued, failure),
      (layers) => stackQueueResult(layers).result !== 'queued',
    )
    const reading = { bound: polled.bound, ...polled.reading }
    if (polled.stale) {
      this.emit(
        false,
        `queue-wait waited ${reading.waited}s but could not re-read the queue of ` +
          `#${failure.layer} (${reading.read_failures} of ` +
          `${reading.reads_ok + reading.read_failures} reads failed, the last among them): ` +
          failure.detail,
        { layer: failure.layer, ...reading, read_error: failure.detail },
      )
      return
    }
    const fields = this.stackQueueFields(polled.last)
    const open = fields.result === 'queued'
    this.emit(
      true,
      open
        ? `the stack is in the queue; still open after ${reading.waited}s`
        : this.stackQueueDetail(polled.last),
      {
        base: stack.base,
        ...fields,
        ...(open ? { result: 'pending' } : {}),
        ...reading,
        read_error: '',
      },
    )
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
      // of 1 s, so it reports. A late layer can pass after that 1 s, so the
      // stack can go past its bound by 1 s for each late layer.
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
      // gh's own words, which the agent copies into its skip. On a
      // refusal, GitHub applied the rules of the base and merged nothing.
      // A gh that could not run, or that a signal killed, comes here too,
      // with this code's account of it. No bound applies to this client,
      // so only an outside signal kills it, and its outcome is unknown.
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
const HANDLERS: Record<string, (worker: StackShepherd, argument: string) => Promise<void>> = {
  state: (worker) => worker.state(),
  update: (worker) => worker.update(),
  wait: (worker) => worker.wait(),
  merge: (worker) => worker.merge(),
  queue: (worker, since) => worker.queue(since),
  'queue-wait': (worker, since) => worker.queueWait(since),
}

/** The actions that take a fourth argument, `<since>`. */
const WITH_SINCE = ['queue', 'queue-wait']

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
  const [target = '', stack = '', action = '', since = ''] = argv
  const most = WITH_SINCE.includes(action) ? 4 : 3
  if (argv.length < 3 || argv.length > most) return refuse(HELP, 2)
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
  const usage = argumentRefusal(action, since)
  if (usage !== null) return refuse(usage, 2)
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
    since,
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
    context.output.err.write(`shepherd.ts shepherd-stack: internal error: ${account}\n`)
    return 3
  }
}
