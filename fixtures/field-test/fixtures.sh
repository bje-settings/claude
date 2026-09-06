#!/usr/bin/env bash
# fixtures.sh: canned input for the field-test specs.
#
# Source this. Each function writes one fixture. The shapes are reconstructed from
# field tests of /gh:shepherd and /workstreams:run, not copied from them: no repo
# name, PR number, or commit subject here came from a repository outside the bje
# enterprise, per CLAUDE.md.
#
# Two kinds of fixture live here. `ft_fixture_events` produces one events file per
# branch of scripts/lib/collect.jq, which is what .claude/rules/type-jq.md asks
# for: a multi-line jq body is one line to kcov, so the branches are only covered
# if each has an example that reaches it. `ft_fixture_repo` builds a real git
# repository, because the redaction table is derived from real remotes, branches
# and commit subjects and a mocked git would prove nothing about it.
#
# Written for bash 3.2, like the scripts under test.

# ft_fixture_run <path> [target] [args-json] [resolved-json]: one run marker.
ft_fixture_run() {
  local path="$1" target="${2:-gh:shepherd}" args="${3:-[\"--dry-run\"]}" resolved="${4:-}"
  [ -n "$resolved" ] || resolved='{"kind":"plugin-skill","plugin":"gh","skill":"shepherd","version":"0.2.0","commit":"0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6","repo":"bje-settings/claude","marketplace_path":"/checkout"}'
  cat > "$path" <<JSON
{"version": 1, "session_id": "ft-session", "target": "$target", "args": $args,
 "cwd": "/checkout", "resolved": $resolved, "claude_version": "2.1.263 (Claude Code)",
 "started_at": "2026-01-02T03:04:05Z", "finished_at": null}
JSON
}

# ft_fixture_events <path> <case>: one events.jsonl per collect.jq branch.
#
#   clean          two Bash calls, both exit 0                    -> no findings
#   nonzero        one exit 0 and the same failing call twice     -> one bash_nonzero, count 2
#   failure        a tool call that failed outright               -> tool_failure
#   denied         a command the PreToolUse hook refused          -> denied
#   deny-error     a deny-list rule that did not compile          -> deny_list_error
#   contradiction  subagent claims success, failure never resolved-> subagent_contradiction
#   retried        same, but the command later succeeded          -> no contradiction
#   honest         subagent reports status failed                 -> no contradiction
#   status-ok      subagent reports a status that is not failed   -> subagent_contradiction
#   args-used      a call carrying --dry-run                      -> no args_dropped
#   no-command     a failed call whose command was never recorded -> the rest survive
#   hook-error     a hook that raised on one tool call            -> hook_error
#   preceding      five calls before a failure, one with no command -> evidence trail
#   null-agent     a failure and a claim, neither from a subagent  -> no contradiction
#   mixed          one of each severity                           -> ordering and dedupe
ft_fixture_events() {
  local path="$1" name="${2:-clean}"
  : > "$path"
  case "$name" in
    clean)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t2","command":"gh pr list --state open","exit_code":0,"stderr_tail":""}
JSON
      ;;
    nonzero)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t2","command":"gh pr merge --auto --squash 11","exit_code":1,"stderr_tail":"GraphQL: Pull request is in unstable status"}
{"ts":"2026-01-02T03:04:09Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t3","command":"gh pr merge --auto --squash 12","exit_code":1,"stderr_tail":"GraphQL: Pull request is in unstable status"}
JSON
      ;;
    failure)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUseFailure","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"bash scripts/does-not-exist.sh","exit_code":127,"stderr_tail":"No such file or directory"}
JSON
      ;;
    denied)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:07Z","event":"denied","agent_id":null,"agent_type":null,"command":"git push --force origin main","reason":"Force-pushing rewrites history other people may already have.","pattern":"force"}
JSON
      ;;
    deny-error)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"deny_list_error","agent_id":null,"agent_type":null,"pattern":"[unclosed","line":2,"error":"unterminated character set at position 0","deny_list":"/plugin/hooks/deny-list.txt"}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
JSON
      ;;
    contradiction)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t1","command":"bash spec/run.sh","exit_code":1,"stderr_tail":"1 example failed"}
{"ts":"2026-01-02T03:04:08Z","event":"SubagentStop","agent_id":"agent-1","agent_type":"shepherd-repo","transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"All four pull requests were merged and the branch is clean."}
JSON
      ;;
    retried)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t1","command":"bash spec/run.sh","exit_code":1,"stderr_tail":"1 example failed"}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t2","command":"bash spec/run.sh","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:08Z","event":"SubagentStop","agent_id":"agent-1","agent_type":"shepherd-repo","transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"All four pull requests were merged and the branch is clean."}
