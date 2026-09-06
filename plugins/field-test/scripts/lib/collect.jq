# collect.jq — the recorded events of one field test, reduced to candidate problems.
#
# Input: null. Arguments: $run (the run marker), $events (events.jsonl as an array).
# Output: an array of finding records, highest severity first:
#   {kind, severity, signature, count, agent_id, agent_type, evidence}
#
# A record is a *candidate*. Deciding which candidates are real problems and which
# are the target working correctly is the skill's job, not this filter's: the rule
# for telling them apart is not mechanical, and guessing here would either hide a
# bug or file a false one.
#
# `signature` is what dedupe is done on, here and against already-open issues, so
# it is normalised: first line only, whitespace collapsed, every run of digits
# replaced by N, truncated. Two runs of the same bug on different PR numbers must
# produce the same signature.

# `split` on the empty string is the empty array, so the first line of a command that
# was never recorded is null, and `gsub` on null is a hard error that would lose every
# other finding in the run. A missing command normalises to the empty string instead.
def norm: ((. // "") | split("\n") | (.[0] // "")) | gsub("\\s+"; " ") | gsub("[0-9]+"; "N") | .[0:80];

def rank: {"high": 0, "medium": 1, "low": 2}[.] // 3;

# The few Bash calls before index $i, which is what makes a failure reproducible:
# an exit code on its own rarely says what put the repository into that state.
def preceding($i):
  [ $events[([$i - 3, 0] | max):$i][] | select(.command != null and .command != "") | .command ];

def failed_event:
  .event == "PostToolUseFailure"
  or .event == "denied"
  or (.exit_code != null and .exit_code != 0);

# Failures recorded for one subagent that were never followed by the same command
# succeeding for it. A worker that retried and got through is not contradicting
# itself, so only the unresolved ones can contradict a claim of success.
def unresolved($agent):
  [ $events | to_entries[]
    | select(.value.agent_id != null and .value.agent_id == $agent)
    | select(.value | failed_event)
    | . as $f
    | select([ $events | to_entries[]
               | select(.key > $f.key
                        and .value.agent_id == $agent
                        and .value.command != null
                        and .value.command == $f.value.command
                        and .value.exit_code == 0) ] | length == 0)
    | .value ];

# A subagent's last message read as a claim. An explicit failed or paused status is
# taken at its word; anything else that reports an outcome is read as success.
def claims_success:
  (. // "") as $m
  | if ($m | test("\"status\"\\s*:\\s*\"(failed|paused)\"")) then false
    elif ($m | test("\"status\"\\s*:\\s*\"")) then true
    else ($m | test("(?i)\\b(merged|done|passed|succeeded|success|complete|completed|clean)\\b"))
    end;

def denied_findings:
  [ $events | to_entries[]
    | select(.value.event == "denied")
    | {kind: "denied", severity: "high",
       signature: ("denied:" + (.value.command | norm)),
       agent_id: .value.agent_id, agent_type: .value.agent_type,
       evidence: {command: .value.command, reason: (.value.reason // null),
                  exit_code: null, stderr: "", preceding: preceding(.key)}} ];

# A deny-list rule that did not compile. It is a finding about the field test
# itself rather than about the target: the rule blocked nothing all run, so the
# absence of a `denied` record for it proves nothing either way.
def deny_list_error_findings:
  [ $events | to_entries[]
    | select(.value.event == "deny_list_error")
    | {kind: "deny_list_error", severity: "high",
       signature: ("deny_list_error:" + (.value.pattern | norm)),
       agent_id: .value.agent_id, agent_type: .value.agent_type,
       evidence: {command: null,
                  reason: ("a deny-list rule did not compile and blocked nothing all run: "
                           + (.value.error // "no reason recorded")),
                  exit_code: null, stderr: "",
                  pattern: (.value.pattern // ""), line: .value.line,
                  deny_list: (.value.deny_list // ""), preceding: []}} ];

# A hook that raised. The wrapper still exits 0, so the tool call went through
# unexamined and, for a PreToolUse, unfiltered: the guardrail was off for that call
# and nothing else in the run would say so.
def hook_error_findings:
  [ $events | to_entries[]
    | select(.value.event == "hook_error")
    | {kind: "hook_error", severity: "high",
       signature: ("hook_error:" + ((.value.hook // "") + ":" + ((.value.error // "") | split("\n") | last // "")) | norm),
       agent_id: .value.agent_id, agent_type: .value.agent_type,
       evidence: {command: null,
                  reason: ("the " + (.value.hook // "unknown") + " hook raised, so that tool call was neither recorded nor filtered"),
                  exit_code: null, stderr: (.value.error // ""), preceding: []}} ];

def tool_failure_findings:
  [ $events | to_entries[]
    | select(.value.event == "PostToolUseFailure")
    | {kind: "tool_failure", severity: "medium",
       signature: ("tool_failure:" + (.value.command | norm)),
       agent_id: .value.agent_id, agent_type: .value.agent_type,
       evidence: {command: .value.command, reason: null,
                  exit_code: .value.exit_code, stderr: (.value.stderr_tail // ""),
                  preceding: preceding(.key)}} ];

def nonzero_findings:
  [ $events | to_entries[]
    | select(.value.event == "PostToolUse")
    | select(.value.exit_code != null and .value.exit_code != 0)
    | {kind: "bash_nonzero", severity: "medium",
       signature: ("bash_nonzero:" + (.value.command | norm)),
       agent_id: .value.agent_id, agent_type: .value.agent_type,
       evidence: {command: .value.command, reason: null,
                  exit_code: .value.exit_code, stderr: (.value.stderr_tail // ""),
                  preceding: preceding(.key)}} ];

def contradiction_findings:
  [ $events[]
    | select(.event == "SubagentStop")
    | select(.last_assistant_message | claims_success)
    | . as $stop
    | (unresolved($stop.agent_id)) as $bad
    | select($bad | length > 0)
    | {kind: "subagent_contradiction", severity: "high",
       signature: ("subagent_contradiction:" + ((($stop.agent_type // "subagent") + ":" + ($bad[0].command // ""))| norm)),
       agent_id: $stop.agent_id, agent_type: $stop.agent_type,
       evidence: {command: $bad[0].command, reason: "reported success after a failure it never resolved",
                  exit_code: $bad[0].exit_code, stderr: ($bad[0].stderr_tail // ""),
                  claim: ($stop.last_assistant_message // ""),
                  unresolved: [$bad[] | .command], preceding: []}} ];

# An option handed to the target that never reached any command it ran. Only
# options are checked: a bare word may legitimately be consumed by the skill
# rather than passed through.
def args_dropped_findings:
  [ ($run.args // [])[]
    | select(startswith("-"))
    | . as $a
    | select([ $events[] | select(.command != null) | select(.command | contains($a)) ] | length == 0)
    | {kind: "args_dropped", severity: "low",
       signature: ("args_dropped:" + $a),
       agent_id: null, agent_type: null,
       evidence: {command: null, reason: ("argument " + $a + " never appeared in any command the target ran"),
                  exit_code: null, stderr: "", argument: $a, preceding: []}} ];

(denied_findings + deny_list_error_findings + hook_error_findings
 + tool_failure_findings + nonzero_findings
 + contradiction_findings + args_dropped_findings)
| group_by(.signature)
| map(.[0] + {count: length})
| sort_by([(.severity | rank), .signature])
