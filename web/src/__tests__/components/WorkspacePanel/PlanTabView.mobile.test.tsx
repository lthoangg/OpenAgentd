/**
 * PlanTabView on a phone: the Comment action and the comment composer dock in
 * the review footer (on the soft keyboard), a touch selection survives the tap
 * that collapses it, the footer compacts while the keyboard is up, a
 * half-written comment survives the tab remounting, and Reply in chat hands
 * the comments to the chat composer.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_QUERY: '(max-width: 767px)' }))

import { PlanTabView, UNSENT_COMMENTS_HINT } from '@/components/WorkspacePanel/PlanTabView'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts } from '@/components/PlanReview/plan-comments'
import { usePlanCommentsInChat } from '@/components/PlanReview/plan-comments-in-chat'
import { resetPlanDecisionChoice } from '@/components/PlanReview/usePlanDecision'
import { useAgentStore } from '@/stores/useAgentStore'
import type { SessionPlan } from '@/api/types'
import type { PendingQuestion } from '@/api/question-types'
import { questionCardOf } from '@/stores/useAgentStore/question-state'

const PLAN: SessionPlan = {
  content: '# Ship it\n\n1. Write the migration\n2. Wire the endpoint',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 2,
  approved_revision: null,
  path: '/repo/project/.agents/plans/ship-it-0000abcd.md',
  workspace_path: '.agents/plans/ship-it-0000abcd.md',
  done_when: 'The endpoint answers and its tests pass.',
}

const REVIEW: PendingQuestion = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  kind: 'plan_review',
  planRevision: 2,
  questions: [
    {
      question: 'Review plan revision 2.',
      header: 'Plan review',
      multiple: false,
      options: [
        { label: 'Approve', description: null, recommended: false },
        { label: 'Request changes', description: null, recommended: false },
      ],
    },
  ],
}

let answers: unknown[] = []
const sendPlanComments = mock((..._args: unknown[]) => {})

beforeEach(() => {
  answers = []
  sendPlanComments.mockClear()
  usePlanCommentsInChat.setState({ block: null })
  clearQuestionDrafts()
  clearPlanReviewDrafts()
  resetPlanDecisionChoice()
  document.documentElement.removeAttribute('data-keyboard-open')
  useAgentStore.setState({ sessionId: 's-1', questionCard: questionCardOf(REVIEW), resolvedQuestions: {}, markTurnResuming: () => {} })
  globalThis.fetch = mock(async (input: unknown, rawInit?: unknown) => {
    const init = rawInit as RequestInit | undefined
    const url = String(input)
    if (url.includes('/answer')) {
      answers.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ status: 'answered', resumed: true }))
    }
    if (url.includes('/settings/goals')) {
      return new Response(JSON.stringify({ max_turns: 50, default_max_turns: 50, allow_questions: true, keep_going_default: false }))
    }
    if (url.includes('/goal')) return new Response(JSON.stringify({ goal: null }))
    return new Response(JSON.stringify({ plan: PLAN }))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-keyboard-open')
  useAgentStore.setState({ questionCard: questionCardOf(null), resolvedQuestions: {} })
})

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PlanTabView plan={PLAN} sessionId="s-1" onSendPlanComments={sendPlanComments} />
    </QueryClientProvider>,
  )
}

function planItem(container: HTMLElement, text: string): HTMLElement {
  return Array.from(container.querySelectorAll('li')).find((li) => li.textContent === text)!
}

function selectText(node: Node) {
  act(() => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

function collapseSelection() {
  act(() => {
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
}

async function setKeyboardOpen(open: boolean) {
  // The attribute is observed with a MutationObserver: its callback is async.
  await act(async () => {
    if (open) document.documentElement.setAttribute('data-keyboard-open', '')
    else document.documentElement.removeAttribute('data-keyboard-open')
  })
}

describe('PlanTabView on a phone', () => {
  it('folds the toolbar actions into one More menu, so none is pushed off a narrow screen', () => {
    renderTab()
    expect(screen.queryByRole('button', { name: 'Copy plan' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More plan actions' }))
    expect(screen.getByRole('menuitem', { name: 'Copy plan' })).toBeTruthy()
  })

  it('offers Comment in the footer, not floating over the selection', () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))

    const action = screen.getByRole('button', { name: 'Comment on selection' })
    // The footer swaps its row for the Comment action; no floating overlay.
    expect(action.closest('[data-plan-overlay]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('still comments when the tap collapses the selection first', () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    const action = screen.getByRole('button', { name: 'Comment on selection' })

    fireEvent.pointerDown(action)
    collapseSelection()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))

    const composer = screen.getByRole('group', { name: 'New comment' })
    expect(composer.textContent).toContain('Write the migration')
  })

  it('docks the composer in the footer and focuses it from the tap', () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))

    const composer = screen.getByRole('group', { name: 'New comment' })
    expect(composer.closest('.oa-prose')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('Comment'))
    // The comment box takes the footer's place.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(screen.getByRole('list', { name: 'Comments on the plan' }).textContent).toContain('Make it reversible.')
    expect(screen.getByRole('button', { name: 'Reply in chat (1)' })).toBeTruthy()
  })

  it('keeps the comment box focused when the page selection is cleared (WebKit)', () => {
    // WebKit keeps a focused text box's caret in the page selection, so
    // clearing the selection after focusing it drops focus (and the keyboard).
    const original = Selection.prototype.removeAllRanges
    Selection.prototype.removeAllRanges = function (this: Selection) {
      original.call(this)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    try {
      const { container } = renderTab()
      selectText(planItem(container, 'Write the migration'))
      fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))

      expect(document.activeElement).toBe(screen.getByLabelText('Comment'))
    } finally {
      Selection.prototype.removeAllRanges = original
    }
  })

  it('keeps a half-written comment when the tab remounts', () => {
    const first = renderTab()
    selectText(planItem(first.container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Half a thought' } })
    first.unmount()

    renderTab()
    expect((screen.getByLabelText('Comment') as HTMLTextAreaElement).value).toBe('Half a thought')
    expect(screen.getByRole('group', { name: 'New comment' }).textContent).toContain('Write the migration')
  })

  it('folds saved comments into a chip and hides the hint while the keyboard is up', async () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    await setKeyboardOpen(true)
    expect(screen.queryByRole('list', { name: 'Comments on the plan' })).toBeNull()
    expect(screen.queryByText(UNSENT_COMMENTS_HINT)).toBeNull()
    const chip = screen.getByRole('button', { name: /1 comment/ })
    fireEvent.click(chip)
    expect(screen.getByRole('list', { name: 'Comments on the plan' })).toBeTruthy()
    // Reply in chat stays in reach.
    expect(screen.getByRole('button', { name: 'Reply in chat (1)' })).toBeTruthy()

    await setKeyboardOpen(false)
    expect(screen.getByText(UNSENT_COMMENTS_HINT)).toBeTruthy()
  })

  it('hands the comments to the chat box with Reply in chat, answering nothing', () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reply in chat (1)' }))

    expect(sendPlanComments.mock.calls[0]?.[0]).toEqual({
      block: { path: '.agents/plans/ship-it-0000abcd.md', revision: 2, comments: [{ quote: 'Write the migration', text: 'Make it reversible.' }] },
      text: '',
    })
    expect(answers).toHaveLength(0)
  })

  it('keeps the turns field mounted and focused when the keyboard opens for it', async () => {
    renderTab()
    const toggle = screen.getByRole('button', { name: 'Keep going until done' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    const turns = screen.getByLabelText('Turns for this goal') as HTMLInputElement
    turns.focus()
    await setKeyboardOpen(true)

    expect(screen.getByLabelText('Turns for this goal')).toBe(turns)
    expect(document.activeElement).toBe(turns)

    // Leaving the field folds the row away again while the keyboard is up.
    act(() => { turns.blur() })
    await waitFor(() => expect(screen.queryByLabelText('Turns for this goal')).toBeNull())
  })

  it('rests as one row of actions: no text box, Reply in chat ready', () => {
    renderTab()
    expect(screen.queryByRole('textbox')).toBeNull()
    const deck = screen.getByRole('button', { name: 'Approve' }).closest('[data-review-deck]') as HTMLElement
    expect(deck.contains(screen.getByRole('button', { name: 'Reply in chat' }))).toBe(true)
    // With no comments it only takes the user to the chat box.
    expect((screen.getByRole('button', { name: 'Reply in chat' }) as HTMLButtonElement).disabled).toBe(false)
    // The phone deck carries a toggle, not the worded checkbox that pushed Approve off screen.
    expect(screen.queryByRole('checkbox', { name: 'Keep going until done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Keep going until done' })).toBeTruthy()
  })

  it('approves in one tap', async () => {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(answers).toHaveLength(1))
  })

  it('keeps Approve short while Keep going is on; its name still says so', async () => {
    renderTab()
    const toggle = screen.getByRole('button', { name: 'Keep going until done' }) as HTMLButtonElement
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const approve = screen.getByRole('button', { name: /^Approve and keep going/ })
    expect(approve.textContent).toBe('Approve')
  })
})
