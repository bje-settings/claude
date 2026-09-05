#!/usr/bin/env bash
# lib/shepherd.sh — shared pieces of the shepherd scripts.
#
# Source this file. It defines:
#
#   SHEPHERD_PR_FIELDS  the --json field list both scripts ask gh for
#   SHEPHERD_JQ_LIB     jq definitions: `checks` reduces a statusCheckRollup,
#                       `summary` shapes one pull request for the loop
#
# statusCheckRollup mixes two shapes. A CheckRun (GitHub Actions and most apps)
# has `status` (QUEUED, IN_PROGRESS, COMPLETED) and `conclusion` (SUCCESS,
# FAILURE, NEUTRAL, SKIPPED, ...). A StatusContext (the older commit-status API)
# has a single `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), names
# itself with `context` rather than `name`, links with `targetUrl` rather than
# `detailsUrl`, and carries no `conclusion` key at all (checked against a real
# Vercel status row). `checks` folds both into one of: none, pending, failed,
# passed.

# shellcheck disable=SC2034  # consumed by the scripts that source this file
SHEPHERD_PR_FIELDS='number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,headRefOid,statusCheckRollup,createdAt,state,mergeCommit'

# shellcheck disable=SC2016
SHEPHERD_JQ_LIB='
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
'
