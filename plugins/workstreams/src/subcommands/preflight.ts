// What every workstreams skill depends on, checked before a round starts,
// rather than halfway through one.
//
// CLAUDE.md: "Cross-plugin dependencies, declared through a preflight
// script rather than vendored." The Python precedent was
// `plugins/field-test/scripts/lib/preflight.py` (deleted at #138). The idea
// ported from it is the registry read: a plugin counts as present when
// Claude's installed-plugins file names it under ANY marketplace, because a
// fork of `gh` under another marketplace is still `gh` to the skill that
// runs its commands.
//
// A registry that cannot be read is reported as ITSELF, never as two
// missing plugins: the fix is a different one, and telling someone to
// install what they already have sends them the wrong way.
//
// The lists are two tables, so a later primitive extends the right one in
// one place: REQUIRED_PLUGINS for a dependency a skill cannot work around,
// and OPTIONAL_PLUGINS for one it works around when absent.
//
// `pr-review-toolkit` is checked twice over. The registry says whether the
// plugin is installed at all. The install paths it records say whether the
// five reviewer agents the review loop dispatches are in it. The second
// check exists because a fork under another marketplace satisfies the
// first while it carries a different set of agents, and because a round
// that finds a reviewer missing halfway through would already have spent
// the others.
//
// The command function is the seam (ADR 001), with the process runner and
// the environment injected, so every arm is reachable in-process with no
// `gh` on the machine. It answers with an exit status, rather than an
// envelope, because the missing list belongs on stdout even when the
// answer is 1, and `lib/envelope.ts` writes nothing to stdout for a
// failure.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parseArguments } from '../lib/args.ts'
import type { Runner } from '../lib/process.ts'
import type { Output } from '../lib/streams.ts'

export const HELP = `Check what the workstreams skills depend on.

Usage:
  workstreams.ts preflight [--json]

Checks that gh is installed, that it is logged in, that the gh-stack
extension is present, that pr-review-toolkit is installed and carries every
reviewer agent the review loop names, and reports whether the optional gh
plugin is installed too. Prints one JSON object with --json:

  {"ok": true|false, "missing": [{"id": ..., "hint": ..., "detail": ...}],
   "optional": [{"id": ..., "present": true|false}]}

and the same findings as lines without it; the optional array has no line
form, since a missing optional plugin is never a finding. Each hint is a
command to run, except where the hint says what could not be checked
instead: an unreadable registry names the file, and a missing reviewer names
the agent. Exits 0 when everything required is present, 1 when anything
required is missing, and 2 on a usage error; the optional array never moves
the exit status.`

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
 *  dependency here and nowhere else. A missing one is a finding and moves
 *  the exit status to 1. */
export const REQUIRED_PLUGINS: ReadonlyArray<{ readonly id: string; readonly hint: string }> = [
  { id: 'pr-review-toolkit', hint: '/plugin install pr-review-toolkit@claude-plugins-official' },
]

/**
 * Plugins a skill uses when present and works around when not, so a missing
 * one is never a finding and never moves the exit status.
 *
 * `gh` is the only row: `/workstreams:question` asks the person to run
 * `/gh:sync` when it is there, and fast-forwards the default branch itself
 * when it is not. Reported in the envelope's `optional` array as
 * `{id, present}` rather than folded into `missing`, so a caller can act on
 * presence without reading it as something to fix.
 */
export const OPTIONAL_PLUGINS: ReadonlyArray<{ readonly id: string; readonly hint: string }> = [
  { id: 'gh', hint: '/plugin install gh@bje' },
]

/** Whether one optional plugin's registry entry was found. */
export interface OptionalStatus {
  readonly id: string
  readonly present: boolean
}

/**
 * The reviewer subagents `skills/review` dispatches. Which of them a round
 * picks is decided by the kind of change under review.
 *
 * Checked by name, rather than inferred from whether the plugin is
 * installed, because a fork of `pr-review-toolkit` under another
 * marketplace satisfies the plugin row above while it carries a different
 * set of agents, and a round that discovers a missing reviewer halfway
 * through is a round that has already spent its reviewers' tokens. The
 * registry does not list agents, so this is checked against the plugin's
 * own `agents/` directory.
 */
