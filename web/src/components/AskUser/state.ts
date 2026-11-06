/**
 * The question cards' store reads, split from the cards so the transcript
 * and the turn footer can ask about a question without loading the cards,
 * which load on demand.
 */
import { useCallback } from 'react'

import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStoreState } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

/** Mirrors ``question_service.PLACEHOLDER_RESULT``. */
const PLACEHOLDER_PREFIX = 'Waiting for the user to answer'

/** The ``tool_call_id`` of the question open in this session, or ``null``. */
export function selectOpenQuestionCallId(state: AgentStoreState): string | null {
  const question = state.pendingQuestion
  return question !== null && state.sessionId !== null && question.sessionId === state.sessionId
    ? question.toolCallId
    : null
}

/** A persisted result that closes nothing yet: none, or the server's placeholder. */
export function isUnsettledResult(result: string | undefined): boolean {
  const text = (result ?? '').trim()
  return !text || text.startsWith(PLACEHOLDER_PREFIX)
}

/**
 * Whether a call that asks the user to confirm a change (``confirm_change``)
 * shows this card: while its question is open, after it was answered here,
 * or while its row still holds the server's placeholder. Otherwise the call
 * never opened a card (refused, deferred) or has settled with the outcome as
 * its result, and stays an ordinary tool row.
 */
export function useShowsConfirmationCard(enabled: boolean, toolCallId: string | undefined, result: string | undefined): boolean {
  const ownsCard = useAgentStore((state) =>
    enabled && !!toolCallId && (selectOpenQuestionCallId(state) === toolCallId || !!state.resolvedQuestions[toolCallId]),
  )
  return enabled && (ownsCard || (!!result?.trim() && isUnsettledResult(result)))
}

/**
 * Whether an ``ask_user`` block's card still reads "Needs your input": it holds
 * the open question, or nothing has closed it yet. Reader mode keeps such a
 * card out of the work fold and folds it once it settles.
 */
export function useQuestionAwaitsUser(): (block: ContentBlock) => boolean {
  const openCallId = useAgentStore(selectOpenQuestionCallId)
  const resolvedQuestions = useAgentStore((state) => state.resolvedQuestions)
  const turnLive = useAgentStore((state) => state.isAgentWorking)
  return useCallback(
    (block: ContentBlock) => {
      const id = block.toolCallId
      if (openCallId !== null && id === openCallId) return true
      return turnLive && !(id && resolvedQuestions[id]) && isUnsettledResult(block.toolResult)
    },
    [openCallId, resolvedQuestions, turnLive],
  )
}
