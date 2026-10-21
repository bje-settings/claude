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
// responsible for. The one exception is a mechanism this repository
// removed on purpose (#346): a test then pins that it stays gone.
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

/** The text with each run of whitespace as one space, so a pin survives a
 *  reflow of the lines. */
const flat = (text: string): string => text.replace(/\s+/g, ' ')

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

// --- the review rules and --all (#465) --------------------------------------

it('takes --all as an argument of the skill', () => {
  expect(section(SKILL, 'argument-hint:', '\n')).toContain('--all')
})

it('passes --all to shepherd-status, and prints not_ready on --dry-run', () => {
  const step = flat(section(SKILL, '## Step 2', '## Step 3'))
  expect(step).toContain('shepherd-status <path> [label] [--all]')
  expect(step).toContain('Pass `--all` only when it was given')
  expect(step).toContain('`not_ready` entries with their `reasons`')
})

it('tells each agent whether --all is on', () => {
  expect(flat(section(SKILL, '## Step 3', '## Step 4'))).toContain('whether `--all` is on')
})

it('names each not-ready pull request in the report, with its reasons', () => {
  const step = flat(section(SKILL, '## Step 5', '## What this skill never does'))
  expect(step).toContain('`not_ready`')
  expect(step).toContain('"needs an approval"')
  expect(step).toContain('"has unresolved review threads"')
})

it('skips a pull request that is not ready by its review rules, before any rebase or wait', () => {
  const step = flat(section(AGENT, '1. `state`.', '2. Decide from'))
  expect(step).toContain(
    'Without `--all`, check the review rules next, before any `rebase` or `wait`',
  )
  expect(step).toContain(
    'If `pr.approval` is `missing`, record it as skipped ("needs an approval")',
  )
  expect(step).toContain(
    'If `pr.threads` is `unresolved`, record it as skipped ("has unresolved review threads")',
  )
  expect(step).toContain('A `null` is not a reason to skip')
  expect(step).toContain('With `--all`, ignore both fields')
  expect(step).toContain('When both hold, name both reasons')
})

it('runs the step 1 checks again after every read of state', () => {
  // The `changed` and `ok:false` paths re-read `state`. Without this rule
  // they go to step 2, and an approval lost during the run is not seen.
  const step = flat(section(AGENT, '1. `state`.', '2. Decide from'))
  expect(step).toContain('Do this step again after every read of `state`, not only the first')
  expect(step).toContain('Keep the `pr.checks.state` of the first read for step 4')
})

it('names the review verdicts among the fields a skip reason may copy', () => {
  const rules = flat(section(AGENT, '## Hard rules', '## The loop'))
  expect(rules).toContain('`autoMerge`, `pr.approval`, `pr.threads`')
})

// --- a head out of sync with its branch (#467) ------------------------------

it('skips a head out of sync with its branch, before any rebase or wait, with both SHAs', () => {
  // Rule 15 (h). A rebase cannot move a head that GitHub has not moved to
  // the newest push of its branch.
  const step = flat(section(AGENT, '1. `state`.', '2. Decide from'))
  expect(step).toContain(
    'If `pr.inSync` is false, record it as skipped ("head out of sync with its branch: ' +
      'headRefOid <pr.headRefOid>, branch at <pr.branchRefOid>") and continue, before any ' +
      '`rebase` or `wait`',
  )
  expect(step).toContain('Copy both SHAs from the JSON')
  expect(step).toContain('A `null` `pr.inSync` is not a reason to skip')
  // The out-of-sync check comes before the check of the review rules.
  expect(step.indexOf('`pr.inSync` is false')).toBeLessThan(step.indexOf('review rules next'))
})

it('names both SHAs among the fields a skip reason may copy', () => {
  const rules = flat(section(AGENT, '## Hard rules', '## The loop'))
  expect(rules).toContain(
    '`pr.headRefOid`, `pr.branchRefOid`, the `progress` fields and the script',
  )
})

it('draws the out-of-sync skip in the skill flow', () => {
  const body = section(FLOW, '```mermaid', '```')
  expect(body).toContain('Head out of sync with its branch ref')
  expect(body).toContain('Skipped: head out of sync with its branch, both SHAs named')
})

it('takes the --all flag as input to the agent', () => {
  expect(flat(section(AGENT, 'Your input is', '```bash'))).toContain('whether `--all`')
})

it('draws the not-ready edges in the skill flow', () => {
  const body = section(FLOW, '```mermaid', '```')
  expect(body).toContain('Not ready: named in the report with its reasons')
  expect(body).toContain('Skipped: needs an approval, or has unresolved review threads')
})

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
  // The skips of #465 name a cause too, so they are not the race.
  expect(flat(step)).toContain('"needs an approval" or "has unresolved review threads"')
})

