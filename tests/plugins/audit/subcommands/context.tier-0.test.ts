// context, part of its tests: the other tier 0 checks.
// The file is one of several so that vitest can run them at the same time (#205).
// `context.test-support.ts` holds the helpers and the header that says what the tests prove.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { Report } from '#audit/report.ts'
import { type ContextEdges, runContext } from '#audit/subcommands/context.ts'
import { createGhMock, type GhClient } from '#harness/gh.ts'
import { audited, blocksIn, reportOf, unitNaming } from './context.test-support.ts'

it('does not read a scoped package name as a path', async () => {
  // `@scope/name` has a slash and is not a path. If the run reports it as
  // absent, that gives a reader a finding to dismiss in every repository with
  // a dependency.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[0]?.refs).toEqual([])
})

it('does not read an owner/name@ref pin as a path', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[1]?.refs).toEqual([])
})

it('treats an env-templated path as a placeholder rather than a missing file', async () => {
  // `${VAR}` is the spelling a skill writes. No existence check can ever
  // succeed on it. It is a shape, which is a different fact from an absence.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[2]?.refs).toEqual([
    {
      kind: 'path',
      value: `\${CLAUDE_PLUGIN_ROOT}/scripts/audit.ts`,
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('resolves a number-only record reference against the one file that starts with it', async () => {
  // Prose names a record by its number, `docs/adr/022`, while the file carries
  // a slug after it. One tracked path that starts with the value and a
  // separator is that file. If the run reports it as absent, that finding is
  // about a naming convention, not about rot.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[3]?.refs).toEqual([
    {
      kind: 'path',
      value: 'docs/adr/022',
      resolution: { status: 'found', repoPath: 'docs/adr/022-slug.md' },
    },
  ])
})

it('does not resolve a number-only reference that two files could answer to', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[4]?.refs).toEqual([
    { kind: 'path', value: 'docs/adr/099', resolution: { status: 'absent' } },
  ])
})

it('answers ignored, not absent, for a path this repository’s own rules exclude', async () => {
  // A build output is not in the tree because it is not meant to be there. If
  // the run reports it as absent, that makes every repository with a
  // `.gitignore` noisy in exactly the places its own rules already explain.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[5]?.refs).toEqual([
    { kind: 'path', value: 'build/output.js', resolution: { status: 'ignored' } },
  ])
})

it('answers ignored for a line reference into an ignored file too', async () => {
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[6]?.refs).toEqual([
    { kind: 'file_line', value: 'build/output.js:12', resolution: { status: 'ignored' } },
  ])
})

it('skips a uses: value in a yaml block, which names another repository’s file', async () => {
  // GitHub Actions resolves a `uses:` value against the repository and ref it
  // names, not against this checkout. So an existence check here answers a
  // question nobody asked. The `run:` line beside it still yields its script.
  // That is what proves the block was read at all.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).opaque[0]?.refs).toEqual([
    {
      kind: 'script',
      value: 'pnpm test',
      resolution: { status: 'unchecked', reason: 'no_resolver' },
    },
  ])
})

it('takes no issue reference from a URL, a cross-repo slug, a colour or a padded number', async () => {
  // The gh double has no reply registered at all, so an endpoint reached here
  // throws. This fixture proves two things: the four shapes all yield
  // nothing, and a repository that names no issue never reaches gh.
  //
  // The colours are two. `#000` is refused by the leading zero alone. `#123`
  // is refused only by the `:` that touches it, which is the rule this test
  // exercises on its own. The URL carries no path, so the cross-repo rule
  // cannot reach it either, and the URL rule alone drops it.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const naming = (text: string) => report.units.filter((unit) => unit.text.includes(text))[0]?.refs
  expect(naming('The thread is at')).toEqual([])
  expect(naming("Another repository's")).toEqual([])
  expect(naming('classDef')).toEqual([])
  expect(naming('zero-padded')).toEqual([])
  expect(report.issueLookup).toBe('ok')
})

it('keeps a closed issue out of the findings text, and an unfindable one in', async () => {
  // A closed issue is not a finding on its own. A history line cites one
  // correctly, and on this repository nearly every such citation is history.
  // The state is in the JSON report for layer 5, whose model judgment decides
  // which of them is rot. An issue nobody can find is an absence like any
  // other. That one is a finding.
  const audit = audited('issues', {
    issueStates: {
      states: { '170': 'OPEN', '164': 'CLOSED', '4242': 'not_found' },
      unavailable: null,
    },
  })

  await runContext([audit.work], audit.edges)

  const text = audit.stdout()
  expect(text).not.toContain('issues cited')
  expect(text).not.toContain('#164')
  expect(text).toContain('  CLAUDE.md:7  issue `#4242`  absent')
})

