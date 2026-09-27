// The intersect: every open pull request's head against the default branch
// and against each other, read with local git. The orchestrator runs it on
// each tick (round 10 rulings 10, 13 and 14). It finds a real collision
// between two streams, the rebase debt of a branch that no round opened, and
// the facts of the per-head check: a `pull_request` run for the head, and
// clean checkouts.
//
// **git does the work, on objects fetched by sha.** Each head is fetched as
// `git fetch origin <sha>`, with no refspec to write and no `FETCH_HEAD`.
// So the command leaves no named ref behind (ruling 10). `git merge-base`,
// `git diff` and `git merge-tree --write-tree` then use the same objects.
// `merge-tree` writes tree objects to the object store and no ref.
//
// **A value that could not be read is reported as itself.** A head that
// could not be fetched has no merge base, no file list and no merge result.
// Its merge result is `unread`, never `clean`. Each reason goes into
// `unavailable`, which a caller reads before it acts on the facts.
//
// The judgement is the skill's: which collision is real work, and the order
// to merge in. This command says what git says.
//
// The command function is the seam (ADR 001): parsed arguments, an injected
// `GhClient` and the directory to run git in, an envelope out.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok } from '../lib/envelope.ts'
import type { GhClient, PullRequestHead } from '../lib/gh.ts'
import { defaultBranch, runGit, toplevel } from '../lib/git.ts'

export const HELP = `Every open pull request's head against the default branch and each other.

Usage:
  workstreams.ts intersect [--json]

Fetches the head of each open pull request by sha, including ones no round
opened, and leaves no named ref behind. Then reports for each head:

  merge base    where the head leaves the default branch, and how many commits
                the default branch has gained since: the rebase debt
  files         the files the head changes against its merge base
  against main  git merge-tree --write-tree of the head and the default
                branch: clean, or the paths that conflict
  run           whether a workflow run with event pull_request exists for
                the exact head sha
  worktree      the local worktree on the head branch, if any, and whether
                it is clean

and each pair of heads that change a common file, with the result of git
merge-tree --write-tree for the pair. It also reports whether the root
checkout is clean.

--json prints the report as one JSON object for a skill to read.

A fact that could not be read is null, or "unread", and never a negative
answer. Each reason is listed under "unavailable". Exits 2 on a usage error,
and 1 outside a git checkout or when no pull request could be read at all.`

const SPEC = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** What `git merge-tree --write-tree` said about two commits. */
export type MergeResult =
  | { readonly result: 'clean' }
  | { readonly result: 'conflict'; readonly paths: readonly string[] }
  | { readonly result: 'unread'; readonly reason: string }

/** A checkout and whether its status is empty. `clean` is null when
 *  `git status` could not run there. */
export interface Checkout {
  readonly path: string
  readonly clean: boolean | null
}

/** The default branch and its tip. `fetched` is false when the fetch
 *  failed and the tip is the local `origin/<name>`. `sha` is null when
 *  neither could be read. */
export interface DefaultTip {
  readonly name: string
  readonly sha: string | null
  readonly fetched: boolean
}

/** One open pull request, with what git said about its head. */
export interface PullReport {
  readonly number: number
  readonly title: string
  readonly head: string
  readonly headSha: string
  readonly base: string
  readonly draft: boolean
  /** Whether the head commit is in the local object store. */
  readonly fetched: boolean
  readonly mergeBase: string | null
  /** The commits the default branch has gained since the merge base. */
  readonly behind: number | null
  /** The files the head changes against the merge base, or null. */
  readonly files: readonly string[] | null
  readonly againstDefault: MergeResult
  /** Whether a run with event `pull_request` exists for the exact head, or
   *  null when the run list fell short and did not show one. */
  readonly pullRequestRun: boolean | null
  /** The worktree on the head branch, or null when there is none. */
  readonly worktree: Checkout | null
}

/** Two heads that change a common file. */
export interface PairReport {
  readonly pullRequests: readonly [number, number]
  readonly shared: readonly string[]
  readonly merge: MergeResult
}

