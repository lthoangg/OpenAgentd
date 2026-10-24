/**
 * useSessionSwitchHold — what the transcript shows while a saved session's
 * history loads after a switch, so a switch never paints a blank frame.
 *
 * - A session viewed recently shows the blocks it last rendered until its
 *   history lands. Block ids match, so the swap to the real ones is silent.
 * - Otherwise the session being left stays for a `fast` beat, then gives
 *   way to the skeleton.
 *
 * Display only: nothing here is written to the store, which only ever holds
 * the session it loads. The caller renders a held transcript `inert`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContentBlock } from '@/api/types'
import { DURATIONS_S } from '@/lib/motion'

/** How long the session being left stays on screen without a snapshot. */
export const SWITCH_HOLD_MS = DURATIONS_S.fast * 1000
const RECENT_LIMIT = 8

export interface TranscriptSnapshot {
  sessionId: string
  blocks: ContentBlock[]
  currentBlocks: ContentBlock[]
  /** The prompt pinned above ``blocks``, if any (see ``AgentStore.pinnedPrompt``). */
  pinnedPrompt: ContentBlock | null
}

/** Last rendered blocks per session, newest last. In memory only. */
const recent = new Map<string, TranscriptSnapshot>()

export function _resetSessionSwitchHoldForTests(): void {
  recent.clear()
}

function remember(snapshot: TranscriptSnapshot) {
  recent.delete(snapshot.sessionId)
  recent.set(snapshot.sessionId, snapshot)
  while (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value as string)
}

const shows = (blocks: ContentBlock[]) => blocks.some((b) => b.type !== 'compaction')

export type SessionSwitchHold =
  | { kind: 'recent' | 'outgoing'; snapshot: TranscriptSnapshot }
  | null

export function useSessionSwitchHold({
  sessionId,
  blocks,
  currentBlocks,
  pinnedPrompt,
  isLoadingHistory,
}: {
  sessionId: string | undefined
  blocks: ContentBlock[]
  currentBlocks: ContentBlock[]
  pinnedPrompt: ContentBlock | null
  isLoadingHistory: boolean
}): SessionSwitchHold {
  const hasContent = shows(blocks) || shows(currentBlocks)
  const lastShownRef = useRef<TranscriptSnapshot | null>(null)
  const [expiredFor, setExpiredFor] = useState<string | null>(null)

  const loading = Boolean(sessionId) && isLoadingHistory && !hasContent
  const cached = loading && sessionId ? recent.get(sessionId) : undefined
  const last = lastShownRef.current
  const outgoing = loading && !cached && last && last.sessionId !== sessionId && expiredFor !== sessionId
    ? last
    : null
  const hold: SessionSwitchHold = cached
    ? { kind: 'recent', snapshot: cached }
    : outgoing ? { kind: 'outgoing', snapshot: outgoing } : null

  // Before paint, so the next render already knows what this one showed.
  useLayoutEffect(() => {
    if (!sessionId || !hasContent) return
    const snapshot = { sessionId, blocks, currentBlocks, pinnedPrompt }
    lastShownRef.current = snapshot
    remember(snapshot)
  }, [sessionId, blocks, currentBlocks, pinnedPrompt, hasContent])

  const outgoingFor = hold?.kind === 'outgoing' ? sessionId : undefined
  useEffect(() => {
    if (!outgoingFor) return
    const timer = setTimeout(() => setExpiredFor(outgoingFor), SWITCH_HOLD_MS)
    return () => clearTimeout(timer)
  }, [outgoingFor])

  return hold
}
