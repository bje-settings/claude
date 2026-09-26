// This file tells whether a target owner and each source owner share an
// enterprise (#233). The `gh:issues` skill runs it before it files an issue
// in another owner's repository. The answer decides whether the issue may
// name the source's repositories, numbers and paths.
//
// It is a script, not skill prose, because the answer is deterministic. An
// agent that guessed from names would guess wrong for an organization whose
// name looks like its neighbours.
//
// It fails closed. A wrong "same enterprise" leaks private details into a
// place where they stay in the edit history. A wrong "outside" costs only
// detail in the issue text. So every doubt reads as outside: a user
// account, an owner in no enterprise the viewer can see, and a list gh
// could not read whole ("unknown", which the skill treats as outside).
import type { GhClient } from '../lib/gh.ts'
import type { Output } from '../lib/streams.ts'

export const HELP = `Whether each source owner shares an enterprise with a target owner.

Usage:
  gh.ts org-scope --target <owner> <source-owner>...

Prints one JSON document:
  {"target": "<owner>", "results": [{"source": "<owner>", "scope": "<scope>"}]}

scope is one of:
  same-owner       the source is the target (case does not matter)
  same-enterprise  one enterprise lists both; "enterprise" names its slug
  outside          anything else, such as a user account
  unknown          the enterprise list could not be read whole; the reason
                   is on stderr; treat it as outside

The enterprises are the ones the gh account can see. Exit 0 on any answer.
Exit 2 means the arguments were refused.`

/** The edges this command reads: the output pair, and a `gh` client. */
export interface OrgScopeContext {
  readonly output: Output
  readonly gh: GhClient
}

/** What one source owner is to the target owner. */
export type Scope = 'same-owner' | 'same-enterprise' | 'outside' | 'unknown'

/** One source owner and its scope. `enterprise` is there only for
 *  `same-enterprise`. */
export interface ScopeResult {
  readonly source: string
  readonly scope: Scope
  readonly enterprise?: string
}

/** GitHub logins do not depend on case, so every comparison uses this form. */
const key = (login: string): string => login.toLowerCase()

/** The enterprises as `gh` answered them. */
type Enterprises = Awaited<ReturnType<GhClient['viewerEnterprises']>>['enterprises']

/** The scope of one source owner that is not the target, read from a whole
 *  enterprise list. */
const scopeOf = (source: string, target: string, enterprises: Enterprises): ScopeResult => {
  const shared = enterprises.find((enterprise) => {
    const logins = enterprise.organizations.map(key)
    return logins.includes(key(source)) && logins.includes(key(target))
  })
  return shared === undefined
    ? { source, scope: 'outside' }
    : { source, scope: 'same-enterprise', enterprise: shared.slug }
}

/**
 * Print the scope of each source owner against `--target`, as one JSON
 * document on stdout, and answer with the exit status.
 */
export const runOrgScope = async (
  argv: readonly string[],
  context: OrgScopeContext,
): Promise<number> => {
  const { output, gh } = context
  const target = argv[1] as string
  const sources = argv.slice(2)
  const others = sources.filter((source) => key(source) !== key(target))
  const { enterprises } = others.length === 0 ? { enterprises: [] } : await gh.viewerEnterprises()
  const results = sources.map(
    (source): ScopeResult =>
      key(source) === key(target)
        ? { source, scope: 'same-owner' }
        : scopeOf(source, target, enterprises),
  )
  output.out.write(`${JSON.stringify({ target, results })}\n`)
  return 0
}
