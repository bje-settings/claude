// The workstreams guard: the `PreToolUse` hook that holds the two rules a
// brief line has failed to hold on its own.
//
// CLAUDE.md, "Plugin design": "Hook when the action must happen the same way
// every time and needs no reasoning. Guardrails belong in `PreToolUse` hooks;
// an instruction in CLAUDE.md or a skill is a request, not enforcement."
// Both rules below were requests first, in three different briefs, and were
// ignored anyway:
//
//   - **`run_in_background`.** In round 2 two of three streams ended their
//     turn on a backgrounded test run and returned "waiting", which a caller
//     can only read as stopped short; in round 3 two of five turns did the
//     same; the audit L1 stream hit it again (#132, the round 2, round 3 and
//     audit L1 findings). Each cost a resume message and idle minutes.
//   - **`git checkout` and `git restore` on a dirty tree.** Round 7's
//     stream lost its uncommitted hook entry point to its own `git checkout`
//     mid mutation sweep and rebuilt the file from memory; a round 2 agent
//     lost edits the same way with the rule in its brief (#132, the round 7
//     finding 1). The fix is one commit away and always was.
//
// **Who it binds.** Round 8 ruling 5: a subagent, never the main thread. The
// input carries `agent_id` "only when the hook fires inside a subagent"
// (hooks.md, "Common input fields"), and that is the whole test.
// `agent_type` is reported in the reason, so a person reading the denial
// knows which worker was stopped, but is never matched on: a plugin
// subagent's `agent_type` is the plugin-scoped name (sub-agents.md, "Project
// level hooks for subagent events"), so matching it would bind the three
// `workstreams:stream-*` agents and leave every reviewer, round agent and
// general purpose worker the same briefs are handed to unguarded. The
// orchestrator keeps backgrounding, because completion is what wakes it.
//
// **What it cannot see.** A command Claude asked to background carries
// `run_in_background: true` and is denied here. A command the harness MOVES
// to the background when it reaches its timeout is a different mechanism,
// after the tool call has started, with no hook in front of it
// (tools-reference.md, "Background commands": "When a command reaches its
// timeout without finishing, Claude Code moves it to the background instead
// of stopping it"). The remedy for that half is the brief's, and it is the
// same remedy: pass an explicit timeout long enough to finish in, and re-run
// in the foreground what was moved.
//
// **Never the reason a session stops.** This decides a tool call on every
// Bash command of every session the plugin is installed in. Anything it
// cannot read is one line on stderr and an allow: `hooks/guard.ts` holds the
// outer half of that promise and this file holds the inner one. An allow is
// silent and returns no decision at all, rather than a
// `permissionDecision: "allow"`, which would skip the permission prompt the
// user's own settings asked for (hooks.md, "PreToolUse decision control").
//
// **Neither `additionalContext` nor `systemMessage`.**
// `.claude/rules/path-hooks.md` is about a hook with something to tell a
// person; this one has something to tell the worker it just stopped, and
// `permissionDecisionReason` is the field the docs say is "shown to Claude"
// for a deny. A `systemMessage` beside it would render in the main terminal
// on every denial, where the person is not the one who has to act and the
// subagent's own transcript already carries the reason.
//
// The command function is the seam (ADR 001, RFC 001 decision 3): the payload
// text, the output pair and a reader for git come in, a status goes out, and
// no test here needs a process.
import type { Envelope } from '../lib/envelope.ts'
import { failed, ok } from '../lib/envelope.ts'
import type { Output } from '../lib/streams.ts'

/** `git status --porcelain` and nothing else, as this file needs it: the
 *  lines, `''` for a clean tree, or `null` when git could not answer at all.
 *  `lib/git.ts` `gitOut` is the production one and is what `hooks/guard.ts`
 *  passes; a test passes the same function with a sandbox's environment
 *  bound, so git is real here as everywhere else (`.claude/rules/type-ts.md`,
 *  "git is not mocked"). */
export type GitReader = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<string | null>

/** The fields of a `PreToolUse` payload this hook reads, and no others
 *  (hooks.md, "Common input fields" and "PreToolUse input"). Every one is
 *  optional in the document, so every one is nullable here: the payload is
 *  Claude Code's, not ours, and a field that is missing is a fact about the
 *  call rather than a reason to fail. */
