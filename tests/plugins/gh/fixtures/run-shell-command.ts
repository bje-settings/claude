// This fixture runs one `SessionStart` entry's command through a shell,
// the way Claude Code runs it. `hook.test.ts` uses it to prove the
// fallback the command string itself carries: with `node` off `PATH`,
// `command -v node` fails, and the command's own `|| printf ...` branch
// writes the alert, with no real hook process started.
//
// argv: the `hooks.json` path to read the command from.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface HooksConfig {
  readonly hooks: { readonly SessionStart: { readonly hooks: { command: string }[] }[] }
}

const [hooksJson = ''] = process.argv.slice(2)
const config = JSON.parse(readFileSync(hooksJson, 'utf8')) as HooksConfig
const command = config.hooks.SessionStart[0]?.hooks[0]?.command ?? ''
process.stdout.write(execFileSync('sh', ['-c', command], { env: process.env }))
