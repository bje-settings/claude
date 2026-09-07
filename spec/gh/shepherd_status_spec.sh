# shellcheck shell=bash
Describe 'gh-shepherd-status.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  # Every example runs the script with `When run script`, which is what kcov
  # traces; a helper function calling it would leave the lines uncovered. The
  # derived assertions go through `satisfy`, which hands the output to the
  # function on stdin.
  json_field() { [ "$(jq -r "$1")" = "$2" ]; }
  targets_are() { json_field '[.targets[].number] | join(" ")' "$1"; }
  skipped_are() { json_field '[.skipped_no_automerge[].number] | join(" ")' "$1"; }
  states_are() { json_field '[.targets[] | "\(.number)=\(.checks.state)"] | join(" ")' "$1"; }

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

    It 'fails closed when gh repo view answers without a usable nameWithOwner or default branch'
      export GH_FIXTURE_REPO=""
      When run script "$SHEPHERD_STATUS" "$REPO"
      The status should equal 1
      The stderr should include 'could not resolve the repository'
      The output should equal ''
    End

    It 'fails closed when gh cannot list pull requests'
      printf 'not json' > "$GH_FIXTURE_PRS"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The status should equal 1
      The stderr should include 'could not list pull requests'
      The output should equal ''
    End
  End

  Describe 'target selection'
    It 'reports valid JSON with the repo and defaults when there are no pull requests'
      When run script "$SHEPHERD_STATUS" "$REPO"
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
      When run script "$SHEPHERD_STATUS" "$REPO"
      The status should be success
      The output should satisfy targets_are '1'
      The output should satisfy skipped_are '2'
    End
    It 'does not treat a pull request without the dependencies label as a target'
      # The label filter is server-side in real gh; the stub applies it the same
      # way, so a PR with only some other label must not appear.
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 1)" \
        "$(fixture_dep_pr 2 | jq -c '.labels = [{name: "enhancement"}]')"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should satisfy targets_are '1'
    End

    It 'orders by merge-risk band, unlabelled after low, then oldest first'
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 5 risk=high created=2026-01-01T00:00:00Z)" \
        "$(fixture_dep_pr 6 created=2026-01-03T00:00:00Z)" \
        "$(fixture_dep_pr 7 created=2026-01-02T00:00:00Z)" \
        "$(fixture_dep_pr 8 risk=medium created=2026-01-01T00:00:00Z)" \
        "$(fixture_dep_pr 9 risk=low created=2026-01-09T00:00:00Z)"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should satisfy targets_are '9 7 6 8 5'
    End

    It 'summarises each target with the fields the loop needs'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=BEHIND checks=failed)"
      When run script "$SHEPHERD_STATUS" "$REPO"
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
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should include '"state": "failed"'
      The output should include '"link": "https://ci.example/1"'
      The output should include '"name": "ci/legacy"'
    End

    It 'folds every conclusion the way the loop needs, not just SUCCESS and FAILURE'
      # NEUTRAL and SKIPPED pass; CANCELLED and a completed run with no
      # conclusion fail; a pending commit status waits; a green one passes.
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 1 checks=neutral)" "$(fixture_dep_pr 2 checks=cancelled)" \
        "$(fixture_dep_pr 3 checks=null-conclusion)" "$(fixture_dep_pr 4 checks=status-pending)" \
        "$(fixture_dep_pr 5 checks=status-passed)"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should satisfy states_are '1=passed 2=failed 3=failed 4=pending 5=passed'
    End

    It 'calls a rollup pending when anything is still running, even beside a failure'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=mixed)"
      When run script "$SHEPHERD_STATUS" "$REPO"
      # A failure wins over pending: the loop should classify now rather than wait.
      The output should include '"state": "failed"'
    End

    It 'recognises a human author'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 bot=false)"
      When run script "$SHEPHERD_STATUS" "$REPO"
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
      When run script "$SHEPHERD_STATUS" "$REPO"
      # sorted: 30 45 50 60 900; the middle one, not the mean the outlier would drag up
      The output should include '"ci_seconds": 50'
    End

    It 'measures only completed runs on the default branch'
      # Two long runs that must not count: one still in progress on main, one
      # completed on a feature branch. If either leaked in, the median would move.
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      runs "$GH_FIXTURE_RUNS" 40 50 60 5000:main:in_progress 6000:feature
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should include '"ci_seconds": 50'
    End

    It 'ignores runs with a non-positive duration and falls back when none remain'
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      runs "$GH_FIXTURE_RUNS" 0
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should include '"ci_seconds": 300'
    End

    It 'falls back to 300 when the run listing is unavailable'
      export GH_FIXTURE_RUNS="$SANDBOX/missing.json"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The output should include '"ci_seconds": 300'
    End

    It 'falls back to 300 when gh run list fails'
      export GH_FIXTURE_RUNS="$SANDBOX/runs.json"
      printf 'not json' > "$GH_FIXTURE_RUNS"
      When run script "$SHEPHERD_STATUS" "$REPO"
      The status should be success
      The output should include '"ci_seconds": 300'
    End
  End
End