export const REVIEWER_PLUGIN = 'pr-review-toolkit'

export const REQUIRED_REVIEWERS: readonly string[] = [
  'code-reviewer',
  'comment-analyzer',
  'silent-failure-hunter',
  'pr-test-analyzer',
  'type-design-analyzer',
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
 * Every directory the registry records the plugin as installed in, under any
 * marketplace and in any scope.
 *
 * One plugin has many entries, one per project that installed it, and they
 * are different cache copies at different versions. Every one of them is
 * checked, and a reviewer found under any is present: the session that runs
 * the round resolves the plugin from whichever scope applies, and there is no
 * project path here to compare against that would say which.
 */
export const installPathsFor = (plugins: Record<string, unknown>, id: string): string[] => {
  const paths: string[] = []
  for (const [key, value] of Object.entries(plugins)) {
    if (!key.startsWith(`${id}@`)) continue
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const record = entry as Record<string, unknown> | null
      const installPath = record === null ? undefined : record.installPath
      if (typeof installPath === 'string' && !paths.includes(installPath)) paths.push(installPath)
    }
  }
  return paths
}

/**
 * The reviewer agents `skills/review` dispatches that no installed copy of
 * `pr-review-toolkit` carries.
 *
 * Checked against the plugin's own `agents/` directory, because the
 * registry records where a plugin is installed, and nothing about what is
 * in it. A fork under another marketplace satisfies the plugin row while
 * it carries a different set of agents. A round that discovers a missing
 * reviewer halfway through has already spent the other reviewers' tokens.
 *
 * A plugin the registry names with no install path at all is reported as
 * ITSELF, never as five missing reviewers, for `registry-unreadable`'s
 * reason: "the reviewers could not be checked" is a different instruction
 * from "these reviewers are not there".
 *
 * A path that is RECORDED and not there gets the same instruction again.
 * The registry keeps an entry per project that installed the plugin, and
 * the cache copy under it is removed on an update or a reinstall, so a
 * stale entry is ordinary. `existsSync` answers false for a directory that
 * is gone, dangling, or unreadable alike. If the code asked it about the
 * agent file first, it would report five reviewers absent from a copy
 * that may well carry all five, and send someone to update a plugin that
 * is not the problem.
 */
export const reviewerFindings = (paths: readonly string[]): Finding[] => {
  const reachable = paths.filter((root) => existsSync(root))
  if (reachable.length === 0) {
    return [
      {
        id: 'reviewers-unlocatable',
        hint:
          paths.length === 0
            ? 'the installed plugins file records no install path for pr-review-toolkit, so its reviewer agents could not be checked'
            : `no install path the installed plugins file records for pr-review-toolkit is there, so its reviewer agents could not be checked: ${paths.join(', ')}`,
      },
    ]
  }
  return REQUIRED_REVIEWERS.filter(
    (reviewer) =>
      !reachable.some((root) => existsSync(path.join(root, 'agents', `${reviewer}.md`))),
  ).map((reviewer) => ({
    id: `reviewer:${reviewer}`,
    hint: `update pr-review-toolkit: no agents/${reviewer}.md in any installed copy that is there`,
  }))
}

/** Either the plugins object, or the findings that explain why there isn't
 *  one. `runPreflight` reads the registry once per invocation and passes the
 *  result to both the required and the optional computation, so the two
 *  never see different snapshots of a registry that changed between them. */
type RegistryRead =
  | { readonly ok: true; readonly plugins: Record<string, unknown> }
  | { readonly ok: false; readonly findings: Finding[] }

/**
 * Read the installed-plugins registry.
 *
 * Every arm that cannot answer the question reports `registry-unreadable`
 * rather than a list of plugins, because the id is what a caller branches on
 * and "two plugins are missing" is a different instruction from "this file
 * could not be read". No file at all is a session with nothing installed
 * from this marketplace, which IS an answer about the plugins, so it reads
 * as an empty plugins object rather than as unreadable.
 */
