# shellcheck shell=bash
# Every example runs the script through `When run script` so kcov traces it; the
# helper functions only read the resulting state file back.
Describe 'ws-state.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  STATE_FILE() { printf '%s/bje-settings__example.json' "$WS_STATE_DIR"; }
  add_s1() { "$WS_STATE" add-stream s1 --issues 1,3 --kind stack --stack parser --order 1 --model sonnet --effort low --reason 'mechanical' "$@"; }
  field() { jq -c ".streams[0].$1" "$(STATE_FILE)"; }
  s1() { jq -c '.streams[0]' "$(STATE_FILE)"; }
  count() { jq '.streams | length' "$(STATE_FILE)"; }
  snapshot() { cat "$(STATE_FILE)"; }

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

    It 'reports the gh error when the repository cannot be resolved'
      export WS_GH_FIXTURE_FAIL=1
      When run script "$WS_STATE" path
      The status should equal 1
      The stderr should include 'cannot resolve the repository (gh: simulated failure)'
      The stderr should include 'set WS_REPO'
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

    It 'refuses to overwrite an existing plan and leaves it untouched'
      "$WS_STATE" init >/dev/null
      add_s1 >/dev/null
      before="$(snapshot)"
      When run script "$WS_STATE" init
      The status should equal 3
      The stderr should include 'pass --force'
      The result of function snapshot should equal "$before"
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

    It 'honours WS_REPO like every other command'
      export WS_REPO=acme/widgets
      When run script "$WS_STATE" init
      The status should be success
      The output should equal "$WS_STATE_DIR/acme__widgets.json"
    End

    It 'rejects --repo without a value'
      When run script "$WS_STATE" init --repo
      The status should equal 2
      The stderr should include '--repo needs a value'
    End

    It 'rejects unknown arguments'
      When run script "$WS_STATE" init --now
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'fails, and says so, when the state dir cannot be created'
      : > "$WS_SANDBOX/blocker"
      export WS_STATE_DIR="$WS_SANDBOX/blocker/state"
      When run script "$WS_STATE" init
      The status should equal 1
      The stderr should include 'cannot create'
      The output should equal ''
    End

    It 'fails, and says so, when the state file cannot be written'
      Skip if 'running as root, permissions do not apply' [ "$(id -u)" = 0 ]
      mkdir -p "$WS_STATE_DIR" && chmod 555 "$WS_STATE_DIR"
      When run script "$WS_STATE" init
      The status should equal 1
      The stderr should include 'cannot write'
      The output should equal ''
      The path "$(STATE_FILE)" should not be exist
    End
  End

  Describe 'without a usable state file'
    It 'show fails and says to init'
      When run script "$WS_STATE" show
      The status should equal 1
      The stderr should include 'run init first'
    End

    It 'add-stream fails the same way'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind independent --model haiku --effort low
      The status should equal 1
      The stderr should include 'run init first'
    End

    It 'rejects a corrupt state file with its own message, not a jq trace'
      mkdir -p "$WS_STATE_DIR"; printf '{"streams": [' > "$(STATE_FILE)"
      When run script "$WS_STATE" show
      The status should equal 1
      The stderr should include 'not valid workstreams JSON'
    End

    It 'rejects a JSON file that is not a workstreams state'
      mkdir -p "$WS_STATE_DIR"; printf '{"plugins": {}}' > "$(STATE_FILE)"
      When run script "$WS_STATE" set s1 status done
      The status should equal 1
      The stderr should include 'not valid workstreams JSON'
    End
  End

  Describe 'streams'
    BeforeEach '"$WS_STATE" init >/dev/null'

    It 'adds an independent stream with defaults filled in'
      When run script "$WS_STATE" add-stream s1 --issues 1,3 --kind independent --model sonnet --effort low --reason 'mechanical'
      The status should be success
      The result of function s1 should equal '{"id":"s1","issues":[1,3],"kind":"independent","stack":null,"order":null,"base":null,"model":"sonnet","effort":"low","reason":"mechanical","status":"planned","branch":null,"worktree":null,"pr":null,"prs":null,"agent":null,"question":null,"attempts":0}'
    End

    layer() { jq -c '[.streams[0].stack, .streams[0].order, .streams[0].base]' "$(STATE_FILE)"; }
    It 'records a stack layer with its stack, order, and base'
      When run script "$WS_STATE" add-stream s1b --issues 3 --kind stack --stack parser --order 2 --base wktr-1-parser --model sonnet --effort low
      The status should be success
      The result of function layer should equal '["parser",2,"wktr-1-parser"]'
    End

    It 'requires --stack and --order for a stack layer'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind stack --model sonnet --effort low
      The status should equal 2
      The stderr should include 'needs --stack and --order'
    End

    It 'rejects stack flags on an independent stream'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind independent --model sonnet --effort low --order 1
      The status should equal 2
      The stderr should include 'are for --kind stack'
    End

    It 'rejects an effort that has no stream agent'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind independent --model sonnet --effort max
      The status should equal 2
      The stderr should include 'effort must be low, medium, or high'
    End

    It 'rejects an unknown model alias'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind independent --model gpt --effort low
      The status should equal 2
      The stderr should include 'model must be one of'
    End

    It 'rejects a flag given last with no value'
      When run script "$WS_STATE" add-stream s1 --issues 1 --kind independent --model sonnet --effort low --reason
      The status should equal 2
      The stderr should include '--reason needs a value'
    End

    issues() { field issues; }
    It 'rejects a duplicate id and keeps the first'
      add_s1 >/dev/null
      When run script "$WS_STATE" add-stream s1 --issues 2 --kind independent --model haiku --effort low
      The status should equal 1
      The stderr should include 'already exists: s1'
      The result of function count should equal '1'
      The result of function issues should equal '[1,3]'
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

    It 'rejects a non-numeric or zero order'
      When run script "$WS_STATE" add-stream s2 --issues 2 --kind stack --stack p --model haiku --effort low --order 0
      The status should equal 2
      The stderr should include '--order must be a number from 1'
    End

    It 'rejects a missing id'
      When run script "$WS_STATE" add-stream --issues 2
      The status should equal 2
      The stderr should include 'needs a stream id'
    End

    It 'rejects an unknown add-stream flag'
      When run script "$WS_STATE" add-stream s2 --issues 2 --kind independent --model haiku --effort low --colour red
      The status should equal 2
      The stderr should include 'unknown argument: --colour'
    End

    Describe 'set'
      BeforeEach 'add_s1 >/dev/null'

      branch() { field branch; }
      It 'sets a string field'
        When run script "$WS_STATE" set s1 branch wktr-1-parser
        The status should be success
        The result of function branch should equal '"wktr-1-parser"'
      End

      pr() { field pr; }
      It 'stores pr as a number without needing --json'
        When run script "$WS_STATE" set s1 pr 10
        The status should be success
        The result of function pr should equal '10'
      End

      It 'clears a numeric field back to null'
        "$WS_STATE" set s1 pr 10
        When run script "$WS_STATE" set s1 pr null
        The status should be success
        The result of function pr should equal 'null'
      End

      It 'rejects a non-numeric pr'
        When run script "$WS_STATE" set s1 pr twelve
        The status should equal 2
        The stderr should include 'pr takes a number or null'
      End

      prs() { field prs; }
      It 'stores prs as a JSON array'
        When run script "$WS_STATE" set s1 prs '[10, 12]'
        The status should be success
        The result of function prs should equal '[10,12]'
      End

      question() { field question; }
      It 'accepts null and false through --json'
        When run script "$WS_STATE" set s1 question null --json
        The status should be success
        The result of function question should equal 'null'
      End

      It 'rejects invalid JSON with --json and leaves the stream unchanged'
        before="$(s1)"
        When run script "$WS_STATE" set s1 prs '{oops'
        The status should equal 2
        The stderr should include 'not valid JSON'
        The result of function s1 should equal "$before"
      End

      It 'rejects an empty --json value'
        When run script "$WS_STATE" set s1 question '' --json
        The status should equal 2
        The stderr should include 'not valid JSON'
      End

      It 'validates status values and leaves the stream unchanged'
        before="$(s1)"
        When run script "$WS_STATE" set s1 status shipped
        The status should equal 2
        The stderr should include 'invalid status: shipped'
        The result of function s1 should equal "$before"
      End

      status() { field status; }
      It 'accepts every documented status'
        for s in planned running draft reviewing paused done; do
          "$WS_STATE" set s1 status "$s" || return 1
        done
        When run script "$WS_STATE" set s1 status failed
        The status should be success
        The result of function status should equal '"failed"'
      End

      It 'rejects a field outside the schema, so a typo cannot create one'
        before="$(s1)"
        When run script "$WS_STATE" set s1 statu running
        The status should equal 2
        The stderr should include 'unknown field: statu'
        The result of function s1 should equal "$before"
      End

      It 'refuses to change the id'
        When run script "$WS_STATE" set s1 id s9
        The status should equal 2
        The stderr should include 'unknown field: id'
      End

      It 'fails for an unknown stream'
        When run script "$WS_STATE" set nope status done
        The status should equal 1
        The stderr should include 'unknown stream: nope'
      End

      It 'rejects a fourth argument other than --json'
        When run script "$WS_STATE" set s1 branch b --raw
        The status should equal 2
        The stderr should include 'unknown argument: --raw'
      End

      It 'needs three arguments'
        When run script "$WS_STATE" set s1 status
        The status should equal 2
        The stderr should include 'set needs'
      End
    End

    It 'lists streams by status'
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

    It 'rejects a misspelled status filter rather than returning nothing'
      When run script "$WS_STATE" list-streams --status runing
      The status should equal 2
      The stderr should include 'invalid status: runing'
    End

    It 'rejects unknown list-streams flags'
      When run script "$WS_STATE" list-streams --kind stack
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'rejects --status with no value'
      When run script "$WS_STATE" list-streams --status
      The status should equal 2
      The stderr should include '--status needs a value'
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

    It 'keeps other deferred issues when adding one'
      "$WS_STATE" defer 4 'needs hardware'
      When run script "$WS_STATE" defer 5 'already closed'
      The status should be success
      The result of function deferred should equal '[{"issue":4,"reason":"needs hardware"},{"issue":5,"reason":"already closed"}]'
    End

    It 'requires a numeric issue for defer'
      When run script "$WS_STATE" defer four 'reason'
      The status should equal 2
      The stderr should include 'defer needs'
    End

    meta() { jq -c '.meta' "$(STATE_FILE)"; }
    It 'stores plan-level metadata as strings'
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
    tmpfiles() { find "$WS_STATE_DIR" -name '*.tmp.*'; }
    It 'leaves no temp file behind after an update'
      "$WS_STATE" init >/dev/null
      When run script "$WS_STATE" meta a b
      The status should be success
      The result of function tmpfiles should equal ''
    End

    It 'keeps the old state when the update cannot be written'
      Skip if 'running as root, permissions do not apply' [ "$(id -u)" = 0 ]
      "$WS_STATE" init >/dev/null
      before="$(snapshot)"
      chmod 555 "$WS_STATE_DIR"
      When run script "$WS_STATE" meta a b
      The status should equal 1
      The stderr should include 'cannot write'
      The result of function snapshot should equal "$before"
      The result of function tmpfiles should equal ''
    End
  End

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$WS_STATE" --help
      The status should be success
      The output should include 'add-stream'
      The output should include 'Stream statuses'
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
