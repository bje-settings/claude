# shellcheck shell=bash
# The hooks run on every Bash call in every session, so the case that matters most
# is the one where nothing is happening: no run marker, no work, no output.
Describe 'the field-test hooks'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  input() { ft_fixture_hook_input "$FT_SANDBOX/payload.json" "$1" "${2:-ft-session}"; }
  hook() { "$FT_HOOK" "$1" < "$FT_SANDBOX/payload.json"; }
  events() { cat "$FT_RUN_DIR/events.jsonl"; }
  event_count() { awk 'NF { n++ } END { print n + 0 }' "$FT_RUN_DIR/events.jsonl" 2>/dev/null; }
  finish_run() {
    jq '.finished_at = "2026-01-02T04:00:00Z"' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
    mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
  }

  Describe 'a session that is not a field test'
    It 'records nothing and says nothing when there is no run marker'
      rm -f "$FT_RUN_DIR/run.json"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    It 'records nothing once the run has finished'
      finish_run
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'records nothing for a different session'
      input post-ok other-session
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'records nothing when no state directory is configured'
      unset FT_STATE_DIR
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'survives a payload that is not JSON'
      input malformed
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    It 'survives a run marker that is not JSON'
      printf 'nope' > "$FT_RUN_DIR/run.json"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'exits 0 with no event name at all'
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK"
      The status should be success
      The output should equal ''
    End

    It 'exits 0 on an event it does not handle'
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreCompact
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End
  End

  Describe 'recording Bash calls'
    It 'records a successful call, so a failure can be read in sequence'
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(events | jq -r '.command')" should equal 'git fetch origin'
      The value "$(events | jq -r '.exit_code')" should equal '0'
      The value "$(events | jq -r '.event')" should equal 'PostToolUse'
    End

    It 'records the exit code however the payload spells it, plus the stderr tail'
      input post-fail
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(events | jq -r '.exit_code')" should equal '1'
      The value "$(events | jq -r '.stderr_tail')" should include 'unstable status'
    End

    It 'does not read a boolean where an exit code belongs as a failure'
      input post-bool-code
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(events | jq -r '.exit_code')" should equal 'null'
    End

    It 'records which subagent made the call'
      input post-fail
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(events | jq -r '.agent_id')" should equal 'agent-1'
      The value "$(events | jq -r '.agent_type')" should equal 'shepherd-repo'
    End

    It 'records a call that failed outright under its own event name'
      input post-failure
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUseFailure
      The status should be success
      The value "$(events | jq -r '.event')" should equal 'PostToolUseFailure'
      The value "$(events | jq -r '.command')" should equal 'bash scripts/does-not-exist.sh'
    End

    # A PostToolUseFailure payload has no tool_response: the exit code is the first
    # line of a top-level error string, and the output is the rest of it. Read only
    # tool_response and every tool_failure issue says the exit code was not recorded
    # and shows an empty output block.
    It 'reads the exit code and the output out of a failure error string'
      input post-failure
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUseFailure
      The status should be success
      The value "$(events | jq -r '.exit_code')" should equal '127'
      The value "$(events | jq -r '.stderr_tail')" should include 'No such file or directory'
    End

    It 'records a failure whose error text names no exit code'
      input post-failure-no-code
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUseFailure
      The status should be success
      The value "$(events | jq -r '.exit_code')" should equal 'null'
      The value "$(events | jq -r '.stderr_tail')" should include 'interrupted'
    End

    It 'keeps the tail of a long error, which is where the reason is'
      long="$(python3 -c 'print("HEAD" + "x" * 4000 + "TAIL")')"
      jq -nc --arg s ft-session --arg e "$long" \
        '{session_id: $s, tool_name: "Bash", tool_input: {command: "bash spec/run.sh"}, error: $e}' \
        > "$FT_SANDBOX/payload.json"
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUseFailure
      The status should be success
      The value "$(events | jq -r '.stderr_tail | length')" should equal '2000'
      The value "$(events | jq -r '.stderr_tail')" should include 'TAIL'
      The value "$(events | jq -r '.stderr_tail')" should not include 'HEAD'
    End

    It 'ignores a tool that is not Bash'
      input pre-other
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'records the transcript path on the marker the first time it sees one'
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(jq -r '.transcript_path' "$FT_RUN_DIR/run.json")" should equal '/transcripts/main.jsonl'
    End

    It 'does not overwrite a transcript path it already has'
      jq '.transcript_path = "/transcripts/first.jsonl"' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(jq -r '.transcript_path' "$FT_RUN_DIR/run.json")" should equal '/transcripts/first.jsonl'
    End
  End

  Describe 'subagents and the end of the run'
    It 'records a subagent last message, which is the claim worth checking'
      input subagent-stop
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" SubagentStop
      The status should be success
      The value "$(events | jq -r '.last_assistant_message')" should include 'were merged'
      # The subagent's own transcript, not the main session's, which the payload also
      # carries and which every SubagentStop would otherwise point at.
      The value "$(events | jq -r '.transcript_path')" should equal '/transcripts/agent-1.jsonl'
    End

    It 'marks the run finished when the session stops'
      input stop
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" Stop
      The status should be success
      The value "$(events | jq -r '.event')" should equal 'Stop'
      The value "$(jq -r '.finished_at | length > 0' "$FT_RUN_DIR/run.json")" should equal 'true'
    End

    # A marker that never gets its finished_at wedges the session: every later hook
    # keeps recording, and the next start is refused as a run already running.
    It 'records the finish it could not make, rather than leaving the run wedged'
      printf 'nope' > "$FT_RUN_DIR/run.json.broken"
      export FT_RUN_SH="$FT_SANDBOX/failing-run.sh"
      printf '#!/bin/sh\necho "cannot write the marker" >&2\nexit 1\n' > "$FT_RUN_SH"
      chmod +x "$FT_RUN_SH"
      input stop
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" Stop
      The status should be success
      The value "$(events | jq -r 'select(.event == "hook_error") | .hook')" should equal 'Stop'
      The value "$(events | jq -r 'select(.event == "hook_error") | .error')" should include 'cannot write the marker'
    End

    It 'still exits 0 when the run script it calls is gone'
      export FT_RUN_SH="$FT_SANDBOX/nowhere.sh"
      input stop
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" Stop
      The status should be success
      The value "$(events | jq -rs '[.[].event] | join(" ")')" should equal 'Stop hook_error'
    End
  End

  Describe 'a payload or marker it cannot use'
    It 'records nothing when the payload is JSON but not an object'
      printf '[1, 2, 3]' > "$FT_SANDBOX/payload.json"
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End

    It 'records nothing when the run marker is JSON but not an object'
      printf '[]' > "$FT_RUN_DIR/run.json"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The value "$(event_count)" should equal '0'
    End
  End

  Describe 'the deny list'
    # Every pattern in hooks/deny-list.txt has a denied sample in
    # fixtures/field-test/commands/deny.txt, and allow.txt holds the near misses no
    # pattern may match. Both files are walked here: a pattern that stops matching,
    # or starts matching too much, fails one of these two.
    payload_for() {
      jq -nc --arg s ft-session --arg c "$1" \
        '{session_id: $s, tool_name: "Bash", tool_input: {command: $c}}' > "$FT_SANDBOX/payload.json"
    }
    decisions() {
      # decisions <file> <expected>: the commands whose decision was not expected
      local command decision
      while IFS= read -r command; do
        [ -n "$command" ] || continue
        payload_for "$command"
        decision=no
        case "$(hook PreToolUse)" in *'"deny"'*) decision=yes ;; esac
        [ "$decision" = "$2" ] || printf '%s\n' "$command"
      done < "$FT_FIXTURES_DIR/commands/$1"
    }

    It 'refuses every command the list names'
      When call decisions deny.txt yes
      The status should be success
      The output should equal ''
    End

    It 'allows every command the list is careful not to name'
      When call decisions allow.txt no
      The status should be success
      The output should equal ''
    End

    # deny.txt is one command per line, so the only place the `(?s)` in every rule can
    # be exercised is here. Drop it and a wrapped or chained command walks through.
    It 'refuses a command the list names when it is wrapped across lines'
      payload_for 'git push \
  --mirror git@github.com:acme/copy.git'
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The output should include 'mirror push'
    End

    It 'refuses a command the list names when it follows a newline in an && chain'
      payload_for 'git fetch origin &&
