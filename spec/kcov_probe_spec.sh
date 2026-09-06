# shellcheck shell=bash
# The probe decides whether `spec/run.sh --coverage` runs at all, so both of its
# answers get examples. A stub kcov stands in for the real one: the failure this
# guards against is a macOS-only kcov, and CI has a working one, so neither
# machine can exercise both branches on its own.
Describe 'kcov-probe.sh'
  PROBE="$ROOT/spec/kcov-probe.sh"

  setup() {
    KDIR="$(mktemp -d)"
    BIN="$KDIR/bin"
    mkdir -p "$BIN"
    # Only the tools the probe calls, so "kcov is not installed" is a real
    # absence rather than the stub being shadowed by a kcov on the outer PATH.
    local t real
    for t in bash mktemp cat chmod grep rm mkdir; do
      real="$(command -v "$t")" || continue
      ln -s "$real" "$BIN/$t"
    done
  }
  BeforeEach 'setup'
  AfterEach 'rm -rf "$KDIR"'

  # stub_kcov <exit status> [report body]: a kcov that exits with the given
  # status and, when a body is given, writes it as the cobertura report where
  # the real one would. kcov's argv ends with <out-dir> <in-file>.
  stub_kcov() {
    local status="$1" report="${2-}"
    cat > "$BIN/kcov" <<STUB
#!/usr/bin/env bash
outdir="\${@: -2:1}"
if [ -n "$report" ]; then
  mkdir -p "\$outdir/probe.sh.abc123"
  cat > "\$outdir/probe.sh.abc123/cobertura.xml" <<'REPORT'
$report
REPORT
fi
exit $status
STUB
    chmod +x "$BIN/kcov"
  }

  measured='<coverage><class filename="probe.sh"><lines>
<line number="2" hits="1"/><line number="3" hits="1"/>
</lines></class></coverage>'

  empty='<coverage line-rate="0.000"></coverage>'

  unmeasured='<coverage><class filename="probe.sh"><lines>
<line number="2" hits="0"/><line number="3" hits="0"/>
</lines></class></coverage>'

  It 'reports kcov as usable when the report shows the probe was executed'
    stub_kcov 0 "$measured"
    When run command env PATH="$BIN" "$PROBE"
    The status should be success
    The stdout should equal ''
  End

  It 'reports kcov as missing when it is not on PATH'
    When run command env PATH="$BIN" "$PROBE"
    The status should equal 2
  End

  It 'reports kcov as unusable when it cannot attach'
    # macOS: kcov 43 exits 255 with "Can't start/attach to ..." under the
    # --bash-method=DEBUG that shellspec always passes.
    stub_kcov 255
    When run command env PATH="$BIN" "$PROBE"
    The status should equal 1
  End

  It 'reports kcov as unusable when it succeeds but writes no report'
    stub_kcov 0
    When run command env PATH="$BIN" "$PROBE"
    The status should equal 1
  End

  It 'reports kcov as unusable when the report names no files'
    # The quiet macOS failure: kcov runs the program, exits 0, and reports a
    # line rate of zero over nothing at all.
    stub_kcov 0 "$empty"
    When run command env PATH="$BIN" "$PROBE"
    The status should equal 1
  End

  It 'reports kcov as unusable when the probe is named but no line was executed'
    stub_kcov 0 "$unmeasured"
    When run command env PATH="$BIN" "$PROBE"
    The status should equal 1
  End

  It 'drives kcov the way shellspec does, so it fails where shellspec fails'
    # The flags are the point of the probe: --bash-method=DEBUG and a
    # --bash-parser are what macOS cannot survive, and a probe that omitted them
    # would pass there and promise a coverage run that then collapses.
    cat > "$BIN/kcov" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$KCOV_ARGV_LOG"
exit 255
STUB
    chmod +x "$BIN/kcov"
    When run command env PATH="$BIN" KCOV_ARGV_LOG="$KDIR/argv" "$PROBE"
    The status should equal 1
    The contents of file "$KDIR/argv" should include '--bash-method=DEBUG'
    The contents of file "$KDIR/argv" should include '--bash-parser='
    The contents of file "$KDIR/argv" should include 'probe.sh'
  End
End
