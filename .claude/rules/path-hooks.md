---
paths:
  - "**/hooks/**/*.ts"
  - "**/hooks/*.json"
---

# Hook Output: additionalContext vs systemMessage

A hook's JSON response can carry two different fields, to get a message to a person. They reach
the user in genuinely different ways:

- `additionalContext` (inside `hookSpecificOutput`) is inserted into the model's context only.
  It is never rendered directly. The model sees it on its next turn, and it may voice,
  paraphrase, or ignore it. The user's first input can pre-empt that turn, when they already run
  the very command the hook would have suggested. If so, the message can go completely
  unmentioned.
- `systemMessage` (top-level in the response) is rendered directly by the Claude Code CLI, as
  visible terminal output. This happens independent of whether the model ever takes a turn.

A `SessionStart` response may return both in the same payload. They are not exclusive.

Reach for `systemMessage` for anything that must reach the user, no matter what they type next.
Reach for `additionalContext` for anything meant only to help the model decide. There, the model
may paraphrase it, or silently drop it, and that is acceptable.

Reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

## Scope: terminal CLI only

This guidance targets the Claude Code terminal/CLI, which is what every plugin here targets.
VS Code's integration currently discards `systemMessage` for `SessionStart`
([anthropics/claude-code#15344](https://github.com/anthropics/claude-code/issues/15344)). That is
a gap in a different client, not a reason to avoid `systemMessage` here.
