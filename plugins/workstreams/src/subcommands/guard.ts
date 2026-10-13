// The workstreams guard: the `PreToolUse` hook that holds three rules a
// brief line failed to hold on its own.
//
// CLAUDE.md, "Plugin design": "Hook when the action must happen the same
// way every time and needs no reasoning. Guardrails belong in
// `PreToolUse` hooks; an instruction in CLAUDE.md or a skill is a
// request, not enforcement." Each rule below was a request first, in one
// or more briefs, and was ignored anyway:
//
//   - **`run_in_background`.** In round 2, two of three streams ended
//     their turn on a backgrounded test run, and returned "waiting",
//     which a caller can only read as stopped short. In round 3, two of
//     five turns did the same. The audit L1 stream hit it again (#132,
//     the round 2, round 3, and audit L1 findings). Each case cost a
//     resume message and idle minutes.
//   - **A command that overwrites uncommitted work in a tracked file.**
//     Round 7's stream lost its uncommitted hook entry point to its own
//     `git checkout`, mid mutation sweep, and rebuilt the file from
//     memory. A round 2 agent lost edits the same way, with the rule in
//     its brief (#132, the round 7 finding 1). The fix was always one
//     commit away. The spellings are `git restore`, `git checkout` with
//     a pathspec written with or without a `--`, and `git checkout` or
//     `git switch` carrying a force, patch, or `--pathspec-from-file`
//     option. Each of these throws the tree away while naming nothing.
//   - **A second `vitest` suite in the same worktree.** Round 12 ruling 9
//     (#299) adds this rule. A subagent once started a second suite while
//     one already ran, on a loaded machine. The spellings are a direct
//     `vitest` run, and `pnpm exec vitest`, this round's own convention.
//     A third spelling is `pnpm test` or `pnpm run test`. `package.json`
//     maps that script to `vitest run --coverage`.
//
// **Who it binds.** Round 8 ruling 5: a subagent, never the main thread.
// The input carries `agent_id` "only when the hook fires inside a
// subagent" (hooks.md, "Common input fields"), and that is the whole
// test. The refusal reports `agent_type`, so a person who reads the
// denial knows which worker was stopped. The guard never matches on it: a
// plugin subagent's `agent_type` is the plugin-scoped name (sub-agents.md,
// "Project level hooks for subagent events"). To match it would bind
// only the `workstreams:stream` agent, and leave every reviewer, round
// agent, and general purpose worker that gets the same briefs unguarded.
// The orchestrator keeps backgrounding commands, because completion is
// what wakes it.
//
// **What it cannot see.** A command Claude asked to background carries
// `run_in_background: true`, and is denied here. A command the harness
// MOVES to the background when it reaches its timeout is a different
// mechanism, after the tool call has started, with no hook in front of it
// (tools-reference.md, "Background commands": "When a command reaches
// its timeout without finishing, Claude Code moves it to the background
// instead of stopping it"). The remedy for that half is the brief's, and
// it is the same remedy: pass an explicit timeout long enough to finish
// in, and re-run in the foreground whatever was moved.
//
// A hook also cannot see whether a reviewer agent still runs. So the rule
// that a subagent must not edit while a reviewer still reads stays a
// brief line here. #263, which gives each reviewer its own worktree, is
// what can enforce it.
//
// **Never the reason a session stops.** This decides a tool call on
// every Bash command of every session the plugin is installed in.
// Anything it cannot read is one line on stderr, and an allow.
// `hooks/guard.ts` holds the outer half of that promise, and this file
// holds the inner one. An allow is silent, and returns no decision at
// all, rather than a `permissionDecision: "allow"`, which would skip the
// permission prompt the user's own settings asked for (hooks.md,
// "PreToolUse decision control").
//
// **Neither `additionalContext` nor `systemMessage`.**
// `.claude/rules/path-hooks.md` is about a hook with something to tell a
// person. This one has something to tell the worker it just stopped, and
// `permissionDecisionReason` is the field the docs call "shown to
// Claude" for a deny. A `systemMessage` beside it would render in the
// main terminal on every denial, where the person is not the one who has
// to act, and the subagent's own transcript already carries the reason.
//
// The command function is the seam (ADR 001, RFC 001 decision 3): the
// payload text, the output pair, a reader for git, and a reader for the
// process list come in. A status goes out. No test here needs a process.
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

