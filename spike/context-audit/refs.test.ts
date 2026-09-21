import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  buildIssueQuery,
  extractBlockRefs,
  extractRefs,
  type PackageJsonCache,
  parseIssueChunkBody,
  parseIssueChunkFailure,
  parseIssueResponse,
  type ResolveContext,
  resolveRefs,
} from './refs.ts'
import type { IssueLookup, Ref } from './types.ts'

const byKind = (refs: Ref[], kind: Ref['kind']) => refs.filter((r) => r.kind === kind)
const values = (refs: Ref[]) => refs.map((r) => r.value)

/** A `ResolveContext` with the fields a test does not care about filled in. */
const context = (overrides: Partial<ResolveContext> & { root: string }): ResolveContext => ({
  file: 'CLAUDE.md',
  issueState: () => 'unavailable',
  ...overrides,
})

const resolveOne = (ref: Ref, ctx: ResolveContext): Ref => {
  const [resolved] = resolveRefs([ref], ctx)
  return resolved as Ref
}

const pathRef = (value: string): Ref => ({
  kind: 'path',
  value,
  resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
})

const fileLineRef = (value: string): Ref => ({
  kind: 'file_line',
  value,
  resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
})

const scriptRef = (value: string): Ref => ({
  kind: 'script',
  value,
  resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
})

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

  it('extraction leaves every ref unchecked, with the not-resolved reason', () => {
    for (const ref of extractRefs('see `lib/git.ts` about #138')) {
      assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'not_resolved_yet' })
    }
  })

  it('does not read a code span containing whitespace as a path', () => {
    // The whitespace guard in `looksLikePath`: no existence check on the
    // whole string could ever succeed, so the script is the only ref here.
    const refs = extractRefs('run `pnpm test lib/git.ts` before pushing')
    assert.deepEqual(values(byKind(refs, 'script')), ['pnpm test'])
    assert.deepEqual(byKind(refs, 'path'), [])
    // And with no script in it, a command line yields nothing at all rather
    // than a "path" of the whole line.
    assert.deepEqual(extractRefs('run `python3 tests/x.py out.xml 95`'), [])
  })

  it('does not read a URL in a code span as a path', () => {
    assert.deepEqual(byKind(extractRefs('see `https://example.com/lib/git.ts`'), 'path'), [])
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

  it('does not extract a numeric hex colour in a mermaid classDef', () => {
    const refs = extractRefs('classDef done fill:#dfd,stroke:#333,color:#000')
    assert.deepEqual(byKind(refs, 'issue'), [])
  })

  it('does not extract a six-digit colour written after a colon', () => {
    assert.deepEqual(byKind(extractRefs('style a fill:#112233'), 'issue'), [])
  })

  it('does not extract another repository’s issue', () => {
    const refs = extractRefs(
      'see [anthropics/claude-code#15344](https://github.com/anthropics/claude-code/issues/15344)',
    )
    assert.deepEqual(byKind(refs, 'issue'), [])
  })

  it('does not extract a number with a leading zero, or zero itself', () => {
    assert.deepEqual(byKind(extractRefs('see #0 and #0138'), 'issue'), [])
  })

  it('still extracts a comma-separated list of three-digit issues', () => {
    // The colour rule requires the `:` or `,` to touch the `#`; prose puts a
    // space there, and these are issue numbers.
    assert.deepEqual(values(byKind(extractRefs('#116, #129, #140; blocked by: #123'), 'issue')), [
      '#116',
      '#129',
      '#140',
      '#123',
    ])
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

  it('does not close a fence on a line that has more after the backticks', () => {
    // CommonMark allows nothing but blanks after a closing fence, so this
    // block runs to the last line and `pnpm run build` is inside it.
    const text = '```bash\ngit status\n``` still inside\npnpm run build\n```'
    const refs = extractRefs(text)
    assert.deepEqual(values(byKind(refs, 'script')), ['pnpm run build'])
    assert.deepEqual(values(byKind(refs, 'command')), ['git', '```', 'pnpm'])
  })
})

describe('extractRefs: order', () => {
  it('emits refs in source order', () => {
    const text = 'first `lib/a.ts`, then #138, then `pnpm test`, then `lib/b.ts`'
    assert.deepEqual(values(extractRefs(text)), ['lib/a.ts', '#138', 'pnpm test', 'lib/b.ts'])
  })

  it('orders a fenced block against the prose around it', () => {
    const text = 'before #1\n\n```bash\ngit status\n```\n\nafter `lib/z.ts`'
    assert.deepEqual(values(extractRefs(text)), ['#1', 'git', 'lib/z.ts'])
  })
})

describe('extractBlockRefs', () => {
  it('extracts nothing from a mermaid block', () => {
    const text = 'flowchart TD\n  A[Start] --> B[lib/git.ts]\n  classDef done color:#000\n'
    assert.deepEqual(extractBlockRefs(text, 'mermaid', 'mermaid'), [])
  })

  it('extracts commands, scripts and paths from a shell block', () => {
    const refs = extractBlockRefs('pnpm exec node lib/x.ts\npnpm test\n', 'bash', 'code')
    assert.deepEqual(values(byKind(refs, 'command')), ['pnpm', 'pnpm'])
    assert.deepEqual(values(byKind(refs, 'path')), ['lib/x.ts'])
    assert.deepEqual(values(byKind(refs, 'script')), ['pnpm test'])
  })

  it('extracts paths but no commands from a non-shell block', () => {
    const refs = extractBlockRefs("import { x } from './lib/x.ts'\n", 'ts', 'code')
    assert.deepEqual(byKind(refs, 'command'), [])
    assert.deepEqual(values(byKind(refs, 'path')), ['./lib/x.ts'])
  })

  it('reads a block whose info string is not a plain word', () => {
    // The old caller re-wrapped the body in a fence, and `c++` as an info
    // string did not match the fence pattern at all.
    const refs = extractBlockRefs('#include "src/thing.h"\n', 'c++', 'code')
    assert.deepEqual(values(byKind(refs, 'path')), ['src/thing.h'])
  })

  it('reads a block whose body contains a fence line', () => {
    const refs = extractBlockRefs('```\nlib/inner.ts\n', null, 'code')
    assert.deepEqual(values(byKind(refs, 'path')), ['lib/inner.ts'])
  })

  it('extracts paths from frontmatter', () => {
    const refs = extractBlockRefs(
      'allowed-tools: Bash\nscript: scripts/run.py\n',
      null,
      'frontmatter',
    )
    assert.deepEqual(values(byKind(refs, 'path')), ['scripts/run.py'])
  })

  it('ignores a slash-bearing token that is no path', () => {
    const refs = extractBlockRefs(
      'git remote add origin git@github.com:owner/repo\n',
      'bash',
      'code',
    )
    assert.deepEqual(byKind(refs, 'path'), [])
  })

  it('extracts a file:line reference written in a block', () => {
    const refs = extractBlockRefs('# see CLAUDE.md:115 for the rule\n', 'ts', 'code')
    assert.deepEqual(values(byKind(refs, 'file_line')), ['CLAUDE.md:115'])
  })

  it('ignores a path wrapped in call syntax', () => {
    // Trimming the edges alone left `import('../src/run.ts`, which is no path
    // anybody wrote, and the audit then reported it absent.
    const refs = extractBlockRefs("const m = await import('../src/run.ts')\n", 'ts', 'code')
    assert.deepEqual(byKind(refs, 'path'), [])
  })

  it('ignores a token carrying an = sign', () => {
    const refs = extractBlockRefs('gh pr list --repo=owner/name.git\n', 'bash', 'code')
    assert.deepEqual(byKind(refs, 'path'), [])
  })

  it('resolves an env-templated block path as a pattern rather than absent', () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the shell's own ${} is the fixture
    const refs = extractBlockRefs('node "${CLAUDE_PLUGIN_ROOT}/bin/gh.ts" sync\n', 'bash', 'code')
    const root = join(tmpdir(), 'context-audit-nonexistent-root', 'deeper')
    const resolved = resolveRefs(refs, context({ root }))
    assert.deepEqual(values(byKind(resolved, 'path')), ['${CLAUDE_PLUGIN_ROOT}/bin/gh.ts'])
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the shell's own ${} is the fixture
    assert.deepEqual(byKind(resolved, 'path')[0]?.resolution, {
      status: 'unchecked',
      reason: 'pattern',
    })
  })

  it('resolves a ../-rooted block path as a pattern rather than absent', () => {
    // Inside a fence, `../` is relative to whatever directory the example runs
    // from, which is not the referencing file's, so there is nowhere to look.
    const refs = extractBlockRefs('node ../scripts/run.ts\n', 'bash', 'code')
    const root = join(tmpdir(), 'context-audit-nonexistent-root', 'deeper')
    const resolved = resolveRefs(refs, context({ root }))
    assert.deepEqual(values(byKind(resolved, 'path')), ['../scripts/run.ts'])
    assert.deepEqual(byKind(resolved, 'path')[0]?.resolution, {
      status: 'unchecked',
      reason: 'pattern',
    })
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
  const freshRepo = () => {
    const root = repo()
    roots.push(root)
    return root
  }

  it('resolves found relative to root', () => {
    const ref = resolveOne(pathRef('lib/git.ts'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'lib/git.ts' })
  })

  it('resolves found relative to the referencing file’s directory', () => {
    const ref = resolveOne(
      pathRef('../../lib/git.ts'),
      context({ root: freshRepo(), file: 'plugins/gh/README.md' }),
    )
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'lib/git.ts' })
  })

  it('prefers the root candidate when a file-relative one also exists', () => {
    const root = freshRepo()
    // Both `lib/git.ts` (root) and `plugins/gh/lib/git.ts` (beside the file)
    // exist and are different files; the root one is the one meant.
    mkdirSync(join(root, 'plugins', 'gh', 'lib'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'gh', 'lib', 'git.ts'), 'a different file\n')
    const ref = resolveOne(pathRef('lib/git.ts'), context({ root, file: 'plugins/gh/README.md' }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'lib/git.ts' })
  })

  it('resolves absent for a path that exists nowhere', () => {
    const ref = resolveOne(pathRef('lib/missing.ts'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('resolves a glob to unchecked, reason pattern', () => {
    const ref = resolveOne(pathRef('plugins/*/src/commands/*.ts'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })

  it('resolves an NNN placeholder to unchecked, reason pattern', () => {
    const ref = resolveOne(pathRef('docs/adr/NNN-title.md'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })

  it('resolves an env-templated path to unchecked, reason pattern', () => {
    // A skill writes `${CLAUDE_PLUGIN_ROOT}/scripts/x.py` because the prefix
    // is only known at run time; it was reported absent.
    const ref = resolveOne(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the skill's own ${} is the fixture
      pathRef('${CLAUDE_PLUGIN_ROOT}/scripts/x.py'),
      context({ root: freshRepo() }),
    )
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })

  it('resolves an ellipsis placeholder to unchecked, reason pattern', () => {
    const ref = resolveOne(pathRef('docs/.../title.md'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })

  it('does not read a leading ../.. as the ellipsis placeholder', () => {
    const ref = resolveOne(
      pathRef('../../lib/git.ts'),
      context({ root: freshRepo(), file: 'plugins/gh/README.md' }),
    )
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'lib/git.ts' })
  })

  it('resolves an absolute path to unchecked, reason machine_specific', () => {
    const ref = resolveOne(pathRef('/etc/hosts'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'machine_specific' })
  })

  it('resolves a ~/ path to unchecked, reason machine_specific', () => {
    const ref = resolveOne(pathRef('~/notes.md'), context({ root: freshRepo() }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'machine_specific' })
  })
})

describe('resolveRefs: path, the tracked tail rule', () => {
  const ctx = (tracked: string[]): ResolveContext =>
    context({ root: join(tmpdir(), 'context-audit-nonexistent-root'), tracked })

  it('resolves tail_match when the value ends a tracked path at a segment boundary', () => {
    const ref = resolveOne(pathRef('fixtures/git.ts'), ctx(['plugins/gh/src/fixtures/git.ts']))
    assert.deepEqual(ref.resolution, {
      status: 'tail_match',
      witness: 'plugins/gh/src/fixtures/git.ts',
    })
  })

  it('resolves a directory reference against whole segments of a tracked path', () => {
    const ref = resolveOne(pathRef('gh/src/'), ctx(['plugins/gh/src/commands/sync.ts']))
    assert.deepEqual(ref.resolution, {
      status: 'tail_match',
      witness: 'plugins/gh/src/commands/sync.ts',
    })
  })

  it('leaves a truly absent path absent even with tracked supplied', () => {
    // `lib` is a PREFIX of `lib/git.ts`, not a tail of it: a file reference
    // that names no tracked file is rot, whatever tracked paths start with.
    const ref = resolveOne(pathRef('lib'), ctx(['lib/git.ts', 'plugins/gh/src/lib/git.ts']))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('does not absolve a file reference that only appears mid-path', () => {
    const ref = resolveOne(pathRef('src'), ctx(['plugins/gh/src/commands/sync.ts']))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('does not match a partial segment', () => {
    // `ixtures/git.ts` ends `src/fixtures/git.ts` as a STRING, but not at a
    // segment boundary, so it names no tracked file.
    const tracked = ['plugins/gh/src/fixtures/git.ts']
    assert.deepEqual(resolveOne(pathRef('ixtures/git.ts'), ctx(tracked)).resolution, {
      status: 'absent',
    })
    assert.deepEqual(resolveOne(pathRef('src/ixtures/'), ctx(tracked)).resolution, {
      status: 'absent',
    })
  })

  it('does not match a partial segment at the start of a directory reference', () => {
    // `h/src/` ends the segment `gh`, so it occurs in `plugins/gh/src/...` as
    // a string. The `/` before the tail is the whole boundary rule; without
    // it any suffix of any segment absolves a path that names no directory.
    const ref = resolveOne(pathRef('h/src/'), ctx(['plugins/gh/src/commands/sync.ts']))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('does not absolve a single-segment directory reference', () => {
    // `skills/` names a directory a dozen trees have; matching it against a
    // tracked path says nothing about the one the prose meant.
    const ref = resolveOne(pathRef('skills/'), ctx(['plugins/gh/skills/sync/SKILL.md']))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })
})

describe('resolveRefs: a ref that already carries a resolution', () => {
  it('keeps it, so extraction can settle what only extraction can see', () => {
    const ref = resolveOne(
      {
        kind: 'path',
        value: '../scripts/run.ts',
        resolution: { status: 'unchecked', reason: 'pattern' },
      },
      context({ root: join(tmpdir(), 'context-audit-nonexistent-root', 'deeper') }),
    )
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })
})

describe('resolveRefs: file_line', () => {
  const roots: string[] = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  /** A file of exactly `lines` lines as `wc -l` counts them: the last line
   *  ends with a newline, as almost every file in a repository does. */
  const repo = (lines: number) => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-fileline-'))
    roots.push(root)
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
    )
    return root
  }

  it('resolves found for the last line of a file ending in a newline', () => {
    const ref = resolveOne(fileLineRef('CLAUDE.md:20'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'CLAUDE.md' })
  })

  it('resolves line_out_of_range one line past the end', () => {
    // The trailing newline ends line 20; it does not start a line 21.
    const ref = resolveOne(fileLineRef('CLAUDE.md:21'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, {
      status: 'line_out_of_range',
      repoPath: 'CLAUDE.md',
      lines: 20,
    })
  })

  it('resolves found well inside the file', () => {
    const ref = resolveOne(fileLineRef('CLAUDE.md:15'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'CLAUDE.md' })
  })

  it('resolves a range by its END line', () => {
    const ref = resolveOne(fileLineRef('CLAUDE.md:15-25'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, {
      status: 'line_out_of_range',
      repoPath: 'CLAUDE.md',
      lines: 20,
    })
  })

  it('resolves a range that fits', () => {
    const ref = resolveOne(fileLineRef('CLAUDE.md:5-15'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: 'CLAUDE.md' })
  })

  it('resolves absent when the file does not exist', () => {
    const ref = resolveOne(fileLineRef('missing.md:1'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('carries the path’s own unchecked reason when it is a glob', () => {
    const ref = resolveOne(fileLineRef('*.md:1'), context({ root: repo(20) }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'pattern' })
  })

  it('resolves unchecked when the path exists but no line count can be taken', () => {
    const root = repo(20)
    mkdirSync(join(root, 'docs'), { recursive: true })
    const ref = resolveOne(fileLineRef('docs:3'), context({ root }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'unavailable' })
  })
})

describe('resolveRefs: script', () => {
  const roots: string[] = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const repo = (packageJson: string | null) => {
    const root = mkdtempSync(join(tmpdir(), 'context-audit-refs-script-'))
    roots.push(root)
    mkdirSync(join(root, 'nested'), { recursive: true })
    if (packageJson !== null) writeFileSync(join(root, 'package.json'), packageJson)
    writeFileSync(join(root, 'nested', 'README.md'), '# nested\n')
    return root
  }

  it('resolves found when the script exists in the nearest package.json', () => {
    const root = repo(JSON.stringify({ scripts: { test: 'vitest run' } }))
    const ref = resolveOne(scriptRef('pnpm test'), context({ root, file: 'nested/README.md' }))
    assert.deepEqual(ref.resolution, { status: 'found', repoPath: null })
  })

  it('resolves absent when the script is missing from package.json', () => {
    const root = repo(JSON.stringify({ scripts: { test: 'vitest run' } }))
    const ref = resolveOne(scriptRef('pnpm build'), context({ root, file: 'nested/README.md' }))
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('resolves unchecked, reason no_resolver, when there is no package.json at all', () => {
    const root = repo(null)
    const ref = resolveOne(scriptRef('pnpm test'), context({ root, file: 'nested/README.md' }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'no_resolver' })
  })

  it('resolves unchecked, reason unavailable, when package.json does not parse', () => {
    // Not "the script is missing": the question could not be asked.
    const root = repo('{ "scripts": { "test": ')
    const ref = resolveOne(scriptRef('pnpm test'), context({ root, file: 'nested/README.md' }))
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'unavailable' })
  })

  it('reads each package.json once when the caller shares a cache', () => {
    const root = repo(JSON.stringify({ scripts: { test: 'vitest run' } }))
    const packageJson: PackageJsonCache = new Map()
    const first = resolveOne(
      scriptRef('pnpm test'),
      context({ root, file: 'nested/README.md', packageJson }),
    )
    assert.deepEqual(first.resolution, { status: 'found', repoPath: null })
    // Both places the walk looked are remembered: the one that has no
    // manifest as well as the one that has.
    assert.deepEqual(
      [...packageJson.keys()].sort(),
      [join(root, 'package.json'), join(root, 'nested', 'package.json')].sort(),
    )

    // Delete the manifest: a second call that re-read the disk would now say
    // no_resolver, and a call with no cache does exactly that.
    rmSync(join(root, 'package.json'))
    const cached = resolveOne(
      scriptRef('pnpm test'),
      context({ root, file: 'nested/README.md', packageJson }),
    )
    assert.deepEqual(cached.resolution, { status: 'found', repoPath: null })
    const uncached = resolveOne(scriptRef('pnpm test'), context({ root, file: 'nested/README.md' }))
    assert.deepEqual(uncached.resolution, { status: 'unchecked', reason: 'no_resolver' })
  })
})

describe('resolveRefs: issue', () => {
  const ctx = (issueState: (n: number) => IssueLookup): ResolveContext =>
    context({ root: '/nonexistent', issueState })

  it('resolves to the state the lookup gives', () => {
    const ref = resolveOne(
      {
        kind: 'issue',
        value: '#138',
        resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
      },
      ctx((n) => (n === 138 ? 'OPEN' : 'not_found')),
    )
    assert.deepEqual(ref.resolution, { status: 'issue', state: 'OPEN' })
  })

  it('resolves absent when the lookup found nothing', () => {
    const ref = resolveOne(
      {
        kind: 'issue',
        value: '#9999',
        resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
      },
      ctx(() => 'not_found'),
    )
    assert.deepEqual(ref.resolution, { status: 'absent' })
  })

  it('resolves unchecked, reason unavailable, when the lookup could not be made', () => {
    const ref = resolveOne(
      {
        kind: 'issue',
        value: '#138',
        resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
      },
      ctx(() => 'unavailable'),
    )
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'unavailable' })
  })
})

describe('resolveRefs: command', () => {
  it('resolves a command to unchecked, reason no_resolver', () => {
    const ref = resolveOne(
      {
        kind: 'command',
        value: 'git',
        resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
      },
      context({ root: '/nonexistent', issueState: () => 'OPEN' }),
    )
    assert.deepEqual(ref.resolution, { status: 'unchecked', reason: 'no_resolver' })
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

/** A GraphQL `errors` entry the way GitHub writes one. Verified by hand:
 *  `gh api graphql` on this repository with a real number and 999999 returns
 *  `{"type":"NOT_FOUND","path":["repository","i1"],"locations":[...],
 *  "message":"Could not resolve to an issue or pull request with the number
 *  of 999999."}`. */
const notFoundError = (alias: string, message = 'Could not resolve to an issue.') => ({
  type: 'NOT_FOUND',
  path: ['repository', alias],
  locations: [{ line: 1, column: 153 }],
  message,
})

describe('parseIssueResponse', () => {
  it('reads each alias back into a number-keyed map', () => {
    const data = { data: { repository: { i0: { state: 'OPEN' }, i1: { state: 'MERGED' } } } }
    assert.deepEqual(
      parseIssueResponse(data, [138, 164]).states,
      new Map([
        [138, 'OPEN'],
        [164, 'MERGED'],
      ]),
    )
  })

  it('reads a response with no top-level "data" wrapper', () => {
    const data = { repository: { i0: { state: 'OPEN' } } }
    assert.deepEqual(parseIssueResponse(data, [138]).states, new Map([[138, 'OPEN']]))
  })

  it('reads a null alias as not_found when a NOT_FOUND error names it', () => {
    const data = { data: { repository: { i0: null } }, errors: [notFoundError('i0')] }
    assert.deepEqual(parseIssueResponse(data, [0]).states, new Map([[0, 'not_found']]))
  })

  it('leaves a FORBIDDEN alias out rather than calling it absent', () => {
    // The defect this rule exists for: a permissions error beside a perfectly
    // good answer used to read as "issue #164 does not exist".
    const data = {
      data: { repository: { i0: { state: 'OPEN' }, i1: null } },
      errors: [
        {
          type: 'FORBIDDEN',
          path: ['repository', 'i1'],
          message: 'Resource not accessible by integration',
        },
      ],
    }
    assert.deepEqual(parseIssueResponse(data, [138, 164]).states, new Map([[138, 'OPEN']]))
  })

  it('leaves every null alias out for a timeout error, which carries no path', () => {
    const data = {
      data: { repository: { i0: null, i1: null } },
      errors: [{ message: 'Something went wrong while executing your query.' }],
    }
    assert.deepEqual(parseIssueResponse(data, [138, 164]).states, new Map())
  })

  it('leaves a null alias out when nothing in errors names it', () => {
    const data = { data: { repository: { i0: null, i1: null } }, errors: [notFoundError('i1')] }
    assert.deepEqual(parseIssueResponse(data, [138, 164]).states, new Map([[164, 'not_found']]))
  })

  it('leaves a missing alias out, and does not throw', () => {
    assert.deepEqual(parseIssueResponse({ data: { repository: {} } }, [138]).states, new Map())
  })

  it('leaves an unrecognised state out: the node exists, so it is not absent', () => {
    const data = { data: { repository: { i0: { state: 'DRAFT' } } } }
    assert.deepEqual(parseIssueResponse(data, [138]).states, new Map())
  })

  it('leaves every number out for a malformed response', () => {
    assert.deepEqual(parseIssueResponse(null, [138]).states, new Map())
    assert.deepEqual(parseIssueResponse('not an object', [138]).states, new Map())
  })

  it('returns the unexplained error messages beside the states', () => {
    const data = {
      data: { repository: { i0: { state: 'OPEN' } } },
      errors: [{ message: 'first' }, { message: 'second' }],
    }
    assert.equal(parseIssueResponse(data, [138]).errors, 'first; second')
    assert.equal(parseIssueResponse({ data: { repository: {} } }, [138]).errors, null)
  })

  it('reports no error for a NOT_FOUND, which the not_found state already says', () => {
    // Otherwise every run naming one dead issue number would report the whole
    // issue lookup as unavailable, on a lookup that worked perfectly.
    const data = { data: { repository: { i0: null } }, errors: [notFoundError('i0')] }
    const parsed = parseIssueResponse(data, [0])
    assert.deepEqual(parsed.states, new Map([[0, 'not_found']]))
    assert.equal(parsed.errors, null)
  })
})

describe('parseIssueChunkBody', () => {
  it('reads an exit-0 body carrying errors by the same rule', () => {
    const body = {
      data: { repository: { i0: { state: 'CLOSED' }, i1: null } },
      errors: [{ type: 'RATE_LIMITED', path: ['repository', 'i1'], message: 'API rate limit' }],
    }
    const outcome = parseIssueChunkBody(body, [127, 164])
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.ok ? outcome.states : null, new Map([[127, 'CLOSED']]))
    assert.equal(outcome.ok ? outcome.errors : null, 'API rate limit')
  })

  it('fails an exit-0 body whose repository is null', () => {
    const body = { data: { repository: null }, errors: [{ message: 'Bad credentials' }] }
    assert.deepEqual(parseIssueChunkBody(body, [1]), { ok: false, reason: 'Bad credentials' })
  })

  it('fails a body with no repository and no errors, with a reason of its own', () => {
    assert.deepEqual(parseIssueChunkBody({ data: {} }, [1]), {
      ok: false,
      reason: 'gh api graphql returned no repository',
    })
  })
})

describe('parseIssueChunkFailure', () => {
  /** What `gh api graphql` prints, and exits 1 with, when one alias in the
   *  query names a number the repository has nothing for. Verified by hand
   *  against this repository with #127 and #999999. */
  const partialFailure = {
    status: 1,
    stdout: JSON.stringify({
      data: { repository: { i0: { state: 'CLOSED' }, i1: null } },
      errors: [
        notFoundError('i1', 'Could not resolve to an issue or pull request with the number of 0.'),
      ],
    }),
    stderr: 'gh: Could not resolve to an issue or pull request with the number of 0.\n',
    message: 'Command failed',
  }

  it('keeps every state a failed call still answered with', () => {
    const outcome = parseIssueChunkFailure(partialFailure, [127, 0])
    assert.equal(outcome.ok, true)
    assert.deepEqual(
      outcome.ok ? outcome.states : null,
      new Map([
        [127, 'CLOSED'],
        [0, 'not_found'],
      ]),
    )
  })

  it('leaves a forbidden alias out of a partial answer', () => {
    const outcome = parseIssueChunkFailure(
      {
        status: 1,
        stdout: JSON.stringify({
          data: { repository: { i0: { state: 'CLOSED' }, i1: null } },
          errors: [{ type: 'FORBIDDEN', path: ['repository', 'i1'], message: 'no access' }],
        }),
      },
      [127, 164],
    )
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.ok ? outcome.states : null, new Map([[127, 'CLOSED']]))
    assert.equal(outcome.ok ? outcome.errors : null, 'no access')
  })

  it('reports the GraphQL message when there is no usable body', () => {
    const outcome = parseIssueChunkFailure(
      {
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ message: 'Could not resolve to a Repository with the name x/y.' }],
        }),
      },
      [1],
    )
    assert.deepEqual(outcome, {
      ok: false,
      reason: 'Could not resolve to a Repository with the name x/y.',
    })
  })

  it('reports stderr when nothing was printed on stdout', () => {
    const outcome = parseIssueChunkFailure(
      { stdout: '', stderr: 'gh: not authenticated\n', message: 'Command failed' },
      [1],
    )
    assert.deepEqual(outcome, { ok: false, reason: 'gh: not authenticated' })
  })

  it('reports the error message when there is no stderr either', () => {
    const outcome = parseIssueChunkFailure(new Error('spawn gh ENOENT'), [1])
    assert.deepEqual(outcome, { ok: false, reason: 'spawn gh ENOENT' })
  })

  it('reports a fallback when the error says nothing at all', () => {
    assert.deepEqual(parseIssueChunkFailure({}, [1]), {
      ok: false,
      reason: 'gh api graphql failed',
    })
  })

  it('reads a Buffer stdout as well as a string one', () => {
    const outcome = parseIssueChunkFailure(
      { stdout: Buffer.from(partialFailure.stdout, 'utf8') },
      [127, 0],
    )
    assert.equal(outcome.ok, true)
  })
})