JSON
      ;;
    honest)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t1","command":"bash spec/run.sh","exit_code":1,"stderr_tail":"1 example failed"}
{"ts":"2026-01-02T03:04:08Z","event":"SubagentStop","agent_id":"agent-1","agent_type":"shepherd-repo","transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"{\"status\": \"failed\", \"question\": \"the suite does not pass on this branch\"}"}
JSON
      ;;
    status-ok)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t1","command":"bash spec/run.sh","exit_code":1,"stderr_tail":"1 example failed"}
{"ts":"2026-01-02T03:04:08Z","event":"SubagentStop","agent_id":"agent-1","agent_type":"shepherd-repo","transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"{\"status\": \"ok\", \"summary\": \"nothing worth reporting\"}"}
JSON
      ;;
    preceding)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:01Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:02Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t2","command":"git status --short","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:03Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t3","command":"gh pr list --state open","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:04Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t4","command":"gh pr checks 11","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:05Z","event":"Stop","agent_id":null,"agent_type":null}
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t5","command":"gh pr merge --auto --squash 11","exit_code":1,"stderr_tail":"GraphQL: Pull request is in unstable status"}
JSON
      ;;
    null-agent)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"bash spec/run.sh","exit_code":1,"stderr_tail":"1 example failed"}
{"ts":"2026-01-02T03:04:08Z","event":"SubagentStop","agent_id":null,"agent_type":null,"transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"All done, merged."}
JSON
      ;;
    hook-error)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"hook_error","agent_id":null,"agent_type":null,"hook":"PreToolUse","error":"Traceback (most recent call last):\n  File \"hook-io.py\", line 206, in handle_pre_tool_use\nTypeError: expected string or bytes-like object"}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
JSON
      ;;
    no-command)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUseFailure","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":null,"exit_code":null,"stderr_tail":""}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t2","command":"","exit_code":2,"stderr_tail":"nothing to run"}
{"ts":"2026-01-02T03:04:08Z","event":"denied","agent_id":null,"agent_type":null,"command":"git push --force origin main","reason":"Force-pushing rewrites history other people may already have.","pattern":"force"}
JSON
      ;;
    args-used)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":null,"agent_type":null,"tool_use_id":"t1","command":"bash scripts/gh-shepherd-pr.sh status --dry-run","exit_code":0,"stderr_tail":""}
JSON
      ;;
    mixed)
      cat >> "$path" <<'JSON'
{"ts":"2026-01-02T03:04:06Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t1","command":"git fetch origin","exit_code":0,"stderr_tail":""}
{"ts":"2026-01-02T03:04:07Z","event":"PostToolUse","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t2","command":"gh pr merge --auto --squash 11","exit_code":1,"stderr_tail":"GraphQL: Pull request is in unstable status"}
{"ts":"2026-01-02T03:04:08Z","event":"PostToolUseFailure","agent_id":"agent-1","agent_type":"shepherd-repo","tool_use_id":"t3","command":"bash scripts/does-not-exist.sh","exit_code":127,"stderr_tail":"No such file or directory"}
{"ts":"2026-01-02T03:04:09Z","event":"denied","agent_id":"agent-1","agent_type":"shepherd-repo","command":"git push --force origin main","reason":"Force-pushing rewrites history other people may already have.","pattern":"force"}
{"ts":"2026-01-02T03:04:10Z","event":"SubagentStop","agent_id":"agent-1","agent_type":"shepherd-repo","transcript_path":"/transcripts/agent-1.jsonl","last_assistant_message":"Done: every pull request merged."}
JSON
      ;;
    *)
      printf 'ft_fixture_events: unknown case: %s\n' "$name" >&2
      return 1
      ;;
  esac
}