/** One process the guard found, and what it needs of it: the pid, named
 *  in a denial, and the cwd. The cwd is `null` when the guard could not
 *  read it. */
export interface RunningProcess {
  readonly pid: number
  readonly cwd: string | null
}

/** Every `vitest` process now on this machine, or `null` when the guard
 *  could not list any of them. `hooks/guard.ts` passes the production
 *  reader, built on `pgrep`, and on `lsof` too: neither macOS nor every
 *  sandbox has `/proc`. A test passes a fixed list instead, so no test
 *  here needs a process, the same trade {@link GitReader} makes. */
export type ProcessReader = () => Promise<readonly RunningProcess[] | null>

/** The fields of a `PreToolUse` payload this hook reads, and no others
 *  (hooks.md, "Common input fields" and "PreToolUse input"). Every field
 *  is optional in the document, so every one is nullable here. The
 *  payload is Claude Code's, not ours. A field that is missing is a fact
 *  about the call, rather than a reason to fail. */
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
  /** Where the tool call runs, which is the tree every refused command acts on
   *  unless it carries a `-C` of its own. */
  readonly cwd: string | null
}

/** What this hook answers: silence, or a denial with the sentence Claude
 *  reads (hooks.md: `permissionDecisionReason` "For `deny`, shown to
 *  Claude"). */
export type Verdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }

/** The shell tools whose `tool_input.command` this reads. Both, because
 *  on Windows Claude Code routes shell commands through PowerShell, and
 *  may not register the Bash tool at all: "a hook that matches only
 *  `Bash` never fires there" (hooks.md, "PowerShell"). The matcher in
 *  `hooks.json` says the same thing. This is the half that survives if
 *  someone narrows it. */
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
    // `String(error)`, with no `instanceof Error` arm in front of it. The
    // one statement inside this `try` is `JSON.parse`, which throws a
    // `SyntaxError` and nothing else. So an arm for a non-Error throw is a
    // branch no test can reach. The coverage rule says to restructure it
    // away, rather than excuse it (`.claude/rules/type-ts.md`,
    // "Coverage").
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

/** Reads the real path of a directory: `fs.realpath` in production. */
export type PathResolver = (path: string) => Promise<string>

/** `path` with every symbolic link resolved, or `path` as given when the
 *  resolver cannot answer. A path that is gone still gets compared, by its
 *  own string, so it never drops out of the check. */
export const resolvedOrSame = async (path: string, resolve: PathResolver): Promise<string> => {
  try {
    return await resolve(path)
  } catch {
    return path
  }
}

/** The payload text with its `cwd` resolved, so {@link decide} still compares
 *  plain strings. On macOS `/var` and `/tmp` are links, and a process cwd
 *  comes back in the resolved form. Text that is not a JSON object, or that
 *  has no string `cwd`, returns as it came: {@link readToolCall} reports it. */
export const resolvePayloadCwd = async (
  payload: string,
  resolve: PathResolver,
): Promise<string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    return payload
  }
  const document = asRecord(parsed)
  const cwd = document === null ? null : text(document, 'cwd')
  if (document === null || cwd === null) return payload
  return JSON.stringify({ ...document, cwd: await resolvedOrSame(cwd, resolve) })
}

/** The shell operators a command line is cut at, before any segment is
 *  read. A segment is what a shell would run as one command, near
 *  enough. The guard is a guardrail, not a security boundary, so a `git
 *  restore` hidden inside a quoted argument is read as a real one, and
 *  denied. That costs a person one commit, and never costs anyone their
 *  work. */
