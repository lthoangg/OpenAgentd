/**
 * Open the Preview tab when the agent's `preview` tool opens a page.
 *
 * Settings → Appearance can leave pages to the tool row's Open button
 * (``previewOpen: 'click'``). Only calls that finish while this view is live count: calls already done
 * when the hook starts or is enabled (history, a session switch) are
 * skipped, and so are blocks without a recent client ``startedAt``. Each
 * call opens once.
 *
 * Whatever the mode, a page the agent opened is also registered with the
 * keep-alive store, so `PreviewKeepAlive` can keep it driveable while no
 * Preview tab shows it; later `preview` calls refresh its last-use time.
 */
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PreviewTarget } from '@/api/preview'
import type { ContentBlock } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { usePreviewKeepAliveStore } from '@/stores/usePreviewKeepAliveStore'
import { PREVIEW_TOOL, isPreviewOpenSuccess, previewTargetFromArgs } from '../Preview/preview-events'

/** A call older than this (client clock) is history, not a live open. */
const LIVE_WINDOW_MS = 10 * 60_000
/** Confirmed rows can be long; only the tail can hold a call that just ended. */
const CONFIRMED_TAIL = 50

function isFinishedPreviewCall(block: ContentBlock): boolean {
  return block.type === 'tool' && block.toolName === PREVIEW_TOOL && block.toolDone === true && Boolean(block.toolCallId)
}

type StreamsState = { agentStreams?: Record<string, { blocks?: ContentBlock[]; currentBlocks?: ContentBlock[] }> }

/** Finished `preview` calls in every stream's live blocks and recent rows. */
export function selectFinishedPreviewCalls(state: StreamsState): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const stream of Object.values(state.agentStreams ?? {})) {
    for (const block of stream.currentBlocks ?? []) if (isFinishedPreviewCall(block)) out.push(block)
    for (const block of (stream.blocks ?? []).slice(-CONFIRMED_TAIL)) if (isFinishedPreviewCall(block)) out.push(block)
  }
  return out
}

export function usePreviewToolAutoOpen({
  enabled,
  onOpen,
  workspace,
}: {
  enabled: boolean
  onOpen: (target: PreviewTarget) => void
  /** The session's workspace; defaults to the agent store's. */
  workspace?: string | null
}) {
  const calls = useAgentStore(useShallow(selectFinishedPreviewCalls))
  const opensItself = useDisplayPrefsStore((s) => s.previewOpen) === 'panel'
  const storeWorkspace = useAgentStore((s) => s._workspace)
  const keepAliveWorkspace = workspace || storeWorkspace
  const handledRef = useRef<Set<string> | null>(null)
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  useEffect(() => {
    const first = handledRef.current === null
    const handled = handledRef.current ?? new Set<string>()
    handledRef.current = handled
    for (const block of calls) {
      const id = block.toolCallId as string
      if (handled.has(id)) continue
      handled.add(id)
      if (first || !enabled) continue
      if (block.startedAt === undefined || Date.now() - block.startedAt > LIVE_WINDOW_MS) continue
      const target = previewTargetFromArgs(block.toolArgs)
      if (!target) {
        // A page action (click, snapshot, …): the agent is still using its pages.
        if (keepAliveWorkspace) usePreviewKeepAliveStore.getState().touchAgent(keepAliveWorkspace)
        continue
      }
      if (!isPreviewOpenSuccess(block.toolResult)) continue
      if (keepAliveWorkspace) usePreviewKeepAliveStore.getState().registerAgent(keepAliveWorkspace, target)
      if (opensItself) onOpenRef.current(target)
    }
  }, [calls, enabled, opensItself, keepAliveWorkspace])
}