# ft_fixture_transcript <path> [with-report|no-assistant|truncated|tool-tail]
# The session transcript, as Claude Code writes it: one JSON object per line. The
# truncated form ends mid-object, which is what a transcript still being written
# looks like when it is read. The tool-tail form ends on an assistant turn holding
# only thinking and tool_use blocks, which is how a real transcript usually ends.
ft_fixture_transcript() {
  local path="$1" name="${2:-with-report}"
  case "$name" in
    with-report)
      cat > "$path" <<'JSON'
{"type":"user","message":{"content":[{"type":"text","text":"run it"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Starting the round."}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"| PR | Outcome |\n| --- | --- |\n| #11 | merged |\n| #12 | skipped |"}]}}
JSON
      ;;
    no-assistant)
      cat > "$path" <<'JSON'
{"type":"user","message":{"content":[{"type":"text","text":"run it"}]}}
JSON
      ;;
    tool-tail)
      cat > "$path" <<'JSON'
{"type":"assistant","message":{"content":[{"type":"text","text":"| PR | Outcome |\n| #11 | merged |"}]}}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"one more check"},{"type":"tool_use","name":"Bash","input":{"command":"gh pr view 11"}}]}}
JSON
      ;;
    truncated)
      cat > "$path" <<'JSON'
{"type":"assistant","message":{"content":[{"type":"text","text":"the whole line"}]}}
{"type":"assistant","message":{"content":[{"type":"text","tex
JSON
      ;;
    *)
      printf 'ft_fixture_transcript: unknown case: %s\n' "$name" >&2
      return 1
      ;;
  esac
}

# ft_fixture_hook_input <path> <case> [session]: one hook payload.
#
#   post-ok post-bool-code post-fail post-failure post-failure-no-code pre-deny
#   pre-allow pre-other subagent-stop stop malformed
ft_fixture_hook_input() {
  local path="$1" name="${2:-post-ok}" session="${3:-ft-session}"
  case "$name" in
    post-ok)
      cat > "$path" <<JSON
{"session_id": "$session", "transcript_path": "/transcripts/main.jsonl", "tool_name": "Bash",
 "tool_use_id": "t1", "tool_input": {"command": "git fetch origin"},
 "tool_response": {"stdout": "", "stderr": "", "exit_code": 0}}
JSON
      ;;
    post-bool-code)
      cat > "$path" <<JSON
{"session_id": "$session", "transcript_path": "/transcripts/main.jsonl", "tool_name": "Bash",
 "tool_use_id": "t1", "tool_input": {"command": "git fetch origin"},
 "tool_response": {"stdout": "", "stderr": "", "code": true}}
JSON
      ;;
    post-fail)
      cat > "$path" <<JSON
{"session_id": "$session", "transcript_path": "/transcripts/main.jsonl", "tool_name": "Bash",
 "agent_id": "agent-1", "agent_type": "shepherd-repo", "tool_use_id": "t2",
 "tool_input": {"command": "gh pr merge --auto --squash 11"},
 "tool_response": {"stdout": "", "stderr": "GraphQL: Pull request is in unstable status", "exitCode": 1}}
JSON
      ;;
    post-failure)
      # The real shape: a PostToolUseFailure payload carries no tool_response at all.
      # The failure arrives as a top-level error string whose first line is the exit
      # code and whose remainder is the command's output.
      cat > "$path" <<JSON
{"session_id": "$session", "tool_name": "Bash", "tool_use_id": "t3",
 "tool_input": {"command": "bash scripts/does-not-exist.sh"},
 "error": "Exit code 127\nbash: scripts/does-not-exist.sh: No such file or directory",
 "is_interrupt": false, "duration_ms": 12}
JSON
      ;;
    post-failure-no-code)
      # The same event for a tool whose error text does not open with an exit code.
      cat > "$path" <<JSON
{"session_id": "$session", "tool_name": "Bash", "tool_use_id": "t4",
 "tool_input": {"command": "sleep 30"},
 "error": "The user interrupted the command", "is_interrupt": true, "duration_ms": 900}
JSON
      ;;
    pre-deny)
      cat > "$path" <<JSON
{"session_id": "$session", "tool_name": "Bash",
 "tool_input": {"command": "git push --force origin main"}}
JSON
      ;;
    pre-allow)
      cat > "$path" <<JSON
{"session_id": "$session", "tool_name": "Bash",
 "tool_input": {"command": "git push --force-with-lease origin wktr-9-fix"}}
JSON
      ;;
    pre-other)
      cat > "$path" <<JSON
{"session_id": "$session", "tool_name": "Read", "tool_input": {"file_path": "/checkout/README.md"}}
JSON
      ;;
    subagent-stop)
      # transcript_path on a SubagentStop is the main session's; the subagent's own
      # is agent_transcript_path.
      cat > "$path" <<JSON
{"session_id": "$session", "agent_id": "agent-1", "agent_type": "shepherd-repo",
 "transcript_path": "/transcripts/main.jsonl",
 "agent_transcript_path": "/transcripts/agent-1.jsonl",
 "last_assistant_message": "All four pull requests were merged."}
JSON
      ;;
    stop)
      cat > "$path" <<JSON
{"session_id": "$session", "transcript_path": "/transcripts/main.jsonl"}
JSON
      ;;
    malformed)
      printf 'this is not json' > "$path"
      ;;
    *)
      printf 'ft_fixture_hook_input: unknown case: %s\n' "$name" >&2
      return 1
      ;;
  esac
}

