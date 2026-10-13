// The guard's decisions, in process. git is real throughout. Every tree
// below is a repository `harness/git.ts` built. The reader passed in is
// `lib/git.ts`'s own `gitOut`, with the sandbox's environment bound. So a
// clean tree, a dirty tree, and a directory git refuses, are all
// genuinely those things (`.claude/rules/type-ts.md`, "git is not
// mocked").
//
// The process boundary, the floor guard, and the wiring `hooks.json`
// carries, are in `tests/plugins/workstreams/hook.test.ts`.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'
import { gitOut } from '#workstreams/lib/git.ts'
import type { Output, Writer } from '#workstreams/lib/streams.ts'
import {
  decide,
  denial,
  destructiveGit,
  type GitReader,
  type ProcessReader,
  type RunningProcess,
  readToolCall,
  resolvedOrSame,
  resolvePayloadCwd,
  runGuard,
  runsVitest,
  type ToolCall,
  type Verdict,
  vitestTarget,
} from '#workstreams/subcommands/guard.ts'

const collector = (): Writer & { text: () => string } => {
  const chunks: string[] = []
  let silenced = false
  return {
    write: (text: string) => {
      chunks.push(text)
    },
    silence: () => {
      silenced = true
    },
    get silenced() {
      return silenced
    },
    text: () => chunks.join(''),
  }
}

const createOutputPair = (): Output & { stdout: () => string; stderr: () => string } => {
  const out = collector()
  const err = collector()
  return {
    out,
    err,
    silence: () => {
      out.silence()
      err.silence()
    },
    stdout: out.text,
    stderr: err.text,
  }
}

/** The real reader, with the sandbox's environment so that a developer's own
 *  git configuration cannot change what a fixture is. */
const readerFor =
  (sandbox: Sandbox): GitReader =>
  (args, options) =>
    gitOut(args, { cwd: options.cwd, env: sandbox.env })

/** A second TRACKED file, committed, so that a case that wants two
 *  uncommitted changes gets two. `seed` tracks `file.txt` and nothing
 *  else, and the fixtures' `dirty` on any other name would leave an
 *  untracked file, which is the one thing this guard deliberately
 *  ignores. */
const trackSecondFile = (git: GitFixtures, work: string): void => {
  writeFileSync(path.join(work, 'two.txt'), 'base\n')
  git.git(work, 'add', '-A')
  git.git(work, 'commit', '-qm', 'two')
}

/** A payload with the fields a case cares about, everything else absent, as
 *  a real one from a subagent would carry them. */
const call = (fields: Partial<ToolCall> = {}): ToolCall => ({
  agentId: 'agent_01',
  agentType: 'workstreams:stream',
  toolName: 'Bash',
  command: null,
  background: false,
  cwd: null,
  ...fields,
})

