// The decisions of the `gh issue create` guard in the hooks module
// (`hooks/register.ts`, #347). They are here, not in the module, so that
// vitest measures them (ADR 007, rulings 1 and 2). This file imports
// nothing. The engine runs the hooks module with no Node, and this file is
// part of its module graph (ADR 007, ruling 6).

/** The time one read of the issue types may take, in milliseconds. A slow
 *  read delays the first create in a repository by this much, and no more. */
export const TYPES_TIMEOUT_MS = 5000

/** The text of a denied call. It names the skill that sets the type. */
export const DENY_REASON =
  'This repository defines issue types, and this gh issue create has no --type. ' +
  'Create the issue through the gh:issues skill. It sets the type and the priority.'

/** The GraphQL query of `skills/issues/format.md`, Type section. */
const TYPES_QUERY =
  'query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issueTypes(first:20){nodes{name description}}}}'

/** An `--type` read: what the repository defines, as the read answers it. */
export type Types = 'types' | 'none' | 'unknown'

/** One `gh issue create` that has no `--type` value. */
export interface Untyped {
  /** The `-R` or `--repo` value, or `undefined` for the session's directory. */
  readonly repo: string | undefined
}

/** One token of a command line. The groups, in order, are single-quoted
 *  text, double-quoted text, a line join, an escaped character, a separator,
 *  a space, and plain text. A quote with no end takes the rest of the command. */
const TOKEN =
  /'([^']*)'?|"((?:\\[\s\S]|[^"\\])*)"?|(\\\n)|\\([\s\S]?)|([;&|()\n])|([^\S\n]+)|([^\s;&|()'"\\]+)/g

/** The start of a here-document: `<<`, `<<-`, and the delimiter word. */
const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_]\w*)\1/

/** The last two parts of a repository, `owner/name`. A host may come before. */
const OWNER_NAME = /([^/]+)\/([^/]+)$/

/** A `VAR=value` word before the command. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/** The flags that take the next word as their value, before the subcommand. */
const REPO_FLAGS: ReadonlySet<string | undefined> = new Set(['-R', '--repo'])

/** The command with the body of each here-document taken out. The body is
 *  text, and a quote in it must not hide the lines after it. */
const withoutHeredocBodies = (command: string): string => {
  const kept: string[] = []
  let end: string | undefined
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined
      continue
    }
    kept.push(line)
    end = HEREDOC.exec(line)?.[2]
  }
  return kept.join('\n')
}

/**
 * Split a Bash command into simple commands, each a list of words. A
 * `;`, `&`, `|`, parenthesis or newline outside quotes ends a command, so
 * `&&` and `||` do. A quote joins its text to the word, and an empty quote
 * makes an empty word. This is not a full shell parser.
 */
export const commandsOf = (command: string): string[][] => {
  const commands: string[][] = []
  let current: string[] = []
  let word: string | undefined
  const endWord = (): void => {
    if (word !== undefined) current.push(word)
    word = undefined
  }
  for (const match of withoutHeredocBodies(command).matchAll(TOKEN)) {
    if (match[5] !== undefined) {
      endWord()
      if (current.length > 0) commands.push(current)
      current = []
    } else if (match[6] !== undefined) {
      endWord()
    } else if (match[3] === undefined) {
      word = (word ?? '') + [match[1], match[2], match[4], match[7]].join('')
    }
  }
  endWord()
  if (current.length > 0) commands.push(current)
  return commands
}

/** True when the words run `gh issue create`. The words may start with
 *  assignments, and `-R <repo>` or other flags may come before `issue`. */
const runsCreate = (words: readonly string[]): boolean => {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word))
  const [gh, ...args] = words.slice(start)
  const previous = ['', ...args]
  const subcommands = args.filter(
    (word, index) => !word.startsWith('-') && !REPO_FLAGS.has(previous[index]),
  )
  return gh === 'gh' && subcommands[0] === 'issue' && subcommands[1] === 'create'
}

/** The value of `--<name> v` or `--<name>=v`, or of `short v`. The last one
 *  wins. A flag with no word after it has an empty value. */
const flagValue = (
  words: readonly string[],
  name: string,
  short: string | undefined,
): string | undefined => {
  let found: string | undefined
  words.forEach((word, index) => {
    if (word === `--${name}` || word === short) found = words[index + 1] ?? ''
    else if (word.startsWith(`--${name}=`)) found = word.slice(name.length + 3)
  })
  return found
}

/**
 * Each `gh issue create` of a Bash command that has no non-empty `--type`,
 * with its repository. A command with no such part gives an empty list.
 */
export const untypedCreates = (command: string): Untyped[] =>
  commandsOf(command)
    .filter(runsCreate)
    .filter((words) => (flagValue(words, 'type', undefined) ?? '').trim() === '')
    .map((words) => ({ repo: flagValue(words, 'repo', '-R') || undefined }))

/**
 * The argv that reads the issue types of a repository: the query of
 * `format.md`. With no `repo`, `gh` takes the repository of the directory
 * that it runs in. A `repo` is `owner/name`, with an optional host before it.
 */
export const typesArgv = (repo: string | undefined): string[] => {
  const [, owner = '', name = ''] = repo === undefined ? [] : (OWNER_NAME.exec(repo) ?? [])
  return [
    'gh',
    'api',
    'graphql',
    '-F',
    `owner=${repo === undefined ? '{owner}' : owner}`,
    '-F',
    `repo=${repo === undefined ? '{repo}' : name}`,
    '-f',
    `query=${TYPES_QUERY}`,
    '--jq',
    '.data.repository.issueTypes.nodes // []',
  ]
}

/** What the repository defines, from the run of {@link typesArgv}. A run
 *  that failed, or wrote no list, is `unknown`. */
export const typesOf = (ran: { readonly exitCode: number; readonly stdout: string }): Types => {
  if (ran.exitCode !== 0) return 'unknown'
  try {
    const nodes: unknown = JSON.parse(ran.stdout)
    if (!Array.isArray(nodes)) return 'unknown'
    return nodes.length > 0 ? 'types' : 'none'
  } catch {
    return 'unknown'
  }
}

/** The cache key of a read: the repository, else the session's directory. */
export const typesKey = (repo: string | undefined, cwd: string): string =>
  repo === undefined ? `dir:${cwd}` : `repo:${repo}`