const SEGMENTS = /[;\n]|&&|\|\|?/

/** Shell syntax that can open a segment, though it is not itself part of
 *  the command: a subshell, a group, or a `then` or `do` from a compound
 *  statement. */
const OPENERS: readonly string[] = ['(', '{', 'then', 'do', 'else', '!']

/** An environment assignment in front of a command (`GIT_DIR=x git ...`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The options that make a `checkout` or a `switch` overwrite the working tree
 *  without naming a single path, so that the whole tree is the question:
 *
 *    - `-f`, `--force`, and `switch`'s `--discard-changes`, which git's own
 *      usage calls "throw away local modifications". Measured against git
 *      2.54.0: `git checkout -f` on a tree with two modified tracked files
 *      left it clean, and so did `git checkout -f <branch>`, `git checkout
 *      --force`, `git switch -f <branch>` and `git switch --discard-changes
 *      <branch>`. This is the loss at the top of this file, spelled without a
 *      pathspec.
 *    - `-p` and `--patch`, which offer every modified tracked file hunk by
 *      hunk when no path follows. `restore` is already caught whatever its
 *      operands, so `git restore -p` was refused while `git checkout -p` was
 *      not.
 *    - `--pathspec-from-file`, which reads the paths out of a file, in either
 *      spelling.
 */
const WHOLE_TREE = /^(-f|--force|-p|--patch|--discard-changes|--pathspec-from-file(=.*)?)$/

/** The options whose argument is a ref and never a path. `git checkout -h`
 *  gives `checkout` two forms, `[<options>] <branch>` and `[<options>]
 *  [<branch>] -- <file>...`. With any of these, the command creates or
 *  tracks a branch, and accepts no pathspec at all, so there is nothing to
 *  put to git. Without this list, the argument of a `-b` was probed as a
 *  path, and `git checkout -b <name>` was refused whenever a dirty
 *  tracked file, or a directory that held one, was called `<name>`. */
const REF_OPTIONS: readonly string[] = ['-b', '-B', '--orphan', '-t', '--track']

/** What a destructive git command names: the tree it would act on, and the
 *  paths inside it to ask about.
 *
 *  `directory` is the command's own `-C` argument, or `null` for "wherever
 *  the tool call runs". An empty `pathspec` means the whole tree is the
 *  question. Anything else is the operands of a `git checkout` written
 *  without a `--`, which {@link decide} hands to git, rather than guess
 *  at them. */
export interface Destructive {
  readonly directory: string | null
  readonly pathspec: readonly string[]
}

/**
 * What a destructive git command in `command` would act on, or `undefined`
 * when the command asks for nothing of the kind.
 *
 * Four forms qualify:
 *
 *   - `git restore ...`, with or without `--staged`, which exists to
 *     overwrite working tree files.
 *   - `git checkout` with a `--` separator, the explicit pathspec form.
 *   - `git checkout` or `git switch` carrying one of {@link WHOLE_TREE}, which
 *     throws local modifications away without naming anything, so the whole
 *     tree is what is at stake.
 *   - `git checkout <operands>` with no separator. This is the spelling round
 *     7's stream lost its file to (`git checkout hook-io.ts`), and `git
 *     checkout .` is the same command with a wider reach. The same words may
 *     be a branch, and only the repository can tell, so the operands are
 *     carried out to {@link decide}, which scopes the one probe it already
 *     runs to them: a path answers with the work about to be overwritten,
 *     while a name that is only a branch matches no path and answers clean.
 *
 * This check costs no extra process. It costs one false refusal, and only one: a
 * name that is BOTH an existing branch and a dirty tracked path reads as the
 * path, while git would have resolved the branch and carried the change
 * over (measured against git 2.54.0). To tell those apart needs a second
 * question to git. The refusal costs a commit and never costs work, so
 * the one probe stands. The options that name a branch are the case that
 * is NOT ambiguous, and {@link REF_OPTIONS} keeps them out of the probe.
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
  if (verb !== 'checkout' && verb !== 'switch') return undefined

  // A spelling that overwrites the working tree without naming a path: the
  // whole tree is the question, as it is for an explicit `--`.
  if (operands.some((token) => WHOLE_TREE.test(token))) return { directory, pathspec: [] }
  // Everything else a `switch` can do carries uncommitted work across with
  // it, rather than overwrite it (measured: `git switch <branch>` on a
  // modified tracked file leaves it modified on the new branch). So only
  // the spellings above make a switch destructive.
  if (verb === 'switch') return undefined
  if (operands.includes('--')) return { directory, pathspec: [] }
  // An option that names the branch rules a pathspec out of the whole command.
  if (operands.some((token) => REF_OPTIONS.includes(token))) return undefined

  // No separator. Everything that is not an option is carried out as the
  // question to put to git; a `checkout` that names nothing at all (`git
  // checkout`, `git checkout --quiet`) asks for no file and is left alone.
  const named = operands.filter((token) => token !== '' && !token.startsWith('-'))
  return named.length === 0 ? undefined : { directory, pathspec: named }
}

/** `pnpm` itself, matched the same way {@link readSegment} matches
 *  `git`: a path may sit in front, and a `.cmd` suffix names the Windows
 *  shim. Case-insensitive, for the same reason. */