describe('reading the payload', () => {
  it('reads the six fields a decision is made from', () => {
    const read = readToolCall(
      JSON.stringify({
        session_id: 's1',
        cwd: '/w',
        hook_event_name: 'PreToolUse',
        agent_id: 'agent_01',
        agent_type: 'workstreams:stream',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test', run_in_background: true },
      }),
    )

    expect(read).toEqual({
      outcome: 'ok',
      value: {
        agentId: 'agent_01',
        agentType: 'workstreams:stream',
        toolName: 'Bash',
        command: 'pnpm test',
        background: true,
        cwd: '/w',
      },
    })
  })

  it('reads a main-thread payload, which carries neither agent field', () => {
    const read = readToolCall(
      JSON.stringify({ cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    )

    expect(read).toEqual({
      outcome: 'ok',
      value: {
        agentId: null,
        agentType: null,
        toolName: 'Bash',
        command: 'ls',
        background: false,
        cwd: '/w',
      },
    })
  })

  it('treats a field of the wrong type as absent rather than as an answer', () => {
    const read = readToolCall(
      JSON.stringify({
        agent_id: 7,
        agent_type: null,
        tool_name: ['Bash'],
        cwd: false,
        tool_input: { command: 12, run_in_background: 'true' },
      }),
    )

    expect(read).toEqual({
      outcome: 'ok',
      value: {
        agentId: null,
        agentType: null,
        toolName: null,
        command: null,
        // A truthy string is not the documented boolean, so it is not a
        // request to background anything.
        background: false,
        cwd: null,
      },
    })
  })

  it('treats a payload with no tool_input key at all as no tool input', () => {
    const read = readToolCall(JSON.stringify({ agent_id: 'a', tool_name: 'Bash' }))

    expect(read).toMatchObject({ outcome: 'ok', value: { command: null, background: false } })
  })

  it('treats a tool_input that is not an object as no tool input at all', () => {
    const read = readToolCall(JSON.stringify({ agent_id: 'a', tool_input: ['command'] }))

    expect(read).toMatchObject({ outcome: 'ok', value: { command: null, background: false } })
  })

  it('reports text that is not JSON, naming what the parser said', () => {
    const read = readToolCall('not json at all')

    expect(read.outcome).toBe('failed')
    expect(read).toMatchObject({ error: expect.stringContaining('payload is not JSON') })
  })

  for (const [name, payload] of [
    ['null', 'null'],
    ['an array', '[1]'],
    ['a number', '12'],
  ] as const) {
    it(`reports a payload that is ${name} as not an object`, () => {
      expect(readToolCall(payload)).toEqual({
        outcome: 'failed',
        error: 'payload is not a JSON object',
      })
    })
  }
})

describe('finding the destructive command', () => {
  for (const command of [
    'git checkout -- .',
    'git checkout --',
    'git restore src/index.ts',
    'git restore --staged --worktree .',
    'pnpm test && git restore .',
    'pnpm test; git checkout -- src',
    'pnpm test || git restore .',
    'pnpm build | tee log\ngit restore .',
    '( git restore . )',
    '{ git restore . ; }',
    'if x; then git restore . ; fi',
    'for f in a; do git restore . ; done',
    'if x; then y; else git restore . ; fi',
    '! git restore .',
    'GIT_PAGER=cat git restore .',
    '/usr/bin/git restore .',
    'git.exe restore .',
    'C:\\Program\\git.exe restore .',
    'git --no-pager restore .',
    'git -c core.hooksPath=/dev/null restore .',
    // The spellings that throw the tree away while naming no path at all.
    // Measured against git 2.54.0: each of these left a tree holding two
    // modified tracked files clean.
    'git checkout -f',
    'git checkout --force',
    'git checkout -f main',
    'git switch -f feature',
    'git switch --force feature',
    'git switch --discard-changes feature',
    // `-p` offers every modified tracked file when no path follows, which is
    // how `git restore -p` is already read.
    'git checkout -p',
    'git checkout --patch',
    'git checkout --pathspec-from-file=paths.txt',
    'git checkout --pathspec-from-file paths.txt',
  ]) {
    it(`finds it in ${JSON.stringify(command)}, targeting the call's own tree`, () => {
      expect(destructiveGit(command)).toEqual({ directory: null, pathspec: [] })
    })
  }

  for (const command of [
    'git -C /w restore .',
    'git -C/w restore .',
    'git -C /w checkout -- src',
    'git -c a=b -C /w restore .',
  ]) {
    it(`reads the -C directory out of ${JSON.stringify(command)}`, () => {
      expect(destructiveGit(command)).toEqual({ directory: '/w', pathspec: [] })
    })
  }

  // A `checkout` with no `--`: the operands are carried out for git to answer,
  // because the same words may be a branch. This is the spelling round 7's
  // stream lost `hook-io.ts` to.
  for (const [command, pathspec] of [
    ['git checkout hook-io.ts', ['hook-io.ts']],
    ['git checkout .', ['.']],
    ['git checkout main', ['main']],
    ['git checkout --quiet src two.txt', ['src', 'two.txt']],
  ] as const) {
    it(`carries the operands of ${JSON.stringify(command)} out to be resolved`, () => {
      expect(destructiveGit(command)).toEqual({ directory: null, pathspec })
    })
  }

  it('reads the -C directory out of a checkout with no separator too', () => {
    expect(destructiveGit('git -C /w checkout file.txt')).toEqual({
      directory: '/w',
      pathspec: ['file.txt'],
    })
  })

  for (const command of [
    'pnpm test',
    'git status --porcelain',
    'git commit -m "git restore is what lost it"',
    'sudo git restore .',
    'git checkout',
    'git checkout --quiet',
    'git -C',
    'git',
    ';;',
    '',
    // A command name that merely ends in `git`. `gitk` and `git-lfs` do not,
    // so they hold whatever the anchor in the matcher does; these are the
    // shape that catches an anchor someone widened.
    'nogit restore .',
    'mygit restore .',
    'gitk restore .',
    'git-lfs restore .',
    // A switch that only switches: git carries uncommitted work across with
    // it, so there is nothing here to refuse.
    'git switch feature',
    'git switch -c a-new-branch',
    'git switch --track origin/feature',
    // The options that name the branch a checkout creates or tracks. Git
    // accepts no pathspec beside them, so the name is never put to git as a
    // path.
    'git checkout -b wktr-132-ws-stream',
    'git checkout -B wktr-132-ws-stream',
    'git checkout --orphan wktr-132-ws-stream',
    'git checkout -t origin/wktr-132-ws-stream',
    'git checkout --track origin/wktr-132-ws-stream',
  ]) {
    it(`leaves ${JSON.stringify(command)} alone`, () => {
      expect(destructiveGit(command)).toBeUndefined()
    })
  }

  it('reads a checkout whose pathspec separator comes after other options', () => {
    expect(destructiveGit('git checkout --quiet HEAD -- src/index.ts')).toEqual({
      directory: null,
      pathspec: [],
    })
  })
})

describe('finding a vitest run', () => {
  for (const command of [
    'vitest',
    'vitest run',
    'vitest related --run src/index.ts',
    'pnpm exec vitest',
    'pnpm exec vitest related --run src/index.ts',
    'pnpm test',
    'pnpm test --watch',
    'pnpm run test',
    'pnpm build && pnpm test',
    'cd /w && pnpm exec vitest run',
    'FOO=bar pnpm exec vitest run',
    '( pnpm test )',
    '/usr/local/bin/vitest run',
    'VITEST run',
    'vitest.cmd run',
    '/usr/local/bin/pnpm test',
    'PNPM test',
    'pnpm.cmd test',
    'pnpm -C /w test',
    'pnpm --dir /w test',
    'pnpm --dir=/w test',
    'pnpm -C /w exec vitest',
    // `-C` and `--dir` both take an `=`-attached value too, the same as
    // git's own `-C`; measured against pnpm 10.34.5.
    'pnpm -C=/w test',
    // A quoted directory, with no space inside it: a subagent may quote an
    // absolute path defensively even where it holds no space.
    'pnpm -C "/w" test',
    "pnpm -C '/w' test",
    // pnpm's own bare-binary spelling: no `exec` needed, measured against
    // pnpm 10.34.5 (`pnpm vitest --version` runs this repository's own
    // vitest).
    'pnpm vitest run',
    'pnpm -C /w vitest run',
  ]) {
    it(`finds it in ${JSON.stringify(command)}`, () => {
      expect(runsVitest(command)).toBe(true)
    })
  }

  for (const command of [
    'pnpm build',
    'pnpm test:unit',
    'pnpm run build',
    'pnpm exec biome check',
    'cat vitest.config.ts',
    'git commit -m "add vitest"',
    'pnpm -C',
    '',
    // The attached form with no `=`, unlike git's own `-C<dir>`. Measured
    // against pnpm 10.34.5: this spelling does not behave like `-C <dir>`
    // or `-C=<dir>`, so it is left unrecognized rather than guessed at.
    'pnpm -Csub test',
  ]) {
    it(`leaves ${JSON.stringify(command)} alone`, () => {
      expect(runsVitest(command)).toBe(false)
    })
  }
})

describe('the directory a vitest run names', () => {
  it('names no directory for a bare vitest call', () => {
    expect(vitestTarget('vitest run')).toEqual({ directory: null })
  })

  it('names no directory for pnpm with no -C or --dir of its own', () => {
    expect(vitestTarget('pnpm test')).toEqual({ directory: null })
  })

  it('names no directory for an empty --dir=, the same as none at all', () => {
    expect(vitestTarget('pnpm --dir= test')).toEqual({ directory: null })
  })

  it('names no directory for a bare pnpm vitest call, this round’s new spelling', () => {
    expect(vitestTarget('pnpm vitest run')).toEqual({ directory: null })
  })

  for (const [command, directory] of [
    ['pnpm -C /w test', '/w'],
    ['pnpm --dir /w test', '/w'],
    ['pnpm --dir=/w test', '/w'],
    ['pnpm -C /w exec vitest', '/w'],
    ['pnpm -C /w run test', '/w'],
    ['pnpm -C=/w test', '/w'],
    ['pnpm -C "/w" test', '/w'],
    ["pnpm -C '/w' test", '/w'],
    ['pnpm -C /w vitest run', '/w'],
    // A quoted value with a space stays one argument (#371).
    ['pnpm -C "/a b" test', '/a b'],
    ["pnpm -C '/a b' test", '/a b'],
    ["pnpm --dir='/a b' test", '/a b'],
    ['pnpm -C=" /a b " test', ' /a b '],
    ['pnpm -C "/a b" exec vitest', '/a b'],
  ] as const) {
    it(`names ${directory} for ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory })
    })
  }

  it('flags a quote that never closes', () => {
    expect(vitestTarget('pnpm -C "/a b test')).toMatchObject({ unclosedQuote: true })
  })

  it('reads a quote that closes after another quote mark as closed', () => {
    expect(vitestTarget(`pnpm -C "it's" test`)).toEqual({ directory: "it's" })
  })

  for (const command of [`pnpm --dir='/a b test`, 'CI=1 pnpm -C "/a b test', 'vitest -C "/a b']) {
    it(`flags the unclosed quote in ${JSON.stringify(command)} only for pnpm`, () => {
      const target = vitestTarget(command)
      expect(target?.unclosedQuote).toBe(command.startsWith('vitest') ? undefined : true)
    })
  }

  for (const command of ['pnpm --dir "/a b test', 'pnpm -C="/a b test']) {
    it(`flags the unclosed quote in ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toMatchObject({ unclosedQuote: true })
    })
  }

  for (const [command, directory] of [
    ['vitest run -t "foo', null],
    ['pnpm -C /a test -t "foo', '/a'],
    ["pnpm test # don't run", null],
    ['pnpm  -C  /w   test', '/w'],
    ['pnpm\t-C\t/w\ttest', '/w'],
  ] as const) {
    it(`still finds the run in ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory })
    })
  }

  it('reads the directory from the tokens when a later quote never closes', () => {
    expect(vitestTarget('pnpm -C "/a b" test -t "x|y"')).toEqual({ directory: '/a b' })
    expect(vitestTarget('pnpm -C "/a b" test -t "foo')).toEqual({ directory: '/a b' })
  })

  it('reads a run the unclosed quote hides from the plain split', () => {
    expect(vitestTarget('CI="x pnpm test')).toEqual({ directory: null })
  })

  for (const command of [
    'pnpm -C /a --dir="x y test',
    'pnpm -C /a -C "x y test',
    'pnpm --dir=/a -C "x y test',
  ]) {
    it(`flags an unclosed quote after a complete option in ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory: null, unclosedQuote: true })
    })
  }

  it('does not read an option after the subcommand as the pnpm directory', () => {
    expect(vitestTarget('pnpm exec vitest run --dir "x')).toEqual({ directory: null })
    expect(vitestTarget('pnpm exec vitest run -C="x')).toEqual({ directory: null })
  })

  for (const command of [
    `pnpm -C /w/"a b" test`,
    `pnpm -C /w/'a b' test`,
    `pnpm -C /w/"ab" test`,
  ]) {
    it(`flags a quote kept inside the value in ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory: null, unclosedQuote: true })
    })
  }

  for (const command of ['echo "it', 'pnpm build "x y', 'pnpm -C /w test "x', 'CI="x y']) {
    it(`does not flag the unclosed quote in ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)?.unclosedQuote).toBeUndefined()
    })
  }
})

describe('a leading cd names the directory of a vitest run (#397)', () => {
  for (const [command, base] of [
    ['(cd /w && pnpm test)', '/w'],
    ['(cd /w && pnpm test )', '/w'],
    ['( cd /w && pnpm test )', '/w'],
    ['cd /w && pnpm test', '/w'],
    ['cd /w && pnpm build && pnpm test', '/w'],
    ['cd /w/sub && pnpm exec vitest run', '/w/sub'],
    ['cd sub && pnpm test', 'sub'],
    ['cd "/a b" && pnpm test', '/a b'],
    ["(cd '/a b' && pnpm test)", '/a b'],
    ['cd /w/my-app && pnpm test', '/w/my-app'],
    ['cd /w/a~b && pnpm test', '/w/a~b'],
    ['(cd /w && pnpm test) 2>&1 | tail', '/w'],
    ['(cd /w && pnpm test) > out', '/w'],
    ['(cd /w && pnpm test) &>log', '/w'],
  ] as const) {
    it(`names ${base} for ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory: null, base })
    })
  }

  it('finds a run in a subshell with no cd, and a closing parenthesis on its last word', () => {
    expect(vitestTarget('(pnpm test)')).toEqual({ directory: null })
    expect(vitestTarget('(pnpm -C /w test)')).toEqual({ directory: '/w' })
    expect(vitestTarget('(pnpm test) > out')).toEqual({ directory: null })
    expect(vitestTarget('pnpm build && (pnpm test)')).toEqual({ directory: null })
  })

  it('keeps the pnpm -C of the run beside the cd', () => {
    expect(vitestTarget('cd /w && pnpm -C /v test')).toEqual({
      directory: '/v',
      base: '/w',
    })
  })

  for (const command of [
    // No `&&`: the run may not follow a `cd` that worked, or runs in a pipe.
    'cd /w; pnpm test',
    'cd /w || pnpm test',
    'cd /w | pnpm test',
    'cd /w\npnpm test',
    // The cd is not the first segment.
    'pnpm build && cd /w && pnpm test',
    // The cd comes after the run.
    'pnpm test && cd /w',
    'pnpm test; cd /w && pnpm build',
    // The cd names a directory that only a shell can read, or more than one word.
    'cd - && pnpm test',
    'cd ~ && pnpm test',
    'cd $HOME && pnpm test',
    'cd "$(pwd)" && pnpm test',
    'cd -P /w && pnpm test',
    'cd && pnpm test',
    'cd /a /b && pnpm test',
    'cd /a/$X && pnpm test',
    'cd `pwd` && pnpm test',
    // The subshell of the cd closes before the run.
    '(cd /w) && pnpm test',
    '(cd /w && pnpm build) > out && pnpm test',
    '(cd /w && pnpm build) 2>&1 && pnpm test',
    // The cd sits in an inner subshell that closes before the run.
    '((cd /w) && pnpm test)',
    '((cd /w && pnpm build) && pnpm test)',
    ' (cd /w) && pnpm test',
  ]) {
    it(`leaves the payload cwd for ${JSON.stringify(command)}`, () => {
      expect(vitestTarget(command)).toEqual({ directory: null })
    })
  }

  it('ends the cd at a second cd', () => {
    expect(vitestTarget('cd /w && cd /v && pnpm test')).toEqual({ directory: null })
    expect(vitestTarget('cd /w && (cd /v && pnpm test)')).toEqual({ directory: null })
    expect(vitestTarget('cd /w && ( cd /v && pnpm test)')).toEqual({ directory: null })
    expect(vitestTarget('cd /w && cd && pnpm test')).toEqual({ directory: null })
    expect(vitestTarget('cd /w && cd&& pnpm test')).toEqual({ directory: null })
  })

  it('reads a cd whose quote never closes as no cd', () => {
    expect(vitestTarget('cd "/a b && pnpm test')).toEqual({ directory: null })
  })

  it('keeps a subshell cd across a nested parenthesis', () => {
    expect(vitestTarget('(cd /w && (pnpm build) && pnpm test)')).toEqual({
      directory: null,
      base: '/w',
    })
    expect(vitestTarget('((cd /w && pnpm test))')).toEqual({ directory: null, base: '/w' })
  })

  it('ends a subshell cd at the segment that closes the parenthesis', () => {
    expect(vitestTarget('(cd /w && pnpm build) && pnpm test')).toEqual({ directory: null })
    expect(vitestTarget('(cd /w && pnpm build && pnpm test)')).toEqual({
      directory: null,
      base: '/w',
    })
  })

  it('keeps a bare cd for a run after a closing parenthesis it never opened', () => {
    expect(vitestTarget('cd /w && echo x) && pnpm test')).toEqual({
      directory: null,
      base: '/w',
    })
  })

  it('flags a stray quote in the cd directory', () => {
    expect(vitestTarget(`cd /w/"a b" && pnpm test`)).toEqual({
      directory: null,
      unclosedQuote: true,
    })
  })
})

