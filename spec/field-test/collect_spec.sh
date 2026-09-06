# shellcheck shell=bash
# One example per branch of scripts/lib/collect.jq, per .claude/rules/type-jq.md:
# the whole jq program is one line to kcov, so a branch with no example here reads
# as covered while being untested. Each example below reaches a different arm.
Describe 'ft-collect.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  events() { ft_fixture_events "$FT_RUN_DIR/events.jsonl" "$1"; }
  kinds() { "$FT_COLLECT" "$FT_RUN_DIR" | jq -r '[.[].kind] | join(" ")'; }
  first() { "$FT_COLLECT" "$FT_RUN_DIR" | jq -r ".[0].$1"; }

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_COLLECT" --help
      The status should be success
      The output should include 'ft-collect.sh <run-dir>'
    End

    It 'exits 2 with usage when given nothing'
      When run script "$FT_COLLECT"
      The status should equal 2
      The stderr should include 'ft-collect.sh <run-dir>'
    End

    It 'rejects an unknown argument'
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --verbose
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'refuses a directory with no run marker'
      When run script "$FT_COLLECT" "$FT_SANDBOX"
      The status should equal 1
      The stderr should include 'no run marker'
    End

    It 'refuses a run marker that is not JSON'
      printf 'nope' > "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should equal 1
      The stderr should include 'not valid JSON'
    End

    It 'refuses an events file that is not JSON lines'
      printf 'nope\n' > "$FT_RUN_DIR/events.jsonl"
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should equal 1
      The stderr should include 'not valid JSON lines'
    End

    It 'treats a missing events file as no events'
      rm -f "$FT_RUN_DIR/events.jsonl"
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should equal '[]'
    End
  End

  Describe 'each kind of finding'
    It 'finds nothing in a run where every call succeeded'
      events clean
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should equal '[]'
    End

    It 'raises bash_nonzero for a command that exited non-zero'
      events nonzero
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should equal 'bash_nonzero'
      The value "$(first 'evidence.exit_code')" should equal '1'
      The value "$(first 'evidence.stderr')" should include 'unstable status'
    End

    It 'collapses the same failure on two PR numbers into one finding'
      events nonzero
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(first 'count')" should equal '2'
      The value "$(first 'signature')" should equal 'bash_nonzero:gh pr merge --auto --squash N'
    End

    It 'carries the calls that led up to the failure'
      events nonzero
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(first 'evidence.preceding | join(", ")')" should equal 'git fetch origin'
    End

    It 'raises tool_failure for a tool call that failed outright'
      events failure
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should equal 'tool_failure'
    End

    It 'raises denied, at the highest severity, for a command the hook refused'
      events denied
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should equal 'denied'
      The value "$(first 'severity')" should equal 'high'
      The value "$(first 'evidence.reason')" should include 'Force-pushing'
    End

    It 'raises subagent_contradiction when a claim of success hides an unresolved failure'
      events contradiction
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should include 'subagent_contradiction'
      The value "$(first 'evidence.claim')" should include 'were merged'
    End

    It 'raises no contradiction when the same command later succeeded for that agent'
      events retried
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should not include 'subagent_contradiction'
    End

    It 'reads a structured status that is neither failed nor paused as a claim of success'
      events status-ok
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include 'subagent_contradiction'
    End

    It 'raises no contradiction when the subagent reported the failure itself'
      events honest
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '[]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should not include 'subagent_contradiction'
    End

    It 'raises args_dropped for an option that never reached a command'
      events clean
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '["--dry-run"]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should equal 'args_dropped'
      The value "$(first 'severity')" should equal 'low'
    End

    It 'raises nothing when the option did reach a command'
      events args-used
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '["--dry-run"]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should equal '[]'
    End

    It 'ignores a positional argument, which a skill may consume itself'
      events clean
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '["acme-org/widgets"]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should equal '[]'
    End
  End

  Describe 'ordering'
    It 'puts the high-severity findings first'
      events mixed
      ft_fixture_run "$FT_RUN_DIR/run.json" gh:shepherd '["--limit"]'
      When run script "$FT_COLLECT" "$FT_RUN_DIR"
      The status should be success
      The output should include '"kind"'
      The value "$(kinds)" should equal 'denied subagent_contradiction bash_nonzero tool_failure args_dropped'
    End
  End

  Describe '--report'
    It 'prints the target own final message from the transcript'
      ft_fixture_transcript "$FT_SANDBOX/transcript.jsonl" with-report
      jq --arg t "$FT_SANDBOX/transcript.jsonl" '.transcript_path = $t' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should be success
      The output should include '| #11 | merged |'
      The output should not include 'Starting the round'
    End

    It 'skips a line the transcript was cut off mid-write'
      ft_fixture_transcript "$FT_SANDBOX/transcript.jsonl" truncated
      jq --arg t "$FT_SANDBOX/transcript.jsonl" '.transcript_path = $t' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should be success
      The output should equal 'the whole line'
    End

    It 'prints the last turn that said something, not the tool call after it'
      ft_fixture_transcript "$FT_SANDBOX/transcript.jsonl" tool-tail
      jq --arg t "$FT_SANDBOX/transcript.jsonl" '.transcript_path = $t' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should be success
      The output should include '| #11 | merged |'
    End

    It 'prints nothing when the transcript holds no assistant turn'
      ft_fixture_transcript "$FT_SANDBOX/transcript.jsonl" no-assistant
      jq --arg t "$FT_SANDBOX/transcript.jsonl" '.transcript_path = $t' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should be success
      The output should equal ''
    End

    It 'says so when no hook ever recorded a transcript path'
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should equal 1
      The stderr should include 'no transcript_path'
    End

    It 'says so when the transcript is gone'
      jq '.transcript_path = "/nowhere/transcript.jsonl"' "$FT_RUN_DIR/run.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_RUN_DIR/run.json"
      When run script "$FT_COLLECT" "$FT_RUN_DIR" --report
      The status should equal 1
      The stderr should include 'no transcript at'
    End
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_COLLECT" "$FT_RUN_DIR"
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
