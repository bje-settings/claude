import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { buildIssueQuery, extractRefs, parseIssueResponse, resolveRefs } from './refs.ts'
import type { Ref } from './types.ts'

const byKind = (refs: Ref[], kind: Ref['kind']) => refs.filter((r) => r.kind === kind)
const values = (refs: Ref[]) => refs.map((r) => r.value)

describe('extractRefs: path', () => {
  it('extracts a backticked path containing a slash', () => {
    assert.deepEqual(values(byKind(extractRefs('see `lib/git.ts` for the helper'), 'path')), [
      'lib/git.ts',
    ])
  })

  it('extracts a well-known bare filename', () => {
    assert.deepEqual(values(byKind(extractRefs('edit `package.json` and `CLAUDE.md`'), 'path')), [
      'package.json',
      'CLAUDE.md',
    ])
  })

  it('does not extract a generic-extension bare filename that is not well known', () => {
    // `.md` alone is not specific enough to tell a real reference from an
    // example; only the well-known bare filenames qualify.
    assert.deepEqual(byKind(extractRefs('see `notes.md` for details'), 'path'), [])
  })

  it('keeps a glob as a path', () => {
    assert.deepEqual(values(byKind(extractRefs('run `plugins/*/src/commands/*.ts`'), 'path')), [
      'plugins/*/src/commands/*.ts',
    ])
  })

  it('keeps a placeholder segment as a path', () => {
    assert.deepEqual(
      values(
        byKind(extractRefs('a command is `plugins/<plugin>/src/commands/<command>.ts`'), 'path'),
      ),
      ['plugins/<plugin>/src/commands/<command>.ts'],
    )
  })

  it('extraction leaves resolved and detail null', () => {
    for (const ref of extractRefs('see `lib/git.ts`')) {
      assert.equal(ref.resolved, null)
      assert.equal(ref.detail, null)
    }
  })
})

describe('extractRefs: file_line', () => {
  it('extracts a single line reference', () => {
    assert.deepEqual(values(byKind(extractRefs('at `CLAUDE.md:115`'), 'file_line')), [
      'CLAUDE.md:115',
    ])
  })

  it('extracts a line range reference', () => {
    assert.deepEqual(values(byKind(extractRefs('at `lib/git.ts:12-34`'), 'file_line')), [
      'lib/git.ts:12-34',
    ])
  })

  it('does not classify a file_line token as a plain path too', () => {
    const refs = extractRefs('at `CLAUDE.md:115`')
    assert.equal(byKind(refs, 'path').length, 0)
  })
})

describe('extractRefs: issue', () => {
  it('extracts an issue reference in prose', () => {
    assert.deepEqual(values(byKind(extractRefs('fixed by #138'), 'issue')), ['#138'])
  })

  it('extracts an issue reference inside a code span', () => {
    assert.deepEqual(values(byKind(extractRefs('see `#138` for context'), 'issue')), ['#138'])
  })

  it('does not extract a "#" that is part of a URL', () => {
    const refs = extractRefs('see https://example.com/page#123 for more')
    assert.deepEqual(byKind(refs, 'issue'), [])
  })

  it('does not extract a hex colour that contains a letter', () => {
    const refs = extractRefs('the accent colour is `#a1b2c3` and `#fff`')
    assert.deepEqual(byKind(refs, 'issue'), [])
  })

  it('does not extract the "#" of an ATX heading', () => {
    const refs = extractRefs('## 123 things to fix\n\nsome text')
    assert.deepEqual(byKind(refs, 'issue'), [])
  })

  it('extracts every issue number found, including duplicates', () => {
    const refs = extractRefs('see #1 and #2, also #1 again')
    assert.deepEqual(values(byKind(refs, 'issue')), ['#1', '#2', '#1'])
  })
})

describe('extractRefs: script', () => {
  it('extracts a bare pnpm script invocation', () => {
    assert.deepEqual(values(byKind(extractRefs('run `pnpm test`'), 'script')), ['pnpm test'])
  })

  it('skips a pnpm built-in subcommand', () => {
    assert.deepEqual(byKind(extractRefs('run `pnpm install`'), 'script'), [])
  })

  it('extracts an explicit pnpm run invocation from a fenced block', () => {
    const text = '```bash\npnpm run build\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'script')), ['pnpm run build'])
  })

  it('extracts npm only in its explicit run form', () => {
    assert.deepEqual(values(byKind(extractRefs('run `npm run lint`'), 'script')), ['npm run lint'])
    assert.deepEqual(byKind(extractRefs('run `npm test`'), 'script'), [])
  })

  it('extracts a bare yarn script invocation and skips a yarn built-in', () => {
    assert.deepEqual(values(byKind(extractRefs('run `yarn dev`'), 'script')), ['yarn dev'])
    assert.deepEqual(byKind(extractRefs('run `yarn install`'), 'script'), [])
  })

  it('extracts a script mentioned in a non-shell fenced block', () => {
    const text = '```text\npnpm run coverage\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'script')), ['pnpm run coverage'])
  })
})

