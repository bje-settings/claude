{{type}}: {{target}}: {{summary}}

Filed by `/field-test:run` while running `{{target}}` under observation. Everything below was
recorded by the field-test hooks during that run, not reconstructed afterwards.

## What happened

{{reason}}

## Expected versus actual

- **Expected:** {{expected}}
- **Actual:** {{actual}}

## Command and output

```console
$ {{command}}
{{stderr}}
```

Exit code: {{exit_code}}

## Leading up to it

{{preceding}}

## Run

| | |
| --- | --- |
| Target | `{{target}}` |
| Arguments | `{{args}}` |
| Repository under test | {{repo}} |
| Plugin | `{{plugin}}` {{version}} |
| Plugin commit | {{commit}} |
| Claude Code | {{claude_version}} |
| Finding | `{{kind}}`, severity {{severity}}, seen {{count}} time(s) |
| Signature | `{{signature}}` |

## Proposed fixture

{{fixture}}
