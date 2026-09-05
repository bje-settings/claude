# pr-status.jq: reduce `gh pr view --json` output to what the run loop decides on.
#
# outcome: CheckRun rows carry status/conclusion; StatusContext rows carry state.
# Null and "" both mean absent. A completed CheckRun with no conclusion is
# unknown, so it is left pending.
def present: select(. != null and . != "");
def outcome:
  ((.conclusion | present) // (.state | present) // "PENDING") | ascii_upcase;

# fold: fail beats pending beats pass; STALE needs a rerun, so it counts as fail.
def fold:
  map(outcome) as $o
  | if ($o | length) == 0 then "none"
    elif any($o[]; . == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED"
                   or . == "ACTION_REQUIRED" or . == "STARTUP_FAILURE" or . == "STALE") then "fail"
    elif all($o[]; . == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED") then "pass"
    else "pending" end;

{
  number, url, title, state,
  draft: .isDraft,
  base: .baseRefName,
  head: .headRefName,
  headSha: .headRefOid,
  mergeable: (.mergeable // "UNKNOWN"),
  checks: ((.statusCheckRollup // []) | fold),
  reviewDecision: (.reviewDecision // "")
}
