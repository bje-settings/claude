// This file writes one line, then hands both of its streams to
// `endOnceWritten` with a grace of argv[0] milliseconds. Its `end` writes
// `ended` and exits 3. argv[1] says what holds the process open:
//
//   - `read <file>`: a read of `file`. The test passes a FIFO that no
//     process writes to, so the read never answers, as on a hung
//     filesystem.
//   - `timer`: a timer of 1 s, as a child that the deadline killed holds
//     the process while it closes.
//   - nothing: the process must exit 0 by itself, before the grace runs
//     out.
import { readFile } from 'node:fs/promises'
import { endOnceWritten } from '../../../lib/process.ts'

const [grace = '0', hold = '', file = ''] = process.argv.slice(2)
if (hold === 'read') readFile(file).catch(() => {})
if (hold === 'timer') setTimeout(() => {}, 1_000)
process.stdout.write('written\n')
endOnceWritten(
  [process.stdout, process.stderr],
  Number(grace),
  () => {
    process.stdout.write('ended\n')
    // A read that hangs blocks `process.exit`, so this ends with a signal,
    // as the hooks do.
    process.kill(process.pid, 'SIGKILL')
  },
  () => process.getActiveResourcesInfo(),
)
