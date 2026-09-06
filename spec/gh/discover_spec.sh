# shellcheck shell=bash
Describe 'lib/discover.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  # Sourced into a subshell per example, so the function is exercised exactly
  # the way the scripts use it rather than through a copy of its logic.
  discover() { . "$DISCOVER"; discover_repos "$@"; }

  It 'yields the checkout root when the target is a repository'
    When call discover "$REPO"
    The status should be success
    The output should equal "$(cd "$REPO" && pwd -P)"
  End

  It 'yields the checkout root when the target is a subdirectory of a repository'
    mkdir -p "$REPO/src/deep"
    When call discover "$REPO/src/deep"
    The status should be success
    The output should equal "$(cd "$REPO" && pwd -P)"
  End

  It 'fans out over immediate subdirectories that are checkout roots'
    fixture_create_at "$SANDBOX/fan" bbb >/dev/null
    fixture_create_at "$SANDBOX/fan" aaa >/dev/null
    mkdir -p "$SANDBOX/fan/plain"
    When call discover "$SANDBOX/fan"
    The status should be success
    The line 1 of output should end with '/aaa'
    The line 2 of output should end with '/bbb'
    The lines of output should equal 2
  End

  It 'does not recurse below one level'
    mkdir -p "$SANDBOX/fan/parent"
    fixture_create_at "$SANDBOX/fan/parent" nested >/dev/null
    When call discover "$SANDBOX/fan"
    The status should be success
    The output should equal ''
  End

  It 'skips a subdirectory that is inside a repository but not its root'
    # A checkout root next to an entry that resolves to a subdirectory of the
    # sandbox repo: git reports that repo's root, which is not the entry itself,
    # so it must not count as a checkout of its own.
    fixture_create_at "$SANDBOX/fan" real >/dev/null
    mkdir -p "$REPO/src"
    ln -s "$REPO/src" "$SANDBOX/fan/inner"
    When call discover "$SANDBOX/fan"
    The status should be success
    The line 1 of output should end with '/real'
    The lines of output should equal 1
  End

  It 'resolves symlinks so the comparison agrees with git'
    # git reports resolved paths; a logical path would never match and every
    # repo under a symlinked parent (like /tmp on macOS) would be skipped.
    fixture_create_at "$SANDBOX/fan" a >/dev/null
    ln -s "$SANDBOX/fan" "$SANDBOX/link"
    When call discover "$SANDBOX/link"
    The status should be success
    The line 1 of output should end with '/fan/a'
    The lines of output should equal 1
  End

  It 'prints nothing and succeeds when there are no repositories'
    mkdir -p "$SANDBOX/empty"
    When call discover "$SANDBOX/empty"
    The status should be success
    The output should equal ''
  End

  It 'fails when the target is not a directory'
    When call discover "$SANDBOX/nope"
    The status should equal 1
    The output should equal ''
  End

  It 'defaults to the current directory'
    cd "$REPO" || return 1
    When call discover
    The status should be success
    The output should equal "$(pwd -P)"
  End
End
