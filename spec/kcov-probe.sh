#!/usr/bin/env bash
# kcov-probe.sh — can kcov measure a shell script the way shellspec drives it?
#
#   exit 0  yes, coverage can run here
#   exit 1  kcov is installed but cannot measure anything here
#   exit 2  kcov is not installed
#
# The probe reproduces shellspec's own kcov invocation in miniature rather than
# just running `kcov --version`, because the ways this fails are specific to how
# shellspec drives it. shellspec's kcov executor hands kcov a generated
# `#!/bin/sh` script together with --bash-method=DEBUG and
# --bash-parser=<the shell under test>; those two flags are what macOS cannot
# survive. See CLAUDE.md, Tests, for the whole story.
#
# It checks for a *measurement*, not for exit status. Homebrew's kcov 43 has a
# failure mode where it runs the program, exits 0, and writes a report with no
# files in it and a line rate of zero, which is easy to mistake for a result.
set -uo pipefail

command -v kcov >/dev/null 2>&1 || exit 2

dir="$(mktemp -d)" || exit 1
trap 'rm -rf "$dir"' EXIT

# `#!/bin/sh` mirrors the shebang shellspec puts on its generated in-file.
probe="$dir/probe.sh"
cat > "$probe" <<'PROBE'
#!/bin/sh
touched=1
[ "$touched" = 1 ]
PROBE
chmod +x "$probe"

# --include-path scopes the report to the probe alone, so coverage kcov happened
# to collect for the shell itself cannot stand in for having measured this.
shell="$(command -v bash)" || exit 1
kcov --include-path="$dir" \
  --bash-method=DEBUG \
  --bash-parser="$shell" \
  "$dir/out" "$probe" >/dev/null 2>&1 || exit 1

# A report naming probe.sh with at least one executed line. Anything less — no
# report, no probe.sh in it, or every line at zero hits — is not a measurement.
grep -h 'hits="[1-9]' "$dir"/out/*/cobertura.xml 2>/dev/null | grep -q . || exit 1
grep -lq 'probe\.sh' "$dir"/out/*/cobertura.xml 2>/dev/null
