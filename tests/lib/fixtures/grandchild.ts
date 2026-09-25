// The grandchild of lib/fixtures/spawn-sleeper.ts. See that file.
import { writeFileSync } from 'node:fs'

const marker = process.argv[2] ?? ''
writeFileSync(`${marker}.started`, 'started')
setTimeout(() => {
  writeFileSync(`${marker}.survived`, 'survived')
}, 5_000)