it('sends a behind head to rebase before any wait, whatever the merge state', () => {
  // GitHub reports BLOCKED in place of BEHIND while a check is pending
  // (#460). So the compare decides first, and its rule comes before every
  // rule that sends a head to `wait`.
  const step = section(AGENT, '2. Decide from', '3. Act on the `wait` result')
  const rule = section(AGENT, '- `pr.behind` true', '- `pr.behind` null')

  expect(rule).toContain('`rebase`, then `wait`, whatever `mergeStateStatus` says')
  expect(rule).toContain('On `DIRTY`, do\n     the step 5 merge in place of the rebase')
  expect(step).toContain(
    'Never send a head with\n   `pr.behind` true to `wait` before a `rebase` or the step 5 merge',
  )
  expect(rule).toContain('Act on the `rebase` report as under `BEHIND`')
  expect(step.indexOf('- `pr.behind` true')).toBeLessThan(step.indexOf('→ `wait`'))
})

it('goes to wait on each rebase result, and never rebases again on a failed read', () => {
  const step = section(AGENT, '2. Decide from', '3. Act on the `wait` result')

  for (const result of ['moved', 'unmoved', 'up_to_date']) {
    expect(step).toContain(`- \`${result}\` → `)
  }
  expect(step).toContain('Do not rebase again before that `wait`')
  expect(step).not.toContain('make sure')
})

it('sends a behind result from wait back to step 2, and counts it toward its own skip', () => {
  const behind = flat(section(AGENT, '- `behind` → ', '4. Classify the failure'))

  expect(behind).toContain('Go back to step 2')
  expect(behind).not.toContain('the base moved')
  // Ruling 16: a `behind` after a rebase that moved the head does not count.
  // A rebase whose last read failed has no `result`, so its `behind` counts.
  expect(behind).toContain('Count a `behind` result unless the `rebase` before it returned `moved`')
  expect(behind).toContain('Stop after three counted results with no change in `pr.headRefOid`')
  expect(behind).toContain('("rebase did not move a head that stays behind its base")')
})

// --- checks that stall (#466) -------------------------------------------------

it('calls wait again on pending, and never counts pending toward a skip', () => {
  // Rule 15 (h). The script decides a stall, so a run whose checks still
  // finish is never skipped for its count of `pending` results.
  const pending = flat(section(AGENT, '- `pending` → ', '- `stalled` → '))
  expect(pending).toContain('call `wait` again')
  expect(pending).toContain('Never count `pending` results toward a skip')
  // Ruling 12: one long job moves through its steps.
  expect(pending).toContain('the stamps of the checks and of their job steps')
})

it('skips a stalled pull request, with the progress the script read', () => {
  const stalled = flat(section(AGENT, '- `stalled` → ', '- `failed` → '))
  expect(stalled).toContain(
    'no check, job or step started or finished for `progress.stall_bound` seconds',
  )
  expect(stalled).toContain('Record the pull request as skipped ("checks made no progress")')
  expect(stalled).toContain(
    '`progress.newest`, `progress.idle`, `progress.stall_bound` and `progress.source`',
  )
})

it('draws the stalled skip in the skill flow, decided by the script', () => {
  const body = section(FLOW, '```mermaid', '```')
  expect(body).toContain('W -->|Still in progress: a check, job or step started or finished| W')
  expect(body).toContain('Skipped: checks made no progress')
})

it('draws the jobs read and the head commit fallback in the shepherd-pr flow', () => {
  // Rulings 12 and 13.
  const body = section(
    path.join(FLOWS, 'gh', 'shepherd', 'shepherd-pr-flow.md'),
    '```mermaid',
    '```',
  )
  expect(body).toContain('Read the jobs of each Actions run with a pending check')
  expect(body).toContain('The newer of the head commit date and updatedAt')
  expect(body).toContain('a failed read gives no stall on this poll')
})

it('decides from the merge state when the compare could not be read', () => {
  expect(section(AGENT, '- `pr.behind` null', '- `BEHIND`')).toContain(
    'Decide from `mergeStateStatus` below',
  )
})

it('re-reads state after settle reports a moved base', () => {
  expect(section(AGENT, '- `changed` →', '- `closed` →')).toContain('Re-read `state`')
})

it('takes the base of a conflict merge from state', () => {
  const step = section(AGENT, '5. Fix in a worktree', '6. After a merge')

  expect(step).toContain('`pr.baseRefName` from `state`')
  expect(step).not.toContain('--json baseRefName')
})

it('names no checks watcher in the wait result the agent reads', () => {
  const failed = section(AGENT, '3. Act on the `wait` result', '- `merged`')

  expect(failed).toContain('the last read\n     before the bound failed')
  expect(read(AGENT)).not.toContain('watcher')
})

