// Build a mermaid.live or mermaid.ink preview URL for a diagram read from
// stdin. This is the TypeScript port of `scripts/mermaid-url.py` (#126). It
// is the first plugin to carry the root `lib/` symlink. `scripts/mermaid.ts`
// is the thin adapter (RFC 001 decision 3). This file has the command
// function: the seam a test reaches without a process. Parsed arguments and
// the stdin bytes go in; an envelope comes out.
//
// **Parity ruling (maintainer, 2026-09-20): parity is of MEANING, not of the
// URL string.** Python's `zlib.compress(..., 9)` and node's `deflateSync` at
// level 9 give different bytes for the same input. Node ships its own zlib
// build. So `tests/plugins/mermaid/subcommands/url.test.ts` never asserts a URL against a fixed string.
//
// It inflates what this file produced. It compares the parsed values
// against `tests/plugins/mermaid/fixtures/*.json`. These fixtures were captured from the Python
// code before deletion. The comparison checks both levels: the outer state
// object, and its `mermaid` value. The `mermaid` value is JSON inside JSON.
import { deflateSync } from 'node:zlib'

import { parseArguments } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'

/**
 * `mermaid-url.py` supports four routes, alphabetised. This is the same
 * order Python's `argparse` reports them in (`choices=sorted(ROUTES)`). So
 * a refusal that names them reads the same, even though the wording around
 * it does not. See the PR body.
 *
 * `ARG_SPEC.route.choices` and `USAGE` both read their route list from this
 * object's own keys. They do not repeat the list by hand. So a route added
 * here later cannot go silently undocumented, or silently unreachable, in
 * either place. A route added to `choices` alone, without a prefix here,
 * still fails `tsc` at the index expression in `buildUrl`. A route added
 * here alone updates both the spec and the help text for free. Before this
 * change, that direction had no check at all.
 */
const ROUTE_PREFIXES = {
  edit: 'https://mermaid.live/edit#pako:',
  'ink-img': 'https://mermaid.ink/img/pako:',
  'ink-svg': 'https://mermaid.ink/svg/pako:',
  view: 'https://mermaid.live/view#pako:',
} as const

export type Route = keyof typeof ROUTE_PREFIXES

const ROUTE_CHOICES = Object.keys(ROUTE_PREFIXES) as Route[]

// This uses `as const`, not `: ArgSpec` and not `satisfies ArgSpec`. Either
// annotation widens `choices` to `readonly string[]` and every key to
// `string`. That collapses `Options<typeof ARG_SPEC>` to an index signature
// (lib/README.md, tests/lib/args.test.ts). This is the same shape tests/lib/args.test.ts
// writes as mermaid's own command line. It is the first caller
// `parseArguments` has, minus `help`. `-h`/`--help` is resolved by
// `wantsHelp` below, before `argv` ever reaches `parseArguments`.
//
// This matches the way argparse resolves `-h`: the instant it sees `-h`,
// before it checks anything else on the line. A `help` field here would
// only become true *after* `--route` had already been validated. That is
// what let a bad `--route` beat `--help` to the answer.
const ARG_SPEC = {
  route: { type: 'string', default: 'view', choices: ROUTE_CHOICES },
  theme: { type: 'string', default: 'default' },
} as const

const USAGE =
  `mermaid.ts [--route {${ROUTE_CHOICES.join(',')}}] [--theme NAME], diagram source on ` +
  'stdin: prints a mermaid.live or mermaid.ink preview URL.'

/**
 * Encode `diagram` the way mermaid.live's own editor does: pako in the URL.
 *
 * The state is a JSON object with `code` (the diagram source) and
 * `mermaid` (the Mermaid config). The `mermaid` value is itself JSON, but
 * as a *string*, not a nested object. That is what mermaid.live's own
 * decoder expects. Editor UI keys (`grid`, `panZoom`, `pan`, `zoom`, ...)
 * are omitted, as they were in the Python. They are view state, not part
 * of the diagram. `theme` is passed through verbatim: Mermaid accepts
 * custom theme names alongside its built-in set, so nothing here
 * restricts it.
 */
