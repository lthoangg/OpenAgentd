/**
 * The chat's side of the Plan tab's comments: Reply in chat puts them in the
 * composer (a phone closes the Review panel), the chip's x returns them to the
 * open review, and the composer's chip is published for the Plan tab.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import { renderHook } from '@testing-library/react'

import { useChatPlanComments } from '@/components/AgentChatView/useChatPlanComments'
import type { InputComposerHandle } from '@/components/InputComposer'
import { clearPlanReviewDrafts, readPlanReviewDraft, writePlanReviewDraft } from '@/components/PlanReview/plan-comments'
import type { PlanCommentsBlock } from '@/components/PlanReview/plan-comments-block'
import { usePlanCommentsInChat } from '@/components/PlanReview/plan-comments-in-chat'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion } from '@/api/question-types'

const REVIEW: PendingQuestion = { id: 'q-1', sessionId: 's-1', toolCallId: 'call-1', kind: 'plan_review', planRevision: 2, questions: [] }
const BLOCK: PlanCommentsBlock = { path: '.agents/plans/x.md', revision: 2, comments: [{ quote: 'Step A', text: 'Split it' }] }

function composer() {
  const ref = createRef<InputComposerHandle>()
  const handle = {
    focus: mock(() => {}),
    setValue: () => {},
    appendValue: mock((..._args: unknown[]) => {}),
    addDesignFeedback: () => {},
    addPlanComments: mock((..._args: unknown[]) => {}),
    insertText: () => {},
    setFiles: () => {},
    addFiles: () => {},
    restoreLastSubmission: () => {},
  }
  ;(ref as { current: InputComposerHandle | null }).current = handle
  return { ref, handle }
}

beforeEach(() => {
  clearPlanReviewDrafts()
  usePlanCommentsInChat.setState({ block: null })
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: REVIEW })
})

afterEach(() => {
  useAgentStore.setState({ pendingQuestion: null })
})

describe('useChatPlanComments', () => {
  it('puts the comments and any old feedback in the composer, closing a phone panel', () => {
    const { ref, handle } = composer()
    const setWorkspacePanel = mock((..._args: unknown[]) => {})
    const { result } = renderHook(() => useChatPlanComments({ isMobile: true, inputRef: ref, setWorkspacePanel }))
    result.current.handleSendPlanComments({ block: BLOCK, text: ' Old note ' })

    expect(handle.addPlanComments.mock.calls).toEqual([[BLOCK]])
    expect(handle.appendValue.mock.calls).toEqual([['Old note', { paragraph: true }]])
    expect(setWorkspacePanel.mock.calls).toEqual([[null]])
    expect(handle.focus).toHaveBeenCalledTimes(1)
  })

  it('only focuses the composer on desktop when there is nothing to move', () => {
    const { ref, handle } = composer()
    const setWorkspacePanel = mock((..._args: unknown[]) => {})
    const { result } = renderHook(() => useChatPlanComments({ isMobile: false, inputRef: ref, setWorkspacePanel }))
    result.current.handleSendPlanComments({ block: null, text: '' })

    expect(handle.addPlanComments).not.toHaveBeenCalled()
    expect(handle.appendValue).not.toHaveBeenCalled()
    expect(setWorkspacePanel).not.toHaveBeenCalled()
    expect(handle.focus).toHaveBeenCalledTimes(1)
  })

  it('returns removed comments to the open review, after the ones there', () => {
    const { ref } = composer()
    writePlanReviewDraft('q-1', { comments: [{ id: 'c1', quote: 'Step B', text: 'Keep' }], overall: '' })
    const { result } = renderHook(() => useChatPlanComments({ isMobile: false, inputRef: ref, setWorkspacePanel: () => {} }))
    result.current.handlePlanCommentsRemoved(BLOCK)

    expect(readPlanReviewDraft('q-1').comments.map(({ quote, text }) => ({ quote, text }))).toEqual([
      { quote: 'Step B', text: 'Keep' },
      { quote: 'Step A', text: 'Split it' },
    ])
  })

  it('drops removed comments once the review is closed', () => {
    const { ref } = composer()
    useAgentStore.setState({ pendingQuestion: null })
    const { result } = renderHook(() => useChatPlanComments({ isMobile: false, inputRef: ref, setWorkspacePanel: () => {} }))
    result.current.handlePlanCommentsRemoved(BLOCK)
    expect(readPlanReviewDraft('q-1').comments).toEqual([])
  })

  it('publishes the composer chip for the Plan tab', () => {
    const { ref } = composer()
    const { result } = renderHook(() => useChatPlanComments({ isMobile: false, inputRef: ref, setWorkspacePanel: () => {} }))
    result.current.handlePlanCommentsChange(BLOCK)
    expect(usePlanCommentsInChat.getState().block).toBe(BLOCK)
    result.current.handlePlanCommentsChange(null)
    expect(usePlanCommentsInChat.getState().block).toBeNull()
  })
})
