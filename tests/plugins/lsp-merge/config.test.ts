import { describe, expect, it } from 'vitest'
import { configPath, loadConfig, parseConfig } from '#lsp-merge/config.ts'

// Spelled in two pieces because biome refuses `${` inside a plain string.
const PROJECT = `$${'{'}CLAUDE_PROJECT_DIR}`

const TWO_SERVERS = JSON.stringify({
  typescript7: {
    command: 'node',
    args: [`${PROJECT}/node_modules/typescript/bin/tsc`, '--lsp', '--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
  },
  biome: {
    command: `${PROJECT}/bin/biome`,
    args: ['lsp-proxy'],
    env: { BIOME_HOME: `${PROJECT}/.biome`, PLAIN: 'x' },
    extensionToLanguage: { '.ts': 'typescript', '.json': 'json' },
    initializationOptions: { a: 1 },
    settings: { b: 2 },
    restartOnCrash: true,
    startupTimeout: 5000,
  },
})

describe('parseConfig', () => {
  it('keeps entry order and puts the project directory in place of the token', () => {
    const result = parseConfig(TWO_SERVERS, '/repo')

    expect(result).toEqual({
      outcome: 'ok',
      children: [
        {
          name: 'typescript7',
          command: 'node',
          args: ['/repo/node_modules/typescript/bin/tsc', '--lsp', '--stdio'],
          env: {},
          extensionToLanguage: { '.ts': 'typescript' },
          initializationOptions: undefined,
          settings: undefined,
        },
        {
          name: 'biome',
          command: '/repo/bin/biome',
          args: ['lsp-proxy'],
          env: { BIOME_HOME: '/repo/.biome', PLAIN: 'x' },
          extensionToLanguage: { '.ts': 'typescript', '.json': 'json' },
          initializationOptions: { a: 1 },
          settings: { b: 2 },
        },
      ],
    })
  })

  it('refuses text that is not JSON', () => {
    const result = parseConfig('{', '/repo')

    expect(result.outcome).toBe('invalid')
    expect(result.outcome === 'invalid' && result.errors[0]).toMatch(/^not valid JSON: /)
  })

  it.each(['[]', '{}', '"x"', 'null'])('refuses %s, which holds no servers', (text) => {
    expect(parseConfig(text, '/repo')).toEqual({
      outcome: 'invalid',
      errors: ['must be an object with one entry for each server'],
    })
  })

  it('names each problem in each entry', () => {
    const text = JSON.stringify({
      a: 'x',
      b: { command: '', args: [1], env: { K: 2 }, extensionToLanguage: {}, extra: true },
      c: { command: 'x', extensionToLanguage: { ts: 'typescript', '.': 'x', '.ok': 'fine' } },
      d: { command: 'x', args: 'no', extensionToLanguage: { '.ts': 3 } },
    })

    expect(parseConfig(text, '/repo')).toEqual({
      outcome: 'invalid',
      errors: [
        'a: must be an object',
        'b: unknown key "extra"',
        'b: "command" must be a non-empty string',
        'b: "args" must be an array of strings',
        'b: "env" must be an object of strings',
        'b: "extensionToLanguage" must be a non-empty object of strings',
        'c: extension "ts" must start with "." (for example ".ts")',
        'c: extension "." must start with "." (for example ".ts")',
        'd: "args" must be an array of strings',
        'd: "extensionToLanguage" must be a non-empty object of strings',
      ],
    })
  })
})

describe('loadConfig', () => {
  it('reads the file at .claude/lsp-merge.json', () => {
    const read: string[] = []
    const result = loadConfig('/repo', (file) => {
      read.push(file)
      return TWO_SERVERS
    })

    expect(read).toEqual([configPath('/repo')])
    expect(configPath('/repo')).toBe('/repo/.claude/lsp-merge.json')
    expect(result.outcome).toBe('ok')
  })

  it('says a missing file is missing', () => {
    const result = loadConfig('/repo', () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })

    expect(result).toEqual({
      outcome: 'invalid',
      errors: ['/repo/.claude/lsp-merge.json is missing'],
      missing: true,
    })
  })

  it('names the code of any other read failure', () => {
    const denied = loadConfig('/repo', () => {
      throw Object.assign(new Error('no'), { code: 'EACCES' })
    })
    const unknown = loadConfig('/repo', () => {
      throw new Error('no code')
    })

    expect(denied).toEqual({
      outcome: 'invalid',
      errors: ['/repo/.claude/lsp-merge.json cannot be read (EACCES)'],
    })
    expect(unknown).toEqual({
      outcome: 'invalid',
      errors: ['/repo/.claude/lsp-merge.json cannot be read (unknown error)'],
    })
  })

  it('puts the file name in front of each validation error', () => {
    expect(loadConfig('/repo', () => '{}')).toEqual({
      outcome: 'invalid',
      errors: ['/repo/.claude/lsp-merge.json: must be an object with one entry for each server'],
    })
  })
})
