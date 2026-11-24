/**
 * Sending a message, now or queued behind a working lead, and cancelling a queued one.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { mockPostAgentChat, mockTeamStream, makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(resetAsyncStore)

// ── sendMessage ───────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("pushes an optimistic user block into the lead's currentBlocks", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
    })

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const leadBlocks = useAgentStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks).toHaveLength(1)
    expect(leadBlocks[0].type).toBe("user")
    expect(leadBlocks[0].content).toBe("hello team")
  })

  it("stamps optimistic user blocks with the lead default model", async () => {
    useAgentStore.setState({
      leadName: "lead",
      sessionModel: null,
      agentStreams: { lead: makeStream({ model: "openai:gpt-5.5" }) },
    })

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const leadBlocks = useAgentStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks[0].extra?.model).toBe("openai:gpt-5.5")
  })

  it("leaves the model off an optimistic block while the lead still has the placeholder a new install starts with", async () => {
    // A model connected a moment ago has not reached this store yet; the
    // placeholder must not be shown as the model the prompt ran with.
    useAgentStore.setState({
      leadName: "lead",
      sessionModel: null,
      agentStreams: { lead: makeStream({ model: "__PROVIDER_MODEL__" }) },
    })

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const leadBlocks = useAgentStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks[0].extra?.model).toBeUndefined()
  })

  it("patches the optimistic user block's id to the server-issued message_id once the POST resolves", async () => {
    // The backend now returns the persisted user message's id even on the
    // immediate (non-queued) send path. Adopting it lets later reconciliation
    // (removePersistedOptimisticUserBlocks) match by id instead of inferring
    // "same message?" from content + a clock-skew time window.
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid", message_id: "server-msg-1" })
    )

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toBe("server-msg-1")
  })

  it("keeps the optimistic user block's local id when the POST response carries no message_id", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid" })
    )

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toMatch(/^user-/)
  })

  it("sets isAgentWorking=true before the POST resolves", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    let resolvePost!: (v: { status: string; session_id: string }) => void
    mockPostAgentChat.mockImplementation(
      () => new Promise((res) => { resolvePost = res })
    )

    const promise = useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)

    resolvePost({ status: "ok", session_id: "team-sid" })
    await promise
  })

  it("calls postAgentChat with the message text", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("test message", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][0]).toBe("test message")
  })

  it("calls postAgentChat with interrupt=false when not working", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat.mock.calls[0][2]).toBe(false)
  })

  it("sets sessionId from postAgentChat response", async () => {
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "new-team-sid" })
    )
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().sessionId).toBe("new-team-sid")
  })

  it("calls connectStream after postAgentChat resolves", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
      sessionId: "team-sid",
    })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
  })

  it("sets error and stops working when postAgentChat throws", async () => {
    mockPostAgentChat.mockImplementation(() =>
      Promise.reject(new Error("Network failure"))
    )
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    const state = useAgentStore.getState()
    expect(state.error).toEqual({ title: "Couldn't send the message", message: "Network failure" })
    expect(isRunLive(state.sessionRun)).toBe(false)
  })

  it("sets fallback error message for non-Error throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject("unknown"))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().error).toEqual({ title: "Couldn't send the message", message: "Couldn't send the message" })
  })

  it("does not call connectStream when postAgentChat throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("fail")))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  // The composer clears optimistically the moment a message is submitted, so
  // callers need to know whether the send actually landed — otherwise a
  // failed POST silently takes the user's text and attachments with it.
  it("reports success so the caller can keep the cleared composer cleared", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(true)
  })

  it("reports failure when the POST throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(false)
  })

  it("reports failure when queueing a follow-up throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" }) },
    })

    const delivered = await useAgentStore.getState().sendMessage("queued follow-up", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(false)
  })
})

// ── sendMessage with files ────────────────────────────────────────────────────

describe("sendMessage with files", () => {
  it("creates optimistic image attachments with blob URLs", async () => {
    const originalCreate = URL.createObjectURL
    URL.createObjectURL = mock(() => "blob:http://localhost/img")

    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const imageFile = new File(["data"], "photo.png", { type: "image/png" })

    await useAgentStore.getState().sendMessage("see this", [imageFile], { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("image")
    expect(block.attachments![0].url).toBe("blob:http://localhost/img")
    expect(block.attachments![0].original_name).toBe("photo.png")

    URL.createObjectURL = originalCreate
  })

  it("creates document attachments without blob URLs for non-image files", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const pdfFile = new File(["data"], "report.pdf", { type: "application/pdf" })

    await useAgentStore.getState().sendMessage("see this", [pdfFile], { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("document")
    expect(block.attachments![0].url).toBeUndefined()
  })

  it("passes files to postAgentChat", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    await useAgentStore.getState().sendMessage("with file", [file], { workspace: "/repo/app" })
    expect(mockPostAgentChat.mock.calls[0][4]).toEqual([file])
  })
})

// ── sendMessage: queue behaviour (lead-working guard) ────────────────────────

describe("sendMessage: queue behaviour", () => {
  // Queued messages always carry a server id (the POST returns it and
  // ``queued_turn_start`` lists it), so a steer is matched by id. Matching by
  // text dropped any steer the session had already said once: "yes",
  // "continue".
  // Queued messages always carry a server id (the POST returns it and
  // ``queued_turn_start`` lists it), so a steer is matched by id. Matching by
  // text dropped any steer the session had already said once: "yes",
  // "continue".
  it("queues a steer whose text an earlier message already used", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "srv-yes-2" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [{ id: "srv-yes-1", type: "user", content: "yes" }],
        }),
      },
    })

    await useAgentStore.getState().sendMessage("yes", undefined, { workspace: "/repo/a" })

    expect(useAgentStore.getState()._pendingMessages.map((m) => m.id)).toEqual(["srv-yes-2"])
  })

  it("persists queued messages through the backend when lead is working", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("queued message", undefined, { workspace: "/repo/a" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][0]).toBe("queued message")
    expect(mockPostAgentChat.mock.calls[0][1]).toBe("session-a")
    expect(mockPostAgentChat.mock.calls[0][3]).toBe("/repo/a")
    expect(mockPostAgentChat.mock.calls[0][4]).toBeUndefined()
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].sessionId).toBe("session-a")
    expect(pending[0].content).toBe("queued message")
  })

  // "Queue until done": the server holds it, and the chip says so at once.
  it("queues a held message on the server and marks it held", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-held" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("then deploy @a.ts", undefined, { workspace: "/repo/a", mentions: ["a.ts"], holdUntilTurnEnd: true })
    expect(mockPostAgentChat.mock.calls[0][12]).toBe(true)
    const [pending] = useAgentStore.getState()._pendingMessages
    expect([pending.id, pending.heldUntilTurnEnd, pending.mentions]).toEqual(["pm-held", true, ["a.ts"]])
  })

  it("does not ask the server to hold a plain steer", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-steer" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("steer", undefined, { workspace: "/repo/a" })
    expect(mockPostAgentChat.mock.calls[0][12]).toBe(false)
    expect(useAgentStore.getState()._pendingMessages[0].heldUntilTurnEnd).toBeUndefined()
  })

  it("queues explicit file attachments while lead is working", async () => {
    // Regression: the backend accepts file uploads on queued messages
    // (f44b0544), but the frontend kept a stale pre-support guard that
    // rejected them with an error — breaking attach-while-streaming on
    // both desktop and mobile.
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-file" }),
    )
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued with file", [file], { workspace: "/repo/app" })

    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][4]).toEqual([file])
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("pm-file")
    expect(pending[0].content).toBe("queued with file")
    expect(pending[0].files).toEqual([file])
    expect(pending[0].attachments).toEqual([
      { original_name: "doc.txt", media_type: expect.stringMatching(/^text\/plain/), category: "document" },
    ])
    expect(useAgentStore.getState().error).toBeNull()
  })

  it("categorises queued image attachments as images", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-img" }),
    )
    const image = new File(["data"], "photo.png", { type: "image/png" })
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued image", [image], { workspace: "/repo/app" })

    expect(useAgentStore.getState()._pendingMessages[0].attachments).toEqual([
      { original_name: "photo.png", media_type: "image/png", category: "image" },
    ])
  })

  it("treats a queued response without message_id as an error", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })

    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    expect(useAgentStore.getState().error).toEqual({ title: "Couldn't send the message", message: "Backend did not return a queued message id" })
  })

  it("does NOT queue when only members are working (lead is idle)", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })
    await useAgentStore.getState().sendMessage("immediate message", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
  })

  // The client picks its send path from its *own* lead status, but only the
  // backend knows whether the team still owns an active turn
  // (``has_active_user_turn`` covers members the lead delegated to, which the
  // client's lead status does not). The response status is the authoritative
  // answer and both directions of disagreement are routine.
  it("adopts the backend's queue decision when it queues a send the client thought was immediate", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "srv-1" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })

    await useAgentStore.getState().sendMessage("only show me once", undefined, { workspace: "/repo/app" })

    // Queued messages render from `_pendingMessages`, never as a live block.
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("srv-1")

    // …and when the backend drains the queue the message appears exactly once.
    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["srv-1"],
      messages: [{ id: "srv-1", content: "only show me once" }],
    })
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
  })

  it("adopts the backend's dispatch decision when it runs a send the client thought was queued", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "accepted", session_id: "session-a", message_id: "srv-2" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("go now", undefined, { workspace: "/repo/app" })

    // Nothing is queued server-side, so no queued chip may linger — the turn
    // is running and only the optimistic block represents it.
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].id).toBe("srv-2")
    expect(userBlocks[0].content).toBe("go now")
  })

  it("does not leave message in _pendingMessages if queued_turn_start arrives before postAgentChat resolves", async () => {
    let resolvePost: (val: any) => void
    mockPostAgentChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    const sendPromise = useAgentStore
      .getState()
      .sendMessage("in-flight race message", undefined, { workspace: "/repo/app" })

    // Simulate backend processing fast and delivering queued_turn_start via SSE
    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["srv-fast"],
      messages: [{ id: "srv-fast", content: "in-flight race message" }],
    })

    // Now postAgentChat resolves with queued
    resolvePost!({
      status: "queued",
      session_id: "session-a",
      message_id: "srv-fast",
    })
    await sendPromise

    // Because queued_turn_start already arrived, it should not be in _pendingMessages
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].id).toBe("srv-fast")
  })

  it("does not add optimistic block when message is queued", async () => {
    // The backend answers "queued" whenever it holds the message back; the
    // store keys off that status, not off the local lead state.
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "team-sid", message_id: "pm-q" }),
    )
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks).toHaveLength(0)
  })

  it("queues multiple messages in order", async () => {
    let n = 0
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "queued", session_id: "team-sid", message_id: `pm-${++n}` }),
    )
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("first", undefined, { workspace: "/repo/app" })
    await useAgentStore.getState().sendMessage("second", undefined, { workspace: "/repo/app" })
    await useAgentStore.getState().sendMessage("third", undefined, { workspace: "/repo/app" })
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(3)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("second")
    expect(pending[2].content).toBe("third")
  })

  it("stores backend queued message ids returned while lead is working", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "message-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })

    const [pending] = useAgentStore.getState()._pendingMessages
    expect(pending).toMatchObject({ id: "message-a", sessionId: "session-a", content: "queued" })
    expect(typeof pending.submittedAt).toBe("number")
  })

  it("removePendingMessage removes message by id", async () => {
    useAgentStore.setState({
      _pendingMessages: [
        { id: "pm-1", content: "first" },
        { id: "pm-2", content: "second" },
        { id: "pm-3", content: "third" },
      ],
    })
    await expect(useAgentStore.getState().removePendingMessage("pm-2")).resolves.toBe("cancelled")
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(2)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("third")
  })
})
