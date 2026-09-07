"""Reading GitHub's answer to "which organizations are in your enterprises?".

The GraphQL shape is all that lives here: the queries, and the two readers that
turn a response into slugs, organization logins, and the cursor for the next
page. `ft-enterprise.py` decides what to do with them, and always has an answer,
because "we could not tell" is one.
"""

from __future__ import annotations

FIRST_PAGE = """query {
  viewer {
    enterprises(first: 10) {
      nodes {
        slug
        organizations(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { login }
        }
      }
    }
  }
}"""

NEXT_PAGE = """query($slug: String!, $after: String) {
  enterprise(slug: $slug) {
    organizations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { login }
    }
  }
}"""


def _dig(document, *keys):
    for key in keys:
        if not isinstance(document, dict):
            return None
        document = document.get(key)
    return document


def enterprise_nodes(document):
    """The enterprises node of a first-page response, or None when there is none.

    None is the answer for a response that parsed but carries no enterprises:
    a token without read:enterprise gets one of those, and reading it as "no
    enterprises" would publish a repository name on the strength of a missing
    scope.
    """
    nodes = _dig(document, "data", "viewer", "enterprises", "nodes")
    return nodes if isinstance(nodes, list) else None


def enterprise_rows(document):
    """[(slug, has next page, cursor)] for every enterprise on the first page.

    Enterprises are few; the pagination this feeds only runs for one that has
    more than a hundred organizations, which is the case the first page would
    answer wrongly.
    """
    rows = []
    for node in enterprise_nodes(document) or []:
        if not isinstance(node, dict):
            continue
        page = _dig(node, "organizations", "pageInfo") or {}
        rows.append(
            (
                node.get("slug") or "",
                bool(page.get("hasNextPage")),
                page.get("endCursor") or "",
            )
        )
    return rows


def logins_of(document, slug: str):
    """The organization logins the first page holds for one enterprise slug."""
    logins = []
    for node in enterprise_nodes(document) or []:
        if not isinstance(node, dict) or node.get("slug") != slug:
            continue
        for organization in _dig(node, "organizations", "nodes") or []:
            if isinstance(organization, dict) and organization.get("login"):
                logins.append(organization["login"])
    return logins


def page_of(document):
    """(logins, has next page, cursor) from one `enterprise(slug:)` page."""
    organizations = _dig(document, "data", "enterprise", "organizations") or {}
    page = organizations.get("pageInfo") if isinstance(organizations, dict) else None
    page = page if isinstance(page, dict) else {}
    nodes = organizations.get("nodes") if isinstance(organizations, dict) else None
    logins = [
        node["login"] for node in (nodes or []) if isinstance(node, dict) and node.get("login")
    ]
    return logins, bool(page.get("hasNextPage")), page.get("endCursor") or ""
