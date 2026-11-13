// The decisions of the `gh issue create` guard, in process (#347). The
// module that uses them runs under `claude plugin test`
// (`register.test.tsx`). These functions are in `src/`, so vitest
// measures them.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  commandsOf,
  DENY_REASON,
  guardOffText,
  TYPES_TIMEOUT_MS,
  typesArgv,
  typesKey,
  typesOf,
  untypedCreates,
} from '#gh/issue-create.ts'

/** The command of `skills/issues/create.md`, step 7, with each
 *  placeholder filled. The here-document body holds a `gh issue create`
 *  with no `--type`. The parser must leave the body out. */
const SKILL_COMMAND = `gh issue create --title "feat(gh): add a thing" --body-file - --type "Feature" --label "gh" --milestone "v1" --blocked-by 3,4 --blocking 5 --parent 2 <<'EOF'
Line one; gh issue create
It's text.
EOF`

describe('commandsOf', () => {
  it('splits on && || ; | & parentheses and newlines outside quotes', () => {
    expect(commandsOf('a && b || c; d | e & f\ng (h)')).toEqual([
      ['a'],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
    ])
  })

  it('keeps a separator inside single or double quotes', () => {
    expect(commandsOf(`echo 'a; b | c' "d && e" f`)).toEqual([['echo', 'a; b | c', 'd && e', 'f']])
  })

  it('joins quoted text to its word, and keeps an empty quote as a word', () => {
    expect(commandsOf(`a"b c"'d'e "" ''`)).toEqual([['ab cde', '', '']])
  })

  it('takes an escaped character, and joins a line that ends in a backslash', () => {
    expect(commandsOf('a\\ b \\; c \\\nd "x\\"y" z\\')).toEqual([
      ['a b', ';', 'c', 'd', 'x\\"y', 'z'],
    ])
  })

  it('joins the two halves of a word that a line join splits', () => {
    expect(commandsOf('a\\\nb c')).toEqual([['ab', 'c']])
  })

  it('takes the rest of the command when a quote has no end', () => {
    expect(commandsOf(`a 'b; c`)).toEqual([['a', 'b; c']])
  })

  it('leaves out the body of a here-document, with a quote in it', () => {
    const command = "cat <<-'END'\nit's here; a\n\tEND\nb <<< word\nc <<X\nstill\nX\nd"
    expect(commandsOf(command)).toEqual([
      ['cat', '<<-END'],
      ['b', '<<<', 'word'],
      ['c', '<<X'],
      ['d'],
    ])
  })

  it('leaves out the body of a here-document with a double-quoted delimiter', () => {
    expect(commandsOf('cat <<"E"\nit\'s\nE\nd')).toEqual([['cat', '<<E'], ['d']])
  })

  it('keeps the lines after a here-document with no end line', () => {
    expect(commandsOf('echo "<<EOF"\ngh issue create\nb')).toEqual([
      ['echo', '<<EOF'],
      ['gh', 'issue', 'create'],
      ['b'],
    ])
    expect(commandsOf('cat <<A\nx; y\nA\necho <<B\nlast')).toEqual([
      ['cat', '<<A'],
      ['echo', '<<B'],
      ['last'],
    ])
  })

  it('gives no command for an empty line', () => {
    expect(commandsOf('')).toEqual([])
    expect(commandsOf(' ; \n ')).toEqual([])
  })
})