function buildUrl(diagram: string, route: Route, theme: string): string {
  const state = { code: diagram, mermaid: JSON.stringify({ theme }) }
  const compressed = deflateSync(Buffer.from(JSON.stringify(state), 'utf8'), { level: 9 })
  // This is base64url, with the padding removed, exactly as Python's
  // `base64.urlsafe_b64encode(...).rstrip("=")` leaves it. mermaid.live's
  // decoder re-pads before it decodes. So the trailing `=` carries no
  // information the URL needs to keep.
  const payload = compressed.toString('base64url').replace(/=+$/, '')
  return `${ROUTE_PREFIXES[route]}${payload}`
}

/**
 * Decode `bytes` as strict UTF-8 and strip it, the way the diagram source is
 * read before it is encoded. Throws on invalid UTF-8; the caller turns that
 * into a refusal.
 *
 * `fatal: true`: a malformed byte here is data loss, not a display glitch.
 * Otherwise, it would be compressed into the URL and shared silently.
 *
 * `ignoreBOM: false` is the default. It is named here so the choice is
 * explicit, not left implicit. A leading byte-order mark is stripped as
 * part of decoding. `.trim()` would also remove it on its own. A BOM is
 * inside the set `trim()` treats as whitespace.
 *
 * **Where this diverges from Python, deliberately.** Python's `str.strip()`
 * and JS's `String.prototype.trim()` do not strip the same set. `trim()`
 * removes `U+FEFF` (the BOM). Python's `strip()` does not, since `﻿` is
 * not in the Unicode "whitespace" category Python's `str.isspace()` reads.
 *
 * In the other direction, Python's `strip()` also removes `\x1c` to `\x1f`
 * (the information separator controls). `trim()` does not remove these
 * characters. A diagram that carries one of those characters at either
 * edge keeps it here. The old script would have removed it there.
 *
 * `tests/plugins/mermaid/subcommands/url.test.ts` pins exactly this case, instead of a workaround. To match
 * Python here, this repository would need to write its own stripper by
 * hand. This repository would then own that code.
 */
function decodeAndTrim(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  return decoder.decode(bytes).trim()
}

/**
 * True when `argv` asks for help. This is a raw scan of the tokens
 * themselves, checked before anything is parsed. It matches how argparse
 * resolves `-h`, the instant it sees `-h`, before it checks anything else
 * on the line. So usage wins over a bad `--route`. It does not lose to
 * one.
 *
 * `scripts/mermaid.ts` calls this too, before it touches descriptor 0. So
 * a session that asks for `--help` gets an answer. It does not wait for a
 * diagram that this call will never read. The decision of what help means
 * and what it prints stays here. This is the seam a test reaches without
 * a process. `bin.ts` only asks whether it still needs to read stdin at
 * all.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('-h') || argv.includes('--help')
}

/**
 * The command function. `argv` is `process.argv.slice(2)`; `stdinBytes` is
 * the diagram source, read whole. The adapter's job is to read stdin and
 * write the result. Every decision is here. That is what makes this
 * reachable from a test with no process at all.
 */
export function runMermaidUrl(argv: readonly string[], stdinBytes: Uint8Array): Envelope<string> {
  // This check runs before argv is parsed, and before stdin is touched. A
  // caller that asks for usage should not have to supply a diagram, or a
  // valid --route, to get it.
  if (wantsHelp(argv)) return ok(USAGE)

  const parsed = parseArguments(argv, ARG_SPEC)
  if (parsed.outcome !== 'ok') return parsed

  let diagram: string
  try {
    diagram = decodeAndTrim(stdinBytes)
  } catch {
    // TextDecoder's fatal mode throws a plain TypeError. It has no offset or
    // byte value in it, unlike Python's UnicodeDecodeError. The message here
    // says what Python's message said: the text could not be decoded. It
    // does not invent a position this decoder does not report.
    return refused('diagram source is not valid UTF-8')
  }
  if (diagram === '') return refused('no diagram source on stdin')

  return ok(buildUrl(diagram, parsed.value.route, parsed.value.theme))
}
