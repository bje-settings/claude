"""Build a mermaid.live / mermaid.ink preview URL for a diagram read from stdin.

One script, no `lib/`: this plugin has nothing else to share it with. The guard
around `main` (UTF-8 streams, broken-pipe handling) is the same shape
`workstreams` and `field-test` give their scripts via `scripts/lib/cli.py`
(`gh` has no such module; its `lib/streams.py` covers only the UTF-8 half).
Inlined here rather than imported, since nothing crosses plugin boundaries and
there is no second script in this plugin to justify a shared module.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import zlib

PROG = "mermaid-url.py"

ROUTES = {
    "view": "https://mermaid.live/view#pako:{payload}",
    "edit": "https://mermaid.live/edit#pako:{payload}",
    "ink-svg": "https://mermaid.ink/svg/pako:{payload}",
    "ink-img": "https://mermaid.ink/img/pako:{payload}",
}


class Failure(Exception):
    """A refusal this script reports as its own, rather than a traceback."""

    def __init__(self, message: str, status: int = 2) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def build_url(diagram: str, route: str, theme: str) -> str:
    """Encode `diagram` the way mermaid.live's own editor does: pako in the fragment.

    The state is a JSON object with `code` (the diagram source) and `mermaid`
    (the Mermaid config, itself JSON, as a *string* rather than a nested
    object -- that is what mermaid.live's own decoder expects). Editor UI keys
    (`grid`, `panZoom`, `pan`, `zoom`, ...) are omitted; they are view state,
    not part of the diagram. `theme` is passed through verbatim: Mermaid
    accepts custom theme names alongside its built-in set, so nothing here
    restricts it -- a typo just renders with the wrong theme rather than
    failing.
    """
    state = {"code": diagram, "mermaid": json.dumps({"theme": theme})}
    compressed = zlib.compress(json.dumps(state).encode("utf-8"), 9)
    payload = base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")
    return ROUTES[route].format(payload=payload)


def read_diagram() -> str:
    """Read the diagram source from stdin as strict UTF-8.

    Read at the byte level rather than through text-mode `sys.stdin`: a
    malformed byte here is data loss, not a display glitch, since it would be
    compressed into the URL and shared. `errors="replace"` -- the right call
    for stdout/stderr, where it only affects how already-correct data is
    displayed -- would otherwise silently swap the offending byte for U+FFFD
    and hand back a corrupted, still-"successful" link.
    """
    raw = sys.stdin.buffer.read()
    try:
        diagram = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Failure(f"diagram source is not valid UTF-8: {error}") from error
    return diagram.strip()


def run(argv: list[str]) -> str:
    parser = argparse.ArgumentParser(prog=PROG, description=__doc__.splitlines()[0])
    parser.add_argument("--route", choices=sorted(ROUTES), default="view")
    parser.add_argument("--theme", default="default")
    args = parser.parse_args(argv)

    diagram = read_diagram()
    if not diagram:
        raise Failure("no diagram source on stdin")

    return build_url(diagram, args.route, args.theme)


def main(argv: list[str] | None = None) -> int:
    for name in ("stdout", "stderr"):
        try:
            getattr(sys, name).reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            # AttributeError: no `reconfigure` at all -- a caller replaced the
            # stream with something of its own (a test double, an io.StringIO),
            # which already accepts str and has no encoding to change.
            # ValueError: the stream has the method but refuses (e.g. it's
            # already closed); nothing to fix here either -- a write to it
            # will raise on its own terms regardless of encoding.
            pass

    try:
        url = run(sys.argv[1:] if argv is None else argv)
        sys.stdout.write(url + "\n")
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, sys.stdout.fileno())
            os.dup2(devnull, sys.stderr.fileno())
        finally:
            os.close(devnull)
        return 0
    except Exception as error:
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
