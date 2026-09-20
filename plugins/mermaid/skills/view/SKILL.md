---
name: view
description: >
  Share a preview link whenever a Mermaid diagram is written, edited, or
  reviewed. Builds the link from a script; never construct the URL by hand.
allowed-tools: Bash
---

Pipe the diagram source into the script and post the link it prints.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/mermaid.ts" --route view <<'EOF'
<diagram source>
EOF
```

Post it as a short markdown link, never bare: `[Preview: <short description>](<url>)`.
Add `--theme <name>` when the user asks for a specific Mermaid theme (default is `default`).

`view` is the default and read-only: the diagram never leaves the browser, since
mermaid.live decodes it from the URL fragment, which is never sent to a server.
Use `--route edit` only when the user asks for an editable link.

`--route ink-svg`/`--route ink-img` send the diagram to mermaid.ink instead, which decodes
it server-side to return an image. Use one of these only when the diagram is going into a
markdown or issue image embed rather than chat, and only for a diagram that's fine to send
to a third party.