export interface ToolCall {
  /** Present only inside a subagent. Its presence is the whole of who this
   *  guard binds. */
  readonly agentId: string | null
  /** Named in a denial, never matched on. */
  readonly agentType: string | null
  readonly toolName: string | null
  /** The shell command, for `Bash` and for `PowerShell`. */
  readonly command: string | null
  /** Whether Claude asked for the command to be started in the background. */
  readonly background: boolean
  /** Where the tool call runs, which is the tree a bare `git restore` would
   *  act on. */
  readonly cwd: string | null
}

/** What this hook answers: silence, or a denial with the sentence Claude
 *  reads (hooks.md: `permissionDecisionReason` "For `deny`, shown to
 *  Claude"). */
export type Verdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }

/** The shell tools whose `tool_input.command` this reads. Both, because on
 *  Windows Claude Code routes shell commands through PowerShell and may not
 *  register the Bash tool at all, and "a hook that matches only `Bash` never
 *  fires there" (hooks.md, "PowerShell"). The matcher in `hooks.json` says
 *  the same thing; this is the half that survives someone narrowing it. */
const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

/** The bound the brief gives a foreground command, named in the denial so the
 *  remedy arrives with the refusal. */
const FOREGROUND_CEILING_MS = 590_000

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** A string field, or `null` for a field that is absent or is some other
 *  type. A number where a string was promised is not an answer. */
const text = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

/**
 * The payload as the call it describes, or the reason it could not be read.
 *
 * A `failed` envelope rather than a throw, because every caller of this does
 * the same thing with it: says so on stderr and allows the tool call. The
 * text is someone's stdin, so "not a document at all" is an ordinary input
 * here and not an exception.
 */
export const readToolCall = (payload: string): Envelope<ToolCall> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch (error) {
    // `String(error)`, with no `instanceof Error` arm in front of it: the one
    // statement inside this `try` is `JSON.parse`, which throws a `SyntaxError`
    // and nothing else, so an arm for a non-Error throw is a branch no test can
    // reach and the coverage rule says to restructure it away rather than
    // excuse it (`.claude/rules/type-ts.md`, "Coverage").
    return failed(`payload is not JSON (${String(error)})`)
  }
  const document = asRecord(parsed)
  if (document === null) return failed('payload is not a JSON object')
  const input = asRecord(document.tool_input) ?? {}
  return ok({
    agentId: text(document, 'agent_id'),
    agentType: text(document, 'agent_type'),
    toolName: text(document, 'tool_name'),
    command: text(input, 'command'),
    // Strictly the boolean, because the field is documented as one and a
    // truthy string would be a payload this file does not understand.
    background: input.run_in_background === true,
    cwd: text(document, 'cwd'),
  })
}

/** The shell operators a command line is cut at before any segment is read.
 *  A segment is what a shell would run as one command, near enough: the
 *  guard is a guardrail and not a security boundary, so a `git restore`
 *  hidden inside a quoted argument is read as a real one and denied, which
 *  costs a person one commit and never costs anyone their work. */
const SEGMENTS = /[;\n]|&&|\|\|?/

/** Shell syntax that can open a segment without being part of the command:
 *  a subshell, a group, or a `then` or `do` from a compound statement. */
const OPENERS: readonly string[] = ['(', '{', 'then', 'do', 'else', '!']

/** An environment assignment in front of a command (`GIT_DIR=x git ...`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** What a destructive git command names: the tree it would act on, and the
 *  paths inside it to ask about.
 *
 *  `directory` is the command's own `-C` argument, or `null` for "wherever the
 *  tool call runs". An empty `pathspec` means the whole tree is the question;
 *  anything else is the operands of a `git checkout` written without a `--`,
 *  which {@link decide} hands to git rather than guessing at. */
export interface Destructive {
  readonly directory: string | null
  readonly pathspec: readonly string[]
}