const PNPM_VERB = /(^|[\\/])pnpm(\.cmd)?$/i

/** `vitest` itself, matched the same way. */
const VITEST_VERB = /(^|[\\/])vitest(\.cmd)?$/i

/** What a `vitest` run in one segment would act on: the directory a
 *  `pnpm -C`/`--dir` option names, or `null` for "wherever the tool call
 *  runs", the same meaning {@link Destructive.directory} carries for a
 *  git command's own `-C`. */
export interface VitestTarget {
  readonly directory: string | null
  /** The directory of a leading `cd <dir> &&` that this run follows
   *  ({@link vitestTarget}), as typed. A relative `directory` also joins to
   *  it. Absent when no such `cd` applies. */
  readonly base?: string
  /** True when the directory could not be read: a quote never closes, or one
   *  is left in the value. The guard then reports it and allows the run. */
  readonly unclosedQuote?: true
}

/** A segment split on whitespace, where a quoted span stays inside one
 *  token with its quote marks kept ({@link readDirectoryValue} removes
 *  them). `closed` is false when a quote never closes. The rest of the
 *  segment is then the last token. */
const tokenize = (segment: string): { tokens: string[]; closed: boolean } => {
  const tokens: string[] = []
  let current = ''
  let quote = ''
  for (const char of segment) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      current += char
      quote = char
    } else if (/\s/.test(char)) {
      if (current !== '') tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') tokens.push(current)
  return { tokens, closed: quote === '' }
}

/** A `-C`/`--dir` value, with one matching pair of surrounding `'` or `"`
 *  removed, and an empty result read as `null`. A quoted value that never
 *  loses its quote marks cannot equal a real process cwd, read through
 *  `/proc` or `lsof`, which never carries one. */
const readDirectoryValue = (value: string): string | null => {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  const unquoted = quoted ? value.slice(1, -1) : value
  return unquoted === '' ? null : unquoted
}

