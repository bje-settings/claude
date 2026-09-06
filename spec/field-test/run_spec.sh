# shellcheck shell=bash
# Every example runs the script through `When run script` so kcov traces it; the
# helpers only read the resulting marker back.
Describe 'ft-run.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  marker() { printf '%s/run.json' "$FT_RUN_DIR"; }
  field() { jq -r "$1" "$(marker)"; }
  fresh() { rm -f "$FT_RUN_DIR/run.json" "$FT_RUN_DIR/events.jsonl"; }

  Describe 'location'
    It 'prints the run directory under the state dir'
      When run script "$FT_RUN" dir
      The status should be success
      The output should equal "$FT_STATE_DIR/runs/ft-session"
    End

    It 'falls back to CLAUDE_PLUGIN_DATA when FT_STATE_DIR is unset'
      unset FT_STATE_DIR
      export CLAUDE_PLUGIN_DATA="$FT_SANDBOX/data"
      When run script "$FT_RUN" dir
      The status should be success
      The output should equal "$FT_SANDBOX/data/runs/ft-session"
    End

    It 'refuses to guess a location when neither is set'
      unset FT_STATE_DIR
      When run script "$FT_RUN" dir
      The status should equal 2
      The stderr should include 'CLAUDE_PLUGIN_DATA'
    End

    It 'refuses to guess a session'
      unset CLAUDE_CODE_SESSION_ID
      When run script "$FT_RUN" dir
      The status should equal 2
      The stderr should include 'no session id'
    End

    It 'takes the session from --session over the environment'
      When run script "$FT_RUN" dir --session other-session
      The status should be success
      The output should equal "$FT_STATE_DIR/runs/other-session"
    End

    It 'rejects --session with no value'
      When run script "$FT_RUN" dir --session
      The status should equal 2
      The stderr should include '--session needs a value'
    End
  End

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_RUN" --help
      The status should be success
      The output should include 'ft-run.sh start'
    End

    It 'exits 2 with usage when given no command'
      When run script "$FT_RUN"
      The status should equal 2
      The stderr should include 'ft-run.sh start'
    End

    It 'rejects an unknown command'
      When run script "$FT_RUN" restart
      The status should equal 2
      The stderr should include 'unknown command: restart'
    End
  End

  Describe 'start'
    BeforeEach 'fresh'

    It 'writes a marker naming the target, the arguments, and the directory'
      When run script "$FT_RUN" start gh:shepherd --cwd /checkout -- --dry-run --limit 2
      The status should be success
      The output should equal "$FT_RUN_DIR/run.json"
      The value "$(field '.target')" should equal 'gh:shepherd'
      The value "$(field '.cwd')" should equal '/checkout'
      The value "$(field '.args | join(" ")')" should equal '--dry-run --limit 2'
      The value "$(field '.session_id')" should equal 'ft-session'
      The value "$(field '.finished_at')" should equal 'null'
    End

    It 'records no arguments as an empty list, not an empty string'
      When run script "$FT_RUN" start gh:sync
      The status should be success
      The output should include 'run.json'
      The value "$(field '.args | length')" should equal '0'
    End

    It 'creates an empty events file for the hooks to append to'
      When run script "$FT_RUN" start gh:sync
      The status should be success
      The output should include 'run.json'
      The path "$FT_RUN_DIR/events.jsonl" should be exist
    End

    It 'folds in what ft-resolve.sh said about the target'
      printf '{"kind":"plugin-skill","plugin":"gh","version":"0.2.0","commit":"deadbee"}' > "$FT_SANDBOX/r.json"
      When run script "$FT_RUN" start gh:shepherd --resolved "$FT_SANDBOX/r.json"
      The status should be success
      The output should include 'run.json'
      The value "$(field '.resolved.plugin')" should equal 'gh'
      The value "$(field '.resolved.commit')" should equal 'deadbee'
    End

    It 'leaves resolved null when it was not told'
      When run script "$FT_RUN" start gh:shepherd
      The status should be success
      The output should include 'run.json'
      The value "$(field '.resolved')" should equal 'null'
    End

    It 'needs a target'
      When run script "$FT_RUN" start
      The status should equal 2
      The stderr should include 'start needs a target'
    End

    It 'rejects an unknown option'
      When run script "$FT_RUN" start gh:sync --verbose
      The status should equal 2
      The stderr should include 'unknown argument: --verbose'
    End

    It 'rejects --resolved with no value'
      When run script "$FT_RUN" start gh:sync --resolved
      The status should equal 2
      The stderr should include '--resolved needs a value'
    End

    It 'rejects --cwd with no value'
      When run script "$FT_RUN" start gh:sync --cwd
      The status should equal 2
      The stderr should include '--cwd needs a value'
    End

    It 'refuses a resolved file that is not there'
      When run script "$FT_RUN" start gh:sync --resolved "$FT_SANDBOX/nope.json"
      The status should equal 2
      The stderr should include 'no such resolved file'
    End

    It 'refuses a resolved file that is not JSON'
      printf 'not json' > "$FT_SANDBOX/r.json"
      When run script "$FT_RUN" start gh:sync --resolved "$FT_SANDBOX/r.json"
      The status should equal 1
      The stderr should include 'not valid JSON'
    End

    It 'refuses to start a second run over a live one'
      ft_fixture_run "$FT_RUN_DIR/run.json"
      When run script "$FT_RUN" start gh:sync
      The status should equal 3
      The stderr should include 'already running'
    End

    It 'starts again once the previous run finished'
      ft_fixture_run "$FT_RUN_DIR/run.json"
      jq '.finished_at = "2026-01-02T04:00:00Z"' "$FT_RUN_DIR/run.json" > "$FT_RUN_DIR/x" && mv "$FT_RUN_DIR/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_RUN" start gh:sync
      The status should be success
      The output should include 'run.json'
      The value "$(field '.target')" should equal 'gh:sync'
      The value "$(field '.finished_at')" should equal 'null'
    End

    It 'reports a state directory it cannot create'
      : > "$FT_SANDBOX/blocked"
      export FT_STATE_DIR="$FT_SANDBOX/blocked"
      When run script "$FT_RUN" start gh:sync
      The status should equal 1
      The stderr should include 'cannot create'
    End
  End

  Describe 'finish and show'
    It 'stamps the finish time'
      When run script "$FT_RUN" finish
      The status should be success
      The value "$(field '.finished_at | length > 0')" should equal 'true'
    End

    It 'keeps the first finish time when finish runs twice'
      "$FT_RUN" finish
      first="$(field '.finished_at')"
      When run script "$FT_RUN" finish
      The status should be success
      The value "$(field '.finished_at')" should equal "$first"
    End

    It 'refuses to finish a session with no run'
      fresh
      When run script "$FT_RUN" finish
      The status should equal 1
      The stderr should include 'no field test is running'
    End

    It 'prints the marker'
      When run script "$FT_RUN" show
      The status should be success
      The output should include '"target": "gh:shepherd"'
    End

    It 'refuses to show a session with no run'
      fresh
      When run script "$FT_RUN" show
      The status should equal 1
      The stderr should include 'no field test is running'
    End
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_RUN" dir
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
