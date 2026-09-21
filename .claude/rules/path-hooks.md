---
paths:
  - "**/hooks/**/*.ts"
  - "**/hooks/**/*.py"
  - "**/hooks/*.json"
---

# Hook Output: additionalContext vs systemMessage

A hook's JSON response can carry two different fields for getting a message to a person, and
they reach the user in genuinely different ways:

- `additionalContext` (inside `hookSpecificOutput`) is inserted into the model's context only.
  It is never rendered directly; the model sees it on its next turn and may voice, paraphrase, or
  ignore it. If the user's first input pre-empts that turn -- they already run the very command
  the hook would have suggested -- the message can go completely unmentioned.
- `systemMessage` (top-level in the response) is rendered directly by the Claude Code CLI as
  visible terminal output, independent of whether the model ever takes a turn.

A `SessionStart` response may return both in the same payload; they are not exclusive.

Reach for `systemMessage` for anything that must reach the user no matter what they type next.
Reach for `additionalContext` for anything meant only to inform the model's reasoning, where being
paraphrased or silently dropped is acceptable.

Reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

## Both languages

`gh`'s hook is TypeScript (`plugins/gh/hooks/hook-io.ts`, #127); `field-test`'s is still Python
until #136. The rule above is about what a hook writes, so it holds for either.

## Scope: terminal CLI only

This guidance targets the Claude Code terminal/CLI, which is what every plugin here targets.
VS Code's integration currently discards `systemMessage` for `SessionStart`
([anthropics/claude-code#15344](https://github.com/anthropics/claude-code/issues/15344)). That is
a gap in a different client, not a reason to avoid `systemMessage` here.
