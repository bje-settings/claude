# add-stream.jq: append one stream record. Arguments: id issues kind stack order base model effort reason
.streams += [{
  id: $id,
  issues: ($issues | split(",") | map(tonumber)),
  kind: $kind,
  stack: (if $stack == "" then null else $stack end),
  order: (if $order == "" then null else ($order | tonumber) end),
  base: (if $base == "" then null else $base end),
  model: $model, effort: $effort, reason: $reason,
  status: "planned", branch: null, worktree: null, pr: null, prs: null,
  agent: null, question: null, attempts: 0
}]