/** One segment's tokens, read for a `vitest` run. Four verb spellings
 *  qualify. The first is a direct `vitest` call. The second is `pnpm
 *  exec vitest`, this round's own convention (`lefthook.yml`,
 *  `.github/workflows/ci.yml`). The third is a bare `pnpm vitest`, which
 *  runs the same binary with no `exec` keyword needed (measured against
 *  pnpm 10.34.5: `pnpm vitest --version` runs this repository's own
 *  vitest). The fourth is `pnpm test` or `pnpm run test`: `package.json`'s
 *  only script, `test`, runs `vitest run --coverage`.
 *
 *  `pnpm`'s own `-C <dir>`, `-C=<dir>`, `--dir <dir>`, and `--dir=<dir>`
 *  name the directory `pnpm` runs the script in, the same fact git's `-C`
 *  names for {@link readSegment} (measured against pnpm 10.34.5: `pnpm
 *  -C=<dir> test` runs the script in `<dir>`, the same as `pnpm -C <dir>
 *  test`; the attached form with no `=`, `-C<dir>`, is not a pnpm spelling
 *  at all). The worktree workflow's own rule is "every command names its
 *  directory by absolute path. Never `cd`", with two exceptions, `gh stack`
 *  and the scratchpad real exercise (rule 12 of
 *  `plugins/workstreams/skills/stream/brief.md`). So this is the ordinary
 *  spelling a subagent uses to test one worktree, not an edge case.
 *  {@link vitestTarget} reads the leading `cd` of the two exceptions. A
 *  directory value wrapped in one matching pair of quote marks has them
 *  stripped. The tokens keep a quoted span whole, so a path with a
 *  space is one value (#371); an empty value, from either form, reads
 *  as no directory named, the meaning {@link Destructive.directory} also
 *  gives an absent `-C`.
 *
 *  `npm` and `yarn` are left out. This repository has one lockfile,
 *  `pnpm-lock.yaml`, and no other manager runs here. */
const readVitestTarget = (tokens: readonly string[]): VitestTarget | undefined => {
  let start = 0
  while (OPENERS.includes(at(tokens, start)) || ASSIGNMENT.test(at(tokens, start))) start += 1

  const verb = at(tokens, start)
  if (VITEST_VERB.test(verb)) return { directory: null }
  if (!PNPM_VERB.test(verb)) return undefined

  let directory: string | null = null
  let cursor = start + 1
  while (true) {
    const token = at(tokens, cursor)
    if (token === '-C' || token === '--dir') {
      directory = readDirectoryValue(at(tokens, cursor + 1))
      cursor += 2
      continue
    }
    if (token.startsWith('-C=') || token.startsWith('--dir=')) {
      const prefixLength = token.startsWith('-C=') ? '-C='.length : '--dir='.length
      directory = readDirectoryValue(token.slice(prefixLength))
      cursor += 1
      continue
    }
    break
  }

  const sub = at(tokens, cursor)
  if (VITEST_VERB.test(sub)) return { directory }
  if (sub === 'exec') return VITEST_VERB.test(at(tokens, cursor + 1)) ? { directory } : undefined
  if (sub === 'test') return { directory }
  return sub === 'run' && at(tokens, cursor + 1) === 'test' ? { directory } : undefined
}

/** One segment, read for a `vitest` run. The tokens keep a quoted value
 *  whole, so `-C "/a b"` names `/a b` (#371). A quote that never closes
 *  swallows the rest of the segment, also the subcommand. When that quote
 *  opens a `pnpm` directory value, the guard cannot read the directory, and
 *  it says so ({@link VitestTarget.unclosedQuote}). Any other unclosed quote
 *  is read from the tokens, and when they hold no run, as the plain
 *  whitespace split did, so a typo elsewhere in the command still finds the
 *  run. */
const readVitestSegment = (segment: string): VitestTarget | undefined => {
  const { tokens, closed } = tokenize(segment)
  if (closed) return readVitestTarget(tokens)
  const start = tokens.findIndex((token) => !OPENERS.includes(token) && !ASSIGNMENT.test(token))
  const verb = at(tokens, start)
  // The open quote is the last token. It is a pnpm directory value only when
  // every token before it is a complete pnpm directory option, as in
  // `readVitestTarget`. An option after the subcommand is the tool's own.
  const end = tokens.length - 1
  let cursor = start + 1
  while (cursor < end) {
    const token = at(tokens, cursor)
    if (token === '-C' || token === '--dir') {
      if (cursor + 1 === end) break
      cursor += 2
    } else if (/^(-C|--dir)=/.test(token)) {
      cursor += 1
    } else {
      break
    }
  }
  const token = at(tokens, cursor)
  const value =
    cursor === end
      ? /^(-C|--dir)=/.test(token)
      : cursor === end - 1 && (token === '-C' || token === '--dir')
  return PNPM_VERB.test(verb) && value
    ? { directory: null, unclosedQuote: true }
    : (readVitestTarget(tokens) ?? readVitestTarget(segment.trim().split(/\s+/)))
}