export interface IntersectReport {
  /** Null when the default branch could not be named at all. */
  readonly defaultBranch: DefaultTip | null
  /** The main worktree: the checkout the others were added from. */
  readonly checkout: Checkout
  readonly pullRequests: readonly PullReport[]
  readonly pairs: readonly PairReport[]
  /** Every reason the report is short. Empty is the only value that means
   *  every fact in it was read. */
  readonly unavailable: readonly string[]
}

/** The edges this command reads: one `gh`, and git in one directory. */
export interface IntersectContext {
  readonly gh: GhClient
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

const short = (sha: string): string => sha.slice(0, 7)

/** git's answer, or its reason for no answer: its own stderr, or its
 *  status when it said nothing. */
type GitAnswer = { readonly out: string } | { readonly reason: string }

const reasonOf = (args: readonly string[], status: number | null, stderr: string): string => {
  const said = stderr.trim().split('\n')[0] as string
  return said === '' ? `git ${args[0]} exited ${status}` : said
}

/** Lists split on NUL, which git prints for `-z`. No entry is empty. */
const nulList = (out: string): string[] => out.split('\0').filter((entry) => entry !== '')

/**
 * The result of `git merge-tree --write-tree` for two commits.
 *
 * Exit 0 is clean. Exit 1 is a conflict, but git also exits 1 for a
 * commit it cannot read ("not something we can merge"). So a conflict is
 * trusted only when stdout starts with the tree oid that `--write-tree`
 * prints first. Anything else is `unread`, never `clean`.
 */
const mergeTree = async (
  git: (
    args: readonly string[],
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>,
  left: string,
  right: string,
): Promise<MergeResult> => {
  const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right]
  const result = await git(args)
  const [tree = '', ...paths] = nulList(result.stdout)
  const wrote = /^[0-9a-f]{40,64}$/.test(tree)
  if (result.status === 0 && wrote) return { result: 'clean' }
  if (result.status === 1 && wrote) return { result: 'conflict', paths }
  return { result: 'unread', reason: reasonOf(args, result.status, result.stderr) }
}

/**
 * Every worktree git knows, from `git worktree list --porcelain -z`. The
 * first entry is the main worktree. `branch` is null for a detached or a
 * bare entry.
 */
const worktreesOf = (out: string): { path: string; branch: string | null }[] => {
  const trees: { path: string; branch: string | null }[] = []
  // With `-z`, a NUL ends each field and a second NUL ends each record.
  for (const record of out.split('\0\0')) {
    const fields = record.split('\0')
    const tree = fields.find((field) => field.startsWith('worktree '))
    if (tree === undefined) continue
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))
    trees.push({
      path: tree.slice('worktree '.length),
      branch: branch === undefined ? null : branch.slice('branch refs/heads/'.length),
    })
  }
  return trees
}

/** How a pair's shared files read, for a person. */
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const mergeText = (merge: MergeResult): string => {
  if (merge.result === 'clean') return 'clean'
  if (merge.result === 'conflict') return `conflict in ${merge.paths.join(', ')}`
  return `unread (${merge.reason})`
}

const cleanText = (clean: boolean | null): string =>
  clean === null ? 'unread' : clean ? 'clean' : 'dirty'

