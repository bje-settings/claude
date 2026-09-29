import { expect, it } from 'vitest'
import { createDiagnosticStore, fileKey } from '#lsp-merge/diagnostics.ts'

const A = 'file:///repo/a.ts'
const B = 'file:///repo/b.ts'
const diagnostic = (message: string, source?: string) =>
  source === undefined ? { message } : { message, source }

it('pushes the union of the last list from each child for the file', () => {
  const store = createDiagnosticStore()

  expect(store.update('typescript7', { uri: A, diagnostics: [diagnostic('type', 'ts')] })).toEqual({
    uri: A,
    diagnostics: [diagnostic('type', 'ts')],
  })
  expect(store.update('biome', { uri: A, diagnostics: [diagnostic('lint', 'biome')] })).toEqual({
    uri: A,
    diagnostics: [diagnostic('type', 'ts'), diagnostic('lint', 'biome')],
  })
})

it("replaces a child's earlier list, and an empty push clears only that child", () => {
  const store = createDiagnosticStore()
  store.update('typescript7', { uri: A, diagnostics: [diagnostic('old', 'ts')] })
  store.update('biome', { uri: A, diagnostics: [diagnostic('lint', 'biome')] })

  expect(store.update('typescript7', { uri: A, diagnostics: [] })).toEqual({
    uri: A,
    diagnostics: [diagnostic('lint', 'biome')],
  })
})

it('keeps each file apart', () => {
  const store = createDiagnosticStore()
  store.update('biome', { uri: A, diagnostics: [diagnostic('in a', 'biome')] })

  expect(store.update('biome', { uri: B, diagnostics: [diagnostic('in b', 'biome')] })).toEqual({
    uri: B,
    diagnostics: [diagnostic('in b', 'biome')],
  })
})

it('uses the child name as the source when the child gives none', () => {
  const store = createDiagnosticStore()

  expect(
    store.update('biome', {
      uri: A,
      diagnostics: [diagnostic('no source'), diagnostic('empty', '')],
    }),
  ).toEqual({
    uri: A,
    diagnostics: [diagnostic('no source', 'biome'), diagnostic('empty', 'biome')],
  })
})

it('keys one file by its path, however a server spells the URI', () => {
  expect(fileKey('file:///repo/%40bje/a.ts')).toBe(fileKey('file:///repo/@bje/a.ts'))
  expect(fileKey('file:///C:/repo/a.ts')).toBe(fileKey('file:///c%3A/repo/a.ts'))
  expect(fileKey('untitled:1')).toBe('untitled:1')
})

it("joins two spellings of one file, and publishes under Claude Code's URI", () => {
  const store = createDiagnosticStore()
  store.open('file:///repo/%40bje/a.ts')
  store.update('typescript7', {
    uri: 'file:///repo/%40bje/a.ts',
    diagnostics: [diagnostic('type', 'ts')],
  })

  expect(
    store.update('biome', {
      uri: 'file:///repo/@bje/a.ts',
      diagnostics: [diagnostic('lint', 'biome')],
    }),
  ).toEqual({
    uri: 'file:///repo/%40bje/a.ts',
    diagnostics: [diagnostic('type', 'ts'), diagnostic('lint', 'biome')],
  })
})

it('forgets every list for a file', () => {
  const store = createDiagnosticStore()
  store.update('typescript7', { uri: A, diagnostics: [diagnostic('old', 'ts')] })
  store.forget(A)

  expect(store.update('biome', { uri: A, diagnostics: [] })).toEqual({ uri: A, diagnostics: [] })
})