/** The segments of a command and the operator after each: the same cuts as
 *  {@link SEGMENTS}, with the operators kept. Even indexes are segments, odd
 *  ones operators. */
const WITH_OPERATORS = /([;\n]|&&|\|\|?)/

/** A directory that could not be read whole: a quote mark left in the value
 *  (`/w/"a b"`), or a `'` span with a space in it. The guard says so and
 *  allows, as for an unclosed quote. A lone `'`, as in `it's`, is a real
 *  name. */
const hasStrayQuote = (directory: string): boolean => /"|'[^']*\s[^']*'/.test(directory)

/** The `(` count less the `)` count. A parenthesis inside quotes counts
 *  too: a guardrail reads the command as text. */
const parenthesisDepth = (text: string): number =>
  (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0)

/** A segment as a run reads it: `(pnpm test)` is `pnpm test`. A subshell
 *  parenthesis joined to the first or the last word hid the verb (`(cd /x`,
 *  `test)`), so the run was not found (#397). */
const unwrapped = (segment: string): string =>
  segment
    .trim()
    .replace(/^\(+\s*/, '')
    .replace(/\)+$/, '')

/** The directory of a segment that is `cd <dir>` and nothing else, or `null`.
 *  A directory that depends on the shell (`-`, `~`, a variable or a
 *  substitution), an option, or a second word is not read, so the run
 *  after it keeps the payload cwd, as it did before #397. */