const readRegistry = (env: NodeJS.ProcessEnv): RegistryRead => {
  const file = registryPath(env)
  if (file === '') {
    return {
      ok: false,
      findings: [
        {
          id: 'registry-unreadable',
          hint: 'cannot locate the installed plugins file: HOME is not set',
        },
      ],
    }
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const problem = error as NodeJS.ErrnoException
    if (problem.code === 'ENOENT') return { ok: true, plugins: {} }
    return {
      ok: false,
      findings: [
        {
          id: 'registry-unreadable',
          hint: `installed plugins file: ${file}`,
          detail: excerpt(problem.message),
        },
      ],
    }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      findings: [
        {
          id: 'registry-unreadable',
          hint: `installed plugins file is not valid JSON: ${file}`,
          detail: excerpt((error as Error).message),
        },
      ],
    }
  }
  const plugins =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>).plugins
      : undefined
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return {
      ok: false,
      findings: [
        {
          id: 'registry-unreadable',
          hint: `installed plugins file has no plugins object: ${file}`,
        },
      ],
    }
  }
  return { ok: true, plugins: plugins as Record<string, unknown> }
}

/**
 * What the registry says is missing, among the REQUIRED plugins.
 *
 * Takes an already-read registry, rather than `env`, because `runPreflight`
 * is the only caller. It reads the registry once, and shares the result
 * with `optionalFromRegistry` below, so the two can never see different
 * snapshots of a registry that changed between them.
 */
export const findingsFromRegistry = (registry: RegistryRead): Finding[] => {
  if (!registry.ok) return registry.findings
  const missing = REQUIRED_PLUGINS.filter(
    (required) => !hasPlugin(registry.plugins, required.id),
  ).map((required) => ({ ...required }))
  // The reviewers are only asked about when the plugin that carries them
  // is there. A missing plugin already says everything, and five reviewer
  // findings under it would send a reader after agents that arrive with
  // the install.
  if (hasPlugin(registry.plugins, REVIEWER_PLUGIN)) {
    missing.push(...reviewerFindings(installPathsFor(registry.plugins, REVIEWER_PLUGIN)))
  }
  return missing
}

/**
 * Whether each OPTIONAL plugin is installed. This is never a finding, and
 * it never moves the exit status.
 *
 * A registry that could not be read answers `present: false` for every
 * optional plugin, the same as one that was read and found empty. The
 * caller's fallback path (fast-forward the default branch itself, rather
 * than ask for `/gh:sync`) is the safe default when presence cannot be
 * confirmed.
 */
export const optionalFromRegistry = (registry: RegistryRead): OptionalStatus[] => {
  const plugins = registry.ok ? registry.plugins : {}
  return OPTIONAL_PLUGINS.map((optional) => ({
    id: optional.id,
    present: hasPlugin(plugins, optional.id),
  }))
}

/**
 * What `gh` is missing: the binary, the login, or the stack extension.
 *
 * One finding stops the rest. A machine with no `gh` cannot be asked
 * whether it is logged in, and to report three findings for one cause
 * would send a reader after two things that are not wrong.
 */
export const ghFindings = async (run: Runner): Promise<Finding[]> => {
  const version = await run('gh', ['--version'])
  // Any non-zero status from `--version` means "gh is not usable". 127
  // and 126 are the shell's own statuses for a command that is not there
  // or cannot run (`lib/process.ts`'s convention for a child that never
  // started). But a corrupted install, or a binary that crashes, can exit
  // with any other code. To fall through to the auth check for those
  // would report "gh auth login" as the remedy for a binary that does not
  // run at all.
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
 * Nothing here throws. A check that cannot be made is a finding. That is
 * the whole point of a check that runs before a round, rather than during
 * one.
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

  const registry = readRegistry(context.env)
  const missing = [...(await ghFindings(context.run)), ...findingsFromRegistry(registry)]
  const optional = optionalFromRegistry(registry)

  if (parsed.value.json) {
    context.output.out.write(`${JSON.stringify({ ok: missing.length === 0, missing, optional })}\n`)
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
