# Longpair

## Managers

| Rule | Why |
| --- | --- |
| The retry policy backs off exponentially on every network failure | A fixed delay hammers a service that is already struggling, so the audit would rather wait than retry |

## Runners

| Rule | Why |
| --- | --- |
| The retry policy backs off exponentially on every network failure | A fixed delay hammers a service that is already struggling, so the audit would rather wait than retry |
