/**
 * The transcript of the lead's stream (or the only one). Its own memo
 * component, so a streamed token re-renders the transcript, not the chat
 * around it.
 */
import { memo } from 'react'
import type { ContentBlock } from '@/api/types'
import { useAgentStore, isAwaitingRestartOutput } from '@/stores/useAgentStore'
import { AgentView } from '../AgentView'
import type { OpenSessionHandler } from '../AgentView/UserBubble'
import type { FileRefOpener } from '../FileRefLink'

const EMPTY_BLOCKS: ContentBlock[] = []

interface ActiveAgentViewProps {
  emptyState?: React.ReactNode
  onMentionFileOpen?: (path: string) => void
  onOpenSession?: OpenSessionHandler
  fileRefOpener?: FileRefOpener
  onRetry?: () => void
  onSwitchModel?: () => void
  /** The docked composer is up: its tray carries the jump-to-latest chip. */
  jumpToLatestInComposer?: boolean
}

export const ActiveAgentView = memo(function ActiveAgentView({
  emptyState,
  onMentionFileOpen,
  onOpenSession,
  fileRefOpener,
  onRetry,
  onSwitchModel,
  jumpToLatestInComposer,
}: ActiveAgentViewProps) {
  const activeStream = useAgentStore((s) => {
    if (s.leadName && s.agentStreams[s.leadName]) return s.agentStreams[s.leadName]
    return Object.values(s.agentStreams)[0]
  })

  const activeBlocks = activeStream?.blocks ?? EMPTY_BLOCKS
  const activeCurrentBlocks = activeStream?.currentBlocks ?? EMPTY_BLOCKS
  const activeStatus = activeStream?.status ?? 'idle'
  const activeLastError = activeStream?.lastError ?? null
  const activeAwaitingRestart = isAwaitingRestartOutput(activeStream)

  return (
    <AgentView
      blocks={activeBlocks}
      currentBlocks={activeCurrentBlocks}
      isWorking={activeStatus === 'working'}
      isTurnOpen={activeStatus === 'working' || activeStatus === 'waiting_input'}
      isAwaitingRestart={activeAwaitingRestart}
      isError={activeStatus === 'error'}
      lastError={activeLastError}
      onMentionFileOpen={onMentionFileOpen}
      onOpenSession={onOpenSession}
      fileRefOpener={fileRefOpener}
      emptyState={emptyState}
      onRetry={onRetry}
      onSwitchModel={onSwitchModel}
      jumpToLatestInComposer={jumpToLatestInComposer}
      marksScrollEdge
    />
  )
})
