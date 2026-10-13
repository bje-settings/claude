// The output capture's claims. Without them, the capture could stop being
// the real `createOutput`, and every test built on it would still pass.
import { expect, it } from 'vitest'
import { captureOutput } from '#harness/output.ts'

it('keeps stdout and stderr apart, in write order', () => {
  const output = captureOutput()

  output.out.write('one ')
  output.err.write('problem')
  output.out.write('two')

  expect(output.stdout()).toBe('one two')
  expect(output.stderr()).toBe('problem')
})

it('starts empty', () => {
  const output = captureOutput()

  expect(output.stdout()).toBe('')
  expect(output.stderr()).toBe('')
})

it('drops what is written after silence, on both streams', () => {
  const output = captureOutput()
  output.out.write('kept')
  output.err.write('kept')

  output.silence()
  output.out.write('lost')
  output.err.write('lost')

  expect(output.out.silenced).toBe(true)
  expect(output.err.silenced).toBe(true)
  expect(output.stdout()).toBe('kept')
  expect(output.stderr()).toBe('kept')
})

it('silences one stream and leaves the other open', () => {
  const output = captureOutput()

  output.out.silence()
  output.out.write('lost')
  output.err.write('kept')

  expect(output.out.silenced).toBe(true)
  expect(output.err.silenced).toBe(false)
  expect(output.stdout()).toBe('')
  expect(output.stderr()).toBe('kept')
})

it('gives each call a capture of its own', () => {
  const first = captureOutput()
  const second = captureOutput()

  first.out.write('only here')

  expect(second.stdout()).toBe('')
})
