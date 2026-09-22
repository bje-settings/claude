// What every workstreams skill depends on, checked before a round starts
// rather than halfway through one.
//
// CLAUDE.md: "Cross-plugin dependencies, declared through a preflight script
// rather than vendored." The Python precedent is
// `plugins/field-test/scripts/lib/preflight.py`, and the idea ported from it
// is the registry read: a plugin is present when Claude's installed-plugins
// file names it under ANY marketplace, because a fork of `gh` under another
// marketplace is still `gh` to the skill that runs its commands.
//
// A registry that cannot be read is reported as ITSELF and never as two
// missing plugins: the fix is a different one, and telling someone to install
// what they already have sends them the wrong way.
//
// The list is a table so a later primitive extends it in one place. Layer 2
// (#133) adds `pr-review-toolkit`, whose reviewers the review loop dispatches.
//
// The command function is the seam (ADR 001), with the process runner and the
// environment injected, so every arm is reachable in-process with no `gh` on
// the machine. It answers with an exit status rather than an envelope,
// because the missing list belongs on stdout even when the answer is 1 and
// `lib/envelope.ts` writes nothing to stdout for a failure.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parseArguments } from '../lib/args.ts'
import type { Runner } from '../lib/process.ts'
import type { Output } from '../lib/streams.ts'

export const HELP = `Check what the workstreams skills depend on.

Usage:
  workstreams.ts preflight [--json]

Checks that gh is installed, that it is logged in, that the gh-stack
extension is present, and that the plugins the skills dispatch to are
installed. Prints one JSON object with --json:

  {"ok": true|false, "missing": [{"id": ..., "hint": ..., "detail": ...}]}

and the same findings as lines without it. Each hint is a command to run,
except for an unreadable registry, whose hint names the file. Exits 0 when
everything is present, 1 when anything is missing, and 2 on a usage error.`

/** How much of a tool's own message is carried, on one line. */
const EXCERPT = 160

/** One finding. `detail` is the tool's own message, when there is one, so a
 *  network failure is not reported as a missing login. */
export interface Finding {
  readonly id: string
  readonly hint: string
  readonly detail?: string
}

/** The plugins the workstreams skills dispatch work to, with the command that
 *  installs each. One row per plugin so a later primitive adds its own
 *  dependency here and nowhere else. */
export const REQUIRED_PLUGINS: ReadonlyArray<{ readonly id: string; readonly hint: string }> = [
  { id: 'gh', hint: '/plugin install gh@bje' },
]

/** A tool's own message on one line, short enough to sit in a JSON field. */
export const excerpt = (text: string): string => text.split('\n').join(' ').trim().slice(0, EXCERPT)

/**
 * Where Claude records the plugins that are installed, or "" when there is
 * nowhere to look.
 *
 * `HOME` unset would otherwise build a relative path, miss, and report every
 * plugin as missing: an answer about the session that ran this rather than
 * about what is installed. The override exists so this command's own suite
 * can point it at a file it wrote, without a `HOME` the rest of the process
 * shares.
 */
export const registryPath = (env: NodeJS.ProcessEnv): string => {
  const override = env.WORKSTREAMS_INSTALLED_PLUGINS
  if (override !== undefined && override !== '') return override
  const home = env.HOME
  if (home === undefined || home === '') return ''
  return path.join(home, '.claude', 'plugins', 'installed_plugins.json')
}

/** Whether the registry names the plugin under any marketplace at all. */
const hasPlugin = (plugins: Record<string, unknown>, id: string): boolean =>
  Object.keys(plugins).some((key) => key.startsWith(`${id}@`))

/**
 * What the registry says is missing.
 *
 * Every arm that cannot answer the question reports `registry-unreadable`
 * rather than a list of plugins, because the id is what a caller branches on
 * and "two plugins are missing" is a different instruction from "this file
 * could not be read".
 */
