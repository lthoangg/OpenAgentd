/**
 * Questions the agent puts to the user (``ask_user``, plan review): the wire
 * shape mapped to the store's, and the events that open and close the card.
 */
import { applyQuestionResolution, parseQuestionClosedReason } from './helpers'
import type { StoreSet } from './types'
import type { PendingQuestion, QuestionItem } from '@/api/types'

/**
 * Coerce the ``question_asked`` payload into ``QuestionItem[]``.
 *
 * The event carries the tool's already-validated args, but they cross the wire
 * as untyped ``dict[str, Any]``. Normalising here means the dock can render
 * without defensive checks at every field, and a malformed entry degrades to an
 * open-text question instead of throwing inside a render.
 */
export function normalizeQuestions(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const q = (entry ?? {}) as Record<string, unknown>
    const options = Array.isArray(q.options) ? q.options : []
    return {
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' ? q.header : '',
      multiple: q.multiple === true,
      options: options.map((opt) => {
        const o = (opt ?? {}) as Record<string, unknown>
        return {
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : null,
          recommended: o.recommended === true,
        }
      }),
    }
  })
}

/**
 * Map a wire question (SSE event or history row) to store shape.
 *
 * Returns ``null`` for a payload with nothing to render, so callers never put a
 * card on screen that the user cannot act on. Single source of truth for the
 * mapping — the SSE path and the cold-load path must agree exactly, or a reload
 * would silently change the card.
 */
export function toPendingQuestion(raw: {
  id?: unknown
  session_id?: unknown
  tool_call_id?: unknown
  questions?: unknown
  kind?: unknown
  plan_revision?: unknown
}): PendingQuestion | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const questions = normalizeQuestions(raw.questions)
  if (!id || questions.length === 0) return null
  const question: PendingQuestion = {
    id,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
    toolCallId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
    questions,
  }
  if (raw.kind === 'plan_review') {
    question.kind = 'plan_review'
    if (typeof raw.plan_revision === 'number') question.planRevision = raw.plan_revision
  }
  return question
}

export function onQuestionAsked(set: StoreSet, d: Record<string, unknown>) {
  // The event names the row ``question_id``; every other carrier calls it
  // ``id``. Normalise before the shared mapper sees it.
  const question = toPendingQuestion({ ...d, id: d.question_id })
  if (!question) return
  set((draft) => {
    draft.pendingQuestion = question
    // The Plan panel must show the revision under review, even if this
    // client missed the `plan` tool finishing (it refreshes on that too).
    const sid = draft.sessionId ?? question.sessionId
    if (question.kind === 'plan_review' && sid) draft.cacheInvalidations.push({ kind: 'plan', sessionId: sid })
  })
}

export function onQuestionResolved(set: StoreSet, type: string, d: Record<string, unknown>) {
  const questionId = d.question_id as string
  const answers = type === 'question_answered'
    ? (Array.isArray(d.answers) ? (d.answers as string[][]) : [])
    : null
  set((draft) => {
    // Guarded inside the helper: a late event for a question we are no
    // longer showing must not close the current card, and the local path
    // may already have recorded this same resolution.
    applyQuestionResolution(
      draft,
      questionId,
      answers,
      answers === null ? parseQuestionClosedReason(d.reason) : null,
    )
  })
}
