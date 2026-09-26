// A local task that throws. Only discovery can throw: it calls
// `realpathSync` after its own directory check. This file makes that call
// throw for one path, so the hook's `check failed` kind has a test.
import { mkdirSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createGhMock } from '#harness/gh.ts'
import { createRig, statusOf } from './hook-io.test-support.ts'

const refused = vi.hoisted(() => ({ path: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const realpathSync = Object.assign(
    (target: Parameters<typeof real.realpathSync>[0], options?: BufferEncoding) => {
      if (target === refused.path) throw new Error('EIO: i/o error, realpath')
      return real.realpathSync(target, options)
    },
    { native: real.realpathSync.native },
  )
  return { ...real, realpathSync }
})

it('warns when a local check throws', async () => {
  const rig = createRig()
  refused.path = rig.sandbox.join('folder')
  mkdirSync(refused.path)

  const ran = await statusOf(rig, refused.path, createGhMock())

  expect(ran).toEqual({
    status: 0,
    stdout: 'gh: ⚠️ check failed: EIO: i/o error, realpath\n',
    stderr: `${refused.path}: Error: EIO: i/o error, realpath\n`,
  })
})
