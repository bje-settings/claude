---
name: context
description: >
  Audit a checkout's CLAUDE.md, README.md and .claude/**/*.md for rot:
  references that no longer resolve, statements whose named condition has
  ended, and duplicated claims. Runs fully without a key; repository text
  reaches TypeSafe only when TYPESAFE_API_KEY is set.
allowed-tools: Bash
disable-model-invocation: true
---

Audit the current checkout, or the root named in `$ARGUMENTS`.

## Step 1: Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.ts" context $ARGUMENTS
```

The audit runs to completion with no key: do not ask for `TYPESAFE_API_KEY` or refuse to run
without one. Pass the user's arguments straight through; supported flags are `--scope`,
`--shape`, `--no-jev`, `--json`, `--out`, `--max-pairs`, `--max-evidence` and
`--pair-threshold`.

## Step 2: Report

Print the findings verbatim. A non-zero exit changes what that means: exit 1 says at least one
model call failed, so say the audit is incomplete before triaging (the report's own `failures`
section names which call); exit 2 means the request was refused, and there is nothing on stdout
to print.

## Step 3: Triage

Tell the reviewer which findings to verify first, in this order:

1. Absent references (tier 0, near-certain).
2. Volatile units whose named issue has closed.
3. Duplicate pairs, highest confidence first.
4. Evidence contradictions last: the excerpt a claim is judged against is only the cited file's
   first 6,000 characters, so a claim about something further down can read as contradicted.

Verify each finding against the actual files before treating it as true, and never edit
anything on a finding alone.
