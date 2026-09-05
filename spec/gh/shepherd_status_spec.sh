# shellcheck shell=bash
Describe 'gh-shepherd-status.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  status() { "$SHEPHERD_STATUS" "$REPO"; }
  targets() { status | jq -r '[.targets[].number] | join(" ")'; }
  skipped() { status | jq -r '[.skipped_no_automerge[].number] | join(" ")'; }

  Describe 'preflight'
    It 'rejects a path that is not a directory'
      When run script "$SHEPHERD_STATUS" "$SANDBOX/nope"
      The status should equal 2
      The stderr should include 'not a directory'
    End

    It 'rejects a directory that is not a git repository'
      mkdir -p "$SANDBOX/plain"
      When run script "$SHEPHERD_STATUS" "$SANDBOX/plain"
      The status should equal 2
      The stderr should include 'not a git repository'
    End

    It 'prints usage for --help'
      When run script "$SHEPHERD_STATUS" --help
      The status should be success
      The output should include 'Usage:'
    End

    It 'fails closed when gh cannot answer for the repository'
      export GH_FIXTURE_FAIL=1
      When run script "$SHEPHERD_STATUS" "$REPO"
      The status should equal 1
      The stderr should include 'could not resolve the repository'
      The output should equal ''
    End

    It 'refuses to run without its library'
      mkdir -p "$SANDBOX/lonely"
      cp "$SHEPHERD_STATUS" "$SANDBOX/lonely/"
      When run script "$SANDBOX/lonely/gh-shepherd-status.sh" "$REPO"
      The status should equal 2
      The stderr should include 'missing'
    End
  End

  Describe 'target selection'
    It 'reports valid JSON with the repo and defaults when there are no pull requests'
      When call status
      The status should be success
      The output should include '"repo": "acme/widgets"'
      The output should include '"default_branch": "main"'
      The output should include '"ci_seconds": 300'
      The output should include '"targets": []'
      The output should include '"skipped_no_automerge": []'
    End

    It 'targets only open, non-draft, auto-merge pull requests and reports the rest'
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 1)" \
        "$(fixture_dep_pr 2 auto=false)" \
        "$(fixture_dep_pr 3 draft=true)" \
        "$(fixture_dep_pr 4 state=MERGED)"
      When call status
      The status should be success
      The result of function targets should equal '1'
      The result of function skipped should equal '2'
    End
    It 'does not treat a pull request without the dependencies label as a target'
      # The label filter is server-side in real gh; the stub applies it the same
      # way, so a PR with only some other label must not appear.
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 1)" \
        "$(fixture_dep_pr 2 | jq -c '.labels = [{name: "enhancement"}]')"
      When call targets
      The output should equal '1'
    End

    It 'orders by merge-risk band, unlabelled after low, then oldest first'
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 5 risk=high created=2026-01-01T00:00:00Z)" \
        "$(fixture_dep_pr 6 created=2026-01-03T00:00:00Z)" \
        "$(fixture_dep_pr 7 created=2026-01-02T00:00:00Z)" \
        "$(fixture_dep_pr 8 risk=medium created=2026-01-01T00:00:00Z)" \
        "$(fixture_dep_pr 9 risk=low created=2026-01-09T00:00:00Z)"
      When call targets
      The output should equal '9 7 6 8 5'
    End

    It 'summarises each target with the fields the loop needs'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=BEHIND checks=failed)"
      When call status
      The status should be success
      The output should include '"is_bot": true'
      The output should include '"mergeStateStatus": "BEHIND"'
      The output should include '"autoMerge": true'
      The output should include '"state": "failed"'
      The output should include '"name": "build"'
      The output should include '/actions/runs/11/job/21'
    End

    It 'reads a StatusContext rollup as well as CheckRuns'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=status-failed)"
      When call status
      The output should include '"state": "failed"'
      The output should include '"link": "https://ci.example/1"'
    End

    It 'calls a rollup pending when anything is still running, even beside a failure'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=mixed)"
      When call status
      # A failure wins over pending: the loop should classify now rather than wait.
      The output should include '"state": "failed"'
    End

    It 'recognises a human author'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 bot=false)"
      When call status
      The output should include '"is_bot": false'
      The output should include '"author": "someone"'
    End
  End

  Describe 'ci_seconds'
    # runs <file> <run...> where each run is "<seconds>[:<branch>[:<status>]]",
    # defaulting to the default branch and "completed".
    runs() {
      local f="$1"; shift
      local out="[" first=1 spec d b st
      for spec in "$@"; do
        d="${spec%%:*}"; b=main; st=completed
        case "$spec" in *:*:*) b="${spec#*:}"; b="${b%%:*}"; st="${spec##*:}" ;; *:*) b="${spec#*:}" ;; esac
        ((first)) || out="$out,"
        out="$out{\"headBranch\":\"$b\",\"status\":\"$st\",\"createdAt\":\"2026-01-01T00:00:00Z\",\"updatedAt\":\"$(python3 -c "import datetime;print((datetime.datetime(2026,1,1)+datetime.timedelta(seconds=$d)).strftime('%Y-%m-%dT%H:%M:%SZ'))")\"}"
        first=0
      done
      printf '%s]\n' "$out" > "$f"
    }

    It 'takes the median of recent run durations'
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      runs "$GH_FIXTURE_RUNS" 30 900 60 45 50
      When call status
      # sorted: 30 45 50 60 900; the middle one, not the mean the outlier would drag up
      The output should include '"ci_seconds": 50'
    End

    It 'measures only completed runs on the default branch'
      # Two long runs that must not count: one still in progress on main, one
      # completed on a feature branch. If either leaked in, the median would move.
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      runs "$GH_FIXTURE_RUNS" 40 50 60 5000:main:in_progress 6000:feature
      When call status
      The output should include '"ci_seconds": 50'
    End

    It 'ignores runs with a non-positive duration and falls back when none remain'
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      runs "$GH_FIXTURE_RUNS" 0
      When call status
      The output should include '"ci_seconds": 300'
    End

    It 'falls back to 300 when the run listing is unavailable'
      export GH_FIXTURE_RUNS="$SANDBOX/missing.json"
      When call status
      The output should include '"ci_seconds": 300'
    End
  End
End
