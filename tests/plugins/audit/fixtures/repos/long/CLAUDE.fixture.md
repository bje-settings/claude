# Long

## Notes

| Rule | Why |
| --- | --- |
| The retry policy backs off exponentially on every network failure, and keeps doing so until `#164` lands | A fixed delay hammers a service that is already struggling, so the audit would rather wait than retry |
