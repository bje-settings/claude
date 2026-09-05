# shepherd-status.jq — shape `gh pr list` output into the shepherd work list.
# Arguments: $repo, $default, $ci. Ordering: gh-security's merge-risk band
# (low, then unlabelled, then medium, then high), oldest first within a band.
include "shepherd";

def rank:
  (.labels | map(.name) | map(select(startswith("merge-risk:"))) | first // "")
  | if . == "merge-risk:low" then 0
    elif . == "" then 1
    elif . == "merge-risk:medium" then 2
    elif . == "merge-risk:high" then 3
    else 4 end;

map(select(.isDraft | not)) as $open
| {
    repo: $repo,
    default_branch: $default,
    ci_seconds: $ci,
    targets: ($open
      | map(select(.autoMergeRequest != null))
      | sort_by([rank, .createdAt])
      | map(summary)),
    skipped_no_automerge: ($open
      | map(select(.autoMergeRequest == null))
      | sort_by(.createdAt)
      | map({number, title, author: .author.login}))
  }
