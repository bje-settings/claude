---
paths:
  - "**/*.sh"
---

# Coverage Does Not Police jq

The 95% gate measures shell lines executed. It says nothing about which branch inside a `jq`
program ran. A multi-line jq body is one shell statement, so kcov scores the whole thing as a
single covered line no matter how much logic is inside it.

So: **any decision made inside jq needs a fixture that reaches each branch.** Coverage will not
tell you when one is missing, and the file will read as covered.

Verify it the only way that works: change one arm of the jq (narrow a filter, drop a case from a
match list, invert a condition) and confirm a specific example goes red. If the suite stays
green, the fixtures are the gap, not the specs. This has caught real branches that no test
reached while the file scored as fully covered.

Two related traps:

- Moving jq into a `.jq` file is good for lint and reuse, and it removes those lines from the
  denominator entirely, since kcov instruments `.sh`. Coverage goes up while nothing becomes
  better tested. The upside is that a `.jq` file can be tested directly, one example per branch:
  `printf '%s' "$canned" | jq -f scripts/lib/thing.jq`. Do that, rather than banking the number.
- kcov traces what shellspec runs via `When run script`. A script invoked from a helper function
  may not be traced at all, so a file can look uncovered while being thoroughly exercised, or
  the reverse.