const cdDirectory = (segment: string): string | null => {
  const { tokens, closed } = tokenize(unwrapped(segment))
  if (!closed || tokens.length !== 2 || tokens[0] !== 'cd') return null
  const directory = readDirectoryValue(at(tokens, 1))
  return directory === null || /^[-~]|[$`]/.test(directory) ? null : directory
}

/**
 * What a `vitest` run in `command` would act on, or `undefined` when no
 * segment starts one, cut at the same shell operators {@link
 * destructiveGit} cuts at.
 *
 * A leading `cd <dir> &&` names the directory of the run that follows
 * (#397, round 16 ruling 6). It covers two forms, `cd <dir> && pnpm test`
 * and `(cd <dir> && pnpm test)`. The rule is the narrowest that covers
 * them:
 *
 *   - The `cd` is the first segment of the command, with `&&` after it. A
 *     `;`, a `||` or a `|` after it does not qualify: the run may not follow
 *     a `cd` that worked, or may run in a pipeline's own subshell. A `cd`
 *     later in the command is not read as a leading one.
 *   - Its scope ends at a second `cd`, and, for the subshell form, at the
 *     segment that closes the parenthesis of the `cd`. The count of `(` and
 *     `)` finds that segment, so `(cd /w) && pnpm test`, a redirect after
 *     the `)`, and a nested `(pnpm build)` are read correctly. A run after
 *     the scope keeps the payload cwd, as before #397.
 *   - A `cd` after the run changes nothing, because the loop returns at the
 *     first run.
 *   - A `pnpm -C` of the run's own wins over the `cd`. A relative one joins
 *     to the `cd` directory, as the shell would.
 */
export const vitestTarget = (command: string): VitestTarget | undefined => {
  const parts = command.split(WITH_OPERATORS)
  const first = parts[0] as string
  const subshell = /^\s*\(/.test(first)
  // The parentheses still open after the `cd` segment. A subshell form that
  // closes in that segment, as in `(cd /w) && pnpm test`, ends the `cd` there.
  let open = parenthesisDepth(first)
  const leading = parts[1] === '&&' && !(subshell && open <= 0) ? cdDirectory(first) : null
  let base: string | null = leading

  for (let index = leading === null ? 0 : 2; index < parts.length; index += 2) {
    const segment = parts[index] as string
    if (/^\s*\(*\s*cd(\s|$)/.test(segment)) base = null
    const target = readVitestSegment(unwrapped(segment))
    if (target === undefined) {
      open += parenthesisDepth(segment)
      if (subshell && open <= 0) base = null
      continue
    }
    const named = base === null ? target : { ...target, base }
    // A quote mark kept inside a token, as in `/w/"a b"`, means the value was
    // not read whole.
    return [named.directory, named.base].some((value) => value != null && hasStrayQuote(value))
      ? { directory: null, unclosedQuote: true }
      : named
  }
  return undefined
}

/** Whether `command` starts a `vitest` run in any segment. */
export const runsVitest = (command: string): boolean => vitestTarget(command) !== undefined

/** The subagent as a denial names it. */
const who = (call: ToolCall): string =>
  call.agentType === null ? 'this subagent' : `subagent ${call.agentType}`

/** Only a tracked file's uncommitted state is work this command can
 *  destroy. `git status --porcelain` marks an untracked file `??`, which
 *  neither `git checkout` nor `git restore` touches, so a tree that holds
 *  only those is clean for this purpose. `harness/git.ts` keeps the same
 *  two fixtures apart for the same reason ("an untracked file, which must
 *  NOT block a sync").
 *
 *  The `!!` arm is defence, not a case this probe can reach: git lists an
 *  ignored file only when asked with `--ignored`, and {@link decide} never
 *  asks. It is kept, and pinned by a test through the injected reader, so
 *  that if someone adds `--ignored` later, that change cannot quietly
 *  turn an ignored file into a reason to refuse someone's command. */
const trackedChanges = (porcelain: string): readonly string[] =>
  porcelain
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('??') && !line.startsWith('!!'))

/** `directory`, with one trailing slash or more removed. A payload's own
 *  `cwd`, and a process's own cwd read through `/proc` or `lsof`, can
 *  name the same directory with or without one; this keeps that
 *  difference from reading as two different worktrees. It does not
 *  resolve a symlink. `hooks/guard.ts` resolves the payload cwd and each
 *  process cwd before this runs ({@link resolvePayloadCwd}). `secondSuite`
 *  resolves a `pnpm -C` directory itself, with the context's `resolve`. */
const stripTrailingSlash = (directory: string): string => directory.replace(/\/+$/, '')

/** The directory that a `pnpm -C` or `--dir` option names, written as a
 *  process cwd is. A relative directory joins to the call cwd. Then
 *  `context.resolve` follows each link. With no `resolve`, an absolute
 *  directory stays as typed. A relative directory has no base when the cwd
 *  is `null` or empty. It returns `null`, as an absent cwd does. */
const namedDirectory = async (
  directory: string,
  cwd: string | null,
  context: { readonly resolve?: PathResolver },
): Promise<string | null> => {
  const rooted = directory.startsWith('/')
  if (!rooted && (cwd === null || cwd === '')) return null
  const joined = rooted ? directory : `${cwd}/${directory}`
  return context.resolve === undefined ? joined : resolvedOrSame(joined, context.resolve)
}

/** The verdict on a `vitest` command alone: whether another `vitest`
 *  process already runs in the same worktree. `decide` asks this before
 *  it asks git. `undefined` means move on to the git check. Either this
 *  command does not run `vitest`, or nothing stands in its way.
 *
 *  `command` is a `string`, not the whole {@link ToolCall}, because
 *  `decide` already narrows out the null case before it calls this. A
 *  second check here would be a branch no test could ever reach. */
const secondSuite = async (
  command: string,
  call: ToolCall,
  context: {
    readonly processes: ProcessReader
    readonly output: Output
    readonly resolve?: PathResolver
  },
): Promise<Verdict | undefined> => {
  const target = vitestTarget(command)
  if (target === undefined) return undefined
  if (target.unclosedQuote) {
    context.output.err.write(
      'workstreams guard: a quote in a pnpm or cd directory value does not close or does not match, so ' +
        'the directory could not be read and a second vitest run could not be checked; allowing it.\n',
    )
    return undefined
  }

  // A leading `cd` moves the run's base from the payload cwd to its own
  // directory (#397). A relative `pnpm -C` then joins to that base.
  const base =
    target.base === undefined ? call.cwd : await namedDirectory(target.base, call.cwd, context)
  const directory =
    target.directory === null ? base : await namedDirectory(target.directory, base, context)
  if (directory === null) {
    context.output.err.write(
      'workstreams guard: the payload carries no cwd, so a second vitest run could not be ' +
        'checked; allowing it.\n',
    )
    return undefined
  }

  const running = await context.processes()
  if (running === null) {
    context.output.err.write(
      'workstreams guard: the running processes could not be listed, so a second vitest run ' +
        'could not be checked; allowing it.\n',
    )
    return undefined
  }

  const other = running.find(
    (entry) =>
      entry.cwd !== null && stripTrailingSlash(entry.cwd) === stripTrailingSlash(directory),
  )
  if (other === undefined) return undefined

  return {
    decision: 'deny',
    reason:
      `The workstreams guard refuses this command for ${who(call)}: pid ${other.pid} is ` +
      `already running vitest in ${directory}; wait for it to finish, and never re-issue the ` +
      'one that is already running.',
  }
}

/**
 * The verdict on one tool call. git and the process list are asked only
 * when they must be.
 *
 * The order is the cost order. A main thread call is answered at once,
 * with no read of the command. So is a call of any tool but a shell. A
 * shell command that neither runs `vitest` nor asks for anything
 * destructive gets no further read either.
 *
 * The one probe for git is `git status --porcelain`, on the command's
 * own target tree. It is scoped with `-- <pathspec>` when a
 * separatorless `checkout` named operands, and it covers the whole tree
 * otherwise. The one probe for a second suite lists the `vitest`
 * processes on the machine, and each one's cwd.
 *
 * A read that fails allows, and says why on stderr. An unreadable tree is
 * not evidence of a dirty one. A guard that denied on a failed probe
 * would deny every command it could not check.
 */
export const decide = async (
  call: ToolCall,
  context: {
    readonly git: GitReader
    readonly processes: ProcessReader
    readonly output: Output
    /** Resolves the links in a `pnpm -C` directory. Without it, a relative
     *  directory only joins to the cwd, and an absolute one stays as typed. */
    readonly resolve?: PathResolver
  },
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

  const suiteVerdict = await secondSuite(call.command, call, context)
  if (suiteVerdict !== undefined) return suiteVerdict

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
      'and this command overwrites them; commit first, ' +
      'because two rounds have lost work to exactly this command.',
  }
}

/** The denial, in the documented shape: `hookSpecificOutput` carries
 *  `permissionDecision` and `permissionDecisionReason` (hooks.md,
 *  "PreToolUse decision control"). Chosen over the exit 2 form, which
 *  `hooks.json`'s trailing `; exit 0` would swallow: that wrapper is what
 *  stops a broken install from failing the whole session. The price of
 *  that is that this hook's decision must live on stdout. */
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
  readonly processes: ProcessReader
  readonly output: Output
  readonly resolve?: PathResolver
}): Promise<number> => {
  const read = readToolCall(await context.stdin())
  // The discriminant rather than `isOk`, so that the failure arm narrows
  // to the shape that carries `error`.
  if (read.outcome !== 'ok') {
    context.output.err.write(`workstreams guard: ${read.error}; allowing the tool call.\n`)
    return 0
  }
  const verdict = await decide(read.value, context)
  if (verdict.decision === 'deny') context.output.out.write(`${denial(verdict.reason)}\n`)
  return 0
}
