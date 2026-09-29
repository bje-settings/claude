import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '#eslint-plugin-claude/data/hook-events.ts'
import { distance, nearMiss, rule } from '#eslint-plugin-claude/rules/hooks-event-name-known.ts'
import { json5Tester, jsonTester } from '../rule-tester.test-support.ts'

const hooks = (...events: string[]) =>
  JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, []])) })

describe('HOOK_EVENTS', () => {
  it('holds the 33 documented events, each once', () => {
    expect(HOOK_EVENTS).toHaveLength(33)
    expect(new Set(HOOK_EVENTS).size).toBe(33)
  })
})

describe('distance', () => {
  it('counts the edits between two strings', () => {
    expect(distance('stop', 'stop')).toBe(0)
    expect(distance('stop', 'stp')).toBe(1)
    expect(distance('', 'ab')).toBe(2)
    expect(distance('kitten', 'sitting')).toBe(3)
  })
})

describe('nearMiss', () => {
  it('finds a case or separator miss', () => {
    expect(nearMiss('preToolUse', HOOK_EVENTS)).toBe('PreToolUse')
    expect(nearMiss('pre_tool_use', HOOK_EVENTS)).toBe('PreToolUse')
    expect(nearMiss('session-start', HOOK_EVENTS)).toBe('SessionStart')
  })

  it('finds a spelling miss of two edits or fewer', () => {
    expect(nearMiss('PreToolUs', HOOK_EVENTS)).toBe('PreToolUse')
    expect(nearMiss('SesionStrt', HOOK_EVENTS)).toBe('SessionStart')
  })

  it('finds nothing for a name far from every event', () => {
    expect(nearMiss('Bogus', HOOK_EVENTS)).toBeNull()
  })
})

jsonTester.run('hooks-event-name-known', rule as never, {
  valid: [
    { code: hooks(...HOOK_EVENTS) },
    { code: JSON.stringify({ description: 'no hooks' }) },
    { code: JSON.stringify({ hooks: './hooks/other.json' }) },
    { code: '[]' },
    { code: hooks('FutureEvent'), options: [{ additionalEvents: ['FutureEvent'] }] },
  ],
  invalid: [
    {
      code: hooks('SessionStart', 'preToolUse'),
      errors: [
        {
          messageId: 'nearMiss',
          data: { key: 'preToolUse', event: 'PreToolUse' },
          suggestions: [
            {
              messageId: 'rename',
              data: { event: 'PreToolUse' },
              output: hooks('SessionStart', 'PreToolUse'),
            },
          ],
        },
      ],
    },
    {
      code: hooks('Bogus'),
      errors: [{ messageId: 'unknown', data: { key: 'Bogus' }, suggestions: [] }],
    },
  ],
})

// JSON5 allows a bare key. The rule reads it the same way.
json5Tester.run('hooks-event-name-known (JSON5)', rule as never, {
  valid: [{ code: '{ hooks: { Stop: [] } }' }],
  invalid: [{ code: '{ hooks: { Bogus: [] } }', errors: [{ messageId: 'unknown' }] }],
})