export const registryFindings = (env: NodeJS.ProcessEnv): Finding[] => {
  const file = registryPath(env)
  if (file === '') {
    return [
      {
        id: 'registry-unreadable',
        hint: 'cannot locate the installed plugins file: HOME is not set',
      },
    ]
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const problem = error as NodeJS.ErrnoException
    // No file at all is a session with nothing installed from this
    // marketplace, which IS an answer about the plugins; anything else is a
    // file this could not read, which is not.
    if (problem.code === 'ENOENT') return REQUIRED_PLUGINS.map((required) => ({ ...required }))
    return [
      {
        id: 'registry-unreadable',
        hint: `installed plugins file: ${file}`,
        detail: excerpt(problem.message),
      },
    ]
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return [
      {
        id: 'registry-unreadable',
        hint: `installed plugins file is not valid JSON: ${file}`,
        detail: excerpt((error as Error).message),
      },
    ]
  }
  const plugins =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>).plugins
      : undefined
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return [
      { id: 'registry-unreadable', hint: `installed plugins file has no plugins object: ${file}` },
    ]
  }
  return REQUIRED_PLUGINS.filter(
    (required) => !hasPlugin(plugins as Record<string, unknown>, required.id),
  ).map((required) => ({ ...required }))
}

/**
 * What `gh` is missing: the binary, the login, or the stack extension.
 *
 * One finding stops the rest: a machine with no `gh` cannot be asked whether
 * it is logged in, and reporting three findings for one cause sends a reader
 * after two things that are not wrong.
 */
export const ghFindings = async (run: Runner): Promise<Finding[]> => {
  const version = await run('gh', ['--version'])
  // Any non-zero status from `--version` is "gh is not usable": 127 and 126
  // are the shell's own statuses for a command that is not there or cannot
  // be run (`lib/process.ts`'s convention for a child that never started),
  // but a corrupted install or a crashing binary can exit with any other
  // code, and falling through to the auth check for those would report
  // "gh auth login" as the remedy for a binary that does not run at all.
  if (version.startFailure !== null || version.status !== 0) {
    const message = version.startFailure === null ? excerpt(version.stderr || version.stdout) : ''
    return [
      {
        id: 'gh',
        hint: 'install the GitHub CLI: https://cli.github.com',
        ...(message === '' ? {} : { detail: message }),
      },
    ]
  }

  const auth = await run('gh', ['auth', 'status'])
  if (auth.status !== 0) {
    return [{ id: 'gh-auth', hint: 'gh auth login', detail: excerpt(auth.stderr || auth.stdout) }]
  }

  const extensions = await run('gh', ['extension', 'list'])
  if (extensions.status !== 0) {
    return [
      {
        id: 'gh-extension-list',
        hint: 'gh extension list',
        detail: excerpt(extensions.stderr || extensions.stdout),
      },
    ]
  }
  // The listing names the extension as `gh stack`, with its repository and
  // version beside it. Matched on the command rather than on the repository,
  // because a fork installed under the same command is the same extension to
  // the skill that runs `gh stack submit`.
  const installed = extensions.stdout.split('\n').some((line) => line.trim().startsWith('gh stack'))
  if (!installed) {
    return [{ id: 'gh-stack', hint: 'gh extension install github/gh-stack' }]
  }
  return []
}

/** The edges this command reads. */
export interface PreflightContext {
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  readonly run: Runner
}

const SPEC = { json: { type: 'boolean' }, help: { type: 'boolean' } } as const

/**
 * Check everything, report it, and answer 0 when nothing is missing.
 *
 * Nothing here throws: a check that cannot be made is a finding, which is the
 * whole point of running it before a round rather than during one.
 */
export const runPreflight = async (
  argv: readonly string[],
  context: PreflightContext,
): Promise<number> => {
  const parsed = parseArguments(argv, SPEC)
  if (parsed.outcome !== 'ok') {
    context.output.err.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.value.help) {
    context.output.out.write(`${HELP}\n`)
    return 0
  }

  const missing = [...(await ghFindings(context.run)), ...registryFindings(context.env)]

  if (parsed.value.json) {
    context.output.out.write(`${JSON.stringify({ ok: missing.length === 0, missing })}\n`)
    return missing.length === 0 ? 0 : 1
  }
  if (missing.length === 0) {
    context.output.out.write('everything the workstreams skills depend on is present\n')
    return 0
  }
  for (const finding of missing) {
    const detail = finding.detail === undefined ? '' : `: ${finding.detail}`
    context.output.out.write(`${finding.id}: ${finding.hint}${detail}\n`)
  }
  return 1
}