describe('extractRefs: command', () => {
  it('extracts the first word of each line in a bash block', () => {
    const text = '```bash\ngit status\npnpm install\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'command')), ['git', 'pnpm'])
  })

  it('strips a "$ " prompt', () => {
    const text = '```sh\n$ git status\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'command')), ['git'])
  })

  it('strips leading environment assignments', () => {
    const text = '```shell\nFOO=bar BAZ=qux some-tool run\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'command')), ['some-tool'])
  })

  it('strips a leading sudo', () => {
    const text = '```zsh\nsudo systemctl restart thing\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'command')), ['systemctl'])
  })

  it('does not extract commands from a non-shell fenced block', () => {
    const text = '```ts\nconst x = 1\n```'
    assert.deepEqual(byKind(extractRefs(text), 'command'), [])
  })

  it('skips blank and comment lines', () => {
    const text = '```bash\n\n# a comment\ngit status\n```'
    assert.deepEqual(values(byKind(extractRefs(text), 'command')), ['git'])
  })
})

describe('resolveRefs: path', () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-'))
    mkdirSync(join(root, 'lib'), { recursive: true })
    mkdirSync(join(root, 'plugins', 'gh'), { recursive: true })
    writeFileSync(join(root, 'lib', 'git.ts'), Array.from({ length: 10 }, () => 'line').join('\n'))
    writeFileSync(join(root, 'plugins', 'gh', 'README.md'), '# gh\n')
    return root
  }
  const roots: string[] = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it('resolves true relative to root', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: 'lib/git.ts', resolved: null, detail: null }],
      {
        root,
        file: 'CLAUDE.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, true)
    assert.equal(ref?.detail, 'lib/git.ts')
  })

  it('resolves true relative to the referencing file’s directory', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: '../../lib/git.ts', resolved: null, detail: null }],
      {
        root,
        file: 'plugins/gh/README.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, true)
    assert.equal(ref?.detail, 'lib/git.ts')
  })

  it('resolves false for a path that exists nowhere', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: 'lib/missing.ts', resolved: null, detail: null }],
      {
        root,
        file: 'CLAUDE.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, false)
    assert.equal(ref?.detail, null)
  })

  it('resolves a glob to null', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: 'plugins/*/src/commands/*.ts', resolved: null, detail: null }],
      { root, file: 'CLAUDE.md', issueState: () => undefined },
    )
    assert.equal(ref?.resolved, null)
  })

  it('resolves an absolute path to null', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: '/etc/hosts', resolved: null, detail: null }],
      {
        root,
        file: 'CLAUDE.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, null)
  })

  it('resolves a ~/ path to null', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'path', value: '~/notes.md', resolved: null, detail: null }],
      {
        root,
        file: 'CLAUDE.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, null)
  })
})

describe('resolveRefs: file_line', () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-fileline-'))
    writeFileSync(
      join(root, 'CLAUDE.md'),
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
    )
    return root
  }
  const roots: string[] = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it('resolves true when the file has at least that many lines', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'file_line', value: 'CLAUDE.md:15', resolved: null, detail: null }],
      {
        root,
        file: 'README.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, true)
  })

  it('resolves true for a range within the file', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'file_line', value: 'CLAUDE.md:5-15', resolved: null, detail: null }],
      { root, file: 'README.md', issueState: () => undefined },
    )
    assert.equal(ref?.resolved, true)
  })

  it('resolves false when the file has fewer lines than claimed', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'file_line', value: 'CLAUDE.md:9999', resolved: null, detail: null }],
      { root, file: 'README.md', issueState: () => undefined },
    )
    assert.equal(ref?.resolved, false)
  })

  it('resolves false when the file does not exist', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'file_line', value: 'missing.md:1', resolved: null, detail: null }],
      { root, file: 'README.md', issueState: () => undefined },
    )
    assert.equal(ref?.resolved, false)
  })

  it('resolves null when the path portion is unchecked (a glob)', () => {
    const root = repo()
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'file_line', value: '*.md:1', resolved: null, detail: null }],
      { root, file: 'README.md', issueState: () => undefined },
    )
    assert.equal(ref?.resolved, null)
  })
})