it('tallies what tier 0 did not settle, by kind and reason', async () => {
  // Without this, "unchecked" reads as "fine". A reader has no way to tell a
  // repository whose refs all resolved apart from one whose refs were mostly
  // never checked.
  const audit = audited('tails')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## tier 0: refs not checked',
      '  1  path pattern',
      '  2  path tail_match',
      '  1  script no_resolver',
    ].join('\n'),
  )
})

it('names every line reference past the end of its file, with the count it has', async () => {
  const audit = audited('lines')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain(
    [
      '## tier 0: line references past the end of the file (3)',
      '  CLAUDE.md:3  file_line `docs/short.md:99`  only 3 lines',
      '  CLAUDE.md:9  file_line `docs/short.md:1-99`  only 3 lines',
      '  CLAUDE.md:11  file_line `docs/empty.txt:1`  only 0 lines',
    ].join('\n'),
  )
})

it('leads with the splitter’s warnings, so the counts beside them are not trusted', async () => {
  // A fence that never closes swallows the rest of the file. So the unit
  // count under it is not the file's own count. The warning must sit where a
  // reader sees it before the findings.
  const audit = audited('warn')

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toMatch(
    /^1 files, 1 units, 1 opaque\n {2}warning: CLAUDE\.md:5 unclosed_fence\n/,
  )
})

it('reads a file:line inside a code block, and leaves a ../ example unchecked', async () => {
  // An example writes a `../` path relative to whatever directory the example
  // runs from. That directory is not the referencing file's own directory, so
  // there is nowhere to look for the path. It is a shape, not an absence. A
  // comment line carries no command, but its file:line is still a reference.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[2]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'scripts/build.ts:1',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
    { kind: 'command', value: 'node', resolution: { status: 'unchecked', reason: 'no_resolver' } },
    {
      kind: 'path',
      value: '../other/tool.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('refuses an unknown flag, with nothing on stdout', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--nope'], audit.edges)

  // This is node's own wording, passed through rather than rewritten. It
  // names the token the caller typed, which is what a caller needs
  // (`lib/args.ts`).
  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(/^Unknown option '--nope'/)
  expect(audit.stdout()).toBe('')
})

it('audits the directory it was called in when no root is given', async () => {
  const audit = audited('absent')
  const edges = { ...audit.edges, cwd: audit.work }

  await runContext(['--json'], edges)

  expect(reportOf(audit.stdout()).files).toEqual(['CLAUDE.md'])
})

it('reads the paths in a fence with no info string, but takes no commands from it', async () => {
  // A fence with no language is not known to be a shell. So its first words
  // are not commands. But the paths written in it are still paths.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[3]?.refs).toEqual([
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
  ])
})

it('reads the refs in a file’s frontmatter, issue numbers included', async () => {
  // Frontmatter never goes to the model either. A skill's frontmatter is
  // exactly where a path to a renamed script sits unnoticed. An issue number
  // is read there, and in a fence too. Only a mermaid diagram is exempt.
  // Without this test, the diagram's own early return would be the only thing
  // that proves it.
  const audit = audited('opaque', {
    issueStates: { states: { '164': 'CLOSED' }, unavailable: null },
  })

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const front = blocksIn(report, '.claude/notes.md')[0]
  expect(front?.file).toBe('.claude/notes.md')
  expect(front?.refs).toEqual([
    {
      kind: 'path',
      value: 'scripts/build.ts',
      resolution: { status: 'found', repoPath: 'scripts/build.ts' },
    },
    { kind: 'issue', value: '#164', resolution: { status: 'issue', state: 'CLOSED' } },
  ])
})