describe('the main thread and the tools this never reads', () => {
  it('allows a main-thread call in silence, whatever it asks for', async () => {
    const output = createOutputPair()

    const verdict = await decide(
      call({ agentId: null, agentType: null, background: true, command: 'git restore .' }),
      {
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      },
    )

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stdout()).toBe('')
    expect(output.stderr()).toBe('')
  })

  it('reads a PowerShell call, which is the only shell Windows may register', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ toolName: 'PowerShell', background: true }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toMatchObject({ decision: 'deny' })
  })

  for (const toolName of ['Read', null]) {
    it(`allows a ${toolName ?? 'nameless'} tool call without reading a command`, async () => {
      const output = createOutputPair()

      const verdict = await decide(call({ toolName, background: true }), {
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      })

      expect(verdict).toEqual({ decision: 'allow' })
    })
  }

  it('allows a shell call carrying no command at all', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: null }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })
})

describe('run_in_background', () => {
  it('refuses it for a subagent, naming the agent and the remedy', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ background: true, command: 'pnpm test' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('subagent workstreams:stream'),
    })
    expect(verdict).toMatchObject({ reason: expect.stringContaining('590000 ms') })
    // Nothing is written here: the decision is the caller's to render.
    expect(output.stdout()).toBe('')
    expect(output.stderr()).toBe('')
  })

  it('names a subagent whose type the payload did not carry', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ agentType: null, background: true }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toMatchObject({ reason: expect.stringContaining('for this subagent:') })
  })

  it('is asked before the command is read, so a background call with no command is still refused', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ background: true, command: null }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toMatchObject({ decision: 'deny' })
  })

  it('allows a foreground command a subagent asked for', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm exec vitest run' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })
})

