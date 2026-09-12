"""Build a mermaid.live / mermaid.ink preview URL for a diagram read from stdin.

One script, no `lib/`: this plugin has nothing else to share it with. The guard
around `main` (UTF-8 streams, broken-pipe handling) is the same shape every
other plugin's `scripts/lib/cli.py` gives its scripts; inlined here rather than
imported, since nothing crosses plugin boundaries and there is no second script
in this plugin to justify a shared module.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import zlib

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
    not part of the diagram.
    """
    state = {"code": diagram, "mermaid": json.dumps({"theme": theme})}
    compressed = zlib.compress(json.dumps(state).encode("utf-8"), 9)
    payload = base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")
    return ROUTES[route].format(payload=payload)


def run(argv: list[str]) -> str:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--route", choices=sorted(ROUTES), default="view")
    parser.add_argument("--theme", default="default")
    args = parser.parse_args(argv)

    diagram = sys.stdin.read().strip()
    if not diagram:
        raise Failure("no diagram source on stdin")

    return build_url(diagram, args.route, args.theme)


def main() -> int:
    # stdin too, not just stdout/stderr: unlike most plugin scripts, this one's
    # own input is untrusted text (the diagram source), not just its output.
    for name in ("stdin", "stdout", "stderr"):
        try:
            getattr(sys, name).reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    prog = "mermaid-url"
    try:
        url = run(sys.argv[1:])
        sys.stdout.write(url + "\n")
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{prog}: {error.message}\n")
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
        sys.stderr.write(f"{prog}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
