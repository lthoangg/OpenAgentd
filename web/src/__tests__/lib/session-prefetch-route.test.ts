/**
 * Entering a session's URL starts what the open needs at once: the history
 * page does not wait for the request that names the session's folder.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test"

const history = { lead: { id: "s1", agent_name: "lead", title: "t", messages: [] }, members: [], has_more: false, next_cursor: null }
const mockSessionHistory = mock(() => Promise.resolve(history)) as any
const mockGetSession = mock(() => new Promise(() => {})) as any
;(mock as any).module("@/api/client", () => ({
  agentStatus: mock(() => Promise.resolve({ lead: null, members: [] })),
  sessionHistory: mockSessionHistory,
  getSession: mockGetSession,
}))

import { queryClient } from "@/lib/query-client"
import { _resetSessionPrefetchForTests, takePrefetchedHistory } from "@/lib/session-prefetch"
import { warmSessionRoute } from "@/lib/session-prefetch-route"
import { queryKeys } from "@/queries"
import { router } from "@/router"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(() => {
  _resetSessionPrefetchForTests()
  queryClient.clear()
  mockSessionHistory.mockClear()
  mockGetSession.mockReset()
  mockGetSession.mockImplementation(() => new Promise(() => {}))
  useAgentStore.setState({ sessionId: null })
})

describe("warming a session on route enter", () => {
  it("asks for the history while the session's own request is still out", () => {
    warmSessionRoute("s1")
    // getSession never answers in this test: the history went out anyway.
    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(mockSessionHistory).toHaveBeenCalledWith("s1")
    expect(takePrefetchedHistory("s1")).not.toBeNull()
  })

  it("puts the session where the layout reads it, so the layout does not ask again", async () => {
    mockGetSession.mockImplementation(() => Promise.resolve({ id: "s1", workspace: "/repo" }))
    warmSessionRoute("s1")
    await queryClient.ensureQueryData({ queryKey: queryKeys.session.sessions.detail("s1"), queryFn: mockGetSession, staleTime: 30_000 })
    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(queryKeys.session.sessions.detail("s1"))).toEqual({ id: "s1", workspace: "/repo" })
  })

  it("skips the session's own request when the session list already names its folder", () => {
    queryClient.setQueryData(queryKeys.session.sessions.infinite(), {
      pages: [{ data: [{ id: "lead", workspace: "/repo", subagents: [{ id: "s1" }] }] }],
      pageParams: [0],
    })
    warmSessionRoute("s1")
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
  })

  it("does nothing for the session already on screen (a draft's first message, a chat kept under the phone's list)", () => {
    useAgentStore.setState({ sessionId: "s1" })
    warmSessionRoute("s1")
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })
})

describe("the session route", () => {
  // Root, the app layout, then the session route.
  const loader = router.getMatchedRoutes("/s1")[2]?.options.loader as (context: { params: { sessionId: string }; cause: string }) => void

  it("warms the session it enters", () => {
    loader({ params: { sessionId: "s1" }, cause: "enter" })
    expect(mockSessionHistory).toHaveBeenCalledWith("s1")
  })

  it("leaves a hovered link alone: the sidebar decides when a hover is intent", () => {
    loader({ params: { sessionId: "s1" }, cause: "preload" })
    loader({ params: { sessionId: "s1" }, cause: "stay" })
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })
})
