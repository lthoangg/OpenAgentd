/**
 * A sidebar hover, or the route entering a session, prefetches its first
 * history page; the next fresh open of that session takes it instead of
 * fetching again.
 */
import { mock, describe, it, expect, beforeEach, spyOn } from "bun:test"

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

import { useAgentStore } from "@/stores/useAgentStore"
import {
  PREFETCH_IN_FLIGHT_MAX_MS,
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

  it("drops a page that arrived too long ago", async () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    prefetchSessionHistory("s1")
    await Promise.resolve()
    clock.mockReturnValue(now + PREFETCH_TTL_MS + 1)
    expect(takePrefetchedHistory("s1")).toBeNull()
    clock.mockRestore()
  })

  it("keeps a page that is still on its way: on a slow link the open would only ask again and wait longer", () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    mockSessionHistory.mockImplementation(() => new Promise(() => {}))
    prefetchSessionHistory("s1")
    clock.mockReturnValue(now + PREFETCH_TTL_MS + 1)
    prefetchSessionHistory("s1")
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(takePrefetchedHistory("s1")).not.toBeNull()
    clock.mockRestore()
  })

  it("counts a page's age from when it arrived, not from when it was asked for", async () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    let arrive: (page: ReturnType<typeof history>) => void = () => {}
    mockSessionHistory.mockImplementation(() => new Promise((resolve) => { arrive = resolve }))
    prefetchSessionHistory("s1")
    clock.mockReturnValue(now + PREFETCH_TTL_MS + 500)
    arrive(history("slow"))
    await Promise.resolve()
    clock.mockReturnValue(now + PREFETCH_TTL_MS + 600)
    expect(takePrefetchedHistory("s1")).not.toBeNull()
    clock.mockRestore()
  })

  it("gives up on a page that never arrives, so a dead request cannot hold an open", () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    mockSessionHistory.mockImplementation(() => new Promise(() => {}))
    prefetchSessionHistory("s1")
    clock.mockReturnValue(now + PREFETCH_IN_FLIGHT_MAX_MS + 1)
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

  it("installs a page only once the caller's hold is over, and a second load of the visit waits with it", async () => {
    // The chat that just came on screen paints before its transcript is drawn.
    let painted!: () => void
    const hold = new Promise<void>((resolve) => { painted = resolve })
    prefetchSessionHistory("s1")
    useAgentStore.setState({ sessionId: "s1", sessionTitle: null, isLoadingHistory: true })

    const opening = useAgentStore.getState().loadSession("s1", null, { holdUntil: hold })
    // The event feed's catch-up asks for the same session meanwhile.
    const catchUp = useAgentStore.getState().loadSession("s1", null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useAgentStore.getState().sessionTitle).toBeNull()

    painted()
    await Promise.all([opening, catchUp])
    expect(useAgentStore.getState().sessionTitle).toBe("fetched")
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
  })
})