it('counts a last line with no final newline, and an empty file as no lines', async () => {
  // A trailing newline ends the last line; it does not start an empty one. So
  // a one-line file with no trailing newline still has a line 1. An empty
  // file has no line at all to point at. This is not `wc -l`, which counts
  // newlines and would answer 0 for that one-line file.
  const audit = audited('lines')

  await runContext([audit.work, '--json'], audit.edges)

  expect(reportOf(audit.stdout()).units[4]?.refs).toEqual([
    {
      kind: 'file_line',
      value: 'docs/empty.txt:1',
      resolution: { status: 'line_out_of_range', repoPath: 'docs/empty.txt', lines: 0 },
    },
    {
      kind: 'file_line',
      value: 'docs/oneline.txt:1',
      resolution: { status: 'found', repoPath: 'docs/oneline.txt' },
    },
  ])
})

it('takes no path out of code that merely quotes one', async () => {
  // `run('scripts/build.ts')` trims to `run('scripts/build.ts`. Nobody wrote
  // that as a path: the token is code around a path, not a path itself. A
  // brace on its own trims to nothing at all.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[4]?.refs).toEqual([])
})

it('reads a backticked URL as no path and a bare well-known filename as one', async () => {
  // A URL has slashes and is no path in the tree. `CLAUDE.md` has an extension
  // too generic to qualify by suffix, so it is a path by name instead.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(report.units.at(-1)?.refs).toEqual([
    { kind: 'path', value: 'CLAUDE.md', resolution: { status: 'found', repoPath: 'CLAUDE.md' } },
  ])
})

it('strips a shell prompt before reading the command on the line', async () => {
  // A transcript writes `$ pnpm test`. If the run reports `$` as the command,
  // that finding is about the prompt, not about this repository.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  expect(blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]?.refs[0]).toEqual({
    kind: 'command',
    value: 'pnpm',
    resolution: { status: 'unchecked', reason: 'no_resolver' },
  })
})

it('asks git about a path outside the tree without losing the answer for the rest', async () => {
  // `git check-ignore` does not skip a path it cannot place. One value outside
  // the repository aborts the whole batch with exit 128. The run shares that
  // batch across every absent ref. If the run sent one bad value, every
  // correctly ignored path in the repository would become a headline finding.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(unitNaming(report, 'bundle is written')).toEqual([
    { kind: 'path', value: 'build/out.js', resolution: { status: 'ignored' } },
  ])
  // The value that cannot be asked about is still answered, from the tree.
  expect(unitNaming(report, 'sibling checkout')).toEqual([
    { kind: 'path', value: '../other/tool.ts', resolution: { status: 'absent' } },
  ])
  // The first segment is what leaves the tree, not the first two characters. A
  // directory whose name merely starts with them is still git's to answer
  // about. A prefix test would drop it and wrongly report it as absent.
  expect(unitNaming(report, 'scratch copy')).toEqual([
    { kind: 'path', value: '..cache/out.js', resolution: { status: 'ignored' } },
  ])
})

it('answers ignored for a path written inside a fenced block too', async () => {
  // Build output is named in a command line more often than in prose. A
  // block's refs go through the same ignore pass, or they do not go through
  // it at all.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  const fence = report.opaque.find((block) => block.text.includes('scripts/build.ts'))
  expect(fence?.refs.find((ref) => ref.value === 'build/nested.js')?.resolution).toEqual({
    status: 'ignored',
  })
})

it('never asks git whether a missing script is ignored', async () => {
  // A script is a name in a manifest, not a path git has an opinion about.
  // This fixture ignores `pnpm*`. So a script value that reached the batch
  // would come back ignored, and a real missing script would no longer count
  // as a finding.
  const audit = audited('ignored')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'this manifest does not declare')).toEqual([
    { kind: 'script', value: 'pnpm missing', resolution: { status: 'absent' } },
  ])
})

it('says the ignore check was unavailable rather than reporting absent as settled', async () => {
  // The shim fails `check-ignore` alone, so everything else still resolves. If
  // the run reads an unanswerable question as "nothing here is ignored", it
  // publishes every ignored path as a finding, with no sign anything went
  // wrong. An exclude file git cannot read makes `check-ignore` exit 128 for
  // the whole batch. This is a real repository state, not a stubbed one.
  const audit = audited('ignored')
  const notAFile = audit.sandbox.join('excludes-dir')
  mkdirSync(notAFile)
  audit.git.git(audit.work, 'config', 'core.excludesFile', notAFile)

  await runContext([audit.work], audit.edges)

  expect(audit.stdout()).toContain('  ignore check unavailable: git check-ignore exited 128')
  expect(audit.stdout()).toContain('  CLAUDE.md:3  path `build/out.js`  absent')
})

