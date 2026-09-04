# shellcheck shell=bash
Describe 'hook-io.py'
  HOOK_IO="$PLUGIN_DIR/hooks/hook-io.py"

  Describe 'cwd'
    It 'prints the cwd from a payload'
      Data '{"session_id":"s","cwd":"/some/where"}'
      When run command python3 "$HOOK_IO" cwd
      The status should be success
      The output should equal '/some/where'
    End

    It 'prints nothing for a payload with no cwd'
      Data '{"session_id":"s"}'
      When run command python3 "$HOOK_IO" cwd
      The status should be success
      The output should equal ''
    End

    It 'prints nothing rather than failing on malformed JSON'
      # The hook falls back to its own working directory, and must never block
      # a session over a payload it could not read.
      Data 'not json'
      When run command python3 "$HOOK_IO" cwd
      The status should be success
      The output should equal ''
    End

    It 'prints nothing when the payload is not an object'
      Data '["a","b"]'
      When run command python3 "$HOOK_IO" cwd
      The status should be success
      The output should equal ''
    End
  End

  Describe 'messages'
    It 'emits the branch message with both branch names'
      When run command python3 "$HOOK_IO" branch feature-x main
      The status should be success
      The output should include 'feature-x'
      The output should include 'main'
      The output should include '/gh:sync'
    End

    It 'emits the report message wrapping the report it is given'
      Data 'repo-a: would delete gone'
      When run command python3 "$HOOK_IO" report
      The status should be success
      The output should include 'would delete gone'
      The output should include 'No branch, worktree, or working tree'
    End
  End

  Describe 'contract'
    It 'rejects an unknown mode'
      When run command python3 "$HOOK_IO"
      The status should equal 2
      The stderr should include 'usage:'
    End

    It 'rejects the branch mode without both branch names'
      When run command python3 "$HOOK_IO" branch only-one
      The status should equal 2
      The stderr should include 'usage:'
    End
  End
End