describe('resolveRefs: script', () => {
  const repoWithPackageJson = (scripts: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-script-'))
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }))
    writeFileSync(join(root, 'nested', 'README.md'), '# nested\n')
    return root
  }
  const roots: string[] = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it('resolves true when the script exists in the nearest package.json', () => {
    const root = repoWithPackageJson({ test: 'vitest run' })
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'script', value: 'pnpm test', resolved: null, detail: null }],
      {
        root,
        file: 'nested/README.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, true)
  })

  it('resolves false when the script is absent from package.json', () => {
    const root = repoWithPackageJson({ test: 'vitest run' })
    roots.push(root)
    const [ref] = resolveRefs(
      [{ kind: 'script', value: 'pnpm build', resolved: null, detail: null }],
      {
        root,
        file: 'nested/README.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, false)
  })

  it('resolves null when there is no package.json at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-noscript-'))
    roots.push(root)
    writeFileSync(join(root, 'README.md'), '# root\n')
    const [ref] = resolveRefs(
      [{ kind: 'script', value: 'pnpm test', resolved: null, detail: null }],
      {
        root,
        file: 'README.md',
        issueState: () => undefined,
      },
    )
    assert.equal(ref?.resolved, null)
  })
})

describe('resolveRefs: issue', () => {
  const ctx = (issueState: (n: number) => string | null | undefined) => ({
    root: '/nonexistent',
    file: 'CLAUDE.md',
    issueState,
  })

  it('resolves true with the state as detail when found', () => {
    const [ref] = resolveRefs(
      [{ kind: 'issue', value: '#138', resolved: null, detail: null }],
      ctx((n) => (n === 138 ? 'OPEN' : undefined)),
    )
    assert.equal(ref?.resolved, true)
    assert.equal(ref?.detail, 'OPEN')
  })

  it('resolves false when looked up and absent', () => {
    const [ref] = resolveRefs(
      [{ kind: 'issue', value: '#9999', resolved: null, detail: null }],
      ctx(() => null),
    )
    assert.equal(ref?.resolved, false)
    assert.equal(ref?.detail, null)
  })

  it('resolves null when the lookup is unavailable', () => {
    const [ref] = resolveRefs(
      [{ kind: 'issue', value: '#138', resolved: null, detail: null }],
      ctx(() => undefined),
    )
    assert.equal(ref?.resolved, null)
    assert.equal(ref?.detail, null)
  })
})

describe('resolveRefs: command', () => {
  it('never resolves a command ref', () => {
    const [ref] = resolveRefs([{ kind: 'command', value: 'git', resolved: null, detail: null }], {
      root: '/nonexistent',
      file: 'CLAUDE.md',
      issueState: () => 'OPEN',
    })
    assert.equal(ref?.resolved, null)
    assert.equal(ref?.detail, null)
  })
})

describe('buildIssueQuery', () => {
  it('builds one aliased field per number', () => {
    const query = buildIssueQuery('bje-settings', 'claude', [138, 164])
    assert.match(query, /repository\(owner: "bje-settings", name: "claude"\)/)
    assert.match(query, /i0: issueOrPullRequest\(number: 138\)/)
    assert.match(query, /i1: issueOrPullRequest\(number: 164\)/)
    assert.match(query, /\.\.\. on Issue \{ state \}/)
    assert.match(query, /\.\.\. on PullRequest \{ state \}/)
  })
})

describe('parseIssueResponse', () => {
  it('reads each alias back into a number-keyed map', () => {
    const data = {
      data: {
        repository: {
          i0: { state: 'OPEN' },
          i1: { state: 'CLOSED' },
        },
      },
    }
    assert.deepEqual(
      parseIssueResponse(data, [138, 164]),
      new Map([
        [138, 'OPEN'],
        [164, 'CLOSED'],
      ]),
    )
  })

  it('reads a response with no top-level "data" wrapper', () => {
    const data = { repository: { i0: { state: 'OPEN' } } }
    assert.deepEqual(parseIssueResponse(data, [138]), new Map([[138, 'OPEN']]))
  })

  it('reads a missing alias as null, not a throw', () => {
    const data = { data: { repository: {} } }
    assert.deepEqual(parseIssueResponse(data, [138]), new Map([[138, null]]))
  })

  it('reads a malformed response as every number absent', () => {
    assert.deepEqual(parseIssueResponse(null, [138]), new Map([[138, null]]))
    assert.deepEqual(parseIssueResponse('not an object', [138]), new Map([[138, null]]))
  })
})
