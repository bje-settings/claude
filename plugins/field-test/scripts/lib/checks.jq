# checks.jq — one pull request's check rollup folded into a single verdict.
#
# Input: the pull request as `gh pr view --json state,isDraft,statusCheckRollup`
# returns it. Output: {state, draft, checks, failing}
# where checks is "pass", "fail", "pending" or "none".
#
# The arms matter more than they look. A cancelled or timed-out run reported as
# pending is a loop that waits forever for a run that already ended; a completed
# run with no conclusion reported as passed is a merge on an answer that has not
# arrived. Each arm below has its own fixture in fixtures/field-test/, per
# .claude/rules/type-jq.md.

def pass_conclusions: ["SUCCESS", "SKIPPED", "NEUTRAL"];
def pass_states: ["SUCCESS", "EXPECTED"];
def pending_states: ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"];

def verdict:
  if .__typename == "StatusContext" then
    if (.state | IN(pass_states[])) then "pass"
    elif (.state | IN(pending_states[])) then "pending"
    else "fail" end
  else
    if .status != "COMPLETED" then "pending"
    elif .conclusion == null then "pending"
    elif (.conclusion | IN(pass_conclusions[])) then "pass"
    else "fail" end
  end;

def name_of: .name // .context // "check";

(.statusCheckRollup // []) as $rollup
| [$rollup[] | {name: name_of, verdict: verdict}] as $folded
| { state: (.state // "UNKNOWN"),
    draft: (.isDraft // false),
    checks:
      (if ($folded | length) == 0 then "none"
       elif any($folded[]; .verdict == "fail") then "fail"
       elif any($folded[]; .verdict == "pending") then "pending"
       else "pass" end),
    failing: [$folded[] | select(.verdict == "fail") | .name] }
