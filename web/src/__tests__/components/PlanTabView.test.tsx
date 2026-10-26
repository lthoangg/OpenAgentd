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

import { PlanTabView } from '@/components/WorkspacePanel/PlanTabView'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts } from '@/components/PlanReview/plan-comments'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import type { ContentBlock, PendingQuestion, SessionPlan } from '@/api/types'

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
let goalSettings: Record<string, unknown> = {}
const markTurnResuming = mock(() => {})

beforeEach(() => {
  calls = []
  putStatus = 200
  goalSettings = { max_turns: 50, default_max_turns: 50, token_budget: null, allow_questions: true, keep_going_default: false }
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
    if (url.includes('/settings/goals')) return new Response(JSON.stringify(goalSettings))
    if (url.includes('/goal')) return new Response(JSON.stringify({ goal: null }))
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
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {}, leadName: null, agentStreams: {} })
})

/** Put the lead's ``plan`` call in the current turn, as the stream builds it. */
function setPlanCall(args: string, extra: Partial<ContentBlock> = {}) {
  const block: ContentBlock = { id: 'call-plan', type: 'tool', content: '', toolName: 'plan', toolCallId: 'call-plan', toolArgs: args, toolDone: false, ...extra }
  act(() => {
    useAgentStore.setState({
      leadName: 'lead',
      agentStreams: { lead: { currentBlocks: [block] } } as never,
    })
  })
}

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

  it('keeps a reading column that a maximized dock widens without going full width', () => {
    const { container } = renderTab()
    const body = container.querySelector('.mx-auto')!
    expect(body.className).toContain('max-w-3xl')
    // index.css: under [data-dock-maximized], prose keeps 88ch and wide blocks get a capped band.
    expect(body.className).toContain('oa-reading')
    expect(body.className).not.toContain('max-w-none')
  })

  it('renders tables and code as direct children of the prose, where the wide band applies', () => {
    const content = '# Wide\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n'
    const { container } = renderTab({ plan: { ...PLAN, content } })
    // index.css selects `.oa-reading .oa-prose > :is([data-slot=code-block], .oa-table-container)`.
    expect(container.querySelector('.oa-reading .oa-prose > .oa-table-container')).not.toBeNull()
    expect(container.querySelector('.oa-reading .oa-prose > [data-slot="code-block"]')).not.toBeNull()
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

  it('reads Done once every task on the board is finished', () => {
    renderTab({
      plan: { ...PLAN, approved_revision: 2 },
      todos: [
        { task_id: 't1', content: 'Write the migration', status: 'completed' },
        { task_id: 't2', content: 'Wire the endpoint', status: 'cancelled' },
      ],
    })
    expect(screen.getByText('Done')).toBeTruthy()
  })
})

