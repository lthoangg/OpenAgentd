/**
 * The chat's side of the Plan tab's comments: **Reply in chat** moves them
 * into the composer as one chip (a phone closes the Review panel to show
 * it), and the chip's x hands them back to the open review's draft. The
 * composer reports its chip so the Plan tab knows comments wait there.
 */
import { useCallback, type RefObject } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import { openQuestion } from '@/stores/useAgentStore/question-state'
import type { InputComposerHandle } from '../InputComposer'
import { readPlanReviewDraft, writePlanReviewDraft } from '../PlanReview/plan-comments'
import type { PlanCommentsBlock, PlanCommentsHandoff } from '../PlanReview/plan-comments-block'
import { setPlanCommentsInChat } from '../PlanReview/plan-comments-in-chat'

export function useChatPlanComments({ isMobile, inputRef, setWorkspacePanel }: {
  isMobile: boolean
  inputRef: RefObject<InputComposerHandle | null>
  setWorkspacePanel: (panel: null) => void
}) {
  const handleSendPlanComments = useCallback(({ block, text }: PlanCommentsHandoff) => {
    if (block) inputRef.current?.addPlanComments(block)
    if (text?.trim()) inputRef.current?.appendValue(text.trim(), { paragraph: true })
    // A phone shows the Review panel over the chat: go back to the message
    // box, where the comments now are.
    if (isMobile) setWorkspacePanel(null)
    inputRef.current?.focus()
  }, [inputRef, isMobile, setWorkspacePanel])

  // The chip's x: the comments go back to the plan they were made on, while
  // its review is still open. A closed review has nothing to take them.
  const handlePlanCommentsRemoved = useCallback((block: PlanCommentsBlock) => {
    const store = useAgentStore.getState()
    const question = openQuestion(store)
    const sessionId = store.sessionId
    if (!question || question.kind !== 'plan_review' || question.sessionId !== sessionId) return
    const draft = readPlanReviewDraft(question.id)
    const stamp = Date.now().toString(36)
    const returned = block.comments.map((comment, index) => ({ id: `returned-${stamp}-${index}`, quote: comment.quote, text: comment.text }))
    writePlanReviewDraft(question.id, { ...draft, comments: [...draft.comments, ...returned] })
  }, [])

  return { handleSendPlanComments, handlePlanCommentsRemoved, handlePlanCommentsChange: setPlanCommentsInChat }
}
