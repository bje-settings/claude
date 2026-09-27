// This tests the output a `SessionStart` hook writes back to the CLI
// (`.claude/rules/path-hooks.md`). `emit` and `colour` moved here from the
// gh hook (round 10 plan ruling P1). So a later hook uses them, with no
// copy of its own. Every case is pinned byte for byte: the CLI renders
// `systemMessage` directly, so a stray character shows in a real terminal.
import { describe, expect, it } from 'vitest'

import { colour, emit } from '#lib/hook-output.ts'

describe('colour', () => {
  it('leaves a line with no prefix untouched', () => {
    expect(colour('gh', 'not a gh line')).toBe('not a gh line')
  })

  it('tints a status line cyan, with the prefix bold', () => {
    expect(colour('gh', 'gh: [behind]')).toBe('\u001b[36m\u001b[1mgh:\u001b[22m [behind]\u001b[0m')
  })

  it('tints a problem line yellow, with the prefix bold', () => {
    expect(colour('gh', 'gh: ⚠️ git not found on PATH')).toBe(
      '\u001b[33m\u001b[1mgh:\u001b[22m ⚠️ git not found on PATH\u001b[0m',
    )
  })

  it('uses the prefix it is given, not a fixed one', () => {
    expect(colour('workstreams', 'workstreams: [state]')).toBe(
      '\u001b[36m\u001b[1mworkstreams:\u001b[22m [state]\u001b[0m',
    )
    expect(colour('workstreams', 'gh: [behind]')).toBe('gh: [behind]')
  })
})

describe('emit', () => {
  it('wraps one line as systemMessage, starting on a new line, with no additionalContext', () => {
    expect(emit('gh', 'gh: [behind]')).toBe(
      '{"systemMessage":"\\n\\u001b[36m\\u001b[1mgh:\\u001b[22m [behind]\\u001b[0m"}\n',
    )
  })

  it('colours each line of a multi-line message on its own', () => {
    const line = 'gh: [behind]\ngh: ⚠️ git not found on PATH'
    expect(emit('gh', line)).toBe(
      '{"systemMessage":"\\n\\u001b[36m\\u001b[1mgh:\\u001b[22m [behind]\\u001b[0m\\n' +
        '\\u001b[33m\\u001b[1mgh:\\u001b[22m ⚠️ git not found on PATH\\u001b[0m"}\n',
    )
  })

  it('adds hookSpecificOutput.additionalContext when given one', () => {
    expect(
      emit('gh', 'gh: ⚠️ git not found on PATH', 'git is absent. The gh plugin cannot run.'),
    ).toBe(
      '{"systemMessage":"\\n\\u001b[33m\\u001b[1mgh:\\u001b[22m ⚠️ git not found on PATH\\u001b[0m",' +
        '"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":' +
        '"git is absent. The gh plugin cannot run."}}\n',
    )
  })

  it('leaves additionalContext out of the payload when none is given, byte for byte', () => {
    expect(emit('gh', 'gh: [behind]')).not.toContain('hookSpecificOutput')
  })
})