it('reports a lookup that threw something other than a GhError as unavailable', async () => {
  // `GhError` is the only failure the client declares, but the catch exists
  // because something else might throw. If the code reads `.detail` off
  // whatever was thrown, it gets `undefined`. That `undefined` folds to the
  // report's success value. So a mis-wired client would publish "the lookup
  // succeeded" while every issue ref silently said unavailable.
  const audit = audited('issues')
  const edges: ContextEdges = {
    ...audit.edges,
    createGh: () => {
      throw new TypeError('gh client is not wired')
    },
  }

  await runContext([audit.work, '--json'], edges)

  const report = reportOf(audit.stdout())
  expect(report.issueLookup).toContain('gh client is not wired')
  expect(report.issueLookup).not.toBe('ok')
})

it('refuses, naming the file, when a tracked markdown file is not on disk', async () => {
  // `git ls-files` lists the index, but the read comes from the working tree.
  // The two differ in ordinary use: a staged deletion, a `git mv` in flight, a
  // sparse checkout. If the read were to throw, the run would end with node's
  // own `fs` stack trace and no envelope. The caller would then get neither
  // findings nor a sentence it can act on.
  const audit = audited('paths')
  rmSync(path.join(audit.work, 'CLAUDE.md'))

  const envelope = await runContext([audit.work], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    /^could not read CLAUDE\.md, which git lists as tracked: ENOENT/,
  )
  expect(audit.stdout()).toBe('')
})

it('takes no command from a bare prompt, an assignment or a sudo', async () => {
  // A transcript writes a lone `$` between commands. An example writes
  // `CI=1 ...` or `sudo ...` in front of the command it means. If the run
  // reports `$`, `CI=1` or `sudo` as the command, that finding is about the
  // shell line, not about this repository.
  const audit = audited('opaque')

  await runContext([audit.work, '--json'], audit.edges)

  const commands = blocksIn(reportOf(audit.stdout()), 'CLAUDE.md')[0]
    ?.refs.filter((ref) => ref.kind === 'command')
    .map((ref) => ref.value)
  expect(commands).toEqual(['pnpm', 'node', 'node'])
})

it('reads each placeholder character as a template on its own', async () => {
  // `{` and `$` are separate rules, because either spelling alone makes the
  // value a template. A fixture that carries both at once satisfies either
  // rule. So neither rule is held to anything.
  const audit = audited('noise')

  await runContext([audit.work, '--json'], audit.edges)

  const report = reportOf(audit.stdout())
  expect(unitNaming(report, 'no braces at all')).toEqual([
    {
      kind: 'path',
      value: '$CLAUDE_PLUGIN_ROOT/scripts/audit.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
  expect(unitNaming(report, 'named by a brace')).toEqual([
    {
      kind: 'path',
      value: 'dist/{name}/index.ts',
      resolution: { status: 'unchecked', reason: 'pattern' },
    },
  ])
})

it('does not absolve a value that ends a tracked path mid-segment', async () => {
  // The tail rule compares against `/` plus the value. So `est/thing.ts` is
  // not answered by `deep/nest/thing.ts`. Without the boundary, a witness
  // could be found for almost any suffix, and `tail_match` would absolve
  // everything.
  const audit = audited('tails')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'partial segment')).toEqual([
    { kind: 'path', value: 'est/thing.ts', resolution: { status: 'absent' } },
  ])
})

it('reads a bare npm subcommand as no script at all', async () => {
  // npm is the one manager whose bare subcommands are not also script
  // shorthands. So only `npm run <name>` is a script. This is tested in the
  // negative case too, since the positive case passes whichever rule applies.
  const audit = audited('scripts')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'only the explicit run form')).toEqual([])
})

it('prefers the root over the referencing file when both hold the path', async () => {
  // Prose names paths from the root far more often than from the file it is
  // written in. So the root's path is the one meant. With only one of the two
  // present anywhere, the order the two lookups run in proves nothing.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  // The ref is written in `plugins/demo/CLAUDE.md`. `lib/x.ts` exists both at
  // the root and beside that file. So the two lookups disagree, and the
  // answer shows which one ran first.
  expect(unitNaming(reportOf(audit.stdout()), 'which exists here and at the root')).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
})

