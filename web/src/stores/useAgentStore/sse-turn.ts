/**
 * Where a turn starts and ends on the stream: the user's messages a turn
 * takes in (``queued_turn_start``), the attach replay that may repeat them,
 * and ``done`` committing the live blocks to the transcript.
 */
import { readBlocks } from '@/utils/blocks'
import { appendLocalBlocks, ensureAgent, revokeBlobUrlsFromBlocks } from './helpers'
import type { AgentStore, StoreGet, StoreSet } from './types'
import type { ContentBlock, MessageAttachment } from '@/api/types'

/** The display fields of an attachment, as history serves them. */
const ATTACHMENT_FIELDS = ['filename', 'media_type', 'original_name', 'category', 'url', 'source'] as const

/**
 * A ``queued_turn_start`` row's raw ``extra``, split as history splits it:
 * the display attachments beside the rest. The event carries the stored
 * ``extra``, so internal fields (``path``, ``converted_text``) are dropped.
 */
export function splitEventAttachments(raw: unknown): {
  attachments: MessageAttachment[] | undefined
  extra: Record<string, unknown> | undefined
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { attachments: undefined, extra: undefined }
  const { attachments: rawAtts, ...rest } = raw as Record<string, unknown>
  const attachments = Array.isArray(rawAtts)
    ? rawAtts.flatMap((att) => {
        if (!att || typeof att !== 'object') return []
        const src = att as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const key of ATTACHMENT_FIELDS) {
          if (typeof src[key] === 'string') out[key] = src[key]
        }
        return [out as MessageAttachment]
      })
    : []
  return {
    attachments: attachments.length > 0 ? attachments : undefined,
    extra: rawAtts === undefined ? (raw as Record<string, unknown>) : rest,
  }
}

function stampOpenTextBlocks(
  blocks: AgentStore['agentStreams'][string]['currentBlocks'],
  completedAt: number,
  turnStartedAt?: number | null,
) {
  return blocks.map((block) => {
    if (block.type !== 'text' || block.responseDurationMs !== undefined) return block
    const startedAt = turnStartedAt ?? block.startedAt
    if (startedAt === undefined || startedAt === null) return block
    return {
      ...block,
      responseDurationMs: Math.max(0, completedAt - startedAt),
    }
  })
}

/**
 * Commit a stream's live blocks to its transcript, as the end of its turn
 * does. A run that failed commits them ahead of its error block, so the
 * error comes after what led to it (the retries, a half-written answer)
 * and is the block the turn ends on.
 */
export function commitLiveBlocks(draft: AgentStore, stream: AgentStore['agentStreams'][string], completedAtMs: number) {
  if (stream.currentBlocks.length === 0) return
  const completedAt = new Date(completedAtMs)
  const revertTime = draft._leadRevertTime
  const stamped = stampOpenTextBlocks(stream.currentBlocks, completedAtMs, stream._turnStartedAt).map((b) => ({
    ...b,
    timestamp: b.timestamp ?? completedAt,
  }))
  // Guard: if a /undo ran while the turn was still in flight, drop
  // any blocks at or after the revert boundary so they don't
  // re-surface as ghost messages when currentBlocks are finalised.
  const toCommit = revertTime === null
    ? stamped
    : stamped.filter((b) => (b.timestamp?.getTime() ?? 0) < revertTime)
  appendLocalBlocks(stream, toCommit)
  stream.currentBlocks = []
}

/**
 * A content frame ends an attach's replay window (``_attachReplay``): the
 * server replays ``queued_turn_start`` ahead of every content frame of the
 * step it started. Cleared inside updates that already run, so it costs no
 * extra store notification.
 */
export function endAttachReplay(draft: AgentStore) {
  if (draft._attachReplay) draft._attachReplay = false
}