describe('untypedCreates', () => {
  it('finds a create with no --type', () => {
    expect(untypedCreates('gh issue create --title t')).toEqual([{ repo: undefined }])
  })

  it('passes --type with a value, in both forms', () => {
    expect(untypedCreates('gh issue create --type Bug --title t')).toEqual([])
    expect(untypedCreates('gh issue create --type=Bug --title t')).toEqual([])
  })

  it('finds a create with an empty or blank --type', () => {
    expect(untypedCreates('gh issue create --type ""')).toEqual([{ repo: undefined }])
    expect(untypedCreates('gh issue create --type=')).toEqual([{ repo: undefined }])
    expect(untypedCreates('gh issue create --type " "')).toEqual([{ repo: undefined }])
    expect(untypedCreates('gh issue create --title t --type')).toEqual([{ repo: undefined }])
  })

  it('reads the repository from -R or --repo, before or after the subcommand', () => {
    expect(untypedCreates('gh -R o/r issue create')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh issue create -R o/r')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh --repo o/r issue create')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh issue create --repo=o/r')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh issue create --repo=')).toEqual([{ repo: undefined }])
  })

  it('reads -R with its value in the same word', () => {
    expect(untypedCreates('gh issue create -Ro/r')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh issue create -Rh/o/r')).toEqual([{ repo: 'h/o/r' }])
    expect(untypedCreates('gh issue create -R=o/r')).toEqual([{ repo: 'o/r' }])
    expect(untypedCreates('gh issue create -R=')).toEqual([{ repo: undefined }])
  })

  it('does not read a value that starts with -R as a repository', () => {
    expect(untypedCreates('gh issue create --title "-Refactor auth"')).toEqual([
      { repo: undefined },
    ])
    expect(untypedCreates('gh issue create -R o/r --label -Rfoo')).toEqual([{ repo: 'o/r' }])
  })

  it('skips a create that asks for help', () => {
    expect(untypedCreates('gh issue create --help')).toEqual([])
    expect(untypedCreates('gh issue create -h')).toEqual([])
    expect(untypedCreates('gh issue create -h && gh issue create')).toEqual([{ repo: undefined }])
  })

  it('takes the last --type', () => {
    expect(untypedCreates('gh issue create --type Bug --type ""')).toEqual([{ repo: undefined }])
    expect(untypedCreates('gh issue create --type "" --type=Bug')).toEqual([])
  })

  it('checks the alias gh issue new', () => {
    expect(untypedCreates('gh issue new --title t')).toEqual([{ repo: undefined }])
    expect(untypedCreates('gh issue new --type Bug')).toEqual([])
  })

  it('allows assignments and other flags before the command', () => {
    expect(untypedCreates('GH_HOST=x A=1 gh --no-color issue create')).toEqual([
      { repo: undefined },
    ])
  })

  it('finds only the part that has no --type in a compound command', () => {
    expect(untypedCreates('gh issue list && gh issue create -R a/b')).toEqual([{ repo: 'a/b' }])
    expect(untypedCreates('gh issue create --type Bug && gh issue create')).toEqual([
      { repo: undefined },
    ])
    expect(
      untypedCreates('gh issue create --type Bug; gh issue create -R a/b --type=Task'),
    ).toEqual([])
    expect(untypedCreates('echo hi | gh issue create\ngh issue create --type Bug')).toEqual([
      { repo: undefined },
    ])
  })

  it('does not split on a separator inside quotes', () => {
    expect(untypedCreates('gh issue create --type Bug --title "a; gh issue create | b"')).toEqual(
      [],
    )
  })

  it('ignores a command that is not gh issue create', () => {
    expect(untypedCreates('gh issue list')).toEqual([])
    expect(untypedCreates('gh pr create')).toEqual([])
    expect(untypedCreates('gh api issue create')).toEqual([])
    expect(untypedCreates('gh -R o/r issue')).toEqual([])
    expect(untypedCreates('echo "gh issue create"')).toEqual([])
    expect(untypedCreates('git issue create')).toEqual([])
    expect(untypedCreates('A=1')).toEqual([])
    expect(untypedCreates('ls')).toEqual([])
  })

  it('passes the command that the gh:issues skill runs', () => {
    expect(untypedCreates(SKILL_COMMAND)).toEqual([])
  })
})

describe('typesArgv', () => {
  it('reads the repository of the directory with the placeholders', () => {
    const argv = typesArgv(undefined)
    expect(argv.slice(0, 7)).toEqual([
      'gh',
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'repo={repo}',
    ])
    expect(argv.at(-1)).toBe('.data.repository.issueTypes.nodes // []')
    expect(argv.some((word) => word.includes('issueTypes(first:20)'))).toBe(true)
  })

  it('sends the owner and name of a repository as strings', () => {
    expect(typesArgv('o/123').slice(3, 7)).toEqual(['-f', 'owner=o', '-f', 'repo=123'])
  })

  it('sends the host of a repository to gh', () => {
    expect(typesArgv('ghe.example.com/o/r').slice(3, 9)).toEqual([
      '--hostname',
      'ghe.example.com',
      '-f',
      'owner=o',
      '-f',
      'repo=r',
    ])
  })

  it('gives an empty owner and name for text that is no repository', () => {
    expect(typesArgv('solo').slice(3, 7)).toEqual(['-f', 'owner=', '-f', 'repo='])
    expect(typesArgv('a/b/c/d').slice(3, 7)).toEqual(['-f', 'owner=', '-f', 'repo='])
  })
})

describe('the query of format.md', () => {
  it('is the query and the filter that typesArgv sends', () => {
    const format = readFileSync(
      new URL('../../../plugins/gh/skills/issues/format.md', import.meta.url),
      'utf8',
    )
    const argv = typesArgv(undefined)
    const query = argv.find((word) => word.startsWith('query='))
    expect(format).toContain(`-f ${query?.replace('=', "='")}'`)
    expect(format).toContain(`--jq '${argv.at(-1)}'`)
  })
})

describe('typesOf', () => {
  it('reads a list of types, an empty list, and anything else', () => {
    expect(typesOf({ exitCode: 0, stdout: '[{"name":"Bug","description":"d"}]\n' })).toBe('types')
    expect(typesOf({ exitCode: 0, stdout: '[]\n' })).toBe('none')
    expect(typesOf({ exitCode: 0, stdout: '{"a":1}' })).toBe('unknown')
    expect(typesOf({ exitCode: 0, stdout: 'not json' })).toBe('unknown')
    expect(typesOf({ exitCode: 0, stdout: '' })).toBe('unknown')
    expect(typesOf({ exitCode: 1, stdout: '[{"name":"Bug"}]' })).toBe('unknown')
  })
})

describe('constants', () => {
  it('keys a read by repository or by directory', () => {
    expect(typesKey('o/r', '/w')).toBe('repo:o/r')
    expect(typesKey(undefined, '/w')).toBe('dir:/w')
    expect(typesKey('/w', '/w')).not.toBe(typesKey(undefined, '/w'))
  })

  it('names the repository, else the directory, in the guard-off line', () => {
    expect(guardOffText('o/r', '/w')).toBe('gh: issue type guard off for o/r: types read failed')
    expect(guardOffText(undefined, '/w')).toBe('gh: issue type guard off for /w: types read failed')
  })

  it('names the skill in the deny reason, and bounds the read at 5 s', () => {
    expect(DENY_REASON).toContain('gh:issues')
    expect(TYPES_TIMEOUT_MS).toBe(5000)
  })
})
