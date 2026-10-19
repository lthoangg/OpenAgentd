/**
 * SideQuestionsTabView — `/btw` side questions as a review-dock tab: every
 * exchange of the session in one list, newest last, with Copy and Stop per
 * answer and a two-press Clear for the whole thread.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import type { SideQuestion } from '@/api/types'
import { SideQuestionsTabView } from '@/components/WorkspacePanel/SideQuestionsTabView'
import { EMPTY_BTW, useBtwStore } from '@/stores/useBtwStore'

const S = 's1'
const BASE = '/api/agent/sessions/s1/btw'
const originalFetch = globalThis.fetch
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

type Call = { url: string; method: string }

const row = (id: string, answer: string, status: SideQuestion['status'] = 'done'): SideQuestion => ({
  id, session_id: S, question: `question ${id}`, answer, status, error: null, model: null, usage: null, created_at: '', updated_at: '',
})

let items: SideQuestion[] = []
let calls: Call[] = []

function installFetch() {
  calls = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const [input, init] = args as [unknown, RequestInit | undefined]
    const call = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    if (call.method === 'DELETE' || call.url.endsWith('/stop')) {
      if (call.method === 'DELETE') items = []
      return new Response(null, { status: 204 })
    }
    if (call.url.endsWith('/count')) return Response.json({ total: items.length })
    return Response.json({ items, total: items.length })
  }) as unknown as typeof fetch
}

function renderTab(active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SideQuestionsTabView sessionId={S} active={active} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setApiBaseUrl('')
  useBtwStore.setState({ sessions: {} })
  items = [row('a', 'first answer'), row('b', 'second answer')]
  installFetch()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
})

describe('SideQuestionsTabView', () => {
  it('lists every side question of the session, oldest first', async () => {
    renderTab()
    expect(await screen.findByText('second answer')).toBeTruthy()
    const questions = screen.getAllByText(/^question /).map((el) => el.textContent)
    expect(questions).toEqual(['question a', 'question b'])
    expect(screen.getByText('first answer')).toBeTruthy()
  })

  it('loads the list without the panel above the composer being open', async () => {
    renderTab()
    await screen.findByText('first answer')
    expect(useBtwStore.getState().sessions[S]?.open ?? false).toBe(false)
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith(`${BASE}?`))).toBe(true)
  })

  it('does not fetch while the dock is closed', () => {
    renderTab(false)
    expect(calls).toHaveLength(0)
  })

  it('explains /btw when the session has none', async () => {
    items = []
    renderTab()
    expect(await screen.findByText('No side questions yet')).toBeTruthy()
  })

  it('shows Thinking for the live answer, and its Stop stops it', async () => {
    items = []
    useBtwStore.setState({
      sessions: { [S]: { ...EMPTY_BTW, live: { id: 'q1', question: 'live one', text: '', status: 'streaming', error: null } } },
    })
    renderTab()
    expect(screen.getByText('live one')).toBeTruthy()
    expect(screen.getByText('Thinking…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/q1/stop`)).toBe(true))
  })

  it('Copy writes that exchange’s raw answer', async () => {
    const writeText = mock(async (..._args: unknown[]) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    items = [row('a', '**bold** answer'), row('b', 'plain answer')]
    renderTab()
    await screen.findByText('question a')
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy answer' })[0])
    expect(writeText).toHaveBeenCalledWith('**bold** answer')
  })

  it('Clear deletes only on the confirming second press', async () => {
    renderTab()
    await screen.findByText('second answer')
    fireEvent.click(screen.getByRole('button', { name: 'Clear side questions' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: delete all side questions' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === BASE)).toBe(true))
    expect(await screen.findByText('No side questions yet')).toBeTruthy()
  })
})