export function onQueuedTurnStart(set: StoreSet, get: StoreGet, d: Record<string, unknown>) {
  const agent = (d.agent as string) || undefined
  const messageIds = Array.isArray(d.message_ids) ? new Set(d.message_ids as string[]) : null
  const eventMessages = Array.isArray(d.messages)
    ? (d.messages as Array<{ id?: unknown; content?: unknown; extra?: unknown }>).flatMap((msg) => {
        if (typeof msg.id !== 'string' || typeof msg.content !== 'string') return []
        const { attachments, extra } = splitEventAttachments(msg.extra)
        return [{
          id: msg.id,
          content: msg.content,
          extra,
          attachments,
        }]
      })
    : []
  // Set when an attach replays an injection the loaded history has not
  // reached; see below.
  let historyBehindReplay = false
  set((draft) => {
    const targetAgent = agent || draft.leadName || Object.keys(draft.agentStreams)[0] || 'openagentd'
    ensureAgent(draft, targetAgent)
    draft.isAgentWorking = true
    draft.error = null
    draft.agentStreams[targetAgent].status = 'working'
    const queued = draft._pendingMessages.filter((msg) => {
      if (draft.sessionId && msg.sessionId && msg.sessionId !== draft.sessionId) return false
      return messageIds === null || messageIds.has(msg.id)
    })
    const queuedById = new Map<string, (typeof queued)[number]>(
      queued.map((msg) => [msg.id, msg]),
    )
    const queuedIds = new Set(queuedById.keys())
    const eventById = new Map(eventMessages.map((msg) => [msg.id, msg]))
    // The server's row carries what the bubble shows.
    const extraOf = (msg: (typeof queued)[number]): Record<string, unknown> | undefined => (
      eventById.get(msg.id)?.extra
    )
    // The queued chip's metas carry no URL; the server's row does, so a
    // spliced image can show at once instead of after a reload.
    const attachmentsOf = (msg: (typeof queued)[number]) => (
      eventById.get(msg.id)?.attachments ?? msg.attachments
    )
    // `message_ids` is the single authoritative order (it is built
    // server-side from the same query, in the same order, as
    // `messages`). Resolve each id against the locally-tracked pending
    // message first — it carries the real `submittedAt`/attachments —
    // falling back to the event's own content only for ids this client
    // never optimistically tracked (e.g. injected by another client, or
    // a POST response that hadn't resolved yet). Concatenating the two
    // groups instead of merging on `message_ids` would silently
    // reorder a message whenever it fell into the fallback group while
    // an earlier id resolved locally.
    const messages = messageIds === null
      ? [
          ...queued.map((msg) => ({
            id: msg.id,
            content: msg.content,
            submittedAt: msg.submittedAt,
            attachments: attachmentsOf(msg),
            extra: extraOf(msg),
          })),
          ...eventMessages
            .filter((msg) => !queuedIds.has(msg.id))
            .map((msg) => ({ ...msg, submittedAt: Date.now() })),
        ]
      : Array.from(messageIds).flatMap((id) => {
          const pending = queuedById.get(id)
          if (pending) {
            return [{
              id: pending.id,
              content: pending.content,
              submittedAt: pending.submittedAt,
              attachments: attachmentsOf(pending),
              extra: extraOf(pending),
            }]
          }
          const ev = eventById.get(id)
          return ev ? [{ ...ev, submittedAt: Date.now() }] : []
        })
    if (messages.length === 0) return
    const now = Date.now()
    const stream = draft.agentStreams[targetAgent]
    // An attach replays the injection of a message this client already
    // shows, ahead of the snapshot of the step that followed it. Handled
    // as a new injection, it sealed that step's live text into `blocks`,
    // so the snapshot then had nothing to merge into and rendered the
    // step a second time, below a re-ordered bubble (the phone app
    // reattaches on every resume). A confirmed row is proof on its own;
    // a live bubble counts only while the replay guard is armed.
    const shownAsUser = (id: string, blocks: ContentBlock[]) =>
      readBlocks(blocks).some((b) => b.type === 'user' && b.id === id)
    const replaying = draft._attachReplay === true
    const alreadyShown = messages.every((msg) =>
      shownAsUser(msg.id, stream.blocks) || (replaying && shownAsUser(msg.id, stream.currentBlocks)),
    )
    if (alreadyShown) {
      const shownIds = new Set(messages.map((msg) => msg.id))
      draft._pendingMessages = draft._pendingMessages.filter((msg) => !shownIds.has(msg.id))
      return
    }
    // The replay starts at this injection, so rows saved between the
    // history read and the injection reach the client by no other path
    // (a tool row stayed missing until the turn ended).
    if (replaying) historyBehindReplay = true
    stream.currentBlocks = stampOpenTextBlocks(
      stream.currentBlocks,
      now,
      stream._turnStartedAt,
    )
    const nextTurnStartedAt = messages[0]?.submittedAt ?? now
    // Guard: if a /undo ran before this SSE event arrived, drop any user
    // blocks whose timestamp is at or after the revert boundary so they
    // do not re-appear as ghost messages in the chat area.
    const revertTime = draft._leadRevertTime
    const filteredMessages = messages.filter((msg) => {
      if (revertTime === null) return true
      const t = msg.submittedAt ?? now
      return t < revertTime
    })

    const incomingIds = new Set(filteredMessages.map((m) => m.id))
    const incomingContents = new Set(filteredMessages.map((m) => (m.content || '').trim()))
    const isMatchingOptimisticBlock = (b: ContentBlock) =>
      b.type === 'user' &&
      !b.extra?.from_agent &&
      (incomingIds.has(b.id) || (b.id.startsWith('user-') && incomingContents.has((b.content || '').trim())))

    // Seal prior in-flight blocks into `stream.blocks` before starting the injected turn.
    // If currentBlocks had blocks from the earlier turn (thinking, tools, text), committing
    // them first prevents the user message from being appended *after* them in currentBlocks,
    // which caused tool calls to disappear on mid-turn reconcile and user messages to appear
    // at the bottom of the previous assistant output.
    const priorBlocks = stream.currentBlocks.filter((b) => !isMatchingOptimisticBlock(b))
    if (priorBlocks.length > 0) {
      const stamped = priorBlocks.map((b) => ({
        ...b,
        timestamp: b.timestamp ?? new Date(now),
      }))
      const toCommit = revertTime === null
        ? stamped
        : stamped.filter((b) => (b.timestamp?.getTime() ?? 0) < revertTime)
      if (toCommit.length > 0) {
        appendLocalBlocks(stream, toCommit)
      }
    }

    const existingOptimisticBlocks = stream.currentBlocks.filter(isMatchingOptimisticBlock)
    const newUserBlocks: ContentBlock[] = []
    for (const msg of filteredMessages) {
      const timestamp = new Date(msg.submittedAt ?? now)
      const attachments = msg.attachments && msg.attachments.length > 0 ? msg.attachments : undefined

      let matchIdx = existingOptimisticBlocks.findIndex((b) => b.id === msg.id)
      if (matchIdx === -1) {
        matchIdx = existingOptimisticBlocks.findIndex(
          (b) => b.type === 'user' && !b.extra?.from_agent && b.id.startsWith('user-') && b.content === msg.content,
        )
      }

      if (matchIdx !== -1) {
        const existing = existingOptimisticBlocks[matchIdx]
        // The server's URLs replace the bubble's in-browser preview; a
        // queued chip's URL-less metas never replace a working one.
        const served = attachments?.some((att) => att.url) ? attachments : undefined
        if (served && existing.attachments) revokeBlobUrlsFromBlocks([existing])
        newUserBlocks.push({
          ...existing,
          id: msg.id,
          timestamp: existing.timestamp ?? timestamp,
          attachments: served ?? existing.attachments ?? attachments,
        })
        continue
      }

      // By id, or by text only against a ``user-<ts>`` bubble whose POST
      // has not answered yet. Any wider text match hid a steer the
      // session had already sent once ("yes").
      const existsInBlocks = stream.blocks.some(
        (b) => b.id === msg.id || (b.type === 'user' && !b.extra?.from_agent && b.id.startsWith('user-') && b.content === msg.content),
      )
      if (existsInBlocks) {
        continue
      }

      newUserBlocks.push({
        id: msg.id,
        type: 'user' as const,
        content: msg.content,
        timestamp,
        ...(attachments ? { attachments } : {}),
        ...(msg.extra ? { extra: msg.extra } : {}),
      })
    }

    stream.currentBlocks = newUserBlocks
    stream._turnStartedAt = nextTurnStartedAt
    const removedIds = new Set<string>(queuedIds)
    if (messageIds !== null) {
      for (const id of messageIds) removedIds.add(id)
    }
    for (const ev of eventMessages) {
      removedIds.add(ev.id)
    }
    draft._pendingMessages = draft._pendingMessages.filter((msg) => !removedIds.has(msg.id))
  })
  if (historyBehindReplay) {
    // Mid-turn reload: keeps the live tail and adds the rows it lacks.
    const { sessionId, _workspace: workspace } = get()
    if (sessionId) void get().loadSession(sessionId, workspace)
  }
}

export function onDone(set: StoreSet) {
  set((draft) => {
    endAttachReplay(draft)
    draft.isAgentWorking = false
    // An open question deliberately survives `done`. The suspension is
    // durable: the row stays `pending`, and a reload brings the card back
    // fully answerable, so closing it here would show a resolution the
    // server never made. Real endings (answer, dismiss, supersede, stop)
    // all broadcast their own resolution.
    const completedAtMs = Date.now()
    Object.keys(draft.agentStreams).forEach((name) => {
      const stream = draft.agentStreams[name]
      commitLiveBlocks(draft, stream, completedAtMs)
      stream._turnStartedAt = null
      if (stream.status !== 'error' && stream.status !== 'offline') {
        stream.status = 'idle'
      }
    })
    if (draft.sessionId) {
      draft._runningPatchedFor = null
      draft.cacheInvalidations.push({
        kind: 'session_running',
        sessionId: draft.sessionId,
        running: false,
      })
    }
  })
}