describe('PlanTabView — Keep going until done', () => {
  const WITH_DONE_WHEN: SessionPlan = { ...PLAN, done_when: 'The endpoint answers and its tests pass.' }

  function keepGoingBox() {
    return screen.getByRole('checkbox', { name: 'Keep going until done' }) as HTMLInputElement
  }

  it('is disabled with a hint when the plan has no Done when', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab()
    expect(keepGoingBox().hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-keep-going]')?.getAttribute('title')).toBe('Add a Done when to the plan to keep going')
  })

  it('starts ticked when Settings say so, with the default turns, and approves with them', async () => {
    goalSettings = { ...goalSettings, keep_going_default: true, max_turns: 30 }
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab({ plan: WITH_DONE_WHEN })
    await waitFor(() => expect(keepGoingBox().checked).toBe(true))
    expect((screen.getByLabelText('Turns for this goal') as HTMLInputElement).value).toBe('30')

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Approve']], keep_going: {} })
  })

  it('starts unticked by default, and plain Approve starts no goal', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab({ plan: WITH_DONE_WHEN })
    await waitFor(() => expect(calls.some((call) => call.url.includes('/settings/goals'))).toBe(true))
    expect(keepGoingBox().checked).toBe(false)
    expect(screen.queryByLabelText('Turns for this goal')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Approve']] })
  })

  it('sends turns changed right before Approve', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab({ plan: WITH_DONE_WHEN })
    fireEvent.click(keepGoingBox())
    fireEvent.change(screen.getByLabelText('Turns for this goal'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]?.body).toEqual({ answers: [['Approve']], keep_going: { max_turns: 20 } })
  })

  it('blocks Approve on turns out of range', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    renderTab({ plan: WITH_DONE_WHEN })
    fireEvent.click(keepGoingBox())
    fireEvent.change(screen.getByLabelText('Turns for this goal'), { target: { value: '0' } })
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

const VISUAL_PLAN: SessionPlan = {
  ...PLAN,
  content: [
    '# Ship it',
    '',
    'See the [mockup](.agents/plans/ship-it-0000abcd/mockup.html), the [notes](docs/notes.md),',
    'the [absolute mockup](/repo/project/.agents/plans/ship-it-0000abcd/b.html) and [the site](https://example.com).',
    '',
    '![Request flow](.agents/plans/ship-it-0000abcd/flow.svg)',
    '',
    '```md',
    '## Appendix (inside a fence, not the real one)',
    '```',
    '',
    '## Appendix',
    '',
    '### A. Files',
    '',
    '- Touch the migration file',
    '',
    '### B. Tests',
    '',
    '- Add a reversal test',
  ].join('\n'),
}

describe('PlanTabView — links, images and the Appendix', () => {
  beforeEach(() => localStorage.clear())

  it('opens HTML attachments in Preview and other workspace files as file tabs', () => {
    const onOpenFile = mock((..._args: unknown[]) => {})
    const onOpenPreview = mock((..._args: unknown[]) => {})
    renderTab({ plan: VISUAL_PLAN, onOpenFile, onOpenPreview, workspace: '/repo/project' })

    fireEvent.click(screen.getByRole('link', { name: 'mockup' }))
    fireEvent.click(screen.getByRole('link', { name: 'absolute mockup' }))
    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    expect(onOpenPreview.mock.calls.map(([path]) => path)).toEqual(['.agents/plans/ship-it-0000abcd/mockup.html', '.agents/plans/ship-it-0000abcd/b.html'])
    expect(onOpenFile.mock.calls.map(([path]) => path)).toEqual(['docs/notes.md'])
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('target')).toBe('_blank')
  })

  it('opens an HTML attachment as a file when previews are unavailable', () => {
    const onOpenFile = mock((..._args: unknown[]) => {})
    renderTab({ plan: VISUAL_PLAN, onOpenFile, workspace: '/repo/project' })
    fireEvent.click(screen.getByRole('link', { name: 'mockup' }))
    expect(onOpenFile.mock.calls.map(([path]) => path)).toEqual(['.agents/plans/ship-it-0000abcd/mockup.html'])
  })

  it('shows an SVG diagram inline through the media route', () => {
    renderTab({ plan: VISUAL_PLAN })
    const img = screen.getByRole('img', { name: 'Request flow' }) as HTMLImageElement
    expect(img.getAttribute('src')).toContain('/agent/s-1/media/.agents/plans/ship-it-0000abcd/flow.svg')
  })

  it('collapses the Appendix under the body and remembers when it is opened', () => {
    const { unmount } = renderTab({ plan: VISUAL_PLAN })
    const toggle = screen.getByRole('button', { name: /^Appendix/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('2 sections')
    const section = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(section.hidden).toBe(true)
    expect(section.textContent).toContain('Touch the migration file')
    // The fenced heading stays in the body as code.
    expect(section.textContent).not.toContain('inside a fence')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(section.hidden).toBe(false)

    unmount()
    renderTab({ plan: VISUAL_PLAN })
    expect(screen.getByRole('button', { name: /^Appendix/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('takes comments on Appendix text and opens the Appendix to show one', async () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = renderTab({ plan: VISUAL_PLAN })
    const toggle = screen.getByRole('button', { name: /^Appendix/ })
    fireEvent.click(toggle)
    comment(container, 'Add a reversal test', 'Cover the down migration.')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByTitle('Show in the plan'))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Request changes (1)' }))
    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(JSON.stringify(answerCalls()[0].body)).toContain('Add a reversal test')
  })
})

describe('PlanTabView — a plan call in progress', () => {
  it('keeps showing the saved plan until the call finishes and the plan refetches', () => {
    setPlanCall('{"action":"write","content":"# Rewrite\\n\\n1. Start ov')
    renderTab({ onClearPlan: () => {} })

    expect(screen.getByText('Write the migration')).toBeTruthy()
    expect(screen.queryByText('Start ov')).toBeNull()
    expect(screen.queryByText('Writing…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit plan' })).toBeTruthy()
  })

  it('stays empty while the first plan is written', () => {
    setPlanCall('{"action":"write","content":"# First\\n\\n1. Look aro')
    renderTab({ plan: null })
    expect(screen.getByText('No plan yet')).toBeTruthy()
  })
})
