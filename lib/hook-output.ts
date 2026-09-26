// This file writes the JSON a `SessionStart` hook returns
// (`.claude/rules/path-hooks.md`, https://code.claude.com/docs/en/hooks).
// It moved here from the gh plugin (round 10 plan, ruling P1), with the
// plugin prefix as a parameter, so a later hook uses it with no copy of
// its own.
//
// `systemMessage` is a top-level field. The CLI renders it directly, under
// its own `SessionStart:<source> says:` label, which no hook can hide. So
// the message starts with a newline, and the first line of real content
// starts a line of its own.
//
// `additionalContext` sits inside `hookSpecificOutput` instead. It reaches
// the model only, on its next turn, and never the terminal. `emit` leaves
// it out of the payload entirely when the caller gives none, so the gh
// hook's happy-path bytes do not change (round 10 plan).

/** SGR codes. The CLI keeps them in `systemMessage`. */
const SGR = {
  bold: '\u001b[1m',
  normal: '\u001b[22m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  reset: '\u001b[0m',
} as const

/**
 * One line of the message, in colour, with `<prefix>:` in bold. A problem
 * line (`<prefix>: ⚠️ ...`) is yellow. A status line (`<prefix>: ...`) is
 * cyan. A line with no `<prefix>:` at the start stays plain.
 */
export const colour = (prefix: string, line: string): string => {
  const start = `${prefix}: `
  if (!line.startsWith(start)) return line
  const tint = line.startsWith(`${prefix}: ⚠️ `) ? SGR.yellow : SGR.cyan
  return `${tint}${SGR.bold}${prefix}:${SGR.normal}${line.slice(start.length - 1)}${SGR.reset}`
}

/**
 * The response a `SessionStart` hook writes: one JSON document on one
 * line. `line` may hold several lines of its own, joined by `\n`; each one
 * is coloured on its own. `additionalContext`, when given, names which
 * items are absent and that the plugin cannot run; left out, the payload
 * carries no `hookSpecificOutput` at all.
 */
export const emit = (prefix: string, line: string, additionalContext?: string): string => {
  const payload: Record<string, unknown> = {
    systemMessage: `\n${line
      .split('\n')
      .map((one) => colour(prefix, one))
      .join('\n')}`,
  }
  if (additionalContext !== undefined) {
    payload.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext }
  }
  return `${JSON.stringify(payload)}\n`
}
