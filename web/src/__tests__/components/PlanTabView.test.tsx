/**
 * PlanTabView — the session plan tab in the review dock.
 *
 * The footer exists only while a plan review is open; its two buttons answer
 * the review question. Comments stay anchored to the passage they are about
 * and go out together with Request changes. Edits go through the PUT route
 * with the revision the editor opened, so a plan that moved on underneath is a
 * conflict, not an overwrite.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { PlanTabView, planStatus } from '@/components/WorkspacePanel/PlanTabView'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts } from '@/components/PlanReview/plan-comments'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
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

interface FetchCall {
  url: string
  method: string
  body: unknown
}

let calls: FetchCall[] = []
let putStatus = 200
const markTurnResuming = mock(() => {})

beforeEach(() => {
  calls = []
  putStatus = 200
  markTurnResuming.mockClear()
  clearQuestionDrafts()
  clearPlanReviewDrafts()
  useToastStore.setState({ toasts: [] })
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: {}, markTurnResuming })
  globalThis.fetch = mock(async (input: unknown, rawInit?: unknown) => {
    const init = rawInit as RequestInit | undefined
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.includes('/answer')) return new Response(JSON.stringify({ status: 'answered', resumed: true }))
    if (method === 'PUT' && url.includes('/plan')) {
      if (putStatus !== 200) {
        return new Response(JSON.stringify({ detail: 'The plan changed since you opened it.' }), { status: putStatus })
      }
      const body = JSON.parse(String(init?.body)) as { content: string }
      return new Response(JSON.stringify({ plan: { ...PLAN, content: body.content, revision: 3 } }))
    }
    return new Response(JSON.stringify({ plan: PLAN }))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

function renderTab(props: Partial<React.ComponentProps<typeof PlanTabView>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PlanTabView plan={PLAN} sessionId="s-1" {...props} />
    </QueryClientProvider>,
  )
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

function planItem(container: HTMLElement, text: string): HTMLElement {
  return Array.from(container.querySelectorAll('li')).find((li) => li.textContent === text)!
}

/** Select a plan passage, open the composer and add a comment on it. */
function comment(container: HTMLElement, passage: string, text: string) {
  selectText(planItem(container, passage))
  fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
  fireEvent.change(screen.getByLabelText('Comment'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
}

function answerCalls() {
  return calls.filter((call) => call.url.includes('/question/q-1/answer'))
}

describe('planStatus', () => {
  it('reads approved, changed since approval, and draft from the revisions', () => {
    expect(planStatus({ ...PLAN, approved_revision: 2 }, false)).toBe('approved')
    expect(planStatus({ ...PLAN, approved_revision: 1 }, false)).toBe('changed')
    expect(planStatus(PLAN, false)).toBe('draft')
    expect(planStatus({ ...PLAN, approved_revision: 2 }, true)).toBe('review')
  })
})

describe('PlanTabView', () => {
  it('explains where the plan comes from when there is none', () => {
    renderTab({ plan: null })
    expect(screen.getByText('No plan yet')).toBeTruthy()
    expect(screen.getByText(/In Plan mode the agent writes its plan here/)).toBeTruthy()
  })

  it('renders the plan with its status and revision, and no review footer outside a review', () => {
    renderTab()
    expect(screen.getByText('Write the migration')).toBeTruthy()
    expect(screen.getByText('Draft')).toBeTruthy()
    expect(screen.getByText('rev 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByLabelText('Feedback on the plan')).toBeNull()
  })

  it('shows the review footer while a plan review is open', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    expect(screen.getByText('Awaiting review')).toBeTruthy()
    expect(screen.getByLabelText('Feedback on the plan')).toBeTruthy()
    expect(screen.getByText('Or reply in chat to redirect the agent.')).toBeTruthy()
  })

  it('ignores an ask_user question: only plan reviews get the footer', () => {
    useAgentStore.setState({ pendingQuestion: { ...REVIEW, kind: undefined } })
    renderTab()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('answers Approve and marks the turn as resuming', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Approve']] })
    await waitFor(() => expect(markTurnResuming).toHaveBeenCalledTimes(1))
    expect(useAgentStore.getState().pendingQuestion).toBeNull()
  })

  it('sends the feedback with Request changes', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    fireEvent.change(screen.getByLabelText('Feedback on the plan'), { target: { value: '  Split step 2.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Split step 2.']] })
  })

  it('sends Request changes without feedback as the bare option', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Request changes']] })
  })

  it('disables Approve while there is feedback', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    fireEvent.change(screen.getByLabelText('Feedback on the plan'), { target: { value: 'Needs tests' } })
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables Approve while the plan has unsaved edits', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Plan Markdown'), { target: { value: `${PLAN.content}\n3. Test it` } })

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Save or cancel your edits first')).toBeTruthy()
  })

  it('comments on a selected passage and lists the comment under it', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))

    const composer = screen.getByRole('group', { name: 'New comment' })
    expect(composer.textContent).toContain('Write the migration')
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Make it reversible.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    expect(screen.queryByRole('group', { name: 'New comment' })).toBeNull()
    const list = screen.getByRole('list', { name: 'Comments on the plan' })
    expect(list.textContent).toContain('Write the migration')
    expect(list.textContent).toContain('Make it reversible.')
    // The feedback box stays free for anything else.
    expect((screen.getByLabelText('Feedback on the plan') as HTMLTextAreaElement).value).toBe('')
  })

  it('sends every comment and the overall feedback together with Request changes', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab()
    comment(container, 'Write the migration', 'Make it reversible.')
    comment(container, 'Wire the endpoint', 'Add a test.')
    fireEvent.change(screen.getByLabelText('Feedback on the plan'), { target: { value: 'Otherwise fine.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes (2)' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({
      answers: [[
        '**Comment 1**\n> Write the migration\n\nMake it reversible.\n\n' +
          '**Comment 2**\n> Wire the endpoint\n\nAdd a test.\n\n' +
          '**Overall**\nOtherwise fine.',
      ]],
    })
  })

  it('removes a comment', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab()
    comment(container, 'Write the migration', 'Make it reversible.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment 1' }))

    expect(screen.queryByRole('list', { name: 'Comments on the plan' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables Approve while there are comments, or one is still being written', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Half a thought' } })
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Add or cancel your comment first')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Your comments go with Request changes')).toBeTruthy()
  })

  it('cancels a comment with Escape', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab()
    selectText(planItem(container, 'Write the migration'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }))
    fireEvent.keyDown(screen.getByLabelText('Comment'), { key: 'Escape' })

    expect(screen.queryByRole('group', { name: 'New comment' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Comments on the plan' })).toBeNull()
  })

  it('keeps the comments when the tab remounts during the review', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const first = renderTab()
    comment(first.container, 'Write the migration', 'Make it reversible.')
    first.unmount()

    renderTab()
    expect(screen.getByRole('list', { name: 'Comments on the plan' }).textContent).toContain('Make it reversible.')
  })

  it('offers no Comment outside a review', () => {
    const { container } = renderTab()
    selectText(container.querySelector('li')!)
    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull()
  })

  it('saves an edit with the revision the editor opened', async () => {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Plan Markdown'), { target: { value: '# Ship it\n\n1. Only this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
    const put = calls.find((call) => call.method === 'PUT')!
    expect(put.url).toContain('/agent/sessions/s-1/plan')
    expect(put.body).toEqual({ content: '# Ship it\n\n1. Only this', base_revision: 2 })
    await waitFor(() => expect(screen.queryByLabelText('Plan Markdown')).toBeNull())
  })

  it('keeps the draft and warns when the plan changed underneath the editor', async () => {
    putStatus = 409
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Plan Markdown'), { target: { value: 'My edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(useToastStore.getState().toasts[0]?.title).toBe('The plan changed while you were editing')
    expect((screen.getByLabelText('Plan Markdown') as HTMLTextAreaElement).value).toBe('My edit')
  })

  it('offers Open file only for a plan in the workspace', () => {
    const onOpenFile = mock(() => {})
    const view = renderTab({ onOpenFile })
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(onOpenFile).toHaveBeenCalledWith('.agents/plans/ship-it-0000abcd.md')
    view.unmount()

    renderTab({ onOpenFile, plan: { ...PLAN, workspace_path: null, path: '/data/sessions/s-1/plan.md' } })
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull()
  })

  it('disables Clear while the plan is awaiting review', () => {
    const onClearPlan = mock(() => {})
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab({ onClearPlan })
    expect((screen.getByRole('button', { name: 'Clear plan' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
