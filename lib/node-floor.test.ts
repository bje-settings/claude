// The node floor check (ADR 001). The seam is the exported function: it takes
// a version string rather than reading `process.version`, so every row below
// is a real verdict rather than a fact about the machine running the suite.
//
// Every expected value here is hand-written, either taken from ADR 001's
// account of the spike (22.16 and 22.17 fail at launch, 22.18.0 is the first
// release that runs with zero bytes on stderr, and 22.22.2, 24.15.0 and
// 24.18.0 run) or a hand-authored extrapolation from it (older majors, an
// unreadable string). None of it is recomputed the way the module computes it.
import { describe, expect, it } from 'vitest'

import { assertNodeFloor, meetsNodeFloor, NODE_FLOOR, NodeFloorError } from './node-floor.ts'

// `v`-prefixed because that is the shape `process.version` has; the bare
// spelling is here because a version read from anywhere else does not carry
// the prefix, and one spelling passing while the other refused would be a
// launch-time failure on a supported runtime.
const AT_OR_ABOVE = ['v22.18.0', '22.18.0', 'v22.18.1', 'v22.22.2', 'v24.15.0', 'v26.0.0']
const BELOW = ['v22.17.1', 'v22.17.0', 'v22.16.0', 'v20.19.0', 'v18.20.8', 'v21.7.3']
// A version string the check cannot read is not evidence that the floor is
// met. Passing an unparsable value is the found-nothing-is-a-pass shape every
// gate in this repository refuses, arriving inside the runtime check.
const UNREADABLE = ['banana', '', 'v22', '22.18', 'v22.18.x', 'v22.18.0.1']

it('states the floor ADR 001 decided', () => {
  expect(NODE_FLOOR).toBe('22.18.0')
})

describe('meetsNodeFloor', () => {
  it.each(AT_OR_ABOVE)('answers true for %s, at or above the floor', (version) => {
    expect(meetsNodeFloor(version)).toBe(true)
  })

  it.each(BELOW)('answers false for %s, below the floor', (version) => {
    expect(meetsNodeFloor(version)).toBe(false)
  })

  it.each(UNREADABLE)('answers false for %s, which it cannot read', (version) => {
    expect(meetsNodeFloor(version)).toBe(false)
  })

  it('answers the same on a second reading of the same string', () => {
    // The regular expression is shared between calls. A global one would
    // carry `lastIndex` forward and answer false the second time, which is a
    // hook passing on its first tool call of a session and refusing on the
    // next.
    expect(meetsNodeFloor('v22.18.0')).toBe(true)
    expect(meetsNodeFloor('v22.18.0')).toBe(true)
  })

  // Each component is compared as its own subtraction, so a component may
  // exceed 999 without carrying into the one above it. Node has never shipped
  // such a release; the floor check is the first thing that runs on every
  // machine, so the property is asserted rather than assumed.
  it('compares each component on its own', () => {
    expect(meetsNodeFloor('v22.18.1000')).toBe(true)
    expect(meetsNodeFloor('v22.17.1000')).toBe(false)
  })

  it('ignores a prerelease or build suffix', () => {
    expect(meetsNodeFloor('v22.18.0-nightly20260101')).toBe(true)
    expect(meetsNodeFloor('v22.18.0+build.7')).toBe(true)
  })
})

describe('assertNodeFloor', () => {
  it.each(AT_OR_ABOVE)('accepts %s', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).not.toThrow()
  })

  it.each([...BELOW, ...UNREADABLE])('refuses %s', (version) => {
    expect(() => {
      assertNodeFloor(version)
    }).toThrow(NodeFloorError)
  })

  it('names both the required and the running version', () => {
    // The message is what a user reads at launch instead of a working plugin
    // (ADR 001, Consequences), so it has to say what is required and what
    // they are actually running. A message naming only one of the two leaves
    // them guessing which half to change.
    let thrown: unknown
    try {
      assertNodeFloor('v22.17.1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(NodeFloorError)
    const error = thrown as NodeFloorError
    expect(error.message).toContain('22.18.0')
    expect(error.message).toContain('22.17.1')
    // And what to do about it. ADR 001's Consequences make the remedy the
    // reason this message exists at all, so a message that named only the
    // two versions would leave a user knowing they are stuck without knowing
    // what to change.
    expect(error.message).toContain('Upgrade node')
    // Named explicitly rather than inherited: a refusal reported as a plain
    // `Error` tells a reader nothing about which guard refused.
    expect(error.name).toBe('NodeFloorError')
  })

  it('quotes the unreadable version in the message', () => {
    expect(() => {
      assertNodeFloor('banana')
    }).toThrow(/"banana"/)
  })
})
