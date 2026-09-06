# Target summary (template)

One of these per target, in the same shape every round, so the rounds can be read side by side.
Fill every `<...>`; write `none` rather than leaving a cell empty.

---

### `<target>` — <clean | fixed | paused | failed>

| | |
| --- | --- |
| Repository under test | `<path, or "a repository outside the enterprise">` |
| Names in the issues | <kept, same enterprise \| redacted, outside the enterprise> |
| Findings | <n> (<denied: n, contradictions: n, failures: n, dropped options: n>) |
| Dismissed as expected behaviour | <n, with a one-line reason each, or none> |
| Issues filed | <#n, #n, or none> |
| Report mismatches | <what the skill claimed against what GitHub said, or none> |
| Pull request | <#n, or none> |
| Merged | <sha, or not yet, or no> |
| Retries | <mechanical CI retries used, out of one> |
| Open question | <the exact question this target is waiting on, or none> |

**What went wrong:** <one paragraph a reader who did not watch the round can follow. The
behaviour, not the tooling.>

**What changed:** <the fix, and the fixture that would have caught it.>