git push origin --delete wktr-9-old'
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The output should include 'Deleting a remote branch'
    End

    It 'tells the target why, in the words of the list itself'
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"permissionDecision": "deny"'
      The output should include 'Force-pushing rewrites history'
      The output should include 'Blocked by the field-test plugin'
    End

    It 'records the attempt, which is the finding'
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The value "$(events | jq -r '.event')" should equal 'denied'
      The value "$(events | jq -r '.command')" should equal 'git push --force origin main'
    End

    It 'says nothing and records nothing for a command it allows'
      input pre-allow
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    It 'ignores a tool that is not Bash'
      input pre-other
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    It 'ignores a Bash call with no command'
      jq -nc '{session_id: "ft-session", tool_name: "Bash", tool_input: {}}' > "$FT_SANDBOX/payload.json"
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should equal ''
    End

    It 'blocks nothing when the list cannot be read, rather than blocking everything'
      export FT_DENY_LIST="$FT_SANDBOX/missing-list.txt"
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should equal ''
    End

    It 'skips a line of the list that is not a valid expression'
      printf '# broken\n[unclosed\n# real\ngit push --force\n' > "$FT_SANDBOX/list.txt"
      export FT_DENY_LIST="$FT_SANDBOX/list.txt"
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The output should include 'real'
      # Not just 'real': the comment above the rule that was dropped must not be read
      # as the reason for the rule that fired.
      The output should not include 'broken'
    End

    It 'records the rule it had to drop, so a hole in the guardrail is not silent'
      printf '# broken\n[unclosed\n\n# real\ngit push --force\n' > "$FT_SANDBOX/list.txt"
      export FT_DENY_LIST="$FT_SANDBOX/list.txt"
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The value "$(events | jq -r 'select(.event == "deny_list_error") | .pattern')" should equal '[unclosed'
      The value "$(events | jq -r 'select(.event == "deny_list_error") | .line')" should equal '2'
      The value "$(events | jq -r 'select(.event == "deny_list_error") | .error | length > 0')" should equal 'true'
    End

    It 'records nothing and denies nothing when the command is not a string'
      jq -nc --arg s ft-session \
        '{session_id: $s, tool_name: "Bash", tool_input: {command: ["rm", "-rf", "/"]}}' \
        > "$FT_SANDBOX/payload.json"
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    # An OverflowError, not an re.error: caught only as a syntax error, one rule
    # written this way takes the whole list down for that call.
    It 'costs one rule, not the list, when a pattern breaks the engine outright'
      printf '# too big\na{4294967296}\n\n# real\ngit push --force\n' > "$FT_SANDBOX/list.txt"
      export FT_DENY_LIST="$FT_SANDBOX/list.txt"
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include '"deny"'
      The value "$(events | jq -r 'select(.event == "deny_list_error") | .pattern')" should equal 'a{4294967296}'
    End

    It 'falls back to the pattern itself when a rule has no comment'
      printf 'git push --force\n' > "$FT_SANDBOX/list.txt"
      export FT_DENY_LIST="$FT_SANDBOX/list.txt"
      input pre-deny
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PreToolUse
      The status should be success
      The output should include 'git push --force'
    End
  End

  Describe 'hook-io.py directly'
    It 'prints usage for an event it does not know'
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run command python3 "$FT_HOOK_IO" Whatever
      The status should be success
      The stderr should include 'usage: hook-io.py'
    End
  End
  Describe 'a machine without python3'
    It 'exits 0 and records nothing rather than failing the tool call'
      export PATH="$(ft_path_without python3)"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_HOOK" PostToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End

    It 'exits 0 when its own JSON helper is missing'
      cp "$FT_HOOK" "$FT_SANDBOX/lonely-hook.sh"
      input post-ok
      Data "$(cat "$FT_SANDBOX/payload.json")"
      When run script "$FT_SANDBOX/lonely-hook.sh" PostToolUse
      The status should be success
      The output should equal ''
      The value "$(event_count)" should equal '0'
    End
  End

  # Every example above calls ft-hook.sh directly, so nothing here would notice a
  # manifest that names the wrong event, points at a script that is not there, or
  # drops an event entirely. Installed, that is a plugin that records nothing and
  # never finishes a run, with a green suite.
  Describe 'the hooks.json manifest'
    manifest() { printf '%s' "$FT_PLUGIN_DIR/hooks/hooks.json"; }

    It 'passes each hook the event name it is registered under'
      mismatched() {
        jq -r '.hooks | to_entries[] | . as $e | .value[].hooks[]
               | select((.command | endswith(" " + $e.key)) | not) | $e.key' "$(manifest)"
      }
      When call mismatched
      The status should be success
      The output should equal ''
    End

    It 'points every hook at a script that is there'
      missing() {
        jq -r '.hooks[][].hooks[].command' "$(manifest)" \
          | sed -e 's|.*${CLAUDE_PLUGIN_ROOT}/||' -e 's|" .*||' \
          | while IFS= read -r rel; do
              [ -f "$FT_PLUGIN_DIR/$rel" ] || printf '%s\n' "$rel"
            done
      }
      When call missing
      The status should be success
      The output should equal ''
    End

    It 'registers exactly the events the JSON helper handles'
      registered() { jq -r '.hooks | keys_unsorted | sort | join(" ")' "$(manifest)"; }
      handled() {
        grep '^EVENTS = ' "$FT_HOOK_IO" | grep -o '"[A-Za-z]*"' | tr -d '"' | sort | tr '\n' ' ' \
          | sed 's/ $//'
      }
      When call registered
      The status should be success
      The output should equal "$(handled)"
    End
  End

End
