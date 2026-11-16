/**
 * What AgentChatView reads of the session and its lead's stream, in one
 * shallow selector of primitives, stable actions and counts. Text streaming
 * into a block changes none of them, so it does not re-render the chat
 * around the transcript.
 */
import { useShallow } from 'zustand/react/shallow'
import type { MessageAttachment } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'

type RevertedMessage = { role: string; content: string; attachments?: MessageAttachment[] }
const EMPTY_REVERTED_MESSAGES: RevertedMessage[] = []

export function useChatSessionState() {
  return useAgentStore(
    useShallow((s) => {
      const leadStream = s.leadName ? s.agentStreams[s.leadName] : undefined
      return {
        connectStream: s.connectStream,
        loadAgentStatus: s.loadAgentStatus,
        loadSession: s.loadSession,
        catchUpLiveTurn: s.catchUpLiveTurn,
        beginResolvedSession: s.beginResolvedSession,
        consumeResolvedSessionReady: s.consumeResolvedSessionReady,
        setupRequired: s.setupRequired,
        dismissSetupRequired: s.dismissSetupRequired,

        isAgentWorking: s.isAgentWorking,
        sessionId: s.sessionId,
        parentSessionId: s.parentSessionId,
        leadName: s.leadName,
        sessionTitle: s.sessionTitle,
        sessionSentFrom: s.sessionSentFrom,
        sessionInteractionMode: s.sessionInteractionMode,
        sessionPendingInteractionMode: s.sessionPendingInteractionMode,
        sessionModel: s.sessionModel,
        sessionFastMode: s.sessionFastMode,

        leadRevertedCount: leadStream?.revertedCount ?? 0,
        leadRevertedMessages: leadStream?.revertedMessages ?? EMPTY_REVERTED_MESSAGES,
        revertKeepsFiles: s.revertKeepsFiles,
        leadHasVisibleBlocks: (leadStream?.blocks.length ?? 0) > 0,
        leadHasLiveBlocks: (leadStream?.currentBlocks.length ?? 0) > 0,

        leadPromptTokens: leadStream?.usage.promptTokens ?? 0,
        leadCompletionTokens: leadStream?.usage.completionTokens ?? 0,
        leadCachedTokens: leadStream?.usage.cachedTokens ?? 0,
        leadCachedPercent: leadStream?.usage.cachedPercent,
        // The lead's and its subagents' spend so far.
        sessionCostUsd: Object.values(s.agentStreams).reduce((total, stream) => total + (stream.usage?.estimatedCostUsd ?? 0), 0),
      }
    })
  )
}
