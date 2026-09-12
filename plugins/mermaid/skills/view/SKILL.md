---
name: view
description: >
  Share a preview link whenever a Mermaid diagram is written, edited, or
  reviewed. Builds the link from a script; never construct the URL by hand.
allowed-tools: Bash
---

Pipe the diagram source into the script and post the link it prints.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/mermaid-url.py" --route view <<'EOF'
<diagram source>
EOF
```

Post it as a short markdown link, never bare: `[Preview: <short description>](<url>)`.

`view` is the default and read-only. Use `--route edit` only when the user asks for an
editable link. Use `--route ink-svg` or `--route ink-img` only when the diagram is going
into a markdown or issue image embed rather than chat.
