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
import { useCallback, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'

import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStoreState, ResolvedQuestion } from '@/stores/useAgentStore'
import type { ContentBlock, QuestionItem } from '@/api/types'
import { QuestionCard } from './QuestionCard'
import { useQuestionResolver } from './useQuestionResolver'
import { TRANSCRIPT_CARD } from '@/components/ui/panel-tokens'
import { useIsPhone } from '@/hooks/use-is-phone'
import { cn } from '@/lib/utils'

/** Mirrors ``question_service.PLACEHOLDER_RESULT``. */
const PLACEHOLDER_PREFIX = 'Waiting for the user to answer'

/**
 * How many ``PinnedQuestion`` hosts are mounted. A lead session's composer
 * always holds one (only a lead may ask the user); the transcript card hands
 * its form over only while one is there, so a view without a composer still
 * answers in place. Registered in a layout effect: a card that mounts in the
 * same commit swaps to its note before paint.
 */
let pinHosts = 0
const pinHostListeners = new Set<() => void>()
function subscribePinHosts(listener: () => void): () => void {
  pinHostListeners.add(listener)
  return () => { pinHostListeners.delete(listener) }
}
function usePinHostMounted(): boolean {
  return useSyncExternalStore(subscribePinHosts, () => pinHosts > 0, () => false)
}
function useRegisterPinHost(): void {
  useLayoutEffect(() => {
    pinHosts += 1
    pinHostListeners.forEach((listener) => listener())
    return () => {
      pinHosts -= 1
      pinHostListeners.forEach((listener) => listener())
    }
  }, [])
}

/** The ``tool_call_id`` of the question open in this session, or ``null``. */
function selectOpenQuestionCallId(state: AgentStoreState): string | null {
  const question = state.pendingQuestion
  return question !== null && state.sessionId !== null && question.sessionId === state.sessionId
    ? question.toolCallId
    : null
}

/** A persisted result that closes nothing yet: none, or the server's placeholder. */
function isUnsettledResult(result: string | undefined): boolean {
  const text = (result ?? '').trim()
  return !text || text.startsWith(PLACEHOLDER_PREFIX)
}

/**
 * Whether ``toolCallId`` belongs to the turn that is running now. A call from
 * an earlier turn cannot still be about to ask: the loop only starts a new
 * turn once the previous question is closed (answered, dismissed, superseded).
 */
function selectInLiveTurn(state: AgentStoreState, toolCallId: string | undefined): boolean {
  if (!toolCallId || !state.isAgentWorking) return false
  return Object.values(state.agentStreams).some((stream) =>
    stream.currentBlocks.some((block) => block.toolCallId === toolCallId),
  )
}

/** ``|``-joined tool call ids of the running turn (a stable selector value). */
function selectLiveTurnCallIds(state: AgentStoreState): string {
  if (!state.isAgentWorking) return ''
  const ids: string[] = []
  for (const stream of Object.values(state.agentStreams)) {
    for (const block of stream.currentBlocks) if (block.toolCallId) ids.push(block.toolCallId)
  }
  return ids.join('|')
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
 * Whether a user-gated block (``ask_user``, plan review, confirmation) still
 * waits on the user: it holds the open question, or it belongs to the running
 * turn and nothing has closed it yet (the loop opens the question only after
 * the reply's other tool calls finish). Reader mode keeps such a card out of
 * the work fold and folds it once it settles. A call from an earlier turn is
 * never waiting — that turn could not have ended with it open.
 */
export function useQuestionAwaitsUser(): (block: ContentBlock) => boolean {
  const openCallId = useAgentStore(selectOpenQuestionCallId)
  const resolvedQuestions = useAgentStore((state) => state.resolvedQuestions)
  const liveCallIds = useAgentStore(selectLiveTurnCallIds)
  return useCallback(
    (block: ContentBlock) => {
      const id = block.toolCallId
      if (openCallId !== null && id === openCallId) return true
      const inLiveTurn = !!id && liveCallIds.split('|').includes(id)
      return inLiveTurn && !resolvedQuestions[id] && isUnsettledResult(block.toolResult)
    },
    [openCallId, resolvedQuestions, liveCallIds],
  )
}

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
  const inLiveTurn = useAgentStore((state) => selectInLiveTurn(state, toolCallId))
  const hostMounted = usePinHostMounted()
  const isPhone = useIsPhone()

  const isOpen = pendingQuestion !== null && openCallId === toolCallId
  // It is answered in the card pinned above the composer (PinnedQuestion).
  // A phone's chat always has one; on desktop it waits for the host.
  const pinned = isOpen && (isPhone || hostMounted) && pendingQuestion.kind !== 'plan_review'
  const { submitting, error, answer } = useQuestionResolver(isOpen && !pinned ? pendingQuestion : null)

  if (!isOpen) {
    const { waiting, body } = describeResolution(resolved, result, args, inLiveTurn)
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

/**
 * The open question, pinned above the composer so it cannot scroll away
 * while the run waits on it (phone mockup J6 6.1, desktop 6.1): the orange
 * frame of "needs you", the same form. Its number keys and ⌘↵ answer it
 * once focus is in it.
 */
export function PinnedQuestion() {
  useRegisterPinHost()
  const isPhone = useIsPhone()
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion)
  const openCallId = useAgentStore(selectOpenQuestionCallId)
  const show = pendingQuestion !== null && openCallId !== null && pendingQuestion.kind !== 'plan_review'
  const { submitting, error, answer } = useQuestionResolver(show ? pendingQuestion : null)
  if (!show) return null
  return (
    <div
      data-question-pinned=""
      // A desktop window keeps more of the transcript above it.
      className={cn(
        'mb-2 overflow-y-auto overscroll-contain rounded-md border border-(--accent-orange-text) bg-(--bg-card)',
        isPhone ? 'max-h-[55dvh]' : 'max-h-[45vh]',
      )}
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

/** The card frame. Fluid width — no separate mobile presentation. */
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
  /** The call belongs to the running turn, so its question may yet open. */
  inLiveTurn: boolean,
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
  // here. Only an open question asks for input. A call in the running turn may
  // still open one — the loop asks after the reply's other tool calls finish —
  // so it says so without claiming the user's attention. Any other call closed
  // in a way that left no outcome here (an open question would be in the
  // store: a load or reattach restores it), so say so instead of waiting.
  if (isUnsettledResult(result)) {
    if (inLiveTurn) return { waiting: false, body: <QuestionNote text="Asks once the running tools finish" /> }
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
