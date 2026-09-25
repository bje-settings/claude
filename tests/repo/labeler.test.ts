// The labeler config (.github/labeler.yml) must have one rule for each
// plugin. The enterprise ruleset "Labeler" runs bje-actions/labeler on
// every pull request, and that workflow labels a pull request only by
// the rules in this file. A plugin with no rule gets no label, and
// nothing else reports it. So this test does.
//
// The file is YAML, and this repository has no YAML parser. The test
// reads the lines it needs by pattern. It requires each rule in one
// fixed shape: the label key, then one brace pattern on the
// `any-glob-to-any-file` line. A rule in another shape fails the test.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { PLUGINS, ROOT } from './repo.ts'

const CONFIG = path.join(ROOT, '.github', 'labeler.yml')

/** The pattern for one plugin: its source, its tests and its flows. */
const expectedGlob = (plugin: string): string => `{plugins,tests/plugins,docs/flows}/${plugin}/**`

/** Each `plugin:<name>` rule in the config, with its one glob. */
const rules = (body: string): Map<string, string> => {
  const found = new Map<string, string>()
  const lines = body.split('\n')
  lines.forEach((line, index) => {
    const plugin = /^"plugin:([a-z0-9-]+)":$/.exec(line)?.[1]
    if (plugin === undefined) return
    const glob = /^ {6}- any-glob-to-any-file: "(.+)"$/.exec(lines[index + 2] ?? '')?.[1]
    expect(glob, `plugin:${plugin}: expected one any-glob-to-any-file line`).toBeDefined()
    found.set(plugin, glob ?? '')
  })
  return found
}

const plugins = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

it('finds plugins and rules to compare', () => {
  expect(plugins.length).toBeGreaterThan(0)
  expect(rules(readFileSync(CONFIG, 'utf8')).size).toBeGreaterThan(0)
})

it.each(plugins)('labels pull requests that change the %s plugin', (plugin) => {
  const found = rules(readFileSync(CONFIG, 'utf8'))
  expect(found.get(plugin), `.github/labeler.yml has no "plugin:${plugin}" rule`).toBe(
    expectedGlob(plugin),
  )
})

it('gives every rule the full pattern for its own plugin', () => {
  for (const [plugin, glob] of rules(readFileSync(CONFIG, 'utf8'))) {
    expect(glob, `plugin:${plugin}`).toBe(expectedGlob(plugin))
  }
})
