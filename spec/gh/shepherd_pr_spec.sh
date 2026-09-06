# shellcheck shell=bash
Describe 'gh-shepherd-pr.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  # Every example runs the script with `When run script`, which is what kcov
  # traces; a helper function calling it would leave the lines uncovered.
  # json_field <jq-path> <expected>: assert one field of the JSON output. The
  # satisfy matcher hands the subject to the function on stdin.
  json_field() { [ "$(jq -r "$1")" = "$2" ]; }
  # Prints NONE when no comment was ever posted, so "nothing posted" is a
  # positive assertion rather than an empty string that could mean anything.
  comments() { if [ -f "$GH_FIXTURE_PRS.comments" ]; then cat "$GH_FIXTURE_PRS.comments"; else printf 'NONE'; fi; }
  head_1() { jq -r '.[] | select(.number == 1) | .headRefOid' "$GH_FIXTURE_PRS"; }

  Describe 'preflight'
    It 'prints usage with too few arguments'
      When run script "$SHEPHERD_PR" "$REPO" 1
      The status should equal 2
      The stderr should include 'Usage:'
    End

    It 'prints usage for --help'
      When run script "$SHEPHERD_PR" --help
      The status should be success
      The output should include 'Usage:'
    End

    It 'rejects a non-numeric pull request number'
      When run script "$SHEPHERD_PR" "$REPO" abc state
      The status should equal 2
      The stderr should include 'not a pull request number'
    End

    It 'rejects a path that is not a directory'
      When run script "$SHEPHERD_PR" "$SANDBOX/nope" 1 state
      The status should equal 2
      The stderr should include 'not a directory'
    End

    It 'rejects a directory that is not a git repository'
      mkdir -p "$SANDBOX/plain"
      When run script "$SHEPHERD_PR" "$SANDBOX/plain" 1 state
      The status should equal 2
      The stderr should include 'not a git repository'
    End

    It 'rejects an unknown action'
      When run script "$SHEPHERD_PR" "$REPO" 1 dance
      The status should equal 2
      The stderr should include 'unknown action: dance'
    End

    It 'fails closed when gh cannot resolve the repository'
      export GH_FIXTURE_FAIL=1
      When run script "$SHEPHERD_PR" "$REPO" 1 state
      The status should equal 1
      The stderr should include 'could not resolve the repository'
    End

    It 'refuses to run without its library'
      mkdir -p "$SANDBOX/lonely"
      cp "$SHEPHERD_PR" "$SANDBOX/lonely/"
      When run script "$SANDBOX/lonely/gh-shepherd-pr.sh" "$REPO" 1 state
      The status should equal 2
      The stderr should include 'missing'
    End
  End

  Describe 'state and merged'
    It 'reports a pull request as the loop sees it'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=BEHIND)"
      When run script "$SHEPHERD_PR" "$REPO" 1 state
      The status should be success
      The output should include '"ok": true'
      The output should include '"mergeStateStatus": "BEHIND"'
      The output should include '"is_bot": true'
    End

    It 'reports ok:false, exit 0, for a pull request it cannot read'
      When run script "$SHEPHERD_PR" "$REPO" 99 state
      The status should be success
      The output should include '"ok": false'
      The output should include 'could not read pull request #99'
    End

    It 'reports a merge and its commit'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 state=MERGED)"
      When run script "$SHEPHERD_PR" "$REPO" 1 merged
      The output should include '"merged": true'
      The output should include '"mergeCommit": "merged1"'
    End

    It 'reports an unmerged pull request as not merged'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1)"
      When run script "$SHEPHERD_PR" "$REPO" 1 merged
      The output should include '"merged": false'
      The output should include 'not merged: OPEN'
    End

    It 'reports merged as unreadable when the pull request is unknown'
      When run script "$SHEPHERD_PR" "$REPO" 99 merged
      The output should include '"ok": false'
    End
  End

  Describe 'rebase'
    It 'rebases an open pull request and reports both heads'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=BEHIND)"
      When run script "$SHEPHERD_PR" "$REPO" 1 rebase
      The output should include '"ok": true'
      The output should include '"before": "sha1"'
      The output should include '"after": "rebased-sha1"'
      The result of function head_1 should equal 'rebased-sha1'
    End

    It 'refuses to rebase a pull request that is not open, and changes nothing'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 state=MERGED)"
      When run script "$SHEPHERD_PR" "$REPO" 1 rebase
      The output should include '"ok": false'
      The output should include 'refused: pull request is MERGED'
      The result of function head_1 should equal 'sha1'
    End

    It 'reports a failed rebase without claiming a new head'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export GH_FIXTURE_FAIL_REBASE=1
      When run script "$SHEPHERD_PR" "$REPO" 1 rebase
      The output should include '"ok": false'
      The output should include 'rebase failed'
      The output should include 'merge conflict'
      The output should not include '"after"'
    End

    It 'does not call update-branch for an unknown pull request'
      export GH_FIXTURE_CALL_LOG="$SANDBOX/calls.log"
      When run script "$SHEPHERD_PR" "$REPO" 99 rebase
      The output should include '"ok": false'
      The contents of file "$GH_FIXTURE_CALL_LOG" should not include 'update-branch'
    End
  End

  Describe 'recreate'
    # Dependabot's answer arrives after the recreate comment. Timing it with a
    # bare sleep raced the script's own reads: under a loaded machine (parallel
    # spec runs) the mutation could land before the comment posted, or the
    # comment's read could find the file already gone. The stub writes
    # "$GH_FIXTURE_PRS.comments" the moment the comment posts, so wait for that.
    after_comment() {
      local n=0
      until [ -e "$GH_FIXTURE_PRS.comments" ]; do
        [ "$n" -lt 200 ] || return 1   # 10s: the example has failed by then
        sleep 0.05; n=$((n + 1))
      done
      "$@"
    }
    set_pr() { local f="$GH_FIXTURE_PRS"; jq "$1" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }

    It 'refuses on a pull request Dependabot did not author, and posts nothing'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY bot=false)"
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": false'
      The output should include 'not authored by Dependabot'
      The result of function comments should equal 'NONE'
    End

    It 'refuses on a pull request that is not open'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 state=CLOSED)"
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include 'refused: pull request is CLOSED'
      The result of function comments should equal 'NONE'
    End

    It 'comments and returns once the head moves'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=4 SHEPHERD_POLL_SECONDS=1
      # Dependabot's answer, arriving after the comment: a new head.
      ( after_comment set_pr '.[0].headRefOid = "recreated"' ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": true'
      The output should include '"after": "recreated"'
      The output should satisfy json_field '.pr.headRefOid' 'recreated'
      The result of function comments should include '@dependabot recreate'
    End

    It 'reports recreated, not merged, when the head moved and the merge landed in the same poll'
      # A recreated branch that went green and auto-merged before the next poll
      # is the success path. The moved head must win over the state change.
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=4 SHEPHERD_POLL_SECONDS=1
      ( after_comment set_pr '.[0].headRefOid = "recreated" | .[0].state = "MERGED"' ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"detail": "recreated"'
      The output should not include '"result"'
    End

    It 'returns early when the pull request is closed with the head unmoved'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=4 SHEPHERD_POLL_SECONDS=1
      # Dependabot's usual answer when another pull request already shipped the
      # bump: close this one instead of recreating it.
      ( after_comment set_pr '.[0].state = "CLOSED"' ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": true'
      The output should include '"result": "closed"'
      The output should include 'closed while waiting for recreate'
      The output should include '"before": "sha1"'
      The output should satisfy json_field '.pr.state' 'CLOSED'
      The result of function comments should include '@dependabot recreate'
    End

    It 'returns early when the pull request is merged with the head unmoved'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=4 SHEPHERD_POLL_SECONDS=1
      ( after_comment set_pr '.[0].state = "MERGED" | .[0].mergeCommit = {oid: "m1"}' ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": true'
      The output should include '"result": "merged"'
      The output should include 'merged while waiting for recreate'
      The output should satisfy json_field '.pr.mergeCommit' 'm1'
      The result of function comments should include '@dependabot recreate'
    End

    It 'keeps polling when gh cannot read the pull request for one poll'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=4 SHEPHERD_POLL_SECONDS=1
      # One poll sees no pull request at all (gh errored), a later one sees it closed.
      ( f="$GH_FIXTURE_PRS"; cp "$f" "$f.keep"; after_comment rm "$f"; sleep 2; jq '.[0].state = "CLOSED"' "$f.keep" > "$f" ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": true'
      The output should include '"result": "closed"'
      The output should satisfy json_field '.pr.state' 'CLOSED'
    End

    It 'says the pull request could not be re-read when no poll succeeded, rather than that the head did not move'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=1 SHEPHERD_POLL_SECONDS=1
      # The comment posts against a readable pull request; then every poll fails.
      ( after_comment rm "$GH_FIXTURE_PRS" ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": false'
      The output should include 'could not be re-read in 2s (2 attempts)'
      The output should include 'Could not resolve to a PullRequest'
      The output should satisfy json_field '.read_failures' '2'
      The output should not include 'head did not change'
    End

    It 'gives up after two CI cycles when the head never moves'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=DIRTY)"
      export SHEPHERD_CI_SECONDS=1 SHEPHERD_POLL_SECONDS=1
      When run script "$SHEPHERD_PR" "$REPO" 1 recreate
      The output should include '"ok": false'
      The output should include 'head did not change within 2s'
      The output should satisfy json_field '.read_failures' '0'
      The output should satisfy json_field '.pr.state' 'OPEN'
      The result of function comments should include '@dependabot recreate'
    End
  End

  Describe 'wait'
    It 'answers merged without watching when the pull request has merged'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 state=MERGED)"
      export GH_FIXTURE_CALL_LOG="$SANDBOX/calls.log"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "merged"'
      The contents of file "$GH_FIXTURE_CALL_LOG" should not include 'checks'
    End

    It 'answers passed without watching when nothing reported a check'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=none)"
      export GH_FIXTURE_CALL_LOG="$SANDBOX/calls.log"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "passed"'
      The output should include 'no checks reported'
      The contents of file "$GH_FIXTURE_CALL_LOG" should not include 'checks'
    End

    It 'answers passed from a green rollup'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=passed)"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "passed"'
    End

    It 'answers failed from a red rollup, naming the check and carrying the log tail'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=failed)"
      export GH_FIXTURE_RUN_LOG="$SANDBOX/log.txt"
      printf 'line %s\n' 1 2 3 > "$GH_FIXTURE_RUN_LOG"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "failed"'
      The output should include '"name": "build"'
      The output should include 'line 3'
    End

    It 'keeps only the requested number of log lines'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=failed)"
      export GH_FIXTURE_RUN_LOG="$SANDBOX/log.txt" SHEPHERD_LOG_LINES=2
      printf 'line %s\n' 1 2 3 > "$GH_FIXTURE_RUN_LOG"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should satisfy json_field '.log_tail' 'line 2
