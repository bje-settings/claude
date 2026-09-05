# shellcheck shell=bash
# The threshold gate decides whether a build passes, so it gets its own examples.
Describe 'coverage-check.py'
  CHECK="$ROOT/spec/coverage-check.py"

  # Minimal Cobertura: one class, <hits> lines covered out of <total>.
  write_report() {
    local file="$1" covered="$2" total="$3" rate lines="" i
    rate="$(python3 -c "print($covered/$total)")"
    for ((i = 1; i <= total; i++)); do
      if ((i <= covered)); then
        lines="$lines<line number=\"$i\" hits=\"1\"/>"
      else
        lines="$lines<line number=\"$i\" hits=\"0\"/>"
      fi
    done
    cat > "$file" <<XML
<?xml version="1.0"?>
<coverage line-rate="$rate">
  <packages><package name="p"><classes>
    <class name="c" filename="plugins/gh/scripts/thing.sh" line-rate="$rate">
      <lines>$lines</lines>
    </class>
  </classes></package></packages>
</coverage>
XML
  }

  setup() { REPORT="$(mktemp -d)/cobertura.xml"; }
  BeforeEach 'setup'
  AfterEach 'rm -rf "$(dirname "$REPORT")"'

  It 'passes when coverage is above the threshold'
    write_report "$REPORT" 97 100
    When run command python3 "$CHECK" "$REPORT" 95
    The status should be success
    The output should include '97.00%'
  End

  It 'passes when coverage sits exactly on the threshold'
    write_report "$REPORT" 95 100
    When run command python3 "$CHECK" "$REPORT" 95
    The status should be success
    The output should include 'overall: 95.00%'
  End

  It 'fails when coverage is below the threshold'
    write_report "$REPORT" 94 100
    When run command python3 "$CHECK" "$REPORT" 95
    The status should equal 1
    The output should include 'overall: 94.00%'
    The stderr should include 'below the threshold'
  End

  It 'names the uncovered lines so a drop says what moved'
    write_report "$REPORT" 8 10
    When run command python3 "$CHECK" "$REPORT" 95
    The status should equal 1
    The output should include 'plugins/gh/scripts/thing.sh'
    The output should include 'uncovered: 9,10'
    The stderr should be present
  End

  It 'defaults to a 95 threshold'
    write_report "$REPORT" 94 100
    When run command python3 "$CHECK" "$REPORT"
    The status should equal 1
    The output should include 'threshold: 95.00%'
    The stderr should be present
  End

  It 'rejects being called with no report'
    When run command python3 "$CHECK"
    The status should equal 2
    The stderr should include 'usage:'
  End
End
