// Writes its stdin back out unchanged. The identity function over bytes: only
// a byte that is not valid UTF-8 can show that nothing decoded it on the way
// through.
import { readFileSync } from 'node:fs'

process.stdout.write(readFileSync(0))
