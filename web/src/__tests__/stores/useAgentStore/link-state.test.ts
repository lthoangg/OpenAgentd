/**
 * The session link machine (``stores/useAgentStore/link-state.ts``): its
 * table, the back-off count, and the direct-feed fallback starting over on
 * the next visit.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { IllegalTransition } from "@/lib/machine"
import { LINK_CLOSED, isLinkOpen, linkMachine, linkOf } from "@/stores/useAgentStore/link-state"

beforeEach(resetAsyncStore)

describe("session link machine", () => {
  it("lists exactly these moves", () => {
    expect(linkMachine.moves()).toEqual([
      ["closed", "open"],
      ["closed", "frame"],
      ["closed", "back_off"],
      ["closed", "close"],
      ["closed", "reset"],
      ["open", "open"],
      ["open", "frame"],
      ["open", "back_off"],
      ["open", "close"],
      ["open", "reset"],
      ["backoff", "open"],
      ["backoff", "frame"],
      ["backoff", "back_off"],
      ["backoff", "close"],
      ["backoff", "reset"],
    ])
  })

  it("counts reconnects until a frame arrives, across the reopen", () => {
    let link = linkMachine.transition(linkOf(true), { type: "back_off" })
    link = linkMachine.transition(link, { type: "open" })
    link = linkMachine.transition(link, { type: "back_off" })
    expect(link).toEqual({ kind: "backoff", attempt: 2 })
    expect(linkMachine.transition(link, { type: "frame" })).toEqual({ kind: "backoff", attempt: 0 })
    expect(isLinkOpen(linkMachine.transition(link, { type: "open" }))).toBe(true)
  })

  it("refuses an event it does not know", () => {
    expect(() => linkMachine.transition(LINK_CLOSED, { type: "teleport" } as never)).toThrow(IllegalTransition)
  })

  it("forgets the direct-feed fallback when another session opens", () => {
    useAgentStore.setState({ sessionId: "s1", _directStreamSession: "s1", streamLink: linkOf(true, 3) })
    useAgentStore.getState().beginResolvedSession("s2", { workspace: "/w" })
    expect(useAgentStore.getState()._directStreamSession).toBeNull()
    expect(useAgentStore.getState().streamLink).toEqual(LINK_CLOSED)
  })
})