it('refuses a bad value for either count, not only the first', async () => {
  const audit = audited('paths')

  const envelope = await runContext([audit.work, '--max-evidence', 'abc'], audit.edges)

  expect(envelope).toEqual({
    outcome: 'refused',
    error: '--max-evidence must be a whole number, not "abc"',
  })
})

it('measures the run on the clock it was given, rounded to whole milliseconds', async () => {
  // `now` is an edge case, so `wallClockMs` is a literal value, not a duration
  // a test must tolerate. The rounding exists because the real clock is
  // `performance.now()`, whose fractions are noise in a report and in a diff.
  const audit = audited('paths')
  const ticks = [0, 1.6]
  const edges: ContextEdges = { ...audit.edges, now: () => ticks.shift() as number }

  await runContext([audit.work, '--json'], edges)

  expect(reportOf(audit.stdout()).wallClockMs).toBe(2)
})

it('audits the checkout a subdirectory belongs to, and asks gh about that root', async () => {
  // The root is the toplevel, not the directory the caller named. `gh`
  // resolves the repository from the working directory it is built with. So a
  // client built with the caller's own path would ask about whatever
  // repository happened to sit there.
  const audit = audited('issues')
  const asked: string[] = []
  const edges: ContextEdges = {
    ...audit.edges,
    createGh: (cwd: string): GhClient => {
      asked.push(cwd)
      return createGhMock({ issueStates: { states: {}, unavailable: null } })
    },
  }
  const below = path.join(audit.work, 'below')
  mkdirSync(below)

  await runContext([below, '--json'], edges)

  const report = reportOf(audit.stdout())
  expect(report.root).toBe(realpathSync(audit.work))
  expect(report.files).toEqual(['CLAUDE.md'])
  expect(asked).toEqual([realpathSync(audit.work)])
})

it('trims a code span before reading it, so padding is not part of the value', async () => {
  // A writer pads a span for readability. Without the trim, the value carries
  // the spaces. `looksLikePath` refuses it because it contains whitespace, and
  // the reference is dropped rather than resolved.
  const audit = audited('paths')

  await runContext([audit.work, '--json'], audit.edges)

  expect(unitNaming(reportOf(audit.stdout()), 'written with padding')).toEqual([
    { kind: 'path', value: 'lib/x.ts', resolution: { status: 'found', repoPath: 'lib/x.ts' } },
  ])
})

it('leaves an existing --out file alone when the run refuses', async () => {
  // The pre-open is a probe. A probe that truncates would destroy the
  // caller's last report before it writes anything new.
  //
  // The refusal must happen AFTER the probe runs. Otherwise the probe never
  // runs, and the assertion passes under either mode. A bad root is the first
  // such case. A bad count is not, which is why the test does not use it
  // here.
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')
  writeFileSync(out, 'previous\n')
  const outside = audit.sandbox.join('outside')
  mkdirSync(outside)

  const envelope = await runContext([outside, '--out', out], audit.edges)

  expect(envelope).toEqual({ outcome: 'refused', error: `not a git repository: ${outside}` })
  expect(readFileSync(out, 'utf8')).toBe('previous\n')
})

it('replaces the --out file rather than appending to it on a second run', async () => {
  // The probe opens for append, so it cannot truncate. The write that earns
  // the file is a separate call, and it must truncate. Otherwise a second run
  // leaves two reports in one file, and nothing can parse it.
  const audit = audited('paths')
  const out = audit.sandbox.join('report.json')

  await runContext([audit.work, '--out', out], audit.edges)
  await runContext([audit.work, '--out', out], audit.edges)

  const written = JSON.parse(readFileSync(out, 'utf8')) as Report
  expect(written.files).toEqual(['CLAUDE.md', 'plugins/demo/CLAUDE.md'])
})

it('refuses an --out whose directory does not exist', async () => {
  // This is the other half of the claim the probe makes. A directory in the
  // file's place is one way it cannot be opened. A missing parent directory
  // is the other way. A caller reaches it when it types a path before the
  // directory exists.
  const audit = audited('paths')
  const out = audit.sandbox.join('nowhere', 'report.json')

  const envelope = await runContext([audit.work, '--out', out], audit.edges)

  expect(envelope.outcome).toBe('refused')
  expect(envelope.outcome !== 'ok' && envelope.error).toMatch(
    new RegExp(`^could not open ${out} for writing: ENOENT`),
  )
  expect(audit.stdout()).toBe('')
})
