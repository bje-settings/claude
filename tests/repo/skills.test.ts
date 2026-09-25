// Skill rules, across the plugins and the repo's own tooling. This is
// ported from tests/test_skills.py, itself ported from
// spec/skills_spec.sh. Every skill documents its flow, and the flow of
// each subcommand it runs, under docs/flows/ (ADR 004). It keeps the
// diagram out of SKILL.md, and spells out the scripts it runs, instead of
// stashing a command in a variable. This file globs
// for skills, rather than listing them, so a new skill is checked without
// anyone editing this file.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLOWS,
  filterUnderSkillsDir,
  flowDirFor,
  PLUGINS,
  REPO_FLOWS,
  REPO_SKILLS,
  rel,
  SKILL_FLOW,
  skillFiles,
  skillsUnder,
  subcommandsRun,
} from './repo.ts'

const MERMAID_FENCE = /^```mermaid/m

// A command held in a variable and expanded as one. zsh does not
// word-split an unquoted expansion, so `S="node ...ts"; $S sync` looks up
// the whole string as a command name, and exits 127 under the Bash tool's
// shell. Spell the script out at every call site instead. The interpreter
// half of the pattern allows digits, so it also catches `python3`.
const COMMAND_IN_A_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*="[a-z][a-z0-9]* /
// A bare expansion in command position. ${VAR} placeholders inside a
// path are fine. A lone $VAR that starts the line is the idiom this
// rejects.
const BARE_EXPANSION = /^\$[A-Za-z_][A-Za-z0-9_]* /

/** Every flow file one skill must have: its own, then one for each
 *  subcommand it runs. */
function flowsFor(skill: string): string[] {
  const dir = flowDirFor(skill)
  const subcommands = subcommandsRun(readFileSync(skill, 'utf8'))
  return [
    path.join(dir, SKILL_FLOW),
    ...subcommands.map((name) => path.join(dir, `${name}-flow.md`)),
  ]
}

/** Every Markdown file under `dir`, at any depth, except `index.md`. */
function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md')
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

it('finds skills to check', () => {
  // Without this, a glob that matches nothing makes every check below pass
  // vacuously: the "green for the wrong reason" failure this suite exists
  // to prevent.
  expect(skillFiles().length).toBeGreaterThan(0)
})

it('finds skills under the plugin root', () => {
  // The guard above only protects plugins/ while it is the sole root.
  // The moment a second root joins it, plugins/ alone still keeps the
  // combined list non-empty. So a typo in the second path would leave
  // this file green, while it enforces nothing on the skills it was
  // extended to cover. This test checks plugins/ on its own for that
  // reason.
  //
  // .claude/skills/ gets no such check. It may legitimately be empty, as
  // #128 leaves it, and skillsUnder's `optional` argument is what makes
  // that not an error (see repo.ts).
  expect(skillsUnder(PLUGINS).length).toBeGreaterThan(0)
})

it('gives every skill a flow, and a flow for each subcommand it runs', () => {
  const missing = skillFiles()
    .flatMap(flowsFor)
    .filter((flow) => !existsSync(flow))
    .map((flow) => rel(flow))
  expect(missing).toEqual([])
})

it('puts a mermaid diagram in every flow', () => {
  const without = markdownUnder(FLOWS)
    .filter((flow) => !MERMAID_FENCE.test(readFileSync(flow, 'utf8')))
    .map((flow) => rel(flow))
  expect(without).toEqual([])
})

it('keeps no flow that no skill needs', () => {
  const needed = new Set(skillFiles().flatMap(flowsFor))
  const orphans = markdownUnder(FLOWS)
    .filter((flow) => !needed.has(flow))
    .map((flow) => rel(flow))
  expect(orphans).toEqual([])
})

it('keeps no FLOW.md in a skill directory, which ships to each user', () => {
  const shipped = skillFiles()
    .map((skill) => path.join(path.dirname(skill), 'FLOW.md'))
    .filter((flow) => existsSync(flow))
    .map((flow) => rel(flow))
  expect(shipped).toEqual([])
})

it('lists every flow in the flows index', () => {
  // .claude/rules/path-docs.md: a new doc gets its row in the bundle's
  // index.md in the same change.
  const index = readFileSync(path.join(FLOWS, 'index.md'), 'utf8')
  const unlisted = markdownUnder(FLOWS)
    .filter((flow) => !index.includes(`](${path.relative(FLOWS, flow)})`))
    .map((flow) => rel(flow))
  expect(unlisted).toEqual([])
})

it('keeps the copies of one subcommand flow identical', () => {
  // A subcommand that two skills run has a copy of its flow in each skill's
  // directory. The copies describe one piece of code, so they must agree.
  const byName = new Map<string, string[]>()
  for (const flow of markdownUnder(FLOWS)) {
    if (path.basename(flow) === SKILL_FLOW) continue
    const plugin = path.relative(FLOWS, flow).split(path.sep)[0] as string
    const key = `${plugin}/${path.basename(flow)}`
    byName.set(key, [...(byName.get(key) ?? []), readFileSync(flow, 'utf8')])
  }
  const differ = [...byName].filter(([, copies]) => new Set(copies).size > 1).map(([key]) => key)
  expect(differ).toEqual([])
})

it('keeps the diagram out of SKILL.md', () => {
  // Required by .claude/rules/file-skill-md.md: SKILL.md is context on every
  // run, FLOW.md is read on demand.
  const carrying = skillFiles()
    .filter((skill) => MERMAID_FENCE.test(readFileSync(skill, 'utf8')))
    .map((skill) => rel(skill))
  expect(carrying).toEqual([])
})

it('spells out every script a skill runs', () => {
  const hits: string[] = []
  for (const skill of skillFiles()) {
    const lines = readFileSync(skill, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (COMMAND_IN_A_VARIABLE.test(line) || BARE_EXPANSION.test(line)) {
        hits.push(`${rel(skill)}:${index + 1}:${line}`)
      }
    })
  }
  expect(hits).toEqual([])
})

it('gives every repo-local skill a name, a description, and no model invocation', () => {
  // `claude plugin validate --strict` covers the plugin skills'
  // frontmatter, and never sees these. CI and the lefthook
  // `plugin-validate` step both point it at `.` and `plugins/*/` only. So
  // this test makes the checks a plugin skill gets for free.
  //
  // `disable-model-invocation` is not optional for these skills. Repo
  // tooling acts on the repository, and a skill with side effects that
  // the model can reach on its own is a side effect nobody asked for.
  const missing: string[] = []
  for (const skill of skillsUnder(REPO_SKILLS, true)) {
    const text = readFileSync(skill, 'utf8')
    if (!text.startsWith('---\n')) {
      missing.push(`${rel(skill)}: no frontmatter`)
      continue
    }
    const frontmatter = text.split('---\n', 3)[1] ?? ''
    for (const field of ['name:', 'description:', 'disable-model-invocation: true']) {
      if (!frontmatter.includes(field)) {
        missing.push(`${rel(skill)}: ${field}`)
      }
    }
  }
  expect(missing).toEqual([])
})

describe('skillsUnder filtering', () => {
  // '' rather than an unassigned `let`: if the `it` body throws before
  // mkdtempSync returns, an unguarded rmSync(undefined) here would replace
  // the real failure with its own TypeError.
  let scratch = ''

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('filters out a SKILL.md that is not under a skills/ directory', () => {
    // Coverage of skillsUnder's filter branch that the real tree never
    // exercises: every plugin's SKILL.md today already sits under a skills/
    // directory, so without a synthetic case the "not under skills/" arm
    // never runs.
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-skills-'))
    const underSkills = path.join(scratch, 'a-plugin', 'skills', 'thing')
    const notUnderSkills = path.join(scratch, 'a-plugin', 'docs')
    mkdirSync(underSkills, { recursive: true })
    mkdirSync(notUnderSkills, { recursive: true })
    writeFileSync(path.join(underSkills, 'SKILL.md'), '---\n---\n')
    writeFileSync(path.join(notUnderSkills, 'SKILL.md'), '---\n---\n')
    const found = skillsUnder(scratch).map((f) => path.relative(scratch, f))
    expect(found).toEqual([path.join('a-plugin', 'skills', 'thing', 'SKILL.md')])
  })

  it('treats a missing optional root as having no skills', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-skills-'))
    const missing = path.join(scratch, 'does-not-exist')
    expect(skillsUnder(missing, true)).toEqual([])
  })

  it('still walks an optional root that exists', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-skills-'))
    const underSkills = path.join(scratch, 'a-plugin', 'skills', 'thing')
    mkdirSync(underSkills, { recursive: true })
    writeFileSync(path.join(underSkills, 'SKILL.md'), '---\n---\n')
    expect(skillsUnder(scratch, true)).toEqual([path.join(underSkills, 'SKILL.md')])
  })

  it('throws when a required root is missing', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bje-skills-'))
    const missing = path.join(scratch, 'does-not-exist')
    expect(() => skillsUnder(missing)).toThrow()
  })

  it('returns every file found when the root is already a skills/ directory', () => {
    // REPO_SKILLS has held no skill since #128, so skillsUnder can no
    // longer reach this arm through the real constant. This test exercises
    // it directly.
    expect(filterUnderSkillsDir(['/a/b/SKILL.md'], '/a', true)).toEqual(['/a/b/SKILL.md'])
  })
})

describe('the flow paths', () => {
  it('maps a plugin skill and a repo-local skill to their flow directories', () => {
    const roots = { plugins: '/r/plugins', repoSkills: '/r/.claude/skills', flows: '/r/docs/flows' }
    expect(flowDirFor('/r/plugins/gh/skills/sync/SKILL.md', roots)).toBe('/r/docs/flows/gh/sync')
    expect(flowDirFor('/r/.claude/skills/publish/SKILL.md', roots)).toBe(
      path.join('/r/docs/flows', REPO_FLOWS, 'publish'),
    )
  })

  it('reads each subcommand a skill runs once, and no pattern or flag', () => {
    // The expansion is built, not written, so no string holds a `${` that
    // reads like a template placeholder.
    const root = `$${'{'}CLAUDE_PLUGIN_ROOT}`
    const text = [
      `allowed-tools: Bash(node "${root}/scripts/workstreams.ts" *)`,
      `node "${root}/scripts/workstreams.ts" preflight`,
      `node "${root}/scripts/workstreams.ts" pr-state <number> --json`,
      `node "${root}/scripts/workstreams.ts" preflight --json`,
      `node "${root}/scripts/mermaid.ts" --route view`,
    ].join('\n')
    expect(subcommandsRun(text)).toEqual(['pr-state', 'preflight'])
  })
})