/** The whole report, for a person. */
export const renderReport = (report: IntersectReport): string => {
  const lines: string[] = []
  if (report.unavailable.length > 0) {
    lines.push('INCOMPLETE: the facts below are short of what was asked for.')
    for (const reason of report.unavailable) lines.push(`  ${reason}`)
    lines.push('')
  }
  const tip = report.defaultBranch
  const main = tip === null ? 'the default branch' : tip.name
  if (tip === null) lines.push('default branch: unknown')
  else if (tip.sha === null) lines.push(`default branch: ${tip.name}, tip unread`)
  else {
    const where = tip.fetched ? 'fetched' : 'local, not fetched'
    lines.push(`default branch: ${tip.name} at ${short(tip.sha)} (${where})`)
  }
  lines.push(`root checkout ${report.checkout.path}: ${cleanText(report.checkout.clean)}`)

  lines.push('', `open pull requests (${report.pullRequests.length})`)
  for (const pull of report.pullRequests) {
    lines.push(`  #${pull.number}  ${pull.head} -> ${pull.base}  ${pull.draft ? 'draft' : 'ready'}`)
    const fetched = pull.fetched ? '' : ' (not fetched)'
    const base =
      pull.mergeBase === null
        ? 'merge base unread'
        : `merge base ${short(pull.mergeBase)}, ${main} is ` +
          (pull.behind === null
            ? 'an unread number of commits ahead of it'
            : `${plural(pull.behind, 'commit')} ahead of it`)
    lines.push(`    head ${short(pull.headSha)}${fetched}, ${base}`)
    lines.push(`    changed files: ${pull.files === null ? 'unread' : pull.files.length}`)
    lines.push(`    against ${main}: ${mergeText(pull.againstDefault)}`)
    const run = pull.pullRequestRun === null ? 'unread' : pull.pullRequestRun ? 'yes' : 'no'
    lines.push(`    pull_request run: ${run}`)
    lines.push(
      `    worktree: ${pull.worktree === null ? 'none' : `${pull.worktree.path}, ${cleanText(pull.worktree.clean)}`}`,
    )
  }

  lines.push('', `pairs that share a file (${report.pairs.length})`)
  for (const pair of report.pairs) {
    const [left, right] = pair.pullRequests
    lines.push(
      `  #${left} and #${right} share ${plural(pair.shared.length, 'file')} ` +
        `(${pair.shared.join(', ')}): ${mergeText(pair.merge)}`,
    )
  }
  return lines.join('\n')
}

/**
 * Read every open pull request's head with local git, and answer with the
 * report.
 */