// A running() list stands in for `pgrep` and its cwd reader, so no test
// here needs a process (round 12 ruling 9, #299).
const running =
  (entries: readonly RunningProcess[]): ProcessReader =>
  () =>
    Promise.resolve(entries)

describe('a second vitest suite', () => {
  for (const command of [
    'vitest run',
    'vitest related --run src/index.ts',
    'pnpm exec vitest related --run src/index.ts',
    'pnpm test',
    'pnpm run test',
  ]) {
    it(`refuses ${JSON.stringify(command)} while one already runs in the same worktree`, async () => {
      const output = createOutputPair()

      const verdict = await decide(call({ command, cwd: '/w' }), {
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: running([{ pid: 4242, cwd: '/w' }]),
        output,
      })

      expect(verdict.decision).toBe('deny')
      expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('/w') })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('wait for it to finish') })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('never re-issue') })
      expect(output.stderr()).toBe('')
    })
  }

  it('allows the main thread, whatever else runs, and never asks for the process list', async () => {
    const output = createOutputPair()

    const verdict = await decide(
      call({ agentId: null, agentType: null, command: 'pnpm test', cwd: '/w' }),
      {
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      },
    )

    expect(verdict).toEqual({ decision: 'allow' })
  })

  it('allows it when the other vitest runs in a different worktree', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([{ pid: 4242, cwd: '/elsewhere' }]),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toBe('')
  })

  it('allows an ordinary command, and never asks for the process list at all', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm build', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })

  it('allows, with a line on stderr, when the payload names no cwd at all', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: null }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toContain('the payload carries no cwd')
  })

  it('allows, with a line on stderr, when the process list could not be read', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.resolve(null),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toContain('the running processes could not be listed')
  })

  it('allows it past a process whose own cwd the guard could not read', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([{ pid: 4242, cwd: null }]),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toBe('')
  })

  it('matches the second entry of several, when only it names the same worktree', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([
        { pid: 1, cwd: '/elsewhere' },
        { pid: 4242, cwd: '/w' },
      ]),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
  })

  it('refuses a pnpm -C <dir> run against the directory it names, not the call’s own cwd', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm -C /w test', cwd: '/root' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([{ pid: 4242, cwd: '/w' }]),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
    expect(verdict).toMatchObject({ reason: expect.stringContaining('/w') })
  })

  it('allows a pnpm -C <dir> run when only a different directory has one running', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm -C /w test', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([{ pid: 4242, cwd: '/root' }]),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })

  it('matches a directory that differs from the process cwd only by a trailing slash', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test', cwd: '/w/' }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running([{ pid: 4242, cwd: '/w' }]),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
  })

  describe('a quoted pnpm -C directory with a space (#371)', () => {
    for (const command of ['pnpm -C "/a b" test', "pnpm --dir='/a b' test"]) {
      it(`refuses ${JSON.stringify(command)} while a vitest runs in /a b`, async () => {
        const verdict = await decide(call({ command, cwd: '/root' }), {
          git: () => Promise.reject(new Error('git must not be asked')),
          processes: running([{ pid: 4242, cwd: '/a b' }]),
          output: createOutputPair(),
        })

        expect(verdict.decision).toBe('deny')
        expect(verdict).toMatchObject({ reason: expect.stringContaining('/a b') })
      })
    }

    it('reports an unclosed quote on stderr, and allows', async () => {
      const output = createOutputPair()

      const verdict = await decide(call({ command: 'pnpm -C "/a b test', cwd: '/root' }), {
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: running([{ pid: 4242, cwd: '/root' }]),
        output,
      })

      expect(verdict).toEqual({ decision: 'allow' })
      expect(output.stderr()).toContain('does not close')
    })
  })

  describe('a pnpm -C directory, resolved before it is compared', () => {
    const idle = (): Pick<Parameters<typeof decide>[1], 'git' | 'output'> => ({
      git: () => Promise.reject(new Error('git must not be asked')),
      output: createOutputPair(),
    })
    const toReal = (path: string): Promise<string> =>
      Promise.resolve(path.replace('/link', '/real'))

    it('refuses a -C link while a vitest runs in the resolved directory', async () => {
      const verdict = await decide(call({ command: 'pnpm -C /link test', cwd: '/root' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/real' }]),
        resolve: toReal,
      })

      expect(verdict.decision).toBe('deny')
      expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
    })

    it('allows a -C link that resolves to a directory with no vitest', async () => {
      const verdict = await decide(call({ command: 'pnpm --dir /link test', cwd: '/link' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/link' }]),
        resolve: toReal,
      })

      expect(verdict).toEqual({ decision: 'allow' })
    })

    it('joins a relative -C to the call cwd, then resolves it', async () => {
      const verdict = await decide(call({ command: 'pnpm -C sub test', cwd: '/root/link' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/root/real/sub' }]),
        resolve: toReal,
      })

      expect(verdict.decision).toBe('deny')
    })

    it('compares the joined path of a -C that cannot be resolved', async () => {
      const unresolvable = (): Promise<string> => Promise.reject(new Error('ENOENT'))

      const same = await decide(call({ command: 'pnpm -C sub test', cwd: '/root' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/root/sub' }]),
        resolve: unresolvable,
      })
      const other = await decide(call({ command: 'pnpm -C sub test', cwd: '/root' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/elsewhere' }]),
        resolve: unresolvable,
      })

      expect(same.decision).toBe('deny')
      expect(other).toEqual({ decision: 'allow' })
    })

    it('compares a -C as typed or joined when the context has no resolve', async () => {
      const typed = await decide(call({ command: 'pnpm -C /link test', cwd: '/root' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/real' }]),
      })
      const joined = await decide(call({ command: 'pnpm -C sub test', cwd: '/root' }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/root/sub' }]),
      })

      expect(typed).toEqual({ decision: 'allow' })
      expect(joined.decision).toBe('deny')
    })

    it('allows, with a line on stderr, a relative -C when the payload has no cwd', async () => {
      const output = createOutputPair()
      const verdict = await decide(call({ command: 'pnpm -C sub test', cwd: null }), {
        git: () => Promise.reject(new Error('git must not be asked')),
        output,
        processes: running([{ pid: 4242, cwd: '/sub' }]),
        resolve: (path) => Promise.resolve(path),
      })

      expect(verdict).toEqual({ decision: 'allow' })
      expect(output.stderr()).toContain('the payload carries no cwd')
    })

    it('allows, with a line on stderr, a relative -C when the payload cwd is empty', async () => {
      const output = createOutputPair()
      const verdict = await decide(call({ command: 'pnpm -C sub test', cwd: '' }), {
        git: () => Promise.reject(new Error('git must not be asked')),
        output,
        processes: running([{ pid: 4242, cwd: '/sub' }]),
      })

      expect(verdict).toEqual({ decision: 'allow' })
      expect(output.stderr()).toContain('the payload carries no cwd')
    })

    it('still compares an absolute -C when the payload has no cwd', async () => {
      const verdict = await decide(call({ command: 'pnpm -C /real test', cwd: null }), {
        ...idle(),
        processes: running([{ pid: 4242, cwd: '/real' }]),
      })

      expect(verdict.decision).toBe('deny')
    })

    it('passes resolve through runGuard', async () => {
      const output = createOutputPair()
      const stdin = JSON.stringify({
        agent_id: 'a',
        tool_name: 'Bash',
        cwd: '/root',
        tool_input: { command: 'pnpm -C /link test' },
      })

      await runGuard({
        stdin: () => Promise.resolve(stdin),
        git: () => Promise.reject(new Error('git must not be asked')),
        processes: running([{ pid: 4242, cwd: '/real' }]),
        output,
        resolve: toReal,
      })

      expect(output.stdout()).toContain('pid 4242')
    })
  })

  // A command that is both a running vitest suite's own second run AND a
  // destructive git command, at the same cwd. `decide`'s own doc comment
  // says the second-suite check runs first; the `git` reader here throws
  // if it is ever asked, so this fails unless that ordering holds.
  it('denies a compound vitest-and-destructive-git command on the vitest rule first', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'pnpm test && git restore .', cwd: '/w' }), {
      git: () => Promise.reject(new Error('git must not be asked: the vitest check decides first')),
      processes: running([{ pid: 4242, cwd: '/w' }]),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
    expect(verdict).toMatchObject({ reason: expect.stringContaining('wait for it to finish') })
  })
})

describe('a second vitest suite after a leading cd (#397)', () => {
  const refuse = async (
    command: string,
    cwd: string | null,
    processes: readonly { pid: number; cwd: string | null }[],
    output = createOutputPair(),
  ): Promise<Verdict> =>
    decide(call({ command, cwd }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: running(processes),
      output,
    })

  for (const command of ['(cd /a && pnpm test)', 'cd /a && pnpm test']) {
    it(`refuses ${JSON.stringify(command)} while a suite runs in /a`, async () => {
      const verdict = await refuse(command, '/root', [{ pid: 4242, cwd: '/a' }])

      expect(verdict.decision).toBe('deny')
      expect(verdict).toMatchObject({ reason: expect.stringContaining('pid 4242') })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('/a') })
    })

    it(`allows ${JSON.stringify(command)} while a suite runs only in the payload cwd`, async () => {
      const verdict = await refuse(command, '/root', [{ pid: 4242, cwd: '/root' }])

      expect(verdict).toEqual({ decision: 'allow' })
    })

    it(`allows ${JSON.stringify(command)} while a suite runs in another directory`, async () => {
      const verdict = await refuse(command, '/root', [{ pid: 4242, cwd: '/b' }])

      expect(verdict).toEqual({ decision: 'allow' })
    })
  }

  it('refuses a subshell cd run with a redirect after the parenthesis', async () => {
    const verdict = await refuse('(cd /a && pnpm test) 2>&1 | tail -5', '/root', [
      { pid: 4242, cwd: '/a' },
    ])

    expect(verdict.decision).toBe('deny')
  })

  it('joins a relative cd directory to the payload cwd', async () => {
    const verdict = await refuse('cd sub && pnpm test', '/root', [{ pid: 4242, cwd: '/root/sub' }])

    expect(verdict.decision).toBe('deny')
  })

  it('reads a quoted cd directory with a space', async () => {
    const verdict = await refuse('(cd "/a b" && pnpm test)', '/root', [{ pid: 4242, cwd: '/a b' }])

    expect(verdict.decision).toBe('deny')
  })

  it('refuses the payload cwd for a cd with no &&, which it does not read', async () => {
    const same = await refuse('cd /a; pnpm test', '/root', [{ pid: 4242, cwd: '/root' }])
    const other = await refuse('cd /a; pnpm test', '/root', [{ pid: 4242, cwd: '/a' }])

    expect(same.decision).toBe('deny')
    expect(other).toEqual({ decision: 'allow' })
  })

  it('refuses the payload cwd for a cd after the run', async () => {
    const verdict = await refuse('pnpm test && cd /a', '/root', [{ pid: 4242, cwd: '/root' }])

    expect(verdict.decision).toBe('deny')
  })

  it('joins a relative pnpm -C to the cd directory', async () => {
    const verdict = await refuse('cd /a && pnpm -C sub test', '/root', [
      { pid: 4242, cwd: '/a/sub' },
    ])

    expect(verdict.decision).toBe('deny')
  })

  it('lets an absolute pnpm -C win over the cd', async () => {
    const onC = await refuse('cd /a && pnpm -C /c test', '/root', [{ pid: 4242, cwd: '/c' }])
    const onCd = await refuse('cd /a && pnpm -C /c test', '/root', [{ pid: 4242, cwd: '/a' }])

    expect(onC.decision).toBe('deny')
    expect(onCd).toEqual({ decision: 'allow' })
  })

  it('allows, with a line on stderr, a relative cd when the payload has no cwd', async () => {
    const output = createOutputPair()

    const verdict = await refuse('cd sub && pnpm test', null, [{ pid: 4242, cwd: '/sub' }], output)

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toContain('the payload carries no cwd')
  })

  it('still compares an absolute cd when the payload has no cwd', async () => {
    const verdict = await refuse('cd /a && pnpm test', null, [{ pid: 4242, cwd: '/a' }])

    expect(verdict.decision).toBe('deny')
  })

  it('reports a stray quote in the cd directory on stderr, and allows', async () => {
    const output = createOutputPair()

    const verdict = await refuse(
      `cd /a/"b c" && pnpm test`,
      '/root',
      [{ pid: 4242, cwd: '/root' }],
      output,
    )

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toContain('does not close')
  })
})

