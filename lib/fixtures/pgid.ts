// Prints this process's process-group id, for `process.test.ts`'s check that
// only a BOUNDED child is detached. node exposes no getpgid, so `ps` answers
// it; both CI (ubuntu) and a developer machine (macOS) carry `-o pgid=`.
import { execFileSync } from 'node:child_process'

process.stdout.write(
  execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    .toString()
    .trim(),
)
