# Sizing a stream

Pick the smallest model and effort that can do the work without a second attempt. The cost of
under-sizing is a failed or paused stream and a rerun; the cost of over-sizing is only tokens.
Record the choice and the reason in the plan so the user can override it.

| Stream shape | Model | Effort | Typical issues |
| --- | --- | --- | --- |
| Mechanical: rename, config, pin a version, move a file, apply a documented pattern | `haiku` | `low` | chore, docs, dependency bumps with a clear target |
| Ordinary: a bug with a known cause, a small feature with a spec, a refactor inside one module | `sonnet` | `medium` | most `fix` and small `feat` issues |
| Judgment-heavy: a cross-module refactor, a design decision left to the implementer, changes to auth, secrets, money, or data deletion | `opus` | `high` | `refactor` across boundaries, security-sensitive `fix`, `feat` with an open design |

Adjustments:

- **Stacks inherit the top of their layers.** One subagent works a stack bottom-up, so it is
  sized for the hardest layer.
- **Anything touching CI gates, release, or the enterprise rulesets** is judgment-heavy even
  when the diff is small, because a mistake blocks every other PR.
- **A stream with a cross-repo dependency** is at least `medium`, since it must reason about
  ordering across two checkouts.
- **A spike** is normally deferred, not sized. If the user wants it run, it is `sonnet`/`medium`
  with the explicit instruction to produce findings, not a code change.

The effort selects the agent (`workstreams:stream-low`, `stream-medium`, or `stream-high`); the
model is passed per call. The review pass runs `workstreams:reviewer` (effort `high`, fixed in
its definition) on the stream's model.
