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
 * breakpoint rather than switching to a separate mobile presentation. It is
 * one thin frame with nothing bordered inside, and no icon before the label.
 */
import { type ReactNode } from 'react'

import { useAgentStore } from '@/stores/useAgentStore'
import type { ResolvedQuestion } from '@/stores/useAgentStore'
import type { QuestionItem } from '@/api/types'
import { QuestionCard } from './QuestionCard'
import { useQuestionResolver } from './useQuestionResolver'
import { TRANSCRIPT_CARD } from '@/components/ui/panel-tokens'
import { useIsPhone } from '@/hooks/use-is-phone'
import { cn } from '@/lib/utils'

import { isUnsettledResult, selectOpenQuestionCallId } from './state'

export { useQuestionAwaitsUser, useShowsConfirmationCard } from './state'

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
  unrecorded: 'No answer recorded',
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
  const openCallId = useAgentStore(selectOpenQuestionCallId)
  const resolved = useAgentStore((state) =>
    toolCallId ? state.resolvedQuestions[toolCallId] : undefined,
  )
  const turnLive = useAgentStore((state) => state.isAgentWorking)
  const isPhone = useIsPhone()

  const isOpen = pendingQuestion !== null && openCallId === toolCallId
  // A phone answers it in the card pinned above the composer (PinnedQuestion).
  const pinned = isOpen && isPhone && pendingQuestion.kind !== 'plan_review'
  const { submitting, error, answer } = useQuestionResolver(isOpen && !pinned ? pendingQuestion : null)

  if (!isOpen) {
    const { waiting, body } = describeResolution(resolved, result, args, turnLive)
    return <QuestionShell waiting={waiting}>{body}</QuestionShell>
  }
  if (pinned) return <QuestionShell waiting><QuestionNote text="Answer below" /></QuestionShell>

  return (
    <QuestionShell waiting open>
      <QuestionCard
        key={pendingQuestion.id}
        question={pendingQuestion}
        submitting={submitting}
        error={error}
        onSubmit={answer}
      />
    </QuestionShell>
  )
}

/** The card frame. Fluid width — no separate mobile presentation. */
/**
 * A phone's open question, pinned above the composer so it cannot scroll
 * away (mockup J6 6.1): the orange frame of "needs you", the same form.
 */
export function PinnedQuestion() {
  const isPhone = useIsPhone()
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion)
  const openCallId = useAgentStore(selectOpenQuestionCallId)
  const show = isPhone && pendingQuestion !== null && openCallId !== null && pendingQuestion.kind !== 'plan_review'
  const { submitting, error, answer } = useQuestionResolver(show ? pendingQuestion : null)
  if (!show) return null
  return (
    <div
      data-question-pinned=""
      className="mb-2 max-h-[55dvh] overflow-y-auto overscroll-contain rounded-md border border-(--accent-orange-text) bg-(--bg-card)"
    >
      <div className="px-3 pt-2 pb-1 label-caps text-(--accent-orange-text)">Agent is asking you</div>
      <QuestionCard
        key={pendingQuestion.id}
        question={pendingQuestion}
        submitting={submitting}
        error={error}
        onSubmit={answer}
      />
    </div>
  )
}

function QuestionShell({
  waiting,
  open = false,
  children,
}: {
  waiting: boolean
  /** Still answerable here; the transcript's timeline marks it. */
  open?: boolean
  children: ReactNode
}) {
  return (
    <div data-question-waiting={open ? '' : undefined} className={cn('tool-row-enter my-2', TRANSCRIPT_CARD)}>
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 label-caps text-(--color-text-muted)">
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
  /** The session's turn is still running, so the question may yet open here. */
  turnLive: boolean,
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

  // The row still holds the placeholder (or nothing) and no question is open
  // here. While the turn runs the question may still open (its event follows
  // the call), so it waits. Once the turn is over, an open question would be
  // in the store (a load restores it from the server), so this one closed in
  // a way that left no outcome here: say so instead of waiting for good.
  if (isUnsettledResult(result)) {
    if (turnLive) return { waiting: true, body: <QuestionNote text="Waiting for an answer…" /> }
    return { waiting: false, body: <ClosedQuestions reason="unrecorded" questions={parseAskedQuestions(args)} /> }
  }

  const text = (result ?? '').trim()
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
    <div className="flex flex-col gap-1 px-3 pt-1 pb-2.5">
      <span className="text-xs leading-relaxed font-medium text-(--color-text-muted)">
        {(reason && REASON_LABEL[reason]) ?? 'Closed without an answer'}
      </span>
      {questions.map((item, index) => (
        <span
          key={index}
          className="truncate text-xs leading-relaxed text-(--color-text-muted)"
        >
          {item.question}
        </span>
      ))}
    </div>
  )
}

function AnswerList({ pairs }: { pairs: { question: string; answer: string }[] }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-1 pb-2.5">
      {pairs.map(({ question, answer }, index) => (
        <div key={index} className="flex flex-col gap-0.5">
          <span className="text-xs leading-relaxed text-(--color-text-muted) [overflow-wrap:anywhere]">
            {question}
          </span>
          {answer && answer !== 'Unanswered' ? (
            <span className="text-xs leading-relaxed font-medium break-words text-(--color-text) [overflow-wrap:anywhere]">
              {answer}
            </span>
          ) : (
            <span className="text-xs leading-relaxed text-(--color-text-muted) italic">
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
    <p className="px-3 pt-1 pb-2.5 text-xs leading-relaxed text-(--color-text-muted)">
      {text}
    </p>
  )
}
