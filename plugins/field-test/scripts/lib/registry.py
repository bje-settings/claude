"""Claude's own plugin registry, read the way `ft-resolve.py` needs it.

Two files, both written by Claude Code and neither documented as an interface:
`installed_plugins.json` says where each installed copy of a plugin lives, and
`known_marketplaces.json` says where the marketplace it came from lives. A
registry whose shape has changed is not the same problem as a plugin that is not
installed, and "install it and try again" cannot fix the first one, so a shape
this does not recognise raises rather than coming back empty.
"""

from __future__ import annotations


class RegistryError(Exception):
    """The registry is not shaped the way this expects."""


def installed_rows(document, plugin: str):
    """[(marketplace, install path, version)] for every installed copy of `plugin`.

    A plugin can be installed from more than one marketplace and at more than
    one scope, so the answer is a list and the caller picks the copy that
    actually carries the skill.
    """
    if not isinstance(document, dict):
        raise RegistryError("the registry is not a JSON object")
    plugins = document.get("plugins")
    if plugins is None:
        plugins = {}
    if not isinstance(plugins, dict):
        raise RegistryError("its plugins entry is not an object of plugin@marketplace keys")
    rows = []
    for key, copies in plugins.items():
        if not key.startswith(plugin + "@"):
            continue
        marketplace = key.split("@")[1] if "@" in key else ""
        if not isinstance(copies, list):
            continue
        for copy in copies:
            if not isinstance(copy, dict):
                continue
            rows.append((marketplace, copy.get("installPath") or "", copy.get("version") or ""))
    return rows


def marketplace_path(document, marketplace: str) -> str:
    """Where a marketplace lives, but only when it was added from a directory.

    A marketplace fetched from GitHub has no checkout to name a commit against,
    which is the case the issues care about, so it answers with nothing.
    """
    if not isinstance(document, dict):
        return ""
    entry = document.get(marketplace)
    if not isinstance(entry, dict):
        return ""
    source = entry.get("source")
    if not isinstance(source, dict) or source.get("source") != "directory":
        return ""
    return source.get("path") or entry.get("installLocation") or ""