/**
 * What a destructive git command in `command` would act on, or `undefined`
 * when the command asks for nothing of the kind.
 *
 * Three forms qualify:
 *
 *   - `git restore ...`, with or without `--staged`, which exists to
 *     overwrite working tree files.
 *   - `git checkout` with a `--` separator, the explicit pathspec form.
 *   - `git checkout <operands>` with no separator. This is the spelling round
 *     7's stream lost its file to (`git checkout hook-io.ts`), and `git
 *     checkout .` is the same command with a wider reach. The same words may
 *     be a branch, and only the repository can tell, so the operands are
 *     carried out to {@link decide}, which scopes the one probe it already
 *     runs to them: a branch name matches no path and answers clean, while a
 *     path answers with the work about to be overwritten. Asking costs no
 *     extra process and denies nothing a branch switch needs.
 */
export const destructiveGit = (command: string): Destructive | undefined => {
  for (const segment of command.split(SEGMENTS)) {
    const answer = readSegment(segment.trim().split(/\s+/))
    if (answer !== undefined) return answer
  }
  return undefined
}

/** The token at `index`, with a position past the end reading as the empty
 *  string. One helper rather than a `?? ''` at each read: a segment can run
 *  out at every one of the positions below (`git -C` is a whole command
 *  line), so this is the one place that fact is handled. */
const at = (tokens: readonly string[], index: number): string => tokens[index] ?? ''

/** One segment's tokens, read the way a shell would start to: openers and
 *  environment assignments, then the command, then git's own options, then
 *  the subcommand. */
const readSegment = (tokens: readonly string[]): Destructive | undefined => {
  let start = 0
  while (OPENERS.includes(at(tokens, start)) || ASSIGNMENT.test(at(tokens, start))) start += 1

  // `git`, `/usr/bin/git`, and the two spellings Windows adds, since the
  // matcher covers `PowerShell` on purpose (hooks.md, "PowerShell"): a `.exe`
  // suffix and a backslash separator. `sudo git` and `xargs git` are not read,
  // and nothing this guard exists to catch has ever arrived that way.
  if (!/(^|[\\/])git(\.exe)?$/i.test(at(tokens, start))) return undefined

  let directory: string | null = null
  let cursor = start + 1
  while (cursor < tokens.length) {
    const token = at(tokens, cursor)
    if (token === '-C') {
      // Empty when `-C` is the last token, which is git's own usage error and
      // not a tree this can name.
      const named = at(tokens, cursor + 1)
      directory = named === '' ? null : named
      cursor += 2
      continue
    }
    if (token.startsWith('-C') && token.length > 2) {
      directory = token.slice(2)
      cursor += 1
      continue
    }
    // `-c a=b` is the one global option a brief has ever used that takes a
    // separate argument; every other option is one token, value attached or
    // not (`--git-dir=...`, `--no-pager`).
    if (token === '-c') {
      cursor += 2
      continue
    }
    if (token.startsWith('-')) {
      cursor += 1
      continue
    }
    break
  }

  const verb = at(tokens, cursor)
  const operands = tokens.slice(cursor + 1)
  if (verb === 'restore') return { directory, pathspec: [] }
  if (verb !== 'checkout') return undefined
  if (operands.includes('--')) return { directory, pathspec: [] }

  // No separator. Everything that is not an option is carried out as the
  // question to put to git; a `checkout` that names nothing at all (`git
  // checkout`, `git checkout -f`) asks for no file and is left alone.
  const named = operands.filter((token) => token !== '' && !token.startsWith('-'))
  return named.length === 0 ? undefined : { directory, pathspec: named }
}

/** The subagent as a denial names it. */
const who = (call: ToolCall): string =>
  call.agentType === null ? 'this subagent' : `subagent ${call.agentType}`

/** Only a tracked file's uncommitted state is work this command can destroy.
 *  `git status --porcelain` marks an untracked file `??`, which neither `git
 *  checkout` nor `git restore` touches, so a tree holding only those is clean
 *  for this purpose. `harness/git.ts` keeps the same two fixtures apart for
 *  the same reason ("an untracked file, which must NOT block a sync").
 *
 *  The `!!` arm is defence and not a case this probe can reach: git lists an
 *  ignored file only when asked with `--ignored`, and {@link decide} never
 *  asks. It is kept, and pinned by a test through the injected reader, so that
 *  adding `--ignored` later cannot quietly turn an ignored file into a reason
 *  to refuse someone's command. */
const trackedChanges = (porcelain: string): readonly string[] =>
  porcelain
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('??') && !line.startsWith('!!'))

