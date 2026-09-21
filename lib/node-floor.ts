// The runtime floor, enforced where it is crossed rather than documented and
// hoped for: ADR 001 holds the floor in three places (`.npmrc`,
// `engines.node`, a CI leg) and executes it in one, which is the guard every
// `bin` and every hook calls first. The floor is a property of the release
// and not of this process, so the check is a pure function over a version
// string: an entry point passes `process.version` to it, and the suite passes
// the versions ADR 001's spike table records.
//
// **This file imports nothing, and that is load-bearing.** `import`
// declarations are hoisted and evaluated before any statement in an entry
// point runs, so a guard with a module graph behind it would load that graph
// on the very runtime it exists to refuse, and the sentence a user should
// have read would be a syntax error from inside a dependency instead.
// `plugins/mermaid/bin/mermaid.ts` (#126) makes this its one static import
// and reaches everything else by `await import` after the check, the way
// `bin/gh-security.ts` does in the SurveyMonkey/skills baseline.
//
// This file ships, so it stays inside the erasable subset (no `enum`, no
// parameter properties, no namespaces): node strips the types rather than
// compiling them (ADR 001, RFC 001 decision 12).

/**
 * The oldest node release that runs this marketplace's TypeScript directly
 * with zero bytes on stderr, as the triple the comparison reads and as the
 * string the error message names. From ADR 001: 22.16 and 22.17 fail at
 * launch, and 22.18.0 is the first release that clears both halves.
 */
const NODE_FLOOR_PARTS: readonly [number, number, number] = [22, 18, 0]

export const NODE_FLOOR = NODE_FLOOR_PARTS.join('.')

/** Thrown when the running node cannot execute the plugin that called this. */
export class NodeFloorError extends Error {
  constructor(message: string) {
    super(message)
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this the refusal a user reads at launch is
    // reported as a plain `Error`.
    this.name = 'NodeFloorError'
  }
}

/**
 * A release triple, or `undefined` when the string is not one.
 *
 * The optional `v` is what `process.version` carries; a prerelease or build
 * suffix is stripped and ignored, not because ignoring it is semver-safe in
 * general (`22.18.0-rc.1` sorts below `22.18.0`), but because a real node
 * release binary's `process.version` never carries one, and that is the only
 * caller this floor is compared against.
 *
 * Not a global regular expression: `exec` on one carries `lastIndex` between
 * calls, so the second read of the same string would answer `null`.
 */
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

const parseVersion = (version: string): [number, number, number] | undefined => {
  const match = RELEASE.exec(version)
  if (match === null) return undefined
  // Three mandatory capturing groups inside an anchored match: a successful
  // match always populates all three positions, so the tuple shape is
  // asserted once here rather than defended at each read with a `?? 0`
  // fallback that `noUncheckedIndexedAccess` cannot see is unreachable. The
  // assertion is erased at runtime, so unlike a fallback it adds no branch
  // for coverage to find and no arm a test would have to invent an input for.
  const [, major, minor, patch] = match as unknown as [string, string, string, string]
  return [Number(major), Number(minor), Number(patch)]
}

/**
 * Lexicographic comparison of two release triples: negative when `a` sorts
 * before `b`, positive when after, zero when equal. Major dominates minor
 * dominates patch, each compared as its own subtraction rather than folded
 * into one magnitude, so no component has a ceiling. A collapsed
 * `major * 1_000_000 + minor * 1_000 + patch` would carry a patch of 1000
 * into minor; node has never shipped one, but this check is the first thing
 * that runs on every user's machine and must not encode that as an unstated
 * assumption.
 */
const compareTriples = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * Whether `version` is at or above {@link NODE_FLOOR}.
 *
 * This is the shape a hook needs. ADR 001 requires the hook guard to be
 * silent, because a hook writes into every tool call in a session, so it asks
 * the question and exits quietly rather than catching a refusal it must not
 * print. A version string that cannot be read as a release answers `false`:
 * an unreadable version is not evidence that the floor is met, and treating
 * it as one is the found-nothing-is-a-pass shape this repository refuses
 * everywhere else.
 */
export const meetsNodeFloor = (version: string): boolean => {
  const running = parseVersion(version)
  return running !== undefined && compareTriples(running, NODE_FLOOR_PARTS) >= 0
}

/**
 * Refuse to run on a node older than {@link NODE_FLOOR}.
 *
 * This is the shape a `bin` entry point needs: it throws a
 * {@link NodeFloorError} naming both the required and the running version, so
 * a user below the floor is told what to change rather than left with a
 * failure deep inside a command. One message covers both refusals, the old
 * release and the unreadable string, because the sentence a user acts on is
 * the same either way and a second message would be a second branch with no
 * second remedy behind it.
 */
export const assertNodeFloor = (version: string): void => {
  if (meetsNodeFloor(version)) return
  throw new NodeFloorError(
    `This plugin requires node ${NODE_FLOOR} or newer, but this is node "${version}". ` +
      'Upgrade node, or run Claude Code under a newer release.',
  )
}