# ft_fixture_installed_plugins <path> <install-dir> [with-skill|without-skill]
# The shape of ~/.claude/plugins/installed_plugins.json, version 2.
ft_fixture_installed_plugins() {
  local path="$1" install="$2" mode="${3:-with-skill}"
  if [ "$mode" = "with-skill" ]; then
    mkdir -p "$install/skills/shepherd"
    printf -- '---\nname: shepherd\n---\n' > "$install/skills/shepherd/SKILL.md"
  fi
  cat > "$path" <<JSON
{"version": 2, "plugins": {
  "gh@bje": [{"scope": "user", "installPath": "$install", "version": "0.2.0"}],
  "pr-review-toolkit@official": [{"scope": "user", "installPath": "$install-other", "version": "abc123"}]}}
JSON
}

# ft_fixture_marketplaces <path> <local-dir> [directory|github]
ft_fixture_marketplaces() {
  local path="$1" dir="$2" kind="${3:-directory}"
  if [ "$kind" = "directory" ]; then
    cat > "$path" <<JSON
{"bje": {"source": {"source": "directory", "path": "$dir"},
         "installLocation": "$dir", "lastUpdated": "2026-01-02T03:04:05Z"},
 "official": {"source": {"source": "github", "repo": "anthropics/claude-plugins-official"},
              "installLocation": "$dir-cache", "lastUpdated": "2026-01-02T03:04:05Z"}}
JSON
  else
    cat > "$path" <<JSON
{"bje": {"source": {"source": "github", "repo": "bje-settings/claude"},
         "installLocation": "$dir-cache", "lastUpdated": "2026-01-02T03:04:05Z"}}
JSON
  fi
}

# ft_fixture_repo <dir> [owner/name] [ssh|https|alias|none]: a real git repository with a
# remote, two branches, and two commits, which is what the redaction table is built
# from. Identity is passed per command so no global git config is needed.
ft_fixture_repo() {
  local dir="$1" slug="${2:-acme-org/widgets}" form="${3:-ssh}"
  mkdir -p "$dir"
  ft_fixture_git "$dir" init -q -b main
  printf 'one\n' > "$dir/README.md"
  ft_fixture_git "$dir" add README.md
  ft_fixture_git "$dir" commit -q -m 'feat: the first commit subject'
  ft_fixture_git "$dir" checkout -q -b wktr-9-widget-fix
  printf 'two\n' >> "$dir/README.md"
  ft_fixture_git "$dir" commit -q -am 'fix: the widget drops its last field'
  case "$form" in
    ssh) ft_fixture_git "$dir" remote add origin "git@github.com:$slug.git" ;;
    https) ft_fixture_git "$dir" remote add origin "https://github.com/$slug.git" ;;
    # An ssh host alias, which is how one machine holds two GitHub accounts. The
    # owner is the same; only the host in the URL differs.
    alias) ft_fixture_git "$dir" remote add origin "git@github.com-work:$slug.git" ;;
    none) : ;;
  esac
  printf '%s' "$dir"
}

# ft_fixture_git <dir> <args...>: git with identity supplied per command.
ft_fixture_git() {
  local dir="$1"; shift
  git -C "$dir" \
    -c user.name='Field Test' -c user.email='field-test@example.invalid' \
    -c commit.gpgsign=false -c init.defaultBranch=main "$@"
}

# ft_fixture_enterprise <dir> [both|neither|paged|second|error|empty]: the canned answers
# fixtures/field-test/bin/gh gives to `api graphql`.
ft_fixture_enterprise() {
  local dir="$1" mode="${2:-both}"
  mkdir -p "$dir"
  printf '%s' "$mode" > "$dir/enterprise-mode"
}

