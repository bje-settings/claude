# pr-status.jq: reduce `gh pr view --json` output to what the run loop decides on.
#
# outcome: dispatch on the row type. CheckRun rows carry status/conclusion and
# name; StatusContext rows carry state and context. Null and "" both mean absent,
# and a completed CheckRun with no conclusion is unknown, so it is left pending.
# Rows without a __typename fall back to whichever field is present.
def present: select(. != null and . != "");
def outcome:
  (if .__typename == "CheckRun" then ((.conclusion | present) // "PENDING")
   elif .__typename == "StatusContext" then ((.state | present) // "PENDING")
   else ((.conclusion | present) // (.state | present) // "PENDING") end)
  | ascii_upcase;
def failed:
  . == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED"
  or . == "ACTION_REQUIRED" or . == "STARTUP_FAILURE" or . == "STALE";
def check_name: .name // .context // "unnamed";

# fold: fail beats pending beats pass; STALE needs a rerun, so it counts as fail.
def fold:
  map(outcome) as $o
  | if ($o | length) == 0 then "none"
    elif any($o[]; failed) then "fail"
    elif all($o[]; . == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED") then "pass"
    else "pending" end;

# failing: the names of the checks that failed, for the pause question.
def failing: [.[] | select(outcome | failed) | check_name];

{
  number, url, title, state,
  draft: .isDraft,
  base: .baseRefName,
  head: .headRefName,
  headSha: .headRefOid,
  mergeable: (.mergeable // "UNKNOWN"),
  checks: ((.statusCheckRollup // []) | fold),
  failing: ((.statusCheckRollup // []) | failing),
  reviewDecision: (.reviewDecision // "")
}
