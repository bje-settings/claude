// The one entry point for `/mermaid:view`. The floor check is first, and it
// is the only static import: `import` declarations are hoisted and
// evaluated before any statement here runs, so a second static import would
// load its whole module graph on the runtime this guard exists to refuse
// (lib/README.md, lib/node-floor.ts). Everything else is reached by `await
// import` after the check has passed.
//
// This file ships. It holds no decisions: `src/url.ts` is the seam a test
// reaches without a process, and this adapter only turns `process.argv` and
// stdin into its arguments, and its envelope into an exit code and a
// stream, the way `spawn.ts`'s one contract test exercises it.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { readFileSync } = await import('node:fs')
const { renderText } = await import('../src/lib/envelope.ts')
const { runMermaidUrl } = await import('../src/url.ts')

// Descriptor 0, read whole and synchronously: the diagram source is never
// streamed, since it has to be complete before it can be compressed, and
// every other seam in this plugin is synchronous too. No encoding is given,
// so this is the raw bytes `runMermaidUrl` decodes itself; decoding here
// would turn an invalid byte into a thrown exception this adapter would then
// have to catch, which is a decision `url.ts` already owns.
const stdinBytes = readFileSync(0)

const rendered = renderText(runMermaidUrl(process.argv.slice(2), stdinBytes))
if (rendered.stdout !== '') process.stdout.write(`${rendered.stdout}\n`)
if (rendered.stderr !== '') process.stderr.write(`${rendered.stderr}\n`)
process.exitCode = rendered.exitCode
