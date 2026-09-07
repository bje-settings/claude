"""The fold ws-pr-comments.py runs over one pull request's GraphQL answer.

Three connections come back in one query -- the reviews, the issue comments, and
the review threads -- and the review round reads them as one list of findings.
Flattening them is where the decisions live: which entries are a bot's, which
thread a comment belongs to and whether that thread is resolved, and which
records carry nothing worth reading. Each is a plain function with a unit test
per arm in `tests/workstreams/test_pr_comments.py`, for the reason
`.claude/rules/type-jq.md` gives: a decision buried in a query string is a
decision no coverage report can name.

Nothing here runs gh or touches the filesystem: `flatten` takes the parsed
`pullRequest` object and returns the list to print.
"""

from __future__ import annotations

# One query, three connections, three cursors. The skill reads all three
# together, and asking for them separately would be three round trips to say the
# same thing. Thread comments are taken 100 to a thread and not paged: a review
# thread longer than that is a conversation, not a finding waiting to be applied.
QUERY = """
query($owner: String!, $name: String!, $number: Int!,
      $reviewsAfter: String, $commentsAfter: String, $threadsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $reviewsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body state author { login __typename } }
      }
      comments(first: 100, after: $commentsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body author { login __typename } }
      }
      reviewThreads(first: 100, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) {
            nodes { databaseId body path line author { login __typename } }
          }
        }
      }
    }
  }
}
"""

# The three connections, in the order they are emitted, paired with the cursor
# name the query takes for each. The script drives its paging from this rather
# than from three copies of the same three lines.
CONNECTIONS = (
    ("reviews", "reviewsAfter"),
    ("comments", "commentsAfter"),
    ("reviewThreads", "threadsAfter"),
)


class Malformed(Exception):
    """An answer this fold cannot read, with the message to report.

    Status 1, which is what ws-pr-comments.py exits on any failure: the round
    that called it has nothing to read either way, and the caller's next tick is
    what decides whether to try again. It carries the pair `cli.run` reports, and
    the script names the class when it calls `run`, the way `pr_status.Malformed`
    is handled: nothing under `lib/` imports another `lib/` module.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
        self.status = 1


def is_bot(author: dict) -> bool:
    """Whether an author is a bot rather than a person.

    Two ways of telling, and both are needed. GitHub types a GitHub App's
    account as `Bot`, which covers most review bots; an account that is a bot by
    convention rather than by type -- one installed as a machine user -- has the
    `[bot]` suffix on its login and the `User` typename. The round replies to a
    bot's thread and a human's thread the same way, but it weighs what they say
    differently, so getting this wrong is a finding read at the wrong altitude.
    """
    if author.get("__typename") == "Bot":
        return True
    login = author.get("login")
    return isinstance(login, str) and login.endswith("[bot]")


def author_of(node: dict) -> dict:
    """The author object, as an object even when GitHub answers with null.

    A comment whose author deleted their account comes back with `author: null`.
    That is a comment worth reading, not a record to drop, so it flattens with an
    empty login and `bot` false rather than raising.
    """
    author = node.get("author")
    return author if isinstance(author, dict) else {}


def entry(node: dict, kind: str, resolved: bool, path, line) -> dict:
    """One record in the flat list the review round reads."""
    author = author_of(node)
    return {
        "id": node.get("databaseId"),
        "kind": kind,
        "author": author.get("login") or "",
        "bot": is_bot(author),
        "resolved": resolved,
        "path": path,
        "line": line,
        "body": node.get("body") or "",
    }


def nodes_of(connection) -> list:
    """The `nodes` of a connection, refusing a shape the fold cannot walk."""
    if not isinstance(connection, dict):
        raise Malformed("the answer has no connection where one was asked for")
    nodes = connection.get("nodes")
    if nodes is None:
        return []
    if not isinstance(nodes, list):
        raise Malformed("a connection's nodes are not a list")
    return [node for node in nodes if isinstance(node, dict)]


def reviews(pull: dict) -> list:
    """The review bodies, dropping the ones that carry no text.

    GitHub records a review for every batch of inline comments, and a batch sent
    with no summary leaves a review whose body is empty. Its comments are in the
    threads already, so keeping the empty shell would put a finding with nothing
    in it in front of the round.
    """
    found = []
    for node in nodes_of(pull.get("reviews")):
        if not (node.get("body") or "").strip():
            continue
        found.append(entry(node, "review", False, None, None))
    return found


def comments(pull: dict) -> list:
    """The issue comments on the pull request, in the order GitHub returns them."""
    return [entry(node, "comment", False, None, None) for node in nodes_of(pull.get("comments"))]


def threads(pull: dict) -> list:
    """Every review thread's comments, each carrying its thread's resolved flag.

    The flag travels on the comment rather than on a thread of its own because
    the round decides per finding, and a resolved thread is one somebody has
    already dealt with. `line` is null on a comment GitHub has marked outdated;
    that is passed through rather than guessed at.
    """
    found = []
    for thread in nodes_of(pull.get("reviewThreads")):
        resolved = thread.get("isResolved") is True
        for node in nodes_of(thread.get("comments")):
            found.append(entry(node, "thread", resolved, node.get("path"), node.get("line")))
    return found


def flatten(pull: dict) -> list:
    """One page of all three connections, as one list, reviews first."""
    return reviews(pull) + comments(pull) + threads(pull)


def page(pull: dict, name: str):
    """A connection's `(hasNextPage, endCursor)`.

    A connection that says there is another page but names no cursor to ask for
    it would send the caller round the same page forever, so it is refused here
    rather than hanging the round that called the script.
    """
    connection = pull.get(name)
    if not isinstance(connection, dict):
        raise Malformed(f"the answer has no {name} connection")
    info = connection.get("pageInfo")
    info = info if isinstance(info, dict) else {}
    has_next = info.get("hasNextPage") is True
    cursor = info.get("endCursor")
    if has_next and not isinstance(cursor, str):
        raise Malformed(f"{name} says there is another page but names no cursor")
    return has_next, cursor


def pull_request(payload) -> dict:
    """The `pullRequest` object inside gh's answer, or the reason there is none.

    A GraphQL error reaches this only when gh still exited 0, which it does for a
    partial answer: the data half is null and the errors half says why. That
    message is GitHub's own and is worth more than any summary of it.
    """
    if not isinstance(payload, dict):
        raise Malformed("gh did not answer with a JSON object")
    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        first = errors[0] if isinstance(errors[0], dict) else {}
        raise Malformed(first.get("message") or "GitHub answered with an error")
    data = payload.get("data")
    repository = (data or {}).get("repository") if isinstance(data, dict) else None
    pull = (repository or {}).get("pullRequest") if isinstance(repository, dict) else None
    if not isinstance(pull, dict):
        raise Malformed("gh answered with no pull request")
    return pull
