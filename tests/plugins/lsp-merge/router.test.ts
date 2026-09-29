import { describe, expect, it } from 'vitest'
import { claimants, extensionOf, languageIdFor } from '#lsp-merge/router.ts'

const TYPESCRIPT = { name: 'typescript7', extensionToLanguage: { '.ts': 'typescript' } }
const BIOME = { name: 'biome', extensionToLanguage: { '.ts': 'ts-biome', '.json': 'json' } }

describe('extensionOf', () => {
  it.each([
    ['file:///repo/src/a.ts', '.ts'],
    ['file:///repo/a.test.ts', '.ts'],
    ['file:///repo/My%20File.json', '.json'],
    ['file:///repo/Makefile', ''],
    ['file:///repo/.env', ''],
    ['file:///repo/dir.d/', ''],
    ['not a uri', ''],
  ])('%s has extension %j', (uri, extension) => {
    expect(extensionOf(uri)).toBe(extension)
  })
})

describe('claimants', () => {
  it('lists every child that claims the extension, in config order', () => {
    expect(claimants([TYPESCRIPT, BIOME], 'file:///repo/a.ts')).toEqual([TYPESCRIPT, BIOME])
    expect(claimants([BIOME, TYPESCRIPT], 'file:///repo/a.ts')).toEqual([BIOME, TYPESCRIPT])
    expect(claimants([TYPESCRIPT, BIOME], 'file:///repo/a.json')).toEqual([BIOME])
  })

  it('lists nothing for a file no child claims, or a file with no extension', () => {
    expect(claimants([TYPESCRIPT, BIOME], 'file:///repo/a.py')).toEqual([])
    expect(claimants([TYPESCRIPT, BIOME], 'file:///repo/Makefile')).toEqual([])
  })

  it('does not read a key from the object prototype as a claim', () => {
    expect(claimants([TYPESCRIPT], 'file:///repo/a.constructor')).toEqual([])
  })
})

describe('languageIdFor', () => {
  it("gives the id from the child's own map", () => {
    expect(languageIdFor(TYPESCRIPT, 'file:///repo/a.ts')).toBe('typescript')
    expect(languageIdFor(BIOME, 'file:///repo/a.ts')).toBe('ts-biome')
  })
})
