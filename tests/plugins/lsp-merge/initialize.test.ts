import { expect, it } from 'vitest'
import { mergeInitializeResults, TEXT_DOCUMENT_SYNC } from '#lsp-merge/initialize.ts'

it('takes each capability from the first child that declares it, and forces full sync', () => {
  const merged = mergeInitializeResults([
    {
      capabilities: {
        textDocumentSync: 2,
        hoverProvider: true,
        definitionProvider: false,
        referencesProvider: null,
        diagnosticProvider: { interFileDependencies: false },
      },
    },
    {
      capabilities: {
        textDocumentSync: { change: 2 },
        hoverProvider: { workDoneProgress: true },
        definitionProvider: true,
        documentFormattingProvider: true,
      },
    },
  ])

  expect(merged).toEqual({
    capabilities: {
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
      textDocumentSync: TEXT_DOCUMENT_SYNC,
    },
    serverInfo: { name: 'lsp-merge' },
  })
  expect(TEXT_DOCUMENT_SYNC.change).toBe(1)
})

it('reads a result with no capabilities, or no result at all, as no capabilities', () => {
  expect(mergeInitializeResults([undefined, null, {}, { capabilities: null }])).toEqual({
    capabilities: { textDocumentSync: TEXT_DOCUMENT_SYNC },
    serverInfo: { name: 'lsp-merge' },
  })
})
