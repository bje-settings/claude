// One finished step of the review loop, written as a commit status on the
// pull request's head (#377, mid-round ruling 14). `pr-state` reads these
// statuses back, so no skill parses a comment for the review facts.
//
// A skill cannot write a status with `gh api`: its `allowed-tools` has no
// such entry, and a layer agent may not add one (mid-round ruling 13 on
// #383). It already may run this dispatcher, so the write is an arm here,
// through `GhClient` (round 16 ruling 8).
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type { GhClient, GhError } from '../lib/gh.ts'
import { LOOP_STATUS_PREFIX } from '../required-contexts.ts'

/** The names `mark` writes. `layer` is #396's, and has no reader yet. */
export const MARK_NAMES = ['review-1', 'review-2', 'rot-check', 'layer'] as const

/** The longest description `mark` sends. The round 16 brief for #377 names
 *  this limit. The REST page "Create a commit status" states none (read on
 *  2026-10-13), so the refusal here is this command's own rule. */
export const DESCRIPTION_LIMIT = 140

export const HELP = `Record one finished step of the review loop as a commit status.

Usage:
  workstreams.ts mark <number> <name> [--description <text>] [--head <sha>]

Writes the commit status workstreams/<name>, with state success, on the
head of the pull request, or on --head when it is given. <name> is one of:

  review-1   review round 1 is done. The description "substantial" says
             that round 1 changed logic; any other description is minor.
  review-2   review round 2 is done
  rot-check  the title and body were checked against the final diff
  layer      the layer agent returned

"workstreams.ts pr-state" reads review-1, review-2 and rot-check from the
commits of the pull request. A status cannot be deleted. A later push leaves
it on an older commit of the pull request, where pr-state still reads it.

--description is ${DESCRIPTION_LIMIT} characters at most. --head is a full 40-character
commit sha. With --head, the pull request is not read.

Exits 2 on a usage error, and on a pull request that GitHub says does not
exist. Exits 1 when the pull request could not be read, or the write failed.`

const SPEC = {
  description: { type: 'string', default: '' },
  head: { type: 'string', default: '' },
  help: { type: 'boolean', short: 'h' },
} as const

/** The edges this command reaches: one `gh`, and nothing else. */
export interface MarkContext {
  readonly gh: GhClient
}

/** The pull request and the name, or the refusal that says what was wrong. */
const requested = (
  positionals: readonly string[],
): Envelope<{ pullRequest: number; name: string }> => {
  if (positionals.length !== 2) {
    return refused(`mark takes a pull request number and a name, not ${positionals.length} words`)
  }
  const [word, name] = positionals as [string, string]
  if (!/^[1-9][0-9]*$/.test(word)) {
    return refused(`mark takes a pull request number, not "${word}"`)
  }
  if (!(MARK_NAMES as readonly string[]).includes(name)) {
    return refused(`mark takes one of ${MARK_NAMES.join(', ')}, not "${name}"`)
  }
  return ok({ pullRequest: Number(word), name })
}

/** The head to mark: `--head`, or the pull request's head as GitHub has it. */
const headToMark = async (
  gh: GhClient,
  pullRequest: number,
  head: string,
): Promise<Envelope<string>> => {
  if (head !== '') return ok(head)
  const viewed = await gh.viewPullRequestDetail({ pullRequest })
  if (viewed.missing) return refused(`pull request ${pullRequest} does not exist`)
  // A list on the pull request that ran past one page leaves its head sha
  // intact, so only a pull request that was not read stops the write.
  if (viewed.pullRequest === null) {
    return failed(`mark could not read pull request ${pullRequest}: ${viewed.unavailable}`)
  }
  return ok(viewed.pullRequest.headSha)
}

/** Write one `workstreams/<name>` status, and say where it went. */
export const runMark = async (
  argv: readonly string[],
  context: MarkContext,
): Promise<Envelope<string>> => {
  const parsed = parseCommandLine(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.options.help) return ok(HELP)
  const asked = requested(parsed.value.positionals)
  if (asked.outcome !== 'ok') return asked
  const { description, head } = parsed.value.options
  // Refused before any read, so a bad description costs no call.
  if (description.length > DESCRIPTION_LIMIT) {
    return refused(
      `--description is ${DESCRIPTION_LIMIT} characters at most, not ${description.length}`,
    )
  }
  // A full sha only. A status cannot be deleted, so the write must name
  // one commit, and a short sha can come to match more than one.
  if (head !== '' && !/^[0-9a-f]{40}$/.test(head)) {
    return refused(`--head takes a full 40-character commit sha, not "${head}"`)
  }

  const sha = await headToMark(context.gh, asked.value.pullRequest, head)
  if (sha.outcome !== 'ok') return sha
  const statusContext = `${LOOP_STATUS_PREFIX}${asked.value.name}`
  try {
    await context.gh.createCommitStatus({
      sha: sha.value,
      context: statusContext,
      state: 'success',
      ...(description === '' ? {} : { description }),
    })
  } catch (error) {
    // `createCommitStatus` throws only `GhError` (`lib/gh.ts`), so this is
    // a cast, not a check. An `instanceof` guard would add an arm no input
    // can reach.
    return failed(
      `mark could not write ${statusContext} on ${sha.value}: ${(error as GhError).detail}`,
    )
  }
  return ok(`${statusContext} success on ${sha.value} (#${asked.value.pullRequest})`)
}
