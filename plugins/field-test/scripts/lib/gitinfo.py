"""What a checkout says about itself: its origin remote, and the owner in it.

Split on the last host separator rather than on the literal "github.com": an
ssh host alias (git@github.com-work:acme/app.git, which is how one machine
holds two GitHub accounts) otherwise parses as the owner "-work:acme", which
matches no enterprise organization, reads as a repository outside the
enterprise, and is an owner redaction never replaces.
"""

from __future__ import annotations

import subprocess


def git(directory: str, *args):
    """Run git in `directory`. Returns its stdout stripped, or "" on failure."""
    try:
        finished = subprocess.run(
            ["git", "-C", directory, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return ""
    if finished.returncode != 0:
        return ""
    return finished.stdout.decode("utf-8", "replace").rstrip("\n")


def owner_repo_of(url: str) -> str:
    """The owner/name a remote URL ends in, for the ssh, scp and https spellings.

    Empty when the URL names anything else, which is a remote no issue can be
    filed against and no name can be redacted from.
    """
    if not url:
        return ""
    trimmed = url[:-4] if url.endswith(".git") else url
    trimmed = trimmed.split("://", 1)[-1]
    trimmed = trimmed.split("@", 1)[-1]
    trimmed = trimmed.split(":", 1)[-1]
    parts = trimmed.split("/")
    if len(parts) > 2:
        parts = parts[1:]
    if len(parts) != 2:
        return ""
    return "/".join(parts)


def origin_url(directory: str) -> str:
    return git(directory, "remote", "get-url", "origin")


def owner_of(directory: str) -> str:
    """The owner segment of a checkout's origin remote, or "" when there is none."""
    slug = owner_repo_of(origin_url(directory))
    return slug.split("/")[0] if slug else ""
