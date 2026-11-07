// Run the tests of each function-hooks plugin with `claude plugin test`
// (ADR 007):
//
//   node scripts/plugin-test.ts            # each plugin whose hooks.json has `modules`
//   node scripts/plugin-test.ts <plugin>   # that plugin only
//
// `claude plugin test` runs the `*.test.ts` and `*.test.tsx` files under one
// folder. Every test here lives under `tests/`, outside the plugin (ADR
// 004), so this script builds that folder. It copies the plugin, and puts
// the plugin's `tests/plugins/<plugin>/**/*.test.tsx` files in its `tests/`
// directory. It removes the folder when the run ends, also when it fails.
//
// Exit codes and output are a contract:
//
// - Exit 0: each run passed, or no plugin has `modules`. Then one line on
//   stdout says so.
// - The exit status of `claude plugin test`, when it is not 0. When
//   several plugins run, it is the first status that is not 0. The output of
//   `claude` goes to the same streams, without a change.
// - Exit 2: an unknown plugin, a stray argument or flag, or a node with no
//   `import.meta.main`. Stderr has the usage line.
//
// This is a root script, not a plugin file (`CLAUDE.md`). It reads the
// repository by path. It needs `claude` on `PATH` and nothing else.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseCommandLine } from '../lib/args.ts'
import { EXIT_CODES, refused, renderText } from '../lib/envelope.ts'
import { pluginNames } from './sync-lib.ts'

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, '..')

const USAGE = 'usage: node scripts/plugin-test.ts [<plugin>]'

/** What the script writes and sets its status on. */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Run `claude plugin test` on one folder, and answer its exit status. */
export type Runner = (folder: string) => number

/**
 * The real runner. It names `claude` by `PATH`. A `claude` that cannot
 * start gives no status, and a status of 0 would hide that. So this answers
 * 1 for a launch error or a signal.
 */
export const runClaude: Runner = (folder) => {
  const result = spawnSync('claude', ['plugin', 'test', folder], { stdio: 'inherit' })
  return result.status ?? 1
}

/** True when the plugin's `hooks/hooks.json` has a `modules` key. */
const hasModules = (root: string, plugin: string): boolean => {
  const file = path.join(root, 'plugins', plugin, 'hooks', 'hooks.json')
  if (!existsSync(file)) return false
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return typeof parsed === 'object' && parsed !== null && 'modules' in parsed
}

/** Each `*.test.tsx` under `dir`, as a path relative to `dir`. */
const testFilesUnder = (dir: string, prefix = ''): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...testFilesUnder(path.join(dir, entry.name), relative))
    else if (entry.name.endsWith('.test.tsx')) found.push(relative)
  }
  return found
}

/** Build the folder for one plugin, run `claude` on it, and remove it. */
const runPlugin = (root: string, plugin: string, run: Runner): number => {
  const folder = mkdtempSync(path.join(tmpdir(), 'bje-plugin-test-'))
  try {
    cpSync(path.join(root, 'plugins', plugin), folder, { recursive: true })
    const testDir = path.join(root, 'tests', 'plugins', plugin)
    if (existsSync(testDir)) {
      for (const file of testFilesUnder(testDir)) {
        const target = path.join(folder, 'tests', file)
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(path.join(testDir, file), target)
      }
    }
    return run(folder)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** The command function: arguments in, a `Result` out. */
export const pluginTest = (argv: readonly string[], root: string, run: Runner): Result => {
  const parsed = parseCommandLine(argv, {})
  if (parsed.outcome !== 'ok') return renderText(parsed)
  const [wanted, ...stray] = parsed.value.positionals
  const known = pluginNames(root)
  if (stray.length > 0 || (wanted !== undefined && !known.includes(wanted))) {
    const reason = wanted !== undefined && stray.length === 0 ? `unknown plugin ${wanted}\n` : ''
    return renderText(refused(`${reason}${USAGE}`))
  }
  const plugins = wanted === undefined ? known.filter((p) => hasModules(root, p)) : [wanted]
  if (plugins.length === 0) {
    return { stdout: 'plugin-test: no plugin has hooks modules', stderr: '', exitCode: 0 }
  }
  let exitCode = 0
  for (const plugin of plugins) {
    const status = runPlugin(root, plugin, run)
    if (exitCode === 0) exitCode = status
  }
  return { stdout: '', stderr: '', exitCode }
}

/** What the entry writes to and sets its status on: `process` itself. */
export interface Host {
  readonly stdout: { write(text: string): unknown }
  readonly stderr: { write(text: string): unknown }
  exitCode?: number | string | null | undefined
}

/**
 * The thin entry. An import from a test passes `false`, so the import runs
 * nothing. A node with no `import.meta.main` passes `undefined`. Then the
 * entry refuses, because a silent exit 0 would read as "all tests pass".
 */
export const entry = (
  isMain: boolean | undefined,
  argv: readonly string[],
  root: string,
  host: Host,
  run: Runner = runClaude,
): void => {
  if (isMain === false) return
  if (isMain === undefined) {
    host.stderr.write(
      'plugin-test: this node has no import.meta.main; run it on node 22.18 or newer\n',
    )
    host.exitCode = EXIT_CODES.refused
    return
  }
  const result = pluginTest(argv, root, run)
  if (result.stdout !== '') host.stdout.write(`${result.stdout}\n`)
  if (result.stderr !== '') host.stderr.write(`${result.stderr}\n`)
  host.exitCode = result.exitCode
}

entry(import.meta.main, process.argv.slice(2), ROOT, process)
