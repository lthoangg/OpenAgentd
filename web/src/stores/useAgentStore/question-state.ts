/**
 * The question card (``web/src/AGENTS.md`` → State machines): the question
 * the lead is suspended on, if any.
 *
 * At most one is open per session (a partial unique index server-side), so a
 * second ``question_asked`` replaces the first instead of stacking cards.
 * Every path that closes the card (the answer's POST reply, the broadcast of
 * the same answer, a dismissal, a supersede by a new send, a history page
 * that no longer has it) is the one ``resolve`` move; a resolve for an id
 * that is not open is listed as a move that changes nothing, because the
 * reply and the broadcast race and either may land second.
 */
import type { PendingQuestion } from '@/api/question-types'
import { defineMachine } from '@/lib/machine'
import type { AgentStore, QuestionClosedReason } from './types'

export type QuestionCard =
  | { kind: 'none' }
  | { kind: 'open'; question: PendingQuestion }

export type QuestionEvent =
  /** ``question_asked``: open this card, replacing any other. */
  | { type: 'ask'; question: PendingQuestion }
  /** Close the card ``id`` names; ``null`` closes whatever is open. */
  | { type: 'resolve'; id: string | null }
  /** A history page's open question, which is durable and outranks the client's. */
  | { type: 'restore'; question: PendingQuestion | null }
  /** A switch to another session. */
  | { type: 'reset' }

export const NO_QUESTION: QuestionCard = { kind: 'none' }

const open = (question: PendingQuestion): QuestionCard => ({ kind: 'open', question })
const restored = (question: PendingQuestion | null): QuestionCard => (question ? open(question) : NO_QUESTION)

export const questionMachine = defineMachine<QuestionCard, QuestionEvent>('question card', {
  none: {
    ask: (_s, e) => open(e.question),
    // The other half of the reply/broadcast race, or a send with nothing open.
    resolve: (s) => s,
    restore: (_s, e) => restored(e.question),
    reset: () => NO_QUESTION,
  },
  open: {
    ask: (_s, e) => open(e.question),
    // A late event for a question this card no longer shows changes nothing.
    resolve: (s, e) => (e.id === null || e.id === s.question.id ? NO_QUESTION : s),
    restore: (_s, e) => restored(e.question),
    reset: () => NO_QUESTION,
  },
})

/** The open question, or ``null``. */
export function openQuestion(state: Pick<AgentStore, 'questionCard'>): PendingQuestion | null {
  return state.questionCard.kind === 'open' ? state.questionCard.question : null
}

/** A question card for a store seed. */
export function questionCardOf(question: PendingQuestion | null): QuestionCard {
  return restored(question)
}

type QuestionDraft = Pick<AgentStore, 'questionCard' | 'resolvedQuestions'> & Partial<Pick<AgentStore, 'sessionId' | 'cacheInvalidations'>>

export function applyQuestion(draft: Pick<AgentStore, 'questionCard'>, event: QuestionEvent): void {
  draft.questionCard = questionMachine.transition(draft.questionCard, event)
}

/**
 * Close the open question and record how it ended.
 *
 * Resolving is a race between the POST reply and the broadcast of the same
 * resolution, and either can land first. Both call this, so whichever wins
 * records the outcome and the loser changes nothing.
 *
 * The outcome is kept against the *tool call*: the persisted tool result is
 * only rewritten server-side at the end of the turn, so without this the card
 * would fall back to "waiting" for the seconds until history reconciles.
 *
 * Closing a plan review also refreshes the plan: an approval records the
 * approved revision, and the user may have edited it during the review.
 */
export function applyQuestionResolution(
  draft: QuestionDraft,
  /** ``null`` closes whatever is open: turn-level events that end a question without naming it. */
  questionId: string | null,
  answers: string[][] | null,
  reason: QuestionClosedReason | null,
): void {
  const before = openQuestion(draft)
  applyQuestion(draft, { type: 'resolve', id: questionId })
  if (!before || draft.questionCard.kind === 'open') return
  draft.resolvedQuestions[before.toolCallId] = { questions: before.questions, answers, reason }
  if (before.kind === 'plan_review' && draft.sessionId) {
    draft.cacheInvalidations?.push({ kind: 'plan', sessionId: draft.sessionId })
  }
}
