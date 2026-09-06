# harden-state.jq — append one field-test target to a hardening run.
#
# Input: the state file. Arguments: $path, $repo.
# Output: the state with the target appended, or unchanged if it is already there.
#
# Targets are an ordered list, not a set keyed by path, because the order is the
# plan: the loop works them front to back and a resumed session has to pick up
# where the last one stopped. Appending a path that is already listed is a no-op
# rather than an error, so a re-run of the same setup does not duplicate work.

.targets = (
  if any(.targets[]?; .path == $path) then .targets
  else .targets + [{
    path: $path,
    repo: (if $repo == "" then null else $repo end),
    status: "pending",
    phase: "field-test",
    issues: [],
    pr: null,
    merge_sha: null,
    question: null,
    summary: null
  }]
  end)
