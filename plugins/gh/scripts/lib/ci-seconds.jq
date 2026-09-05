# ci-seconds.jq — median wall time, in seconds, of an array of workflow runs.
# Input: `gh run list --json createdAt,updatedAt`. Runs missing either stamp or
# with a non-positive duration are ignored; no usable run at all gives 300.
[ .[] | select(.createdAt != null and .updatedAt != null)
      | ((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601))
      | select(. > 0) ]
| if length == 0 then 300
  else sort | .[length / 2 | floor] end
