# shellcheck shell=bash
Describe 'ws-state.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  STATE_FILE() { printf '%s/bje-settings__example.json' "$WS_STATE_DIR"; }
  add_s1() { "$WS_STATE" add-stream s1 --issues 1,3 --kind stack --model sonnet --effort low --reason 'mechanical' "$@"; }

  Describe 'location'
    It 'derives the path from gh repo view under the state dir'
      When run script "$WS_STATE" path
      The status should be success
      The output should equal "$(STATE_FILE)"
    End

    It 'falls back to CLAUDE_PLUGIN_DATA when WS_STATE_DIR is unset'
      unset WS_STATE_DIR
      export CLAUDE_PLUGIN_DATA="$WS_SANDBOX/data"
      When run script "$WS_STATE" path
      The status should be success
      The output should equal "$WS_SANDBOX/data/bje-settings__example.json"
    End

    It 'refuses to guess a location when neither is set'
      unset WS_STATE_DIR
      When run script "$WS_STATE" path
      The status should equal 2
      The stderr should include 'CLAUDE_PLUGIN_DATA'
    End

    It 'takes the repo from WS_REPO without calling gh'
      export WS_REPO=acme/widgets WS_GH_FIXTURE_FAIL=1
      When run script "$WS_STATE" path
      The status should be success
      The output should equal "$WS_STATE_DIR/acme__widgets.json"
    End

    It 'fails when gh cannot resolve the repository'
      export WS_GH_FIXTURE_FAIL=1
      When run script "$WS_STATE" path
      The status should equal 1
      The stderr should include 'cannot resolve the repository'
    End

    It 'rejects a repo that is not owner/name'
      When run script "$WS_STATE" init --repo widgets
      The status should equal 2
      The stderr should include 'owner/name'
    End
  End

  Describe 'init'
    shape() { jq -r '[.repo, .version, (.streams | length), (.deferred | length)] | join(" ")' "$(STATE_FILE)"; }
    It 'creates the state file and prints its path'
      When run script "$WS_STATE" init
      The status should be success
      The output should equal "$(STATE_FILE)"
      The path "$(STATE_FILE)" should be file
      The result of function shape should equal 'bje-settings/example 1 0 0'
    End

    count() { jq '.streams | length' "$(STATE_FILE)"; }
    It 'refuses to overwrite an existing plan'
      "$WS_STATE" init >/dev/null
      add_s1 >/dev/null
      When run script "$WS_STATE" init
      The status should equal 3
      The stderr should include 'pass --force'
      The result of function count should equal '1'
    End

    It 'starts over with --force'
      "$WS_STATE" init >/dev/null
      add_s1 >/dev/null
      When run script "$WS_STATE" init --force
      The status should be success
      The result of function count should equal '0'
    End

    It 'accepts --repo explicitly'
      When run script "$WS_STATE" init --repo acme/widgets
      The status should be success
      The output should equal "$WS_STATE_DIR/acme__widgets.json"
    End

    It 'rejects unknown arguments'
      When run script "$WS_STATE" init --now
      The status should equal 2
      The stderr should include 'unknown argument'
    End
  End

  Describe 'without a state file'
    It 'show fails and says to init'
      When run script "$WS_STATE" show
      The status should equal 1
      The stderr should include 'run init first'
    End

    It 'add-stream fails the same way'
      When run add_s1
      The status should equal 1
      The stderr should include 'run init first'
    End
  End

  Describe 'streams'
    BeforeEach '"$WS_STATE" init >/dev/null'

    s1() { jq -c '.streams[0]' "$(STATE_FILE)"; }
    It 'adds a stream with defaults filled in'
      When run add_s1
      The status should be success
      The result of function s1 should equal '{"id":"s1","issues":[1,3],"kind":"stack","order":null,"base":null,"model":"sonnet","effort":"low","reason":"mechanical","status":"planned","branch":null,"worktree":null,"pr":null,"agent":null,"question":null,"attempts":0}'
    End

    order_base() { jq -c '[.streams[0].order, .streams[0].base]' "$(STATE_FILE)"; }
    It 'records --order and --base as given'
      When run add_s1 --order 2 --base wktr-1-parser
      The status should be success
      The result of function order_base should equal '[2,"wktr-1-parser"]'
    End

    It 'rejects a duplicate id'
      add_s1 >/dev/null
      When run add_s1
      The status should equal 1
      The stderr should include 'already exists: s1'
    End

    It 'rejects a missing required flag'
      When run script "$WS_STATE" add-stream s2 --issues 2 --kind independent --model haiku
      The status should equal 2
      The stderr should include 'needs --issues, --kind, --model, and --effort'
    End

    It 'rejects a bad kind'
      When run script "$WS_STATE" add-stream s2 --issues 2 --kind chain --model haiku --effort low
      The status should equal 2
      The stderr should include 'kind must be'
    End

    It 'rejects malformed issue lists'
      When run script "$WS_STATE" add-stream s2 --issues '2, 3' --kind independent --model haiku --effort low
      The status should equal 2
      The stderr should include 'comma-separated numbers'
    End

    It 'rejects a non-numeric order'
      When run add_s1 --order first
      The status should equal 2
      The stderr should include '--order must be a number'
    End

    It 'rejects a missing id and unknown flags'
      When run script "$WS_STATE" add-stream --issues 2
      The status should equal 2
      The stderr should include 'needs a stream id'
    End

    It 'rejects an unknown add-stream flag'
      When run add_s1 --colour red
      The status should equal 2
      The stderr should include 'unknown argument: --colour'
    End

    branch() { jq -r '.streams[0].branch' "$(STATE_FILE)"; }
    It 'sets a string field'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 branch wktr-1-parser
      The status should be success
      The result of function branch should equal 'wktr-1-parser'
    End

    pr() { jq -c '.streams[0].pr' "$(STATE_FILE)"; }
    It 'sets a JSON field with --json'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 pr 10 --json
      The status should be success
      The result of function pr should equal '10'
    End

    It 'rejects invalid JSON with --json'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 pr '{oops' --json
      The status should equal 2
      The stderr should include 'not valid JSON'
    End

    It 'validates status values'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 status shipped
      The status should equal 2
      The stderr should include 'invalid status: shipped'
    End

    It 'accepts every documented status'
      add_s1 >/dev/null
      for s in planned running draft reviewing paused done failed; do
        "$WS_STATE" set s1 status "$s" || return 1
      done
      When call jq -r '.streams[0].status' "$(STATE_FILE)"
      The output should equal 'failed'
    End

    It 'refuses to change the id'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 id s9
      The status should equal 2
      The stderr should include 'immutable'
    End

    It 'fails for an unknown stream'
      When run script "$WS_STATE" set nope status done
      The status should equal 1
      The stderr should include 'unknown stream: nope'
    End

    It 'rejects a fourth argument other than --json'
      add_s1 >/dev/null
      When run script "$WS_STATE" set s1 pr 10 --raw
      The status should equal 2
      The stderr should include 'unknown argument: --raw'
    End

    It 'needs three arguments for set'
      When run script "$WS_STATE" set s1 status
      The status should equal 2
      The stderr should include 'set needs'
    End

    It 'lists streams, optionally by status'
      add_s1 >/dev/null
      "$WS_STATE" add-stream s2 --issues 2 --kind independent --model haiku --effort low >/dev/null
      "$WS_STATE" set s2 status draft
      When run script "$WS_STATE" list-streams --status draft
      The status should be success
      The output should include '"id": "s2"'
      The output should not include '"id": "s1"'
    End

    listed() { "$WS_STATE" list-streams | jq length; }
    It 'lists every stream without a filter'
      add_s1 >/dev/null
      "$WS_STATE" add-stream s2 --issues 2 --kind independent --model haiku --effort low >/dev/null
      When run script "$WS_STATE" list-streams
      The status should be success
      The result of function listed should equal '2'
    End

    It 'rejects unknown list-streams flags'
      When run script "$WS_STATE" list-streams --kind stack
      The status should equal 2
      The stderr should include 'unknown argument'
    End
  End

  Describe 'deferred and meta'
    BeforeEach '"$WS_STATE" init >/dev/null'

    deferred() { jq -c '.deferred' "$(STATE_FILE)"; }
    It 'records a deferred issue with its reason, replacing an earlier entry'
      "$WS_STATE" defer 4 'needs hardware'
      When run script "$WS_STATE" defer 4 'needs a week of data'
      The status should be success
      The result of function deferred should equal '[{"issue":4,"reason":"needs a week of data"}]'
    End

    It 'requires a numeric issue for defer'
      When run script "$WS_STATE" defer four 'reason'
      The status should equal 2
      The stderr should include 'defer needs'
    End

    meta() { jq -c '.meta' "$(STATE_FILE)"; }
    It 'stores plan-level metadata'
      When run script "$WS_STATE" meta loop_delay 1800
      The status should be success
      The result of function meta should equal '{"loop_delay":"1800"}'
    End

    It 'requires a field and value for meta'
      When run script "$WS_STATE" meta loop_delay
      The status should equal 2
      The stderr should include 'meta needs'
    End

    It 'pretty-prints the whole file with show'
      When run script "$WS_STATE" show
      The status should be success
      The output should include '"repo": "bje-settings/example"'
    End
  End

  Describe 'atomic writes'
    It 'leaves no temp file behind after an update'
      "$WS_STATE" init >/dev/null
      add_s1 >/dev/null
      When call find "$WS_STATE_DIR" -name '*.tmp.*'
      The output should equal ''
    End
  End

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$WS_STATE" --help
      The status should be success
      The output should include 'add-stream'
    End

    It 'prints usage with no command'
      When run script "$WS_STATE"
      The status should equal 2
      The stderr should include 'ws-state.sh path'
    End

    It 'rejects an unknown command'
      When run script "$WS_STATE" frobnicate
      The status should equal 2
      The stderr should include 'unknown command'
    End

    It 'requires jq'
      export PATH="$(ws_path_without jq)"
      When run script "$WS_STATE" path
      The status should equal 1
      The stderr should include 'jq is required'
    End
  End
End