line 3'
    End

    It 'answers failed with an empty log when the failing check is not an Actions job'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=status-failed)"
      export GH_FIXTURE_CALL_LOG="$SANDBOX/calls.log"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "failed"'
      The output should include '"log_tail": ""'
      The contents of file "$GH_FIXTURE_CALL_LOG" should not include 'run view'
    End

    It 'watches while checks are pending and reports pending when its bound is hit'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=pending)"
      export GH_FIXTURE_WATCH_HANG=1 SHEPHERD_WAIT_BOUND=1
      export GH_FIXTURE_CALL_LOG="$SANDBOX/calls.log"
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "pending"'
      The output should include '"bound": 1'
      The output should include '"watcher_rc": 124'
      The contents of file "$GH_FIXTURE_CALL_LOG" should include 'checks 1'
    End

    It 'reports the rollup, not the watcher, once the watcher returns'
      # The watcher returns at once (no hang) and the rollup still says pending,
      # which is what a check that finished between two reads looks like from
      # the wrong side. The answer is pending, and the caller asks again.
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=pending)"
      export SHEPHERD_WAIT_BOUND=5
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "pending"'
      The output should include '"watcher_rc": 8'
    End

    It 'reports merged when auto-merge fires during the watch'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 checks=pending)"
      export GH_FIXTURE_WATCH_HANG=1 SHEPHERD_WAIT_BOUND=2
      ( sleep 1; f="$GH_FIXTURE_PRS"; jq '.[0].state = "MERGED" | .[0].mergeCommit = {oid: "m1"}' "$f" > "$f.tmp" && mv "$f.tmp" "$f" ) &
      When run script "$SHEPHERD_PR" "$REPO" 1 wait
      The output should include '"result": "merged"'
    End

    It 'reports ok:false when the pull request cannot be read'
      When run script "$SHEPHERD_PR" "$REPO" 99 wait
      The output should include '"ok": false'
    End
  End

  Describe 'skip'
    It 'posts the reason and reports the comment URL'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1)"
      printf 'Skipping: the failing test asserts behaviour, not a mechanical fix.\n' > "$SANDBOX/reason.md"
      When run script "$SHEPHERD_PR" "$REPO" 1 skip "$SANDBOX/reason.md"
      The output should include '"ok": true'
      The output should include '"comment_url": "https://github.com/acme/widgets/pull/1#issuecomment-1"'
      The result of function comments should include 'not a mechanical fix'
    End

    It 'refuses an empty reason and posts nothing'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1)"
      : > "$SANDBOX/empty.md"
      When run script "$SHEPHERD_PR" "$REPO" 1 skip "$SANDBOX/empty.md"
      The output should include '"ok": false'
      The output should include 'reason file is missing or empty'
      The result of function comments should equal 'NONE'
    End

    It 'is a usage error without a reason file'
      When run script "$SHEPHERD_PR" "$REPO" 1 skip
      The status should equal 2
      The stderr should include 'skip needs a reason file'
    End

    It 'refuses to comment on a pull request that is not open'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 state=MERGED)"
      printf 'reason\n' > "$SANDBOX/reason.md"
      When run script "$SHEPHERD_PR" "$REPO" 1 skip "$SANDBOX/reason.md"
      The output should include 'refused: pull request is MERGED'
      The result of function comments should equal 'NONE'
    End

    It 'reports ok:false when the pull request cannot be read'
      printf 'reason\n' > "$SANDBOX/reason.md"
      When run script "$SHEPHERD_PR" "$REPO" 99 skip "$SANDBOX/reason.md"
      The output should include '"ok": false'
      The result of function comments should equal 'NONE'
    End
  End
End
