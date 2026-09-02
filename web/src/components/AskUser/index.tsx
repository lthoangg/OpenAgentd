/**
 * The `ask_user` tool card, rendered inline in the transcript.
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
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import type { ResolvedQuestion } from '@/stores/useAgentStore'
import type { QuestionItem } from '@/api/types'
import { QuestionCard } from './QuestionCard'
import { forgetQuestionDraft } from './draft-cache'

/** Mirrors ``question_service.PLACEHOLDER_RESULT``. */
const PLACEHOLDER_PREFIX = 'Waiting for the user to answer'

/**
 * Recovers the reason from the persisted sentence, which is all a cold load
 * has. Mirrors the non-answer entries of ``question_service._RESOLUTION_TEXT``;
 * plus the agent loop's refusal sentences (``ASK_BUDGET_EXHAUSTED`` /
 * ``ASK_MERGED_INTO_PRIMARY`` in ``agent_loop/core.py``), which are written
 * straight onto the tool row without a question ever opening; plus the loop's
 * failure endings, which also never open a question: an ``Error: …`` result
 * (argument validation runs before the tool body, and hook-chain failures are
 * stringified the same way), the tool's own no-call-id refusal, and the
 * synthetic stub ``heal_orphaned_tool_calls`` writes when a restart killed the
 * turn between persisting the call and asking. An unrecognised sentence still
 * resolves, just without a specific reason.
 */
const RESOLUTION_PREFIXES: readonly (readonly [string, string])[] = [
  ['Question(s) being dismissed', 'dismissed'],
  ['Superseded', 'superseded'],
  ['This question is no longer relevant', 'expired'],
  ['You already used your one interruption', 'refused'],
  ['Merged into your other ask_user call', 'merged'],
  ['Error:', 'failed'],
  ['Your question could not be delivered', 'failed'],
  ['Tool execution was interrupted before a result could be recorded', 'interrupted'],
]

const REASON_LABEL: Record<string, string> = {
  dismissed: 'Dismissed',
  superseded: 'Superseded by your next message',
  expired: 'No longer relevant',
  resolved_elsewhere: 'Already resolved from another window or device',
  refused: 'Not asked — the agent already used its one question for this turn',
  merged: 'Merged into the other question card',
  failed: 'Not asked — the question failed to send, so the agent continued without it',
  interrupted: 'Not asked — interrupted before the question went out',
}

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

export function AskUser({
  toolCallId,
  args,
  result,
}: {
  toolCallId?: string
  /** Raw tool-call arguments — the only record of what was asked once a
   *  question closes without an answer and the store has been reloaded. */
  args?: string
  result?: string
}) {
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion)
  const sessionId = useAgentStore((state) => state.sessionId)
  const resolveQuestion = useAgentStore((state) => state.resolveQuestion)
  const markTurnResuming = useAgentStore((state) => state.markTurnResuming)
  const resolved = useAgentStore((state) =>
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
    const { waiting, body } = describeResolution(resolved, result, args)
    return <QuestionShell waiting={waiting}>{body}</QuestionShell>
  }

  const questionId = pendingQuestion.id

  const resolve = async (
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
            answers,
            null,
          )
        }
        onDismiss={() =>
          void resolve(
            () => dismissQuestion(sessionId, questionId),
            'Could not dismiss the question.',
            false,
            null,
            'dismissed',
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
  args: string | undefined,
): { waiting: boolean; body: ReactNode } {
  if (resolved) {
    if (resolved.answers === null) {
      return {
        waiting: false,
        body: <ClosedQuestions reason={resolved.reason} questions={resolved.questions} />,
      }
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
  if (pairs.length > 0) return { waiting: false, body: <AnswerList pairs={pairs} /> }

  // No answer pairs: it closed without one. The sentence carries the reason but
  // not the questions, so those come back from the call arguments.
  const reason = RESOLUTION_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? null
  return {
    waiting: false,
    body: <ClosedQuestions reason={reason} questions={parseAskedQuestions(args)} />,
  }
}

/** Recover the asked questions from the raw tool-call arguments. */
function parseAskedQuestions(args: string | undefined): QuestionItem[] {
  if (!args) return []
  try {
    const parsed: unknown = JSON.parse(args)
    const questions = (parsed as { questions?: unknown })?.questions
    return Array.isArray(questions) ? (questions as QuestionItem[]) : []
  } catch {
    // Truncated or streaming-partial arguments: the reason alone still renders.
    return []
  }
}

/**
 * A question that ended without an answer.
 *
 * Minimised on purpose: the outcome plus what was asked, and nothing else. The
 * options are no longer actionable, so showing them would only invite a click.
 */
function ClosedQuestions({
  reason,
  questions,
}: {
  reason: string | null
  questions: QuestionItem[]
}) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <span className="text-[11px] leading-relaxed font-medium text-(--color-text-muted)">
        {(reason && REASON_LABEL[reason]) ?? 'Closed without an answer'}
      </span>
      {questions.map((item, index) => (
        <span
          key={index}
          className="truncate text-[11px] leading-relaxed text-(--color-text-subtle)"
        >
          {item.question}
        </span>
      ))}
    </div>
  )
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
