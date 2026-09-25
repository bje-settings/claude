---
name: context
description: >
  Audit a checkout's CLAUDE.md, README.md, and .claude/**/*.md for rot. Rot
  is a reference that no longer resolves, a statement whose condition has
  ended, or a duplicate claim. The audit runs fully without a key. Repository
  text reaches TypeSafe only when TYPESAFE_API_KEY is set.
allowed-tools: Bash
disable-model-invocation: true
---

Audit the current checkout, or the root named in `$ARGUMENTS`.

## Step 1: Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.ts" context $ARGUMENTS
```

The audit runs to completion with no key: do not ask for `TYPESAFE_API_KEY` or refuse to run
without one. Pass the user's arguments straight through; supported flags are `--scope`,
`--shape`, `--no-jev`, `--json`, `--out`, `--max-pairs`, `--max-evidence` and
`--pair-threshold`.

## Step 2: Report

Print the findings verbatim. A non-zero exit changes what that means. Exit 1 means at least one
model call failed. State that the audit is incomplete before you triage the findings. The
report's own `failures` section names which call failed. Exit 2 means the audit refused the
request, and there is nothing on stdout to print.

## Step 3: Triage

Tell the reviewer which findings to verify first, in this order:

1. Absent references (tier 0, near-certain).
2. Volatile units whose named issue has closed.
3. Duplicate pairs, highest confidence first.
4. Evidence contradictions last. The evidence stage judges a claim only against the first 6,000
   characters of the cited file's excerpt. A claim about something further down can look
   contradicted when it is not.

Verify each finding against the actual files before you treat it as true. Never edit anything
based on a finding alone.
