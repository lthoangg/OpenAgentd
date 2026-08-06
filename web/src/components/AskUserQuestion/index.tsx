/**
 * The `ask_user_question` tool card, rendered inline in the transcript.
 *
 * It sits where the tool call happened rather than floating over the chat: the
 * question is part of the turn's narrative, and answering it later reads back
 * as a normal step. There is no collapse control — a card with an unanswered
 * question in it is the one thing on screen that must not be hidden, and once
 * resolved it is a two-line summary that costs nothing to leave open.
 *
 * Two states, decided by the store rather than by the persisted tool result:
 *
 * 1. **Waiting** — this tool call is the open question. Show the form.
 * 2. **Resolved** — show what the user chose (or that they dismissed it).
 *
 * The persisted result is only rewritten server-side, so immediately after
 * answering it still reads "waiting for the user". `resolvedQuestions` carries
 * the outcome locally so the card flips straight to state 2.
 *
 * The card owns its own frame and label, because both depend on that state: a
 * resolved question still headed "Needs your input" reads as an outstanding
 * request. The frame is fluid — it takes the transcript's width at every
 * breakpoint rather than switching to a separate mobile presentation.
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'

import { answerQuestion, dismissQuestion } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import type { ResolvedQuestion } from '@/stores/useTeamStore'
import { QuestionCard } from './QuestionCard'
import { forgetQuestionDraft } from './draft-cache'

/** Mirrors ``question_service.PLACEHOLDER_RESULT``. */
const PLACEHOLDER_PREFIX = 'Waiting for the user to answer'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function AskUserQuestion({
  toolCallId,
  result,
}: {
  toolCallId?: string
  result?: string
}) {
  const pendingQuestion = useTeamStore((state) => state.pendingQuestion)
  const sessionId = useTeamStore((state) => state.sessionId)
  const clearPendingQuestion = useTeamStore((state) => state.clearPendingQuestion)
  const resolved = useTeamStore((state) =>
    toolCallId ? state.resolvedQuestions[toolCallId] : undefined,
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOpen =
    pendingQuestion !== null &&
    sessionId !== null &&
    pendingQuestion.sessionId === sessionId &&
    pendingQuestion.toolCallId === toolCallId

  if (!isOpen) {
    const { waiting, body } = describeResolution(resolved, result)
    return <QuestionShell waiting={waiting}>{body}</QuestionShell>
  }

  const questionId = pendingQuestion.id

  const resolve = async (
    action: () => Promise<{ resumed: boolean }>,
    failure: string,
    // Only an answer restarts the turn; a dismissal reports ``resumed: false``
    // by design, and warning about that would turn "not now" into an error.
    expectResume: boolean,
  ) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await action()
      forgetQuestionDraft(questionId)
      // The resolution also arrives over SSE, but closing here too means the
      // card still resolves when this client's stream is mid-reconnect.
      clearPendingQuestion(questionId)
      if (expectResume && !outcome.resumed) {
        useToastStore.getState().push({
          tone: 'error',
          title: 'Answer saved, but the agent did not restart',
          description: 'Send a message to continue the turn.',
        })
      }
    } catch (cause) {
      // Keep the form and the draft: the selection is still valid and the user
      // should be able to retry without re-picking anything.
      setError(errorMessage(cause, failure))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <QuestionShell waiting>
      <QuestionCard
        key={questionId}
        question={pendingQuestion}
        submitting={submitting}
        error={error}
        onSubmit={(answers) =>
          void resolve(
            () => answerQuestion(sessionId, questionId, answers),
            'Could not send the answer.',
            true,
          )
        }
        onDismiss={() =>
          void resolve(
            () => dismissQuestion(sessionId, questionId),
            'Could not dismiss the question.',
            false,
          )
        }
      />
    </QuestionShell>
  )
}

/** The card frame. Fluid width — no separate mobile presentation. */
function QuestionShell({
  waiting,
  children,
}: {
  waiting: boolean
  children: ReactNode
}) {
  return (
    <div className="tool-row-enter my-2 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)">
      <div className="flex items-center gap-1.5 border-b border-(--color-border) px-3 py-1.5 text-[11px] font-medium tracking-wide text-(--color-text-muted) uppercase">
        <MessageCircleQuestion size={12} aria-hidden />
        {waiting ? 'Needs your input' : 'Your input'}
      </div>
      {children}
    </div>
  )
}

/**
 * What the user decided, and whether the card is still asking.
 *
 * Prefers the structured outcome recorded when the question resolved; falls
 * back to parsing the persisted sentence, which is all a cold load has.
 */
function describeResolution(
  resolved: ResolvedQuestion | undefined,
  result: string | undefined,
): { waiting: boolean; body: ReactNode } {
  if (resolved) {
    if (resolved.answers === null) {
      return { waiting: false, body: <QuestionNote text="Dismissed" /> }
    }
    return {
      waiting: false,
      body: (
        <AnswerList
          pairs={resolved.questions.map((item, index) => ({
            question: item.question,
            answer: (resolved.answers?.[index] ?? []).join(', '),
          }))}
        />
      ),
    }
  }

  const text = (result ?? '').trim()
  // A cold load mid-wait: the row still holds the placeholder, and the store had
  // no open question for this call (another device answered, or this client
  // reconnected after the fact). Still unanswered, so the label stays "waiting".
  if (!text || text.startsWith(PLACEHOLDER_PREFIX)) {
    return { waiting: true, body: <QuestionNote text="Waiting for an answer…" /> }
  }

  const pairs = [...text.matchAll(/"([^"]*)"="([^"]*)"/g)].map(([, question, answer]) => ({
    question,
    answer,
  }))
  if (pairs.length === 0) return { waiting: false, body: <QuestionNote text={text} /> }
  return { waiting: false, body: <AnswerList pairs={pairs} /> }
}

function AnswerList({ pairs }: { pairs: { question: string; answer: string }[] }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      {pairs.map(({ question, answer }, index) => (
        <div key={index} className="flex flex-col gap-0.5">
          <span className="text-[11px] leading-relaxed text-(--color-text-muted)">
            {question}
          </span>
          {answer && answer !== 'Unanswered' ? (
            <span className="text-[11px] leading-relaxed font-medium break-words text-(--color-text)">
              {answer}
            </span>
          ) : (
            <span className="text-[11px] leading-relaxed text-(--color-text-subtle) italic">
              Skipped
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function QuestionNote({ text }: { text: string }) {
  return (
    <p className="px-3 py-2 text-[11px] leading-relaxed text-(--color-text-muted)">
      {text}
    </p>
  )
}