it('names no recreate action in the agent', () => {
  // Shepherd resolves a Dependabot conflict like any other (#346).
  expect(read(AGENT)).not.toContain('recreate')
})

it('resolves a conflict by merging the base, and forbids force', () => {
  const fix = section(AGENT, '5. Fix in a worktree', '## Report')
  const hardRules = section(AGENT, '## Hard rules', '## The loop')

  expect(fix).toContain('git merge origin/<base>')
  expect(fix).toContain('plain `git push`')
  expect(fix).toContain('Never use `--force`')
  expect(hardRules).toContain('never force')
})

it('aborts the merge and removes the fix worktree when a fix does not land', () => {
  const fix = section(AGENT, '5. Fix in a worktree', '## Report')

  expect(fix).toContain('git merge --abort')
  expect(fix).toContain('On every path, run `git worktree remove`')
})

it('reports the conflicted files and how each was resolved', () => {
  const report = section(AGENT, '## Report')

  // Once in the merged example, once in the skipped example.
  expect(occurrences(report, '"conflicts": [{"file"')).toBe(2)
  expect(report).toContain('had conflicts carries `conflicts`')
})

it('does not list conflict resolution among what the skill never does', () => {
  const never = section(SKILL, '## What this skill never does')

  expect(never).not.toContain('conflict')
  expect(never).toContain('force-push')
})

it('draws the behind edge from wait back to the decision in the shepherd diagram', () => {
  const body = section(FLOW, '```mermaid', '```')

  expect(body).toContain('W -->|Base moved: head behind| T')
  expect(body).toContain('Head behind the base, no conflict, whatever the merge state')
  expect(body).toContain('Skipped: rebase did not move a head that stays behind its base')
})

it('draws the settle branch in the shepherd diagram', () => {
  const body = section(FLOW, '```mermaid', '```')

  expect(body).toContain('Settle')
  expect(body).toContain('BEHIND or DIRTY')
})

// --- stacks (#469) ----------------------------------------------------------

it('takes a stack as one unit, serially with the other targets', () => {
  const intro = flat(section(AGENT, 'Your input is', '## Hard rules'))
  expect(intro).toContain('or `stack:<s>` for a GitHub stack')
  expect(intro).toContain('A stack is one target: take it as one unit, in its place in that order')
  const stack = flat(section(AGENT, '## A stack target', '## Report'))
  expect(stack).toContain('shepherd-stack <path> <s> state|update|wait|merge')
  for (const step of ['1. Call `state`', '2. Call `update`', '3. Call `wait`', '4. Call `merge`']) {
    expect(stack).toContain(step)
  }
})

it('allows one merge, shepherd-stack merge, and no other', () => {
  const rules = flat(section(AGENT, '## Hard rules', '## The loop'))
  expect(rules).toContain('**Never merge, never enable or disable auto-merge')
  expect(rules).toContain(
    'The one exception is `shepherd-stack merge` on a stack target. It is the only merge you run.',
  )
  const merge = flat(section(AGENT, '4. Call `merge`', '## Report'))
  expect(merge).toContain(
    "On `refused`, record it as skipped. Copy `reason` verbatim: it is gh's own words",
  )
})

it('never force pushes, a stack included', () => {
  const rules = flat(section(AGENT, '## Hard rules', '## The loop'))
  expect(rules).toContain('and never force. This holds for a stack too')
  expect(rules).toContain('never run `gh stack rebase`, `gh stack push` or `gh stack sync`')
  expect(flat(section(AGENT, '2. Call `update`', '3. Call `wait`'))).toContain(
    'a fix worktree for that layer',
  )
})

it('passes stack targets to the agent, and lists them on --dry-run', () => {
  expect(flat(section(SKILL, '## Step 2', '## Step 3'))).toContain(
    'for a stack, `stack`, `base` and `layers`',
  )
  expect(flat(section(SKILL, '## Step 3', '## Step 4'))).toContain('each stack as `stack:<s>`')
})

it('reports each layer of a stack, and the one merge exception', () => {
  const report = flat(section(SKILL, '## Step 5', '## What this skill never does'))
  expect(report).toContain('| stack s | merged | each layer and its merge commit |')
  expect(report).toContain('For a stack, name each `failing` layer and its `reasons`')
  const never = flat(section(SKILL, '## What this skill never does'))
  expect(never).toContain('The one exception is a stack')
  expect(never).toContain('force-push, a stack included')
  expect(flat(section(SKILL, 'description:', 'allowed-tools:'))).toContain(
    'except a stack with gh stack merge',
  )
})

it('draws the stack loop in the shepherd diagram', () => {
  const body = section(FLOW, '```mermaid', '```')
  expect(body).toContain('The target is a stack: one unit')
  expect(body).toContain('gh stack merge: all layers or none')
  expect(body).toContain('never a force push')
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
