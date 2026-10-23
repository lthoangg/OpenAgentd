/**
 * A sidebar hover prefetches a session's first history page; the next fresh
 * open of that session takes it instead of fetching again.
 */
import { mock, describe, it, expect, beforeEach, spyOn } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
const history = (title: string) => ({
  lead: { id: "s1", agent_name: "lead", title, created_at: null, updated_at: null, sub_sessions: [], messages: [] },
  members: [],
  has_more: false,
  next_cursor: null,
})
const mockSessionHistory = mock(() => Promise.resolve(history("fetched"))) as any
;(mock as any).module("@/api/client", () => ({
  agentStatus: mock(() => Promise.resolve({ lead: null, members: [] })),
  sessionHistory: mockSessionHistory,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"
import {
  PREFETCH_TTL_MS,
  _resetSessionPrefetchForTests,
  forgetPrefetchedHistory,
  prefetchSessionHistory,
  takePrefetchedHistory,
} from "@/lib/session-prefetch"

beforeEach(() => {
  _resetSessionPrefetchForTests()
  mockSessionHistory.mockReset()
  mockSessionHistory.mockImplementation(() => Promise.resolve(history("fetched")))
  useAgentStore.setState({ sessionId: null, isLoadingHistory: false, liveAgentNames: [], _sessionGeneration: 0 })
})

describe("session history prefetch", () => {
  it("fetches a page once per session while it is recent, and hands it out once", () => {
    prefetchSessionHistory("s1")
    prefetchSessionHistory("s1")
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)

    expect(takePrefetchedHistory("s1")).not.toBeNull()
    expect(takePrefetchedHistory("s1")).toBeNull()
  })

  it("drops a page that is too old", () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    prefetchSessionHistory("s1")
    clock.mockReturnValue(now + PREFETCH_TTL_MS + 1)
    expect(takePrefetchedHistory("s1")).toBeNull()
    clock.mockRestore()
  })

  it("drops a page when the session's turn changes it", () => {
    prefetchSessionHistory("s1")
    forgetPrefetchedHistory("s1")
    expect(takePrefetchedHistory("s1")).toBeNull()
  })

  it("lets a fresh open take the prefetched page instead of fetching", async () => {
    mockSessionHistory.mockImplementation(() => Promise.resolve(history("prefetched")))
    prefetchSessionHistory("s1")
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: true })

    await useAgentStore.getState().loadSession("s1")
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().sessionTitle).toBe("prefetched")
  })

  it("does not use a prefetched page to reload a session already on screen", async () => {
    mockSessionHistory.mockImplementation(() => Promise.resolve(history("prefetched")))
    prefetchSessionHistory("s1")
    mockSessionHistory.mockImplementation(() => Promise.resolve(history("fetched")))
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: false })

    await useAgentStore.getState().loadSession("s1")
    expect(mockSessionHistory).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().sessionTitle).toBe("fetched")
  })

  it("fetches on its own when the prefetch failed", async () => {
    mockSessionHistory.mockImplementation(() => Promise.reject(new Error("offline")))
    prefetchSessionHistory("s1")
    mockSessionHistory.mockImplementation(() => Promise.resolve(history("fetched")))
    useAgentStore.setState({ sessionId: "s1", isLoadingHistory: true })

    await useAgentStore.getState().loadSession("s1")
    expect(useAgentStore.getState().sessionTitle).toBe("fetched")
  })
})
