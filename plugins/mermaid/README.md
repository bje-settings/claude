# mermaid

Mermaid diagram previews.

## `/mermaid:view`

Model-invoked: whenever a Mermaid diagram is written, edited, or reviewed, shares a
preview link built by `scripts/mermaid-url.py` — never constructed by hand.

The diagram source, plus a Mermaid config, is JSON-encoded, zlib-compressed, and
base64url-encoded into the URL fragment, the same format mermaid.live's own editor uses.

### Routes

| Flag | Result | Use |
| --- | --- | --- |
| `--route view` (default) | `https://mermaid.live/view#pako:...` | Read-only render. |
| `--route edit` | `https://mermaid.live/edit#pako:...` | Only when the user asks to edit it. |
| `--route ink-svg` | `https://mermaid.ink/svg/pako:...` | Direct SVG, for markdown/image embeds. |
| `--route ink-img` | `https://mermaid.ink/img/pako:...` | Direct PNG, for markdown/image embeds. |

### Flags

| Flag | Effect |
| --- | --- |
| `--theme` | Mermaid theme name, default `default`. |

### Example

```bash
python3 scripts/mermaid-url.py --route view <<'EOF'
graph TD; A-->B
EOF
```
