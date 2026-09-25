// Paths into the plugins, for a test that runs a plugin's script or hook as
// its own process. The tests live under `tests/`, outside every plugin
// (ADR 004), so a test reaches a plugin file through this module and not
// through `..` steps from its own directory. An import goes through the
// `#<plugin>/*` aliases in the root `package.json` instead.
import path from 'node:path'

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, '..')

/** A file inside `plugins/<plugin>/`, such as `scripts/gh.ts`. */
export const pluginFile = (plugin: string, ...parts: string[]): string =>
  path.join(ROOT, 'plugins', plugin, ...parts)