/**
 * The verdict on one tool call, with git asked only when it has to be.
 *
 * The order is the cost order. A main thread call, or a call of any tool but
 * a shell, is answered without reading the command at all; a shell command
 * that asks for nothing destructive is answered without starting git. The
 * one probe this runs is `git status --porcelain`, on the command's own
 * target tree.
 *
 * A git that cannot answer allows, and says why on stderr: an unreadable tree
 * is not evidence of a dirty one, and a guard that denied on a failed probe
 * would deny every command run outside a repository.
 */
export const decide = async (
  call: ToolCall,
  context: { readonly git: GitReader; readonly output: Output },
): Promise<Verdict> => {
  if (call.agentId === null) return { decision: 'allow' }
  if (call.toolName === null || !SHELL_TOOLS.includes(call.toolName)) return { decision: 'allow' }

  if (call.background) {
    return {
      decision: 'deny',
      reason:
        `The workstreams guard refuses run_in_background for ${who(call)}: run it in the ` +
        `foreground with an explicit timeout of at most ${FOREGROUND_CEILING_MS} ms, because a ` +
        'turn that ends on a background command reads to your caller as a worker that stopped ' +
        'short, and costs a resume message and the minutes before it.',
    }
  }

  if (call.command === null) return { decision: 'allow' }
  const target = destructiveGit(call.command)
  if (target === undefined) return { decision: 'allow' }

  const directory = target.directory ?? call.cwd
  if (directory === null) {
    context.output.err.write(
      'workstreams guard: the payload carries neither a -C directory nor a cwd, so the tree ' +
        'this command targets could not be checked; allowing it.\n',
    )
    return { decision: 'allow' }
  }

  // The whole tree, or only the paths a separatorless `checkout` named. Git
  // resolves those the way it would have resolved them for the command
  // itself, relative to the same directory, so a branch name answers with
  // nothing and this stays silent for every ordinary branch switch.
  const scoped = target.pathspec.length > 0
  const porcelain = await context.git(
    scoped ? ['status', '--porcelain', '--', ...target.pathspec] : ['status', '--porcelain'],
    { cwd: directory },
  )
  if (porcelain === null) {
    context.output.err.write(
      `workstreams guard: git could not report the state of ${directory}, so this command was ` +
        'not checked; allowing it.\n',
    )
    return { decision: 'allow' }
  }

  const changed = trackedChanges(porcelain)
  if (changed.length === 0) return { decision: 'allow' }

  const where = scoped
    ? `${directory}, under ${target.pathspec.join(' ')}, has`
    : `${directory} has`
  return {
    decision: 'deny',
    reason:
      `The workstreams guard refuses this command for ${who(call)}: ${where} ` +
      `${changed.length} uncommitted change${changed.length === 1 ? '' : 's'} to tracked files, ` +
      'and git checkout with a pathspec and git restore both overwrite them; commit first, ' +
      'because two rounds have lost work to exactly this command.',
  }
}

/** The denial, in the documented shape: `hookSpecificOutput` carrying
 *  `permissionDecision` and `permissionDecisionReason` (hooks.md, "PreToolUse
 *  decision control"). Chosen over the exit 2 form, which `hooks.json`'s
 *  trailing `; exit 0` would swallow: that wrapper is what keeps a broken
 *  install from failing a session, and the price of it is that this hook's
 *  decision has to live on stdout. */
export const denial = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

/**
 * Read the payload, decide, and write the decision. Always 0.
 *
 * An allow writes nothing at all. Nothing on stdout is no decision, so the
 * tool call goes on to the permission rules the user actually configured;
 * `permissionDecision: "allow"` would instead skip the prompt those rules
 * asked for, which is a widening nobody asked this guard for.
 */
export const runGuard = async (context: {
  readonly stdin: () => Promise<string>
  readonly git: GitReader
  readonly output: Output
}): Promise<number> => {
  const read = readToolCall(await context.stdin())
  // The discriminant rather than `isOk`, so that the failure arm narrows to
  // the shape carrying `error`.
  if (read.outcome !== 'ok') {
    context.output.err.write(`workstreams guard: ${read.error}; allowing the tool call.\n`)
    return 0
  }
  const verdict = await decide(read.value, context)
  if (verdict.decision === 'deny') context.output.out.write(`${denial(verdict.reason)}\n`)
  return 0
}
