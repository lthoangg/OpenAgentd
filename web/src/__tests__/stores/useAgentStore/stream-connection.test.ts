import { describe, expect, it } from "bun:test"
import {
  decideAbort,
  decideFrame,
  decideReconnectTimer,
  decideSilence,
  decideStreamEnd,
  decideStreamError,
  reconnectDelay,
} from "@/stores/useAgentStore/stream-connection"

/** One row of a decision table: the input and the decision it must produce. */
type Case<F extends (input: never) => unknown> = [Parameters<F>[0], ReturnType<F>]

const live = { aborted: false, sameSession: true, unloading: false }

describe("decideFrame", () => {
  const cases: Case<typeof decideFrame>[] = [
    [{ ...live, type: "message" }, { kind: "apply" }],
    [{ ...live, type: "error" }, { kind: "apply" }],
    [{ ...live, aborted: true, type: "message" }, { kind: "ignore", reason: "superseded" }],
    [{ ...live, sameSession: false, type: "message" }, { kind: "ignore", reason: "session_changed" }],
    [{ ...live, unloading: true, type: "error" }, { kind: "ignore", reason: "unloading" }],
    [{ ...live, unloading: true, type: "message" }, { kind: "apply" }],
    // A replaced link is stale before anything else is asked of it.
    [{ aborted: true, sameSession: false, unloading: true, type: "error" }, { kind: "ignore", reason: "superseded" }],
  ]
  it.each(cases)("%o -> %o", (input, expected) => {
    expect(decideFrame(input)).toEqual(expected)
  })
})

describe("decideStreamError", () => {
  const base = { ...live, transient: false, working: true, message: "boom" }
  const cases: Case<typeof decideStreamError>[] = [
    [base, { kind: "fail", message: "boom" }],
    [{ ...base, working: false }, { kind: "detach" }],
    [{ ...base, transient: true }, { kind: "back_off" }],
    [{ ...base, transient: true, working: false }, { kind: "back_off" }],
    [{ ...base, aborted: true }, { kind: "ignore", reason: "superseded" }],
    [{ ...base, unloading: true }, { kind: "ignore", reason: "unloading" }],
    [{ ...base, sameSession: false, aborted: true }, { kind: "ignore", reason: "session_changed" }],
  ]
  it.each(cases)("%o -> %o", (input, expected) => {
    expect(decideStreamError(input)).toEqual(expected)
  })
})

describe("decideStreamEnd", () => {
  const base = { ...live, working: true, receivedAnyEvent: true }
  const cases: Case<typeof decideStreamEnd>[] = [
    [base, { kind: "reattach" }],
    [{ ...base, receivedAnyEvent: false }, { kind: "back_off" }],
    [{ ...base, working: false }, { kind: "idle" }],
    // Unloading reads as the end of the turn, never as a reason to reopen.
    [{ ...base, unloading: true }, { kind: "idle" }],
    [{ ...base, aborted: true }, { kind: "ignore", reason: "superseded" }],
    [{ ...base, sameSession: false }, { kind: "ignore", reason: "session_changed" }],
  ]
  it.each(cases)("%o -> %o", (input, expected) => {
    expect(decideStreamEnd(input)).toEqual(expected)
  })
})

describe("decideReconnectTimer", () => {
  const cases: Case<typeof decideReconnectTimer>[] = [
    [{ sameSession: true, unloading: false, connected: false }, { kind: "reconnect" }],
    [{ sameSession: true, unloading: false, connected: true }, { kind: "ignore", reason: "already_connected" }],
    [{ sameSession: true, unloading: true, connected: false }, { kind: "ignore", reason: "unloading" }],
    [{ sameSession: false, unloading: false, connected: false }, { kind: "ignore", reason: "session_changed" }],
  ]
  it.each(cases)("%o -> %o", (input, expected) => {
    expect(decideReconnectTimer(input)).toEqual(expected)
  })
})

describe("decideSilence", () => {
  const base = { current: true, sameSession: true, working: true, unloading: false }
  const cases: Case<typeof decideSilence>[] = [
    [base, { kind: "resync" }],
    [{ ...base, current: false }, { kind: "ignore", reason: "superseded" }],
    [{ ...base, sameSession: false }, { kind: "ignore", reason: "session_changed" }],
    [{ ...base, working: false }, { kind: "ignore", reason: "not_expected" }],
    [{ ...base, unloading: true }, { kind: "ignore", reason: "not_expected" }],
  ]
  it.each(cases)("%o -> %o", (input, expected) => {
    expect(decideSilence(input)).toEqual(expected)
  })
})

describe("decideAbort", () => {
  it("detaches the current link aborted from outside", () => {
    expect(decideAbort({ replaced: false, current: true })).toEqual({ kind: "detach" })
  })

  it("leaves a replaced link's successor connected", () => {
    expect(decideAbort({ replaced: true, current: true })).toEqual({ kind: "ignore", reason: "superseded" })
    expect(decideAbort({ replaced: false, current: false })).toEqual({ kind: "ignore", reason: "superseded" })
  })
})

describe("reconnectDelay", () => {
  it("doubles from 1.5s and caps at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000])
  })
})
