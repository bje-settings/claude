# shepherd.jq — jq definitions shared by the shepherd scripts. Load with
#   jq -L "$HERE/lib" 'include "shepherd"; ...'
#
# statusCheckRollup mixes two shapes. A CheckRun (GitHub Actions and most apps)
# has `status` (QUEUED, IN_PROGRESS, COMPLETED) and `conclusion` (SUCCESS,
# FAILURE, NEUTRAL, SKIPPED, ...). A StatusContext (the older commit-status API)
# has a single `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), names
# itself with `context` rather than `name`, links with `targetUrl` rather than
# `detailsUrl`, and carries no `conclusion` key at all (checked against a real
# Vercel status row). So dispatch on __typename, never on a field falling
# through: a `.conclusion // .state` chain reads the wrong row shape silently.
# `checks` folds both into one of: none, pending, failed, passed.
#
# A jq program is one line to kcov, so nothing here counts as covered or not;
# the fixtures reach every arm instead (fixture_dep_pr, checks=...), and the
# specs assert the fold result per arm.

def check_state:
  if .__typename == "StatusContext" then
    if .state == "SUCCESS" then "passed"
    elif .state == "PENDING" or .state == "EXPECTED" then "pending"
    else "failed" end
  else
    if .status != "COMPLETED" then "pending"
    elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "passed"
    else "failed" end
  end;
def checks:
  (.statusCheckRollup // []) as $rollup
  | ($rollup | map(. + {result: check_state})) as $each
  | {
      state: (if ($each | length) == 0 then "none"
              elif any($each[]; .result == "failed") then "failed"
              elif any($each[]; .result == "pending") then "pending"
              else "passed" end),
      failing: ($each | map(select(.result == "failed"))
                | map({name: (.name // .context), link: (.detailsUrl // .targetUrl // null)}))
    };
def is_bot:
  (.author.is_bot == true) or ((.author.login // "") | test("^(app/)?dependabot"));
def summary:
  {
    number,
    title,
    author: .author.login,
    is_bot: is_bot,
    state,
    mergeStateStatus,
    mergeable,
    headRefOid,
    autoMerge: (.autoMergeRequest != null),
    mergeCommit: (.mergeCommit.oid // null),
    labels: (.labels | map(.name)),
    createdAt,
    checks: checks
  };
