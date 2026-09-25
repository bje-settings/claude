---
name: view
description: >
  Share a preview link whenever a Mermaid diagram is written, edited, or
  reviewed. Builds the link from a script; never construct the URL by hand.
allowed-tools: Bash
---

Pipe the diagram source into the script and post the link it prints.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mermaid.ts" --route view <<'EOF'
<diagram source>
EOF
```

Post it as a short markdown link, never bare: `[Preview: <short description>](<url>)`.
Add `--theme <name>` when the user asks for a specific Mermaid theme (default is `default`).

`view` is the default, and it is read-only. The diagram never leaves the browser. mermaid.live
decodes it from the URL fragment, and a browser never sends that fragment to a server.
Use `--route edit` only when the user asks for an editable link.

`--route ink-svg`/`--route ink-img` send the diagram to mermaid.ink instead, which decodes
it server-side to return an image. Use one of these only when the diagram goes into a markdown
or issue image embed, not chat. Only use them for a diagram that is safe to send to a third
party.