export const runIntersect = async (
  argv: readonly string[],
  context: IntersectContext,
): Promise<Envelope<string>> => {
  const parsed = parseArguments(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.help) return ok(HELP)

  const where = { cwd: context.cwd, env: context.env }
  const git = (args: readonly string[]) => runGit(args, where)
  const answer = async (args: readonly string[]): Promise<GitAnswer> => {
    const result = await git(args)
    return result.status === 0
      ? { out: result.stdout.replace(/\n+$/, '') }
      : { reason: reasonOf(args, result.status, result.stderr) }
  }
  const statusOf = async (directory: string): Promise<boolean | null> => {
    const result = await runGit(['status', '--porcelain'], { cwd: directory, env: context.env })
    return result.status === 0 ? result.stdout === '' : null
  }

  const top = await toplevel(where)
  if (top === null) {
    return failed(`intersect runs inside a git checkout, and ${context.cwd} is not in one`)
  }

  const heads = await context.gh.listOpenPullRequestHeads()
  if (heads.rows.length === 0 && heads.unavailable !== null) {
    return failed(`intersect read no pull requests: ${heads.unavailable}`)
  }
  const unavailable: string[] = []
  if (heads.unavailable !== null) unavailable.push(`open pull requests: ${heads.unavailable}`)

  // The default branch and its tip. The fetch updates `origin/<name>`, the
  // ref a clone already keeps for it, and adds no new one. No fetch here
  // writes `FETCH_HEAD` either.
  const name = await defaultBranch(where)
  let tip: DefaultTip | null = null
  if (name === null) {
    unavailable.push(
      'the default branch is unknown: origin/HEAD is not set (git remote set-head origin --auto)',
    )
  } else {
    const fetch = await answer([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      'origin',
      `refs/heads/${name}`,
    ])
    const local = await answer([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${name}^{commit}`,
    ])
    const sha = 'out' in local ? local.out : null
    tip = { name, sha, fetched: 'out' in fetch }
    if ('reason' in fetch) {
      unavailable.push(
        `${name} could not be fetched, so the local origin/${name} is used: ${fetch.reason}`,
      )
    }
    if (sha === null) unavailable.push(`origin/${name} could not be read`)
  }
  const base = tip === null ? null : tip.sha

  const listed = await answer(['worktree', 'list', '--porcelain', '-z'])
  const trees = 'out' in listed ? worktreesOf(listed.out) : []
  if ('reason' in listed) unavailable.push(`the worktree list could not be read: ${listed.reason}`)
  // The main worktree comes first in the list. With no list, the checkout
  // the command stands in is the best root there is.
  const root = trees[0]?.path ?? top
  const checkout: Checkout = { path: root, clean: await statusOf(root) }

  const pullRequests: PullReport[] = []
  for (const pull of heads.rows) {
    pullRequests.push(await readPull(pull))
  }

  /** One head's facts. Each read that fell short leaves its own fact null,
   *  and adds its reason. */
  async function readPull(pull: PullRequestHead): Promise<PullReport> {
    const note = (reason: string): void => {
      unavailable.push(`#${pull.number}: ${reason}`)
    }
    // A head already in the object store needs no fetch.
    let fetched = (await git(['cat-file', '-e', `${pull.headSha}^{commit}`])).status === 0
    if (!fetched) {
      const fetch = await answer([
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        pull.headSha,
      ])
      fetched = 'out' in fetch
      if ('reason' in fetch)
        note(`head ${short(pull.headSha)} could not be fetched: ${fetch.reason}`)
    }

    let mergeBase: string | null = null
    let behind: number | null = null
    let files: string[] | null = null
    let againstDefault: MergeResult = {
      result: 'unread',
      reason: base === null ? 'no default branch to compare against' : 'the head was not fetched',
    }
    if (fetched && base !== null) {
      const found = await answer(['merge-base', base, pull.headSha])
      if ('out' in found) {
        mergeBase = found.out
        const count = await answer(['rev-list', '--count', `${mergeBase}..${base}`])
        if ('out' in count) behind = Number(count.out)
        else note(`the commits since the merge base could not be counted: ${count.reason}`)
        const changed = await answer(['diff', '--name-only', '-z', mergeBase, pull.headSha])
        if ('out' in changed) files = nulList(changed.out)
        else note(`the changed files could not be read: ${changed.reason}`)
      } else {
        note(`no merge base with the default branch: ${found.reason}`)
      }
      againstDefault = await mergeTree(git, base, pull.headSha)
      if (againstDefault.result === 'unread') {
        note(`merge-tree against the default branch failed: ${againstDefault.reason}`)
      }
    }

    const runs = await context.gh.listWorkflowRuns({ branch: pull.head })
    const found = runs.rows.some(
      (run) => run.event === 'pull_request' && run.headSha === pull.headSha,
    )
    if (runs.unavailable !== null) note(`runs: ${runs.unavailable}`)
    const pullRequestRun = found ? true : runs.unavailable === null ? false : null

    const tree = trees.find((candidate) => candidate.branch === pull.head)
    const worktree =
      tree === undefined ? null : { path: tree.path, clean: await statusOf(tree.path) }

    return {
      number: pull.number,
      title: pull.title,
      head: pull.head,
      headSha: pull.headSha,
      base: pull.base,
      draft: pull.draft,
      fetched,
      mergeBase,
      behind,
      files,
      againstDefault,
      pullRequestRun,
      worktree,
    }
  }

  // Each pair of heads with a file in common. A head whose file list is
  // unread cannot be paired, and says so once, rather than be left out in
  // silence.
  const pairs: PairReport[] = []
  for (const [index, left] of pullRequests.entries()) {
    if (left.files === null) {
      if (pullRequests.length > 1) {
        unavailable.push(
          `#${left.number}: its changed files are unread, so no pair with it was compared`,
        )
      }
      continue
    }
    for (const right of pullRequests.slice(index + 1)) {
      if (right.files === null) continue
      const theirs = new Set(right.files)
      const shared = left.files.filter((file) => theirs.has(file))
      if (shared.length === 0) continue
      pairs.push({
        pullRequests: [left.number, right.number],
        shared,
        merge: await mergeTree(git, left.headSha, right.headSha),
      })
    }
  }

  const report: IntersectReport = {
    defaultBranch: tip,
    checkout,
    pullRequests,
    pairs,
    unavailable,
  }
  return ok(parsed.value.json ? JSON.stringify(report) : renderReport(report))
}
