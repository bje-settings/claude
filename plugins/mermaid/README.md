# mermaid

Mermaid diagram previews.

## `/mermaid:view`

Model-invoked. Whenever a Mermaid diagram is written, edited, or reviewed, this skill shares a
preview link from mermaid.live or mermaid.ink. `scripts/mermaid.ts` builds the link; nobody
constructs it by hand.

The diagram source, plus a Mermaid config, is JSON-encoded, zlib-compressed, and
base64url-encoded into the URL fragment. This is the same format mermaid.live's own editor uses.

### Requirements

Node 22.18 or newer.

### Routes

| Flag | Result | Use |
| --- | --- | --- |
| `--route view` (default) | `https://mermaid.live/view#pako:...` | Read-only render. The payload stays in the URL fragment, which browsers never send to a server. |
| `--route edit` | `https://mermaid.live/edit#pako:...` | Only when the user asks to edit it. Same fragment-only handling as `view`. |
| `--route ink-svg` | `https://mermaid.ink/svg/pako:...` | Direct SVG, for markdown/image embeds. The payload is in the URL **path**, so mermaid.ink receives and decodes the diagram server-side. |
| `--route ink-img` | `https://mermaid.ink/img/pako:...` | Direct PNG, for markdown/image embeds. Same server-side handling as `ink-svg`. |

### Flags

| Flag | Effect |
| --- | --- |
| `--theme` | Mermaid theme name, default `default`. Passed through verbatim; not validated against Mermaid's built-in theme set, since Mermaid also accepts custom themes. |
| `--help`, `-h` | Prints usage and exits 0. Wins over every other flag, including an invalid `--route`. It never reads stdin. A diagram is never required to ask for help. |

### Example

From an installed copy of the plugin, `<plugin>` below is the plugin's own directory:

```bash
node <plugin>/scripts/mermaid.ts --route view <<'EOF'
graph TD; A-->B
EOF
```
