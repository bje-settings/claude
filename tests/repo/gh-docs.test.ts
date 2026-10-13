// The gh plugin's prose, checked for the parts a script cannot enforce.
// This is ported from tests/gh/test_shepherd_docs.py and
// tests/gh/test_flow_discover.py, both deleted with the rest of
// tests/gh at #127.
//
// `settle` is only useful if the agent calls it. The orchestrator only
// catches the residual race if its skill says to make that read. The
// diagram is what a reader consults before either step. None of that is
// reachable from the commands' own tests, so this file checks it. /gh:sync
// and /gh:shepherd also resolve their scope by one shared rule, so their
// flow diagrams describe it with one shared `discover` subgraph. A drift
// between the two would mean one diagram lies about how scope is decided.
//
// **Positive assertions only.** These files are prose and get reworded. A
// test that fails on a rewording is a test that gets deleted. This file
// checks only that each document still names the mechanism it is
// responsible for.
//
// Every assertion is scoped with `section`, which fails loudly when a
// marker it slices on has moved. A bare split would do the opposite of
// what a test should do: an error where a reader expects an assertion,
// or, worse, a whole document handed back as "the section." There, a
// substring check would pass for the wrong reason, and the test would
// quietly stop testing anything.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { FLOWS, PLUGINS } from './repo.ts'

const GH = path.join(PLUGINS, 'gh')
const AGENT = path.join(GH, 'agents', 'shepherd-prs.md')
const SKILL = path.join(GH, 'skills', 'shepherd', 'SKILL.md')
const FLOW = path.join(FLOWS, 'gh', 'shepherd', '_skill-flow.md')

const read = (file: string): string => readFileSync(file, 'utf8')

const occurrences = (body: string, marker: string): number => body.split(marker).length - 1

/** The text between two markers. This asserts that each one is still
 *  there. With `end` left out, this runs to the end of the file. */
const section = (file: string, start: string, end?: string): string => {
  const body = read(file)
  expect(occurrences(body, start), `${path.basename(file)}: expected exactly one ${start}`).toBe(1)
  const after = body.slice(body.indexOf(start) + start.length)
  if (end === undefined) return after
  expect(
    occurrences(after, end),
    `${path.basename(file)}: ${end} does not follow ${start}`,
  ).toBeGreaterThanOrEqual(1)
  return after.slice(0, after.indexOf(end))
}

// --- the shepherd's prose -----------------------------------------------------

it('names settle in the actions the agent may run', () => {
  // An action the agent does not know about is an action nobody calls.
  const lines = read(AGENT)
    .split('\n')
    .filter((line) => line.includes('shepherd-pr') && line.includes('|'))

  expect(lines).toHaveLength(1)
  const actions = (lines[0] ?? '').trim().split(/\s+/).at(-1) ?? ''
  expect(actions.split('|')).toContain('settle')
})

for (const result of ['merged', 'blocked', 'changed', 'closed', 'open']) {
  it(`says what to do with the settle result ${result}`, () => {
    // The `passed` arm is where the false `blocked` came from.
    const passed = section(AGENT, '- `passed`', '- `pending`')

    expect(passed).toContain('`settle`')
    expect(passed).toContain(`\`${result}\``)
  })
}

it('bounds a settle call like the other blocking ones', () => {
  // Without `timeout: 600000` the Bash call is cut off at 120 s and the agent
  // sees nothing.
  expect(section(AGENT, '## Hard rules', '## The loop')).toContain(
    '`settle` call MUST pass `timeout: 600000`',
  )
})

it('forbids a blocked reason the agent did not read', () => {
  // Defect two of the field test: the reason carried hypotheses the state
  // contradicted.
  expect(section(AGENT, '## Hard rules', '## The loop')).toContain('only fields you actually read')
})

for (const field of ['reviewDecision', 'autoMerge', 'waited']) {
  it(`carries ${field} in the agent's report, because the orchestrator decides from it`, () => {
    expect(section(AGENT, '## Report')).toContain(field)
  })
}

it('reclassifies a blocked entry with one merged read', () => {
  // Scoped to the step: `merged` alone appears in the report table too.
  const step = section(SKILL, '## Step 4', '## Step 5')

  expect(step).toContain('scripts/gh.ts" shepherd-pr <path> <n> merged')
  expect(step).toContain('autoMerge')
  expect(step).toContain('CLEAN')
  expect(step).toContain('UNKNOWN')
})

it('does not re-read a blocked entry that names a cause', () => {
  // The safety-relevant half: GitHub decided those, so timing cannot undo them.
  const step = section(SKILL, '## Step 4', '## Step 5')

  expect(step).toContain('not run')
  for (const named of ['BLOCKED', 'DIRTY', 'BEHIND', 'reviewDecision']) {
    expect(step).toContain(named)
  }
})

it('names no recreate action in the agent', () => {
  // Shepherd resolves a Dependabot conflict like any other (#346).
  expect(read(AGENT)).not.toContain('recreate')
})

it('resolves a conflict by merging the base, and forbids force', () => {
  const body = read(AGENT)
  const hardRules = section(AGENT, '## Hard rules', '## The loop')

  expect(body).toContain('git merge origin/<base>')
  expect(body).toContain('plain `git push`')
  expect(body).toContain('Never use `--force`')
  expect(hardRules).toContain('never force')
})

it('reports the conflicted files and how each was resolved', () => {
  expect(section(AGENT, '## Report')).toContain('conflicts')
})

it('does not list conflict resolution among what the skill never does', () => {
  const never = section(SKILL, '## What this skill never does')

  expect(never).not.toContain('conflict')
  expect(never).toContain('force-push')
})

it('draws the settle branch in the shepherd diagram', () => {
  const body = section(FLOW, '```mermaid', '```')

  expect(body).toContain('Settle')
  expect(body).toContain('BEHIND or DIRTY')
})

// --- the one shared discover subgraph -----------------------------------------

/** The `subgraph discover ... end` block of one skill flow, indentation
 *  stripped. */
const discoverBlock = (skill: string): string => {
  const lines = read(path.join(FLOWS, 'gh', skill, '_skill-flow.md')).split('\n')
  const block: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^ *subgraph discover /.test(line)) inside = true
    if (!inside) continue
    block.push(line.trim())
    if (line.trim() === 'end') break
  }
  return block.join('\n')
}

for (const skill of ['sync', 'shepherd']) {
  it(`draws a discover subgraph in the ${skill} diagram`, () => {
    const block = discoverBlock(skill)

    expect(block).toContain('Inside a git repo?')
    expect(block).toContain('Skipped silently')
    expect(block).toContain('Stop: no git repositories directly inside cwd')
  })
}

it('keeps the two discover subgraphs identical', () => {
  expect(discoverBlock('sync')).toBe(discoverBlock('shepherd'))
})
