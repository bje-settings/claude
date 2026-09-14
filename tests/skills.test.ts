// Skill rules, across the plugins and the repo's own tooling. Ported from
// tests/test_skills.py, itself ported from spec/skills_spec.sh: every skill
// documents its flow in a sibling FLOW.md, keeps the diagram out of
// SKILL.md, and spells out the scripts it runs rather than stashing a
// command in a variable. Globs rather than listing skills, so a new skill is
// checked without anyone editing this file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_SKILLS, rel, SKILL_ROOTS, skillFiles, skillsUnder } from './repo.ts'

const MERMAID_FENCE = /^```mermaid/m

// A command held in a variable and expanded as one. zsh does not word-split
// an unquoted expansion, so `S="python3 ...py"; $S show` looks up the whole
// string as a command name and exits 127 under the Bash tool's shell. Spell
// the script out at every call site instead. The interpreter half of the
// pattern allows digits, so `python3` is caught.
const COMMAND_IN_A_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*="[a-z][a-z0-9]* /
// A bare expansion in command position. ${VAR} placeholders inside a path are
// fine; a lone $VAR starting the line is the idiom this rejects.
const BARE_EXPANSION = /^\$[A-Za-z_][A-Za-z0-9_]* /

function flowPath(skill: string): string {
  return path.join(path.dirname(skill), 'FLOW.md')
}

it('finds skills to check', () => {
  // Without this, a glob that matches nothing makes every check below pass
  // vacuously -- the "green for the wrong reason" failure this suite exists
  // to prevent.
  expect(skillFiles().length).toBeGreaterThan(0)
})

it('finds skills under each root it claims to check', () => {
  // The guard above stops protecting a root the moment there are two of
  // them: plugins/ alone keeps the combined list non-empty, so a typo in the
  // second path would leave this file green while enforcing nothing on the
  // skills it was extended to cover. Each root is asserted on its own.
  const empty = SKILL_ROOTS.filter((root) => skillsUnder(root).length === 0).map((root) =>
    rel(root),
  )
  expect(empty).toEqual([])
})

it('gives every skill a FLOW.md beside its SKILL.md', () => {
  const missing = skillFiles()
    .filter((skill) => !existsSync(flowPath(skill)))
    .map((skill) => rel(skill))
  expect(missing).toEqual([])
})

it('puts a mermaid diagram in every FLOW.md', () => {
  const without: string[] = []
  for (const skill of skillFiles()) {
    const flow = flowPath(skill)
    if (!existsSync(flow)) continue
    if (!MERMAID_FENCE.test(readFileSync(flow, 'utf8'))) {
      without.push(rel(flow))
    }
  }
  expect(without).toEqual([])
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
  // `claude plugin validate --strict` covers the plugin skills' frontmatter
  // and never sees these: CI and the pre-commit hook both point it at `.`
  // and `plugins/*/` only. So the checks a plugin skill gets for free are
  // made here instead.
  //
  // disable-model-invocation is not optional for these. Repo tooling acts on
  // the repository, and a skill with side effects that the model can reach
  // on its own is a side effect nobody asked for.
  const missing: string[] = []
  for (const skill of skillsUnder(REPO_SKILLS)) {
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
  let scratch: string

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
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
})
