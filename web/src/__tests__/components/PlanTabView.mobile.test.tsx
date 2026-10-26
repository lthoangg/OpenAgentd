/**
 * PlanTabView on a phone: the Comment action and the comment composer dock in
 * the review footer (on the soft keyboard), a touch selection survives the tap
 * that collapses it, the footer compacts while the keyboard is up, and a
 * half-written comment survives the tab remounting.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_QUERY: '(max-width: 767px)' }))

import { PlanTabView } from '@/components/WorkspacePanel/PlanTabView'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts } from '@/components/PlanReview/plan-comments'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion, SessionPlan } from '@/api/types'

const PLAN: SessionPlan = {
  content: '# Ship it\n\n1. Write the migration\n2. Wire the endpoint',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 2,
  approved_revision: null,
  path: '/repo/project/.agents/plans/ship-it-0000abcd.md',
  workspace_path: '.agents/plans/ship-it-0000abcd.md',
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

beforeEach(() => {
  answers = []
  clearQuestionDrafts()
  clearPlanReviewDrafts()
  document.documentElement.removeAttribute('data-keyboard-open')
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: REVIEW, resolvedQuestions: {}, markTurnResuming: () => {} })
  globalThis.fetch = mock(async (input: unknown, rawInit?: unknown) => {
    const init = rawInit as RequestInit | undefined
    const url = String(input)
    if (url.includes('/answer')) {
      answers.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ status: 'answered', resumed: true }))
    }
    return new Response(JSON.stringify({ plan: PLAN }))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-keyboard-open')
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PlanTabView plan={PLAN} sessionId="s-1" />
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
    // One text box at a time: the overall feedback box steps aside.
    expect(screen.queryByLabelText('Feedback on the plan')).toBeNull()

    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(screen.getByRole('list', { name: 'Comments on the plan' }).textContent).toContain('Make it reversible.')
    expect(screen.getByLabelText('Feedback on the plan')).toBeTruthy()
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
    expect(screen.queryByText('Or reply in chat to redirect the agent.')).toBeNull()
    const chip = screen.getByRole('button', { name: /1 comment/ })
    fireEvent.click(chip)
    expect(screen.getByRole('list', { name: 'Comments on the plan' })).toBeTruthy()
    // Request changes stays in reach.
    expect(screen.getByRole('button', { name: 'Request changes (1)' })).toBeTruthy()

    await setKeyboardOpen(false)
    expect(screen.getByText('Or reply in chat to redirect the agent.')).toBeTruthy()
  })

  it('sends Request changes with the comments', async () => {
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Request changes (1)' }))

    await waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0]).toEqual({ answers: [['**Comment 1**\n> Write the migration\n\nMake it reversible.']] })
  })
})
