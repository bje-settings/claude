// This file writes one line, then hands both of its streams to
// `endOnceWritten` with a grace of argv[0] milliseconds. Its `end` writes
// `ended` and exits 3. With argv[1] set to `held`, an interval holds the
// process open, the way a hung read does in a hook. Otherwise nothing
// holds it, and it must exit 0 by itself, before the grace runs out.
import { endOnceWritten } from '../../../lib/process.ts'

const graceMs = Number(process.argv[2])
if (process.argv[3] === 'held') setInterval(() => {}, 1_000)
process.stdout.write('written\n')
endOnceWritten([process.stdout, process.stderr], graceMs, () => {
  process.stdout.write('ended\n')
  process.exit(3)
})
