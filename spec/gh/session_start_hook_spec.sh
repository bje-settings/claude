# shellcheck shell=bash
Describe 'session-start.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  payload() { printf '{"session_id":"s1","cwd":"%s"}' "$1"; }

  # Asserts the hook's stdout is one JSON object carrying the SessionStart
  # contract. Run via `When call` so it executes where spec functions are visible.
  validate_hook_json() {
    printf '%s' "$1" | python3 -c '
import json, sys
h = json.load(sys.stdin)["hookSpecificOutput"]
assert h["hookEventName"] == "SessionStart", h
assert isinstance(h["additionalContext"], str) and h["additionalContext"].strip()
'
  }

  Describe 'inside a git repository'
    It 'stays silent on the default branch'
      Data "$(payload "$REPO")"
      When run script "$HOOK"
      The status should be success
      The output should equal ''
    End

    It 'asks about syncing when HEAD is not on the default branch'
      fixture_git "$REPO" checkout -q -b side
      Data "$(payload "$REPO")"
      When run script "$HOOK"
      The status should be success
      The output should include 'side'
      The output should include 'main'
      The output should include '/gh:sync'
      The output should include 'Ask'
    End

    It 'emits valid JSON carrying the SessionStart contract'
      fixture_git "$REPO" checkout -q -b side
      json="$(payload "$REPO" | bash "$HOOK")"
      When call validate_hook_json "$json"
      The status should be success
    End

    It 'does not reach the network for the in-repo check'
      # Proven by breaking the remote: a fetch would fail and change the report.
      fixture_git "$REPO" checkout -q -b side
      fixture_git "$REPO" remote set-url origin /nonexistent/nope.git
      Data "$(payload "$REPO")"
      When run script "$HOOK"
      The status should be success
      The output should include 'side'
    End
  End

  Describe 'outside a git repository'
    It 'stays silent when there are no repositories to report on'
      mkdir -p "$SANDBOX/empty"
      Data "$(payload "$SANDBOX/empty")"
      When run script "$HOOK"
      The status should be success
      The output should equal ''
    End

    It 'stays silent when every repository is already in order'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      Data "$(payload "$SANDBOX/fan")"
      When run script "$HOOK"
      The status should be success
      The output should equal ''
    End

    It 'reports when a repository has prunable work, and changes nothing'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      fixture_branch_with_work "$SANDBOX/fan/a" gone
      fixture_merge_commit "$SANDBOX/fan/a" gone
      before="$(branches "$SANDBOX/fan/a")"
      json="$(payload "$SANDBOX/fan" | bash "$HOOK")"
      When call validate_hook_json "$json"
      The status should be success
      The value "$json" should include 'would delete gone'
      The value "$(branches "$SANDBOX/fan/a")" should equal "$before"
    End

    It 'speaks up when the merge lookups were degraded rather than reporting silence'
      # Nothing is actionable here, but nothing could be checked either, and
      # silence would read as "everything is in order".
      export GH_FIXTURE_FAIL=1
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      fixture_branch_with_work "$SANDBOX/fan/a" wip
      Data "$(payload "$SANDBOX/fan")"
      When run script "$HOOK"
      The status should be success
      The output should include 'could not read merged pull requests'
    End
  End

  Describe 'robustness, because a hook must never block a session'
    It 'exits cleanly on a malformed payload'
      Data 'not json at all'
      When run script "$HOOK"
      The status should be success
      The stdout should be defined
    End

    It 'exits cleanly on an empty payload'
      Data ''
      When run script "$HOOK"
      The status should be success
      The stdout should be defined
    End

    It 'exits cleanly when cwd names a directory that does not exist'
      Data "$(payload "$SANDBOX/gone")"
      When run script "$HOOK"
      The status should be success
      The stdout should be defined
    End
  End
End
