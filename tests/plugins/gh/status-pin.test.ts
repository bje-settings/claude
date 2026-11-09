// The decisions of the gh hooks module, in process (#488). The module itself
// runs under `claude plugin test` (`register.test.tsx`). These functions are
// in `src/`, so vitest measures them.
import { expect, it } from 'vitest'
import {
  changesCounts,
  failureText,
  outcomeOf,
  pinnedText,
  REFRESH_MS,
  RUN_TIMEOUT_MS,
} from '#gh/status-pin.ts'

it('pins the status line, then each problem without a second prefix, on one line', () => {
  expect(
    pinnedText(
      'gh: [repos: 2] [behind]\ngh: ⚠️ fetch failed in 2 repos: Invalid username or token\ngh: ⚠️ GitHub request failed\n',
    ),
  ).toBe(
    'gh: [repos: 2] [behind] ⚠️ fetch failed in 2 repos: Invalid username or token ⚠️ GitHub request failed',
  )
})

it('pins a problem line alone when there is no status line', () => {
  expect(pinnedText('gh: ⚠️ git not found on PATH\n')).toBe('gh: ⚠️ git not found on PATH')
})

it('keeps a later line that has no prefix as it is', () => {
  expect(pinnedText('gh: [behind]\nsomething else\n')).toBe('gh: [behind] something else')
})

it('clears the line for an output with no text', () => {
  expect(pinnedText('')).toBeUndefined()
  expect(pinnedText('\n  \n')).toBeUndefined()
})

it('refreshes after a git or gh command, and after the sync of this plugin', () => {
  for (const command of [
    'git pull',
    '  git fetch --prune',
    'git',
    'gh pr merge 12',
    'gh\tissue list',
    'node "/home/me/.claude/plugins/gh/scripts/gh.ts" sync',
    'node /home/me/plugins/gh/scripts/gh.ts sync --dry-run',
    'node "/p/scripts/gh.ts" sync-repo /a/repo',
  ]) {
    expect([command, changesCounts(command)]).toEqual([command, true])
  }
})

it('does not refresh after any other command', () => {
  for (const command of [
    'ls -la',
    'echo git pull',
    'gitk',
    'ghq list',
    'cd repo && git pull',
    'node scripts/other.ts sync',
    'node "/p/scripts/gh.ts" issues',
    'node "/p/scripts/gh.ts" syncer',
    '',
  ]) {
    expect([command, changesCounts(command)]).toEqual([command, false])
  }
})

it('names the exit code and the first line of stderr for a failed exit', () => {
  expect(failureText({ exitCode: 2, stderr: 'usage: hook-io.ts\nmore\n' })).toBe(
    'gh: the status check failed with exit 2: usage: hook-io.ts',
  )
  expect(failureText({ exitCode: 1, stderr: '  \n' })).toBe(
    'gh: the status check failed with exit 1',
  )
})

it('names the reason a run did not start', () => {
  expect(failureText({ error: new Error('spawn node ENOENT') })).toBe(
    'gh: the status check could not run: spawn node ENOENT',
  )
  expect(failureText({ error: 'timed out' })).toBe('gh: the status check could not run: timed out')
})

it('refreshes every five minutes, and gives a run 15 seconds', () => {
  expect(REFRESH_MS).toBe(300_000)
  expect(RUN_TIMEOUT_MS).toBe(15_000)
})

it('pins the stdout of an exit 0, and clears the line for an empty one', () => {
  expect(outcomeOf({ exitCode: 0, stdout: 'gh: [behind]\n', stderr: 'a cause\n' })).toEqual({
    kind: 'pin',
    text: 'gh: [behind]',
  })
  expect(outcomeOf({ exitCode: 0, stdout: '', stderr: '' })).toEqual({
    kind: 'pin',
    text: undefined,
  })
})

it('pins a line that a run wrote before a signal ended it, as exit 1', () => {
  expect(outcomeOf({ exitCode: 1, stdout: 'gh: [✂️ 2]\n', stderr: '' })).toEqual({
    kind: 'pin',
    text: 'gh: [✂️ 2]',
  })
})

it('fails a run that exits non-zero with no line', () => {
  expect(outcomeOf({ exitCode: 1, stdout: '\n', stderr: 'Error: ENOENT\n    at x\n' })).toEqual({
    kind: 'failed',
    text: 'gh: the status check failed with exit 1: Error: ENOENT',
  })
})
