// Build a mermaid.live / mermaid.ink preview URL for a diagram read from
// stdin: the TypeScript port of `scripts/mermaid-url.py` (#126), the first
// plugin to carry the root `lib/` symlink. `scripts/mermaid.ts` is the thin
// adapter (RFC 001 decision 3); this is the command function, the seam a
// test reaches without a process: parsed args and the stdin bytes in, an
// envelope out.
//
// **Parity ruling (maintainer, 2026-09-20): parity is of MEANING, not of the
// URL string.** Python's `zlib.compress(..., 9)` and node's `deflateSync` at
// level 9 give different bytes for the same input, because node ships its
// own zlib build, so `url.test.ts` never asserts a URL against a fixed
// string. It inflates what this file produced and compares the parsed
// values against `fixtures/*.json`, captured from the Python before it was
// deleted, at both levels: the outer state object, and its `mermaid` value,
// which is JSON inside JSON.
import { deflateSync } from 'node:zlib'

import { parseArguments } from '../lib/args.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'

/**
 * The four routes `mermaid-url.py` supports, alphabetised: the same order
 * Python's `argparse` reports them in (`choices=sorted(ROUTES)`), so a
 * refusal naming them reads the same even though the wording around it does
 * not (see the PR body). `ARG_SPEC.route.choices` and `USAGE` both read
 * their route list from this object's own keys rather than repeating it by
 * hand, so a route added here later cannot go silently undocumented or
 * silently unreachable in either place (a route added to `choices` alone
 * without a prefix here still fails `tsc` at the index expression in
 * `buildUrl`; a route added here alone, the direction that previously had
 * no check at all, now updates both the spec and the help text for free).
 */
const ROUTE_PREFIXES = {
  edit: 'https://mermaid.live/edit#pako:',
  'ink-img': 'https://mermaid.ink/img/pako:',
  'ink-svg': 'https://mermaid.ink/svg/pako:',
  view: 'https://mermaid.live/view#pako:',
} as const

export type Route = keyof typeof ROUTE_PREFIXES

const ROUTE_CHOICES = Object.keys(ROUTE_PREFIXES) as Route[]

// `as const`, not `: ArgSpec` and not `satisfies ArgSpec`: either annotation
// widens `choices` to `readonly string[]` and every key to `string`, which
// collapses `Options<typeof ARG_SPEC>` to an index signature (lib/README.md,
// lib/args.test.ts). This is the same shape lib/args.test.ts writes as
// mermaid's own command line, the first caller `parseArguments` has, minus
// `help`: `-h`/`--help` is resolved by `wantsHelp` below, before `argv` ever
// reaches `parseArguments`, the way argparse resolves `-h` the instant it
// sees it and before validating anything else on the line. A `help` field
// here would only become true *after* `--route` had already been validated,
// which is what let a bad `--route` beat `--help` to the answer.
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
 * The state is a JSON object with `code` (the diagram source) and `mermaid`
 * (the Mermaid config, itself JSON, as a *string* rather than a nested
 * object, which is what mermaid.live's own decoder expects). Editor UI keys
 * (`grid`, `panZoom`, `pan`, `zoom`, ...) are omitted, as they were in the
 * Python; they are view state, not part of the diagram. `theme` is passed
 * through verbatim: Mermaid accepts custom theme names alongside its
 * built-in set, so nothing here restricts it.
 */
function buildUrl(diagram: string, route: Route, theme: string): string {
  const state = { code: diagram, mermaid: JSON.stringify({ theme }) }
  const compressed = deflateSync(Buffer.from(JSON.stringify(state), 'utf8'), { level: 9 })
  // base64url with the padding removed, exactly as the Python's
  // `base64.urlsafe_b64encode(...).rstrip("=")` leaves it: mermaid.live's
  // decoder re-pads before decoding, so the trailing `=` carries no
  // information the URL needs to keep.
  const payload = compressed.toString('base64url').replace(/=+$/, '')
  return `${ROUTE_PREFIXES[route]}${payload}`
}

/**
 * Decode `bytes` as strict UTF-8 and strip it, the way the diagram source is
 * read before it is encoded. Throws on invalid UTF-8; the caller turns that
 * into a refusal.
 *
 * `fatal: true`: a malformed byte here is data loss, not a display glitch,
 * since it would otherwise be compressed into the URL and shared silently.
 * `ignoreBOM: false`, the default, named here so the choice reads rather
 * than relying on it: a leading byte-order mark is stripped as part of
 * decoding, which is also what `.trim()` would remove from it on its own,
 * since a BOM is inside the set `trim()` treats as whitespace.
 *
 * **Where this diverges from Python, deliberately.** Python's `str.strip()`
 * and JS's `String.prototype.trim()` do not strip the same set. `trim()`
 * removes `U+FEFF` (the BOM); Python's `strip()` does not, since `﻿` is
 * not in the Unicode "whitespace" category Python's `str.isspace()` reads.
 * Going the other way, Python's `strip()` also removes `\x1c` to `\x1f` (the
 * information separator control characters), which `trim()` does not: a
 * diagram carrying one of those at either edge keeps it here and would not
 * have kept it in the script this replaces. `url.test.ts` pins exactly this
 * case rather than working around it, since matching Python there would mean
 * hand-writing a stripper this repository would then own.
 */
function decodeAndTrim(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  return decoder.decode(bytes).trim()
}

/**
 * True when `argv` asks for help. A raw scan of the tokens themselves,
 * checked before anything is parsed, the way argparse resolves `-h` the
 * instant it sees it and before validating anything else on the command
 * line: usage wins over a bad `--route` rather than losing to it.
 * `scripts/mermaid.ts` calls this too, before it touches descriptor 0, so a
 * session asking for `--help` is answered without blocking on a diagram
 * that was never going to be read: the decision of what help means and
 * what it prints stays here, in the seam a test reaches without a
 * process; `bin.ts` only asks whether it still needs to read stdin at all.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('-h') || argv.includes('--help')
}

/**
 * The command function. `argv` is `process.argv.slice(2)`; `stdinBytes` is
 * the diagram source, read whole. Reading stdin and writing the result are
 * the adapter's job; every decision is here, which is what makes this
 * reachable from a test with no process at all.
 */
export function runMermaidUrl(argv: readonly string[], stdinBytes: Uint8Array): Envelope<string> {
  // Checked before argv is parsed, let alone stdin touched: a caller asking
  // for usage should not have to supply a diagram, or a valid --route, to
  // get it.
  if (wantsHelp(argv)) return ok(USAGE)

  const parsed = parseArguments(argv, ARG_SPEC)
  if (parsed.outcome !== 'ok') return parsed

  let diagram: string
  try {
    diagram = decodeAndTrim(stdinBytes)
  } catch {
    // TextDecoder's fatal mode throws a plain TypeError with no offset or
    // byte value in it, unlike Python's UnicodeDecodeError; the message here
    // says what Python's said, that decoding failed, without inventing a
    // position this decoder does not report.
    return refused('diagram source is not valid UTF-8')
  }
  if (diagram === '') return refused('no diagram source on stdin')

  return ok(buildUrl(diagram, parsed.value.route, parsed.value.theme))
}
