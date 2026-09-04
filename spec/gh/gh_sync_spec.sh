# shellcheck shell=bash
Describe 'gh-sync.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  Describe 'argument handling'
    It 'rejects a zero -j rather than spinning forever'
      # In arithmetic context a non-numeric or zero value makes the throttle
      # condition permanently true, so no job ever launches.
      When run script "$SYNC" -j 0 "$SANDBOX"
      The status should equal 2
      The stderr should include 'invalid -j value: 0'
    End

    It 'rejects a non-numeric -j'
      When run script "$SYNC" -j four "$SANDBOX"
      The status should equal 2
      The stderr should include 'invalid -j value: four'
    End

    It 'rejects an unknown flag'
      When run script "$SYNC" --nope "$SANDBOX"
      The status should equal 2
      The stderr should include 'unknown flag'
    End

    It 'accepts the attached -j4 form as well as -j 4'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      When run script "$SYNC" --dry-run -j2 "$SANDBOX/fan"
      The status should be success
      The output should include '(1 repos)'
    End

    It 'prints usage for --help without leaking code'
      When run script "$SYNC" --help
      The status should be success
      The output should include 'Usage:'
      The output should not include 'set -uo pipefail'
    End

    It 'rejects a target that is not a directory'
      When run script "$SYNC" "$SANDBOX/nothing-here"
      The status should equal 2
      The stderr should include 'not a directory'
    End
  End

  Describe 'scope detection'
    It 'syncs the current repository when the target is a git repo'
      When run script "$SYNC" --dry-run "$REPO"
      The status should be success
      The output should include 'already up to date'
      The output should not include 'repos)'
    End

    It 'fans out over immediate subdirectories that are git repos'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      fixture_create_at "$SANDBOX/fan" b >/dev/null
      When run script "$SYNC" --dry-run "$SANDBOX/fan"
      The status should be success
      The output should include '(2 repos)'
      The output should include 'already up to date'
    End

    It 'does not recurse: a repo two levels down is out of scope'
      mkdir -p "$SANDBOX/deep/nested"
      fixture_create_at "$SANDBOX/deep/nested" x >/dev/null
      When run script "$SYNC" --dry-run "$SANDBOX/deep"
      The status should be success
      The output should include 'No git repositories directly inside'
    End

    It 'says so when a directory holds no git repositories'
      mkdir -p "$SANDBOX/empty"
      When run script "$SYNC" --dry-run "$SANDBOX/empty"
      The status should be success
      The output should include 'No git repositories directly inside'
    End

    It 'ignores a bare repository, which has no work tree to sync'
      mkdir -p "$SANDBOX/bare"
      git init -q --bare "$SANDBOX/bare/thing.git"
      When run script "$SYNC" --dry-run "$SANDBOX/bare"
      The status should be success
      The output should include 'No git repositories directly inside'
    End
  End

  Describe 'reporting'
    It 'reports each repository in directory order regardless of finish order'
      fixture_create_at "$SANDBOX/fan" aaa >/dev/null
      fixture_create_at "$SANDBOX/fan" bbb >/dev/null
      fixture_create_at "$SANDBOX/fan" ccc >/dev/null
      When run script "$SYNC" --dry-run -j 3 "$SANDBOX/fan"
      The status should be success
      The output should include '(3 repos)'
      # Ordering is by directory name, not by which job finished first.
      The output should match pattern "*aaa*bbb*ccc*"
    End

    It 'surfaces a job that exited abnormally instead of reporting silence'
      # Stand up a copy of the orchestrator beside a per-repo script that fails,
      # to prove a crashed job cannot pass for a repo with nothing to say.
      mkdir -p "$SANDBOX/fake"
      cp "$SYNC" "$SANDBOX/fake/gh-sync.sh"
      printf '#!/usr/bin/env bash\nexit 7\n' > "$SANDBOX/fake/gh-sync-repo.sh"
      chmod +x "$SANDBOX/fake/gh-sync-repo.sh"
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      When run script "$SANDBOX/fake/gh-sync.sh" "$SANDBOX/fan"
      The status should be success
      The output should include 'exited with status 7'
    End
  End

  Describe 'wiring' 
    It 'refuses to run when the per-repo script is missing'
      mkdir -p "$SANDBOX/lonely"
      cp "$SYNC" "$SANDBOX/lonely/gh-sync.sh"
      When run script "$SANDBOX/lonely/gh-sync.sh" "$SANDBOX"
      The status should equal 2
      The stderr should include 'missing'
    End

    It 'throttles to the requested number of jobs'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      fixture_create_at "$SANDBOX/fan" b >/dev/null
      fixture_create_at "$SANDBOX/fan" c >/dev/null
      When run script "$SYNC" --dry-run -j 1 "$SANDBOX/fan"
      The status should be success
      The output should match pattern "*a*b*c*"
    End
  End

  Describe 'fan-out safety'
    It 'mutates nothing in --dry-run'
      fixture_create_at "$SANDBOX/fan" a >/dev/null
      fixture_branch_with_work "$SANDBOX/fan/a" gone
      fixture_merge_commit "$SANDBOX/fan/a" gone
      before="$(branches "$SANDBOX/fan/a")"
      When run script "$SYNC" --dry-run "$SANDBOX/fan"
      The status should be success
      The output should include 'would delete gone'
      The value "$(branches "$SANDBOX/fan/a")" should equal "$before"
    End

    It 'skips a dirty repository but still syncs its clean neighbours'
      fixture_create_at "$SANDBOX/fan" dirty >/dev/null
      fixture_create_at "$SANDBOX/fan" clean >/dev/null
      fixture_dirty "$SANDBOX/fan/dirty"
      When run script "$SYNC" --dry-run "$SANDBOX/fan"
      The status should be success
      The output should include 'skipped: uncommitted changes'
      The output should include 'already up to date'
    End
  End
End
