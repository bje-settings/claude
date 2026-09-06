# render.jq — one finding rendered into the issue template.
#
# Input: null. Arguments: $record, $run, and $template (the template file, --rawfile).
# Output: the filled template as raw text. Its first line is the issue title and
# the rest is the body, so the whole thing is one stream of text that redaction can
# be applied to in one pass; splitting title from body would mean redacting twice
# and give a second place for a name to survive.
#
# The per-kind text is here rather than in the template because it is a decision:
# what a reader should have expected, and what state a fixture has to reproduce,
# differ by finding. `test:` is used instead of `fix:` for a finding that says a
# check is missing rather than that something failed.

def kind: $record.kind;

def type_of:
  if kind == "args_dropped" then "test" else "fix" end;

def expected_of:
  if kind == "denied" then "the target not to reach for a command that cannot be undone"
  elif kind == "tool_failure" then "the tool call to complete, or the target to handle the failure and say so"
  elif kind == "bash_nonzero" then "the command to exit 0, or the target to stop and report the non-zero exit"
  elif kind == "subagent_contradiction" then "a subagent that hit a failure it never resolved to report that failure"
  elif kind == "deny_list_error" then "every rule in the deny list to be in force for the whole run"
  elif kind == "hook_error" then "the field-test hooks to record every tool call and filter every Bash call"
  elif kind == "args_dropped" then "every option given to the target to reach the commands it runs"
  else "the target to complete the step without this" end;

def actual_of:
  if kind == "denied" then "the field-test hook blocked it, and the run continued without it"
  elif kind == "tool_failure" then "the tool call failed and the run continued"
  elif kind == "bash_nonzero" then "the command exited non-zero and the run continued"
  elif kind == "subagent_contradiction" then "the subagent's last message reported success: " + (($record.evidence.claim // "") | .[0:400])
  elif kind == "deny_list_error" then "the rule did not compile, so it blocked nothing and nothing it names was refused"
  elif kind == "hook_error" then "the hook raised and the tool call went through unrecorded and unfiltered"
  elif kind == "args_dropped" then "the option never appeared in any command the target ran"
  else "see the output below" end;

def fixture_of:
  if kind == "denied" then "A repository where the target reaches this step, plus a spec asserting the deny list still matches this command and still allows the benign form of it."
  elif kind == "args_dropped" then "A spec that runs the target with this option and asserts it reaches the command the target builds."
  elif kind == "subagent_contradiction" then "A canned subagent result whose text claims success beside recorded events holding an unresolved failure, asserted to produce this finding."
  elif kind == "deny_list_error" then "A deny list holding this pattern, asserted to leave the remaining rules in force and to record the rule it lost."
  elif kind == "hook_error" then "The payload that made the hook raise, asserted to leave the session running and to record the call the hook could not handle."
  else "A repository in the state the commands above left it in, built by the fixtures rather than mocked, plus a spec asserting the target's behaviour from that state." end;

def summary_of:
  ($record.signature // "") | split(":") | .[1:] | join(":") | ltrimstr(" ") | .[0:70];

def preceding_of:
  ($record.evidence.preceding // [])
  | if length == 0 then "Nothing was recorded before it."
    else map("1. `" + (. | split("\n")[0]) + "`") | join("\n") end;

def args_of:
  ($run.args // []) | if length == 0 then "(none)" else join(" ") end;

{ "type": type_of,
  "target": ($run.target // "unknown"),
  "summary": summary_of,
  "reason": ($record.evidence.reason // ("A " + kind + " finding recorded during the run.")),
  "expected": expected_of,
  "actual": actual_of,
  "command": ($record.evidence.command // "(no single command; the finding is about the run as a whole)"),
  "stderr": (($record.evidence.stderr // "") | if . == "" then "(no output recorded)" else . end),
  "exit_code": (if $record.evidence.exit_code == null then "not recorded" else ($record.evidence.exit_code | tostring) end),
  "preceding": preceding_of,
  "args": args_of,
  "repo": ($run.cwd // "unknown"),
  "plugin": ($run.resolved.plugin // $run.target // "unknown"),
  "version": ($run.resolved.version // "version unknown"),
  "commit": ($run.resolved.commit // "not a local checkout"),
  "claude_version": (($run.claude_version // "") | if . == "" then "not recorded" else . end),
  "kind": kind,
  "severity": ($record.severity // "medium"),
  "count": (($record.count // 1) | tostring),
  "signature": ($record.signature // ""),
  "fixture": fixture_of }
| to_entries
| reduce .[] as $s ($template; split("{{" + $s.key + "}}") | join($s.value))
