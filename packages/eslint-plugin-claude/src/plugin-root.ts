// Find out if a directory is the root of a Claude Code plugin. A glob cannot
// see a sibling file, so a rule that needs plugin context asks here (ADR 005).
import { existsSync } from 'node:fs'
import path from 'node:path'

/** True when `dir` holds `.claude-plugin/plugin.json`. */
export function isPluginRoot(dir: string): boolean {
  return existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))
}