describe('git checkout and git restore, against real repositories', () => {
  it('refuses the command when the tree has uncommitted work in a tracked file', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const work = git.create(sandbox.join('r'))
    git.dirty(work)
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'git checkout -- .', cwd: work }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('1 uncommitted change to tracked files'),
    })
    expect(verdict).toMatchObject({ reason: expect.stringContaining(work) })
    expect(output.stderr()).toBe('')
  })

  it('counts the changes it found, so the denial says how much is at stake', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const work = git.create(sandbox.join('r'))
    trackSecondFile(git, work)
    git.dirty(work)
    git.dirty(work, 'two.txt')
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'git restore .', cwd: work }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toMatchObject({
      reason: expect.stringContaining('2 uncommitted changes to tracked files'),
    })
  })

  // Round 7's stream lost `hook-io.ts` to `git checkout hook-io.ts`, written
  // without a separator, which the first shape of this guard allowed.
  for (const [command, named] of [
    ['git checkout file.txt', 'file.txt'],
    ['git checkout .', 'under .'],
  ] as const) {
    it(`refuses ${JSON.stringify(command)}, written without a separator`, async () => {
      const sandbox = createSandbox()
      const git = createGitFixtures(sandbox)
      const work = git.create(sandbox.join('r'))
      git.dirty(work)
      const output = createOutputPair()

      const verdict = await decide(call({ command, cwd: work }), {
        git: readerFor(sandbox),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      })

      expect(verdict.decision).toBe('deny')
      expect(verdict).toMatchObject({
        reason: expect.stringContaining('1 uncommitted change to tracked files'),
      })
      // The denial names the worker, so a person who reads it knows who
      // was stopped, and it names the paths, so they know what would
      // have gone.
      expect(verdict).toMatchObject({
        reason: expect.stringContaining('subagent workstreams:stream'),
      })
      expect(verdict).toMatchObject({ reason: expect.stringContaining(named) })
      expect(output.stderr()).toBe('')
    })
  }

  // The other half of the same decision: git is what tells a branch from a
  // path, so none of these costs anyone a branch switch on a dirty tree.
  for (const command of [
    'git checkout main',
    'git checkout -b a-new-branch',
    'git checkout two.txt',
    // The branch the checkout creates is called exactly what the dirty
    // tracked file is called. `git.dirty` writes to `file.txt`, so these
    // are the collision the operand filter used to refuse: git creates
    // the branch and leaves the file alone, and a case where the two
    // names differ cannot show it.
    'git checkout -b file.txt',
    'git checkout -B file.txt',
    'git checkout --orphan file.txt',
    'git switch -c file.txt',
    // A switch that only switches, on the same dirty tree.
    'git switch a-branch-that-does-not-exist',
  ]) {
    it(`allows ${JSON.stringify(command)} on the same dirty tree`, async () => {
      const sandbox = createSandbox()
      const git = createGitFixtures(sandbox)
      const work = git.create(sandbox.join('r'))
      trackSecondFile(git, work)
      git.dirty(work)
      const output = createOutputPair()

      const verdict = await decide(call({ command, cwd: work }), {
        git: readerFor(sandbox),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      })

      expect(verdict).toEqual({ decision: 'allow' })
      expect(output.stderr()).toBe('')
    })
  }

  // The spellings that name no path and take the whole tree anyway. Measured
  // against git 2.54.0: each of these left a tree with two modified tracked
  // files clean, which is the loss this hook exists for, written so that the
  // operand filter sees nothing to ask about.
  for (const command of [
    'git checkout -f',
    'git checkout --force',
    'git checkout -f main',
    'git checkout -p',
    'git switch --discard-changes main',
    'git switch -f main',
  ]) {
    it(`refuses ${JSON.stringify(command)}, which names no path at all`, async () => {
      const sandbox = createSandbox()
      const git = createGitFixtures(sandbox)
      const work = git.create(sandbox.join('r'))
      git.dirty(work)
      const output = createOutputPair()

      const verdict = await decide(call({ command, cwd: work }), {
        git: readerFor(sandbox),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      })

      expect(verdict.decision).toBe('deny')
      // The whole tree, so the reason names the directory and not a pathspec.
      expect(verdict).toMatchObject({
        reason: expect.stringContaining(`${work} has 1 uncommitted change to tracked files`),
      })
      expect(output.stderr()).toBe('')
    })
  }

  it('scopes a separatorless checkout to the tree its own -C names', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const dirty = git.createAt(sandbox.join('trees'), 'dirty')
    const clean = git.createAt(sandbox.join('trees'), 'clean')
    git.dirty(dirty)
    const output = createOutputPair()

    const denied = await decide(
      call({ command: `git -C ${dirty} checkout file.txt`, cwd: clean }),
      {
        git: readerFor(sandbox),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      },
    )
    const allowed = await decide(
      call({ command: `git -C ${clean} checkout file.txt`, cwd: dirty }),
      {
        git: readerFor(sandbox),
        processes: () => Promise.reject(new Error('processes must not be asked')),
        output,
      },
    )

    expect(denied.decision).toBe('deny')
    expect(allowed).toEqual({ decision: 'allow' })
    expect(output.stderr()).toBe('')
  })

  it('allows the command on a clean tree', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const work = git.create(sandbox.join('r'))
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'git restore .', cwd: work }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toBe('')
  })

  it('allows it on a tree holding only untracked files, which it cannot destroy', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const work = git.create(sandbox.join('r'))
    git.untracked(work)
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'git checkout -- .', cwd: work }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })

  it('would not count an ignored file either, if the probe ever asked for one', async () => {
    const output = createOutputPair()

    // A porcelain real git does not produce here: `!!` lines appear only under
    // `--ignored`, which `decide` never passes. The reader is injected so the
    // arm that keeps an ignored file from refusing someone's command stays
    // pinned if that flag is ever added.
    const verdict = await decide(call({ command: 'git restore .', cwd: '/w' }), {
      git: () => Promise.resolve('!! build/out.js\n?? notes.md'),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
  })

  it('checks the tree the -C names, not the one the call runs in', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const dirty = git.createAt(sandbox.join('trees'), 'dirty')
    const clean = git.createAt(sandbox.join('trees'), 'clean')
    git.dirty(dirty)
    const output = createOutputPair()

    const denied = await decide(call({ command: `git -C ${dirty} restore .`, cwd: clean }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })
    const allowed = await decide(call({ command: `git -C ${clean} restore .`, cwd: dirty }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(denied.decision).toBe('deny')
    expect(allowed).toEqual({ decision: 'allow' })
  })

  it('allows, with a line on stderr, where git cannot report the tree at all', async () => {
    const sandbox = createSandbox()
    const output = createOutputPair()
    const outside = sandbox.join('not-a-repository')
    mkdirSync(outside, { recursive: true })

    const verdict = await decide(call({ command: 'git restore .', cwd: outside }), {
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toBe(
      `workstreams guard: git could not report the state of ${outside}, so this command was ` +
        'not checked; allowing it.\n',
    )
  })

  it('allows, with a line on stderr, when the payload names no tree at all', async () => {
    const output = createOutputPair()

    const verdict = await decide(call({ command: 'git restore .', cwd: null }), {
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(verdict).toEqual({ decision: 'allow' })
    expect(output.stderr()).toContain('neither a -C directory nor a cwd')
  })
})

describe('what the hook writes', () => {
  it('renders a denial in the documented PreToolUse shape', () => {
    expect(JSON.parse(denial('because'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'because',
      },
    })
  })

  it('writes the denial to stdout and exits 0', async () => {
    const output = createOutputPair()

    const status = await runGuard({
      stdin: () =>
        Promise.resolve(
          JSON.stringify({
            agent_id: 'a',
            agent_type: 'workstreams:stream',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test', run_in_background: true },
          }),
        ),
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(status).toBe(0)
    const body = JSON.parse(output.stdout()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
    }
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain('workstreams:stream')
    expect(output.stderr()).toBe('')
  })

  it('writes nothing at all on an allow, so the permission rules still decide', async () => {
    const output = createOutputPair()

    const status = await runGuard({
      stdin: () => Promise.resolve(JSON.stringify({ tool_name: 'Bash', tool_input: {} })),
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(status).toBe(0)
    expect(output.stdout()).toBe('')
    expect(output.stderr()).toBe('')
  })

  it('says what it could not read, allows, and still exits 0', async () => {
    const output = createOutputPair()

    const status = await runGuard({
      stdin: () => Promise.resolve(''),
      git: () => Promise.reject(new Error('git must not be asked')),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(status).toBe(0)
    expect(output.stdout()).toBe('')
    expect(output.stderr()).toMatch(/^workstreams guard: payload is not JSON .*allowing the tool/)
  })

  it('denies a real dirty-tree command end to end, reading a real repository', async () => {
    const sandbox = createSandbox()
    const git = createGitFixtures(sandbox)
    const work = git.create(sandbox.join('r'))
    git.dirty(work)
    const output = createOutputPair()

    const status = await runGuard({
      stdin: () =>
        Promise.resolve(
          JSON.stringify({
            agent_id: 'a',
            agent_type: 'workstreams:stream',
            cwd: work,
            tool_name: 'Bash',
            tool_input: { command: 'git checkout -- file.txt' },
          }),
        ),
      git: readerFor(sandbox),
      processes: () => Promise.reject(new Error('processes must not be asked')),
      output,
    })

    expect(status).toBe(0)
    expect(output.stdout()).toContain('"permissionDecision":"deny"')
  })
})

describe('resolvedOrSame', () => {
  it('answers the real path of a directory reached through a link', async () => {
    const sandbox = createSandbox()
    const real = sandbox.join('real')
    mkdirSync(real)
    const link = sandbox.join('link')
    symlinkSync(real, link)

    expect(await resolvedOrSame(link, realpath)).toBe(realpathSync(real))
  })

  it('keeps the path as given when the resolver cannot answer', async () => {
    const gone = createSandbox().join('never-made')

    expect(await resolvedOrSame(gone, realpath)).toBe(gone)
  })
})

describe('resolvePayloadCwd', () => {
  const upper = (path: string): Promise<string> => Promise.resolve(path.toUpperCase())

  it('rewrites the cwd and keeps every other field', async () => {
    const text = JSON.stringify({ agent_id: 'a', cwd: '/w', tool_input: { command: 'x' } })

    const resolved = JSON.parse(await resolvePayloadCwd(text, upper)) as Record<string, unknown>

    expect(resolved).toEqual({ agent_id: 'a', cwd: '/W', tool_input: { command: 'x' } })
  })

  it('keeps a cwd the resolver cannot answer', async () => {
    const text = JSON.stringify({ cwd: '/gone' })

    const resolved = await resolvePayloadCwd(text, () => Promise.reject(new Error('ENOENT')))

    expect(JSON.parse(resolved)).toEqual({ cwd: '/gone' })
  })

  it.each([
    ['text that is not JSON', 'not json at all'],
    ['JSON that is not an object', '[1]'],
    ['an object with no cwd', '{"a":1}'],
    ['an object with a cwd that is not a string', '{"cwd":3}'],
  ])('returns %s as it came', async (_name, text) => {
    expect(await resolvePayloadCwd(text, upper)).toBe(text)
  })
})
