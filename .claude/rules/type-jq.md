---
paths:
  - "**/*.sh"
  - "**/*.jq"
---

# Testing jq Decision Logic

**Where jq makes a decision, every branch needs a test.** A filter that selects, a fold that
maps outcomes to a verdict, a `select` that excludes — each arm needs an example that reaches it.

Coverage will not tell you when one is missing. The gate measures shell lines executed, and a
multi-line jq body is a single shell statement, so kcov scores the whole program as one covered
line however much logic it holds. A file whose every decision is untested reads as fully covered.

## Verify by mutation, not by the number

Change one arm of the jq — narrow a filter, drop a value from a match list, invert a condition —
and confirm a *specific* example goes red. If the suite stays green, the fixtures are the gap.

This is not theoretical. Three mutations of one check-state fold (narrowing the fail set so
`CANCELLED` and `TIMED_OUT` stopped counting, dropping `NEUTRAL` from the pass set, inverting the
`COMPLETED` arm) each left a 219-example suite green with coverage unmoved. The first would have
reported a cancelled build as pending and polled it forever.

## One fixture per branch, not per input

Values that share an arm share a test. `CANCELLED`, `TIMED_OUT` and `ACTION_REQUIRED` all land in
the same "completed but not in the pass list" arm, so one fixture covers it. What needs its own
fixture is each arm the jq can take.

## Extracting to a .jq file

Reasonable when a program is big enough to warrant lint, reuse, or direct testing:

```bash
printf '%s' "$canned" | jq -f scripts/lib/thing.jq
```

That form is easy to test one branch at a time, which is the reason to do it.

It is **not** a coverage mechanism, and it is not required. kcov instruments `.sh`, so moving jq
out of a shell script removes those lines from the denominator entirely: the number rises while
nothing becomes better tested. Extract for testability, then write the per-branch tests. Do not
extract to move a number.

## Also worth knowing

kcov traces what shellspec runs via `When run script`. A script invoked from a helper function
may not be traced at all, so a file can look uncovered while being thoroughly exercised, or the
reverse.
