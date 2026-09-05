# issues-merge.jq: merge gh issue view/list results (slurped) into one sorted array.
# refs: the other issue numbers mentioned as #N in the body, excluding the issue itself.
# A #N directly after a letter, digit, or slash (as in a url anchor) is not a reference.
map(if type == "array" then .[] else . end)
| unique_by(.number)
| sort_by(.number)
| map(
    . as $i
    | {
        number, title, state, url,
        body: (.body // ""),
        labels: [.labels[]?.name],
        refs: ([(.body // "") | scan("(?:^|[^A-Za-z0-9/])#([0-9]+)") | .[0] | tonumber]
               | unique | map(select(. != $i.number)))
      }
  )
