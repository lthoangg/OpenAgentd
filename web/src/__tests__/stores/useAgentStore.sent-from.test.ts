/**
 * The chat view's "handled by" strip reads who started the session from the
 * history it opens with (``lead.sent_from``).
 */
import { mock, describe, it, expect, beforeEach } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
const sender = { session_id: "app-session", workspace: "/r/app", title: "Orders API" }
const history = (sentFrom: unknown) => ({
  lead: { id: "s1", agent_name: "lead", title: "Orders table", created_at: null, updated_at: null, sub_sessions: [], messages: [], ...(sentFrom ? { sent_from: sentFrom } : {}) },
  members: [],
  has_more: false,
  next_cursor: null,
})
const mockSessionHistory = mock(() => Promise.resolve(history(sender))) as any
;(mock as any).module("@/api/client", () => ({
  agentStatus: mock(() => Promise.resolve({ lead: null, members: [] })),
  sessionHistory: mockSessionHistory,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(() => {
  useAgentStore.setState({ sessionId: null, sessionSentFrom: null, isLoadingHistory: false, liveAgentNames: [], _sessionGeneration: 0 })
})

describe("sessionSentFrom", () => {
  it("holds the sender of a session another workspace started, and clears for one the user started", async () => {
    mockSessionHistory.mockImplementation(() => Promise.resolve(history(sender)))
    await useAgentStore.getState().loadSession("s1")
    expect(useAgentStore.getState().sessionSentFrom).toEqual(sender)

    mockSessionHistory.mockImplementation(() => Promise.resolve(history(null)))
    await useAgentStore.getState().loadSession("s2")
    expect(useAgentStore.getState().sessionSentFrom).toBeNull()
  })
})
