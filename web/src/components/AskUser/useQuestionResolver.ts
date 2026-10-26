/**
 * Answer or dismiss the open question — from its card, or from the composer.
 *
 * Both surfaces go through here so an answer is recorded, the draft dropped,
 * and a question another device already closed handled the same way.
 */
import { useState } from 'react'

import { answerQuestion, dismissQuestion } from '@/api/client'
import type { PendingQuestion } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { forgetQuestionDraft } from './draft-cache'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/**
 * The server's "this question is not open any more" reply (see
 * ``_open_question_or_conflict`` / ``_resolve_or_conflict`` in
 * ``routes/agent/questions.py``). Another window or device got there first, or
 * a new message superseded the question. Duck-typed on ``status`` rather than
 * on the client's error class so the check does not depend on which module
 * threw.
 */
function isAlreadyResolved(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { status?: unknown }).status === 409
  )
}

export function useQuestionResolver(question: PendingQuestion | null) {
  const sessionId = useAgentStore((state) => state.sessionId)
  const resolveQuestion = useAgentStore((state) => state.resolveQuestion)
  const markTurnResuming = useAgentStore((state) => state.markTurnResuming)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resolve = async (
    questionId: string,
    action: () => Promise<{ resumed: boolean }>,
    failure: string,
    // Only an answer restarts the turn; a dismissal reports ``resumed: false``
    // by design, and warning about that would turn "not now" into an error.
    expectResume: boolean,
    answers: string[][] | null,
    reason: string | null,
  ) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await action()
      forgetQuestionDraft(questionId)
      // Record the outcome here as well as on the broadcast. Either can land
      // first; the store guard makes the second a no-op. Clearing without
      // recording would strand the card in "waiting" — the broadcast then has
      // no open question left to attach the outcome to.
      resolveQuestion(questionId, answers, reason)
      if (expectResume) {
        if (outcome.resumed) {
          // The restarted turn adds no user block, so nothing else marks it
          // live until its first token — show the "about to respond" dots now.
          markTurnResuming()
        } else {
          useToastStore.getState().push({
            tone: 'error',
            title: 'Answer saved, but the agent did not restart',
            description: 'Send a message to continue the turn.',
          })
        }
      }
    } catch (cause) {
      // Retrying cannot succeed: the row is gone. Close the card with what we
      // know; the persisted result shows the real outcome on the next load.
      // (Normally the resolution broadcast already closed it, and the store
      // guard makes this a no-op.)
      if (isAlreadyResolved(cause)) {
        forgetQuestionDraft(questionId)
        resolveQuestion(questionId, null, 'resolved_elsewhere')
        return
      }
      // Keep the form and the draft: the selection is still valid and the user
      // should be able to retry without re-picking anything.
      setError(errorMessage(cause, failure))
    } finally {
      setSubmitting(false)
    }
  }

  return {
    submitting,
    error,
    /** ``options.keepGoing``: a plan approval that also starts a goal (see ``answerQuestion``). */
    answer: (answers: string[][], options?: { keepGoing?: { maxTurns?: number } }) => {
      if (!question || !sessionId) return
      void resolve(question.id, () => answerQuestion(sessionId, question.id, answers, options), 'Could not send the answer.', true, answers, null)
    },
    dismiss: () => {
      if (!question || !sessionId) return
      void resolve(question.id, () => dismissQuestion(sessionId, question.id), 'Could not dismiss the question.', false, null, 'dismissed')
    },
  }
}