# ft_fixture_issues <path>: the open issues fixtures/field-test/bin/gh serves to
# `gh issue list`. Two already carry a finding's signature, one of them holding the
# quotes a real command holds, so the duplicate search has something to find; the
# others are near misses that must not match.
ft_fixture_issues() {
  cat > "$1" <<'JSON'
[
  {"number": 40, "title": "fix: gh:shepherd: gh pr merge --auto --squash N", "state": "OPEN",
   "labels": [{"name": "bug"}, {"name": "field-test"}],
   "body": "Signature: `bash_nonzero:gh pr merge --auto --squash N`\n\nSeen on an earlier round."},
  {"number": 41, "title": "fix: gh:shepherd: something else entirely", "state": "OPEN",
   "labels": [{"name": "bug"}, {"name": "field-test"}],
   "body": "Signature: `bash_nonzero:git fetch origin`"},
  {"number": 42, "title": "fix: gh:shepherd: gh pr merge --auto --squash N", "state": "CLOSED",
   "labels": [{"name": "bug"}, {"name": "field-test"}],
   "body": "Signature: `bash_nonzero:gh pr merge --auto --squash N`\n\nAlready fixed."},
  {"number": 43, "title": "chore: unrelated", "state": "OPEN", "labels": [{"name": "chore"}],
   "body": "Mentions bash_nonzero:gh pr merge --auto --squash N but is not a field-test issue."},
  {"number": 44, "title": "fix: gh:shepherd: gh pr comment", "state": "OPEN",
   "labels": [{"name": "bug"}, {"name": "field-test"}],
   "body": "Signature: `bash_nonzero:gh pr comment -b \"done\" N`\n\nA signature holding quotes."}
]
JSON
}

# ft_fixture_prs <path>: the pull requests fixtures/field-test/bin/gh serves to
# `gh pr view`, covering every arm of scripts/lib/checks.jq and every claim
# ft-verify-report.sh can be handed.
#
#   50 open, every check green, skipped, or neutral      checks pass
#   51 open, a FAILURE beside a SUCCESS                 checks fail
#   52 open, a run still in progress and a PENDING      checks pending
#   53 open, no checks at all                           checks none
#   54 merged                                           state MERGED
#   55 closed unmerged                                  state CLOSED
#   56 open, a COMPLETED run with no conclusion         checks pending
#   57 open, CANCELLED beside SUCCESS                   checks fail
#   58 open, pending on the first look then green       a sequence; green stays
#   59 open, a commit status in FAILURE beside a green  checks fail (StatusContext)
#   60 open, a FAILURE beside a run still in progress   checks fail, not pending
#   61 open, no checks on the first look, then a run    a sequence; none then pending
ft_fixture_prs() {
  cat > "$1" <<'JSON'
[
  {"number": 50, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "shellcheck", "status": "COMPLETED", "conclusion": "SKIPPED"},
     {"__typename": "CheckRun", "name": "codeql", "status": "COMPLETED", "conclusion": "NEUTRAL"},
     {"__typename": "StatusContext", "context": "coverage", "state": "SUCCESS"}]},
  {"number": 51, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "FAILURE"}]},
  {"number": 52, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-3.2", "status": "IN_PROGRESS", "conclusion": null},
     {"__typename": "StatusContext", "context": "coverage", "state": "PENDING"}]},
  {"number": 53, "state": "OPEN", "isDraft": false, "statusCheckRollup": []},
  {"number": 54, "state": "MERGED", "isDraft": false,
   "statusCheckRollup": [{"__typename": "StatusContext", "context": "ci", "state": "SUCCESS"}]},
  {"number": 55, "state": "CLOSED", "isDraft": false, "statusCheckRollup": []},
  {"number": 56, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": null}]},
  {"number": 57, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "CANCELLED"}]},
  {"number": 58, "state": "OPEN", "isDraft": true,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"}],
   "sequence": [
     {"statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "IN_PROGRESS", "conclusion": null}]},
     {"statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"}]}]},
  {"number": 59, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "StatusContext", "context": "coverage", "state": "FAILURE"}]},
  {"number": 60, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "FAILURE"},
     {"__typename": "CheckRun", "name": "bash-3.2", "status": "IN_PROGRESS", "conclusion": null}]},
  {"number": 61, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "IN_PROGRESS", "conclusion": null}],
   "sequence": [{"statusCheckRollup": []}]}
]
JSON
}

# ft_fixture_report <path> <case>: what a field-test report claimed about the
# pull requests of one round.
#
#   accurate   every claim holds against ft_fixture_prs
#   wrong      claims a pull request merged that is still open
#   unknown    uses a word the verifier cannot check
#   missing    names a pull request that does not exist
ft_fixture_report() {
  local path="$1" name="${2:-accurate}"
  case "$name" in
    accurate)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins",
 "prs": [{"number": 54, "claimed": "merged"},
         {"number": 50, "claimed": "skipped"},
         {"number": 55, "claimed": "closed"}]}
JSON
      ;;
    wrong)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "merged"}]}
JSON
      ;;
    unknown)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "shepherded"}]}
JSON
      ;;
    missing)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 999, "claimed": "merged"}]}
JSON
      ;;
    *)
      printf 'ft_fixture_report: unknown case: %s\n' "$name" >&2
      return 1
      ;;
  esac
}
