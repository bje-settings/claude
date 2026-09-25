# Parity fixtures

Generated from `plugins/mermaid/scripts/mermaid-url.py`, at commit 2e65908b3db3dd2e18f05528c03b0a3fd746bab2, the last commit before this one deletes that script. The generator ran as a real subprocess, once per case. The command was `python3 mermaid-url.py --route <route> [--theme <theme>]`, with the diagram source on stdin. This is the same way `tests/mermaid/test_view.py` drove it. This file and the sibling `*.json` fixtures are the only change in this commit. So the history shows they came from the Python, before the port (#126) touches anything else.

Parity ruling (maintainer, 2026-09-20): parity is of MEANING, not of the URL string. Python's `zlib.compress(..., 9)` and node's `zlib.deflateSync` at level 9 give different bytes for the same input. This is because node ships its own zlib build. So these fixtures do not carry a reproducible URL.

Each fixture instead carries the **decoded** state. This is the URL prefix up to and including `pako:`. It also includes the outer state object, with `mermaid` still a JSON string. It includes that string parsed a second time as `mermaidConfig`, since it is JSON inside JSON.

A refusal carries the exit status and the stderr text instead. The status is asserted: `url.test.ts`'s `RefusedFixture` reads it. The Python `stderr` text is captured provenance only. It is kept so a reader can see what the Python actually said. It is never asserted.

The port's own refusal wording is its own throughout. See the PR body's divergence note. The port is never required to match the Python's wording.

`stdinBytes` is the diagram source as a byte array. So a case with non-ASCII or invalid UTF-8 content round-trips through JSON exactly.

The generator script itself is not committed here. This plugin ships no `.py` (acceptance criteria, #126). The fixtures are a one-time capture, not a step this plugin's own tooling repeats.
