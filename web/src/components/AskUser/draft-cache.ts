/**
 * In-progress answers, keyed by question id.
 *
 * A half-filled answer must survive a remount: the dock unmounts when the user
 * switches sessions, opens a file, or rotates the device, and losing three
 * selections to a stray tap is worse than any staleness this cache can cause.
 *
 * Module-level rather than store state — it is transient UI scratch space with
 * no subscribers, and keying by the (server-generated, unique) question id means
 * a draft can never leak into a different question. Answering or dismissing
 * drops the entry.
 */

export interface QuestionDraft {
  /** Selected option labels per question index. */
  selected: Record<number, string[]>
  /** Free-text answer per question index (only used while ``custom`` is on). */
  customText: Record<number, string>
  /** Whether the "type your own answer" option is chosen, per question index. */
  customActive: Record<number, boolean>
  /** Which question the stepper is showing. */
  step: number
}

/**
 * Only a handful can ever be live (one open question per session), but a long
 * session that asks repeatedly would otherwise grow this map without bound.
 */
const MAX_DRAFTS = 20

const drafts = new Map<string, QuestionDraft>()

export function emptyQuestionDraft(): QuestionDraft {
  return { selected: {}, customText: {}, customActive: {}, step: 0 }
}

export function readQuestionDraft(questionId: string): QuestionDraft {
  return drafts.get(questionId) ?? emptyQuestionDraft()
}

export function writeQuestionDraft(questionId: string, draft: QuestionDraft): void {
  // Re-insert so iteration order is least-recently-written first.
  drafts.delete(questionId)
  drafts.set(questionId, draft)
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next()
    if (oldest.done) break
    drafts.delete(oldest.value)
  }
}

/** Drop a resolved question's draft — it can never be edited again. */
export function forgetQuestionDraft(questionId: string): void {
  drafts.delete(questionId)
}

/** Test seam. */
export function clearQuestionDrafts(): void {
  drafts.clear()
}
