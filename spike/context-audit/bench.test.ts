import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agreement, stride } from './bench.ts'

test('stride spans the input and never repeats or overruns an index', () => {
  const items = Array.from({ length: 23 }, (_, i) => i)
  const picked = stride(items, 5)
  assert.equal(picked.length, 5)
  assert.equal(new Set(picked).size, 5)
  assert.equal(picked[0], 0)
  assert.ok((picked[4] as number) <= 22)
  assert.deepEqual(stride([1, 2], 5), [1, 2])
})

test('agreement counts ids missing on either side instead of hiding them', () => {
  const x = { a: 'k', b: 'k', c: 'k' }
  const y = { a: 'k', b: 'j', d: 'k' }
  assert.deepEqual(agreement(x, y), { same: 1, both: 2, onlyX: 1, onlyY: 1 })
  assert.deepEqual(
    agreement({ a: { kind: 'x' } }, { a: { kind: 'x' } }, (v) => (v as { kind: string }).kind),
    { same: 1, both: 1, onlyX: 0, onlyY: 0 },
  )
})
