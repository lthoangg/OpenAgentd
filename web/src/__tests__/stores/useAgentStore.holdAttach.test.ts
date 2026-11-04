/**
 * The live feed attached beside the history read (``connectStream({ holdUntil })``).
 *
 * Opening a running session reads its history and attaches its feed at once.
 * Frames that arrive while the read is in flight must wait for it (applied
 * earlier, the read's commit wiped them), then apply on top of it; and a step
 * the attach replayed that the read then found saved must not show twice.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
let streamCallbacks: any = null
const mockAgentStream = mock((_sid: any, callbacks: any) => { streamCallbacks = callbacks }) as any
;(mock as any).module("@/api/client", () => ({
  agentStream: mockAgentStream,
  sessionHistorySince: mock(async () => ({ lead: { messages: [] }, members: [], truncated: false })),
  sessionHistory: mock(async () => { throw new Error("not used") }),
  agentStatus: mock(async () => ({ lead: null, members: [] })),
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

function lead() {
  return useAgentStore.getState().agentStreams.lead
}

/** A history load whose commit the test drives. */
function pendingHistory(blocks: ContentBlock[]) {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => {
      useAgentStore.setState((state) => {
        state.isAgentWorking = true
        state.agentStreams.lead.blocks = blocks
        state.agentStreams.lead.currentBlocks = []
        state.agentStreams.lead.status = "working"
      })
      done()
    }
  })
  return { promise, commit: async () => { resolve(); await promise; await Promise.resolve() } }
}

beforeEach(() => {
  streamCallbacks = null
  useAgentStore.setState({
    sessionId: "s1",
    _workspace: "/repo",
    leadName: "lead",
    agentNames: ["lead"],
    isAgentWorking: false,
    _syncedThrough: null,
    loadSession: mock(async () => {}),
    agentStreams: {
      lead: { ...useAgentStore.getState().agentStreams.lead, blocks: [], currentBlocks: [], status: "idle" } as never,
    },
  })
})

describe("a feed attached beside the history read", () => {
  it("holds its frames until the history commits, then applies them on top of it", async () => {
    const history = pendingHistory([{ id: "u1", type: "user", content: "go" }])
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    streamCallbacks.onEvent("message", { agent: "lead", text: "Working on it." })
    streamCallbacks.onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-1" })
    // Nothing applied yet: the read's commit would wipe it.
    expect(lead().currentBlocks).toHaveLength(0)

    await history.commit()
    expect(lead().blocks.map((b) => b.content)).toEqual(["go"])
    expect(lead().currentBlocks.map((b) => b.type)).toEqual(["text", "tool"])
    expect(lead().currentBlocks[0].content).toBe("Working on it.")

    // Later frames apply as they arrive.
    streamCallbacks.onEvent("tool_start", { agent: "lead", name: "shell", tool_call_id: "call-1", arguments: "{}" })
    expect(lead().currentBlocks[1].toolArgs).toBe("{}")
  })

  it("drops a replayed step that the history read found saved", async () => {
    const history = pendingHistory([
      { id: "u1", type: "user", content: "go" },
      { id: "a1", type: "text", content: "Step one done." },
    ])
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    // The attach replayed step one before the history read saw it saved.
    streamCallbacks.onEvent("message", { agent: "lead", text: "Step one done." })

    await history.commit()
    expect(lead().blocks.map((b) => b.content)).toEqual(["go", "Step one done."])
    expect(lead().currentBlocks).toHaveLength(0)
  })

  it("does not commit a saved step twice when the held frames end with done", async () => {
    const history = pendingHistory([
      { id: "u1", type: "user", content: "go" },
      { id: "a1", type: "text", content: "All done." },
    ])
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    streamCallbacks.onEvent("message", { agent: "lead", text: "All done." })
    streamCallbacks.onEvent("done", {})

    await history.commit()
    expect(lead().blocks.map((b) => b.content)).toEqual(["go", "All done."])
    expect(useAgentStore.getState().isAgentWorking).toBe(false)
  })

  it("keeps a stream end that came while held until the history says whether the turn runs", async () => {
    const history = pendingHistory([{ id: "u1", type: "user", content: "go" }])
    useAgentStore.getState().connectStream({ holdUntil: history.promise })
    streamCallbacks.onEvent("message", { agent: "lead", text: "Half" })
    streamCallbacks.onDone()
    // Not yet: the end is read against the committed history.
    expect(useAgentStore.getState().isConnected).toBe(true)
    mockAgentStream.mockClear()

    await history.commit()
    // The turn runs and the feed had spoken, so it reattaches at once.
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it("applies frames at once without a history to wait for", () => {
    useAgentStore.getState().connectStream()
    streamCallbacks.onEvent("tool_call", { agent: "lead", name: "shell", tool_call_id: "call-1" })
    expect(lead().currentBlocks).toHaveLength(1)
  })
})
