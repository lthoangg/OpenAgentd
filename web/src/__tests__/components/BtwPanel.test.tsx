import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import type { SideQuestion } from '@/api/types'
import { BtwPanel } from '@/components/BtwPanel'
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

function renderPanel(countEnabled = true, extra: { chipOnly?: boolean; onReopen?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BtwPanel sessionId={S} countEnabled={countEnabled} {...extra} />
    </QueryClientProvider>,
  )
}

const state = () => useBtwStore.getState().sessions[S] ?? EMPTY_BTW
const open = () => act(() => useBtwStore.getState().reopen(S))

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

describe('BtwPanel', () => {
  it('shows a chip with the stored count while closed, and the chip reopens the panel', async () => {
    renderPanel()
    const chip = await screen.findByRole('button', { name: 'Show side questions (2)' })
    // Closed: only the count is read, never the list.
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/count`])
    fireEvent.click(chip)
    expect(state().open).toBe(true)
    expect(await screen.findByText('question b')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show side questions/ })).toBeNull()
  })

  it('renders nothing while closed without side questions or a count', () => {
    items = []
    const { container } = renderPanel(false)
    expect(container.innerHTML).toBe('')
    expect(calls).toHaveLength(0)
  })

  it('chip-only (the dock shows them): never opens the panel, and the chip calls onReopen', async () => {
    const onReopen = mock(() => {})
    // ``ask`` marks the panel open; with the dock in charge it must not show.
    act(() => useBtwStore.getState().reopen(S))
    renderPanel(true, { chipOnly: true, onReopen })
    const chip = await screen.findByRole('button', { name: 'Show side questions (2)' })
    expect(screen.queryByRole('region', { name: 'Side question' })).toBeNull()
    fireEvent.click(chip)
    expect(onReopen).toHaveBeenCalledTimes(1)
  })

  it('opens on the newest exchange and steps back through earlier ones', async () => {
    renderPanel(false)
    open()
    expect(await screen.findByText('second answer')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Later side question' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Earlier side question' }))
    expect(screen.getByText('question a')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(state().view).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Later side question' }))
    expect(screen.getByText('question b')).toBeTruthy()
    // Back on the newest: follow new answers again.
    expect(state().view).toBeNull()
  })

  it('shows Thinking until the first text, and Stop stops the live answer', async () => {
    items = []
    useBtwStore.setState({
      sessions: { [S]: { ...EMPTY_BTW, open: true, live: { id: 'q1', question: 'live one', text: '', status: 'streaming', error: null } } },
    })
    renderPanel(false)
    expect(screen.getByText('live one')).toBeTruthy()
    expect(screen.getByText('Thinking…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/q1/stop`)).toBe(true))
  })

  it('shows an error and a stopped answer', async () => {
    items = [{ ...row('a', 'Par', 'stopped') }, { ...row('b', '', 'error'), error: 'rate limited' }]
    renderPanel(false)
    open()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'rate limited')
    fireEvent.click(screen.getByRole('button', { name: 'Earlier side question' }))
    expect(screen.getByText('Stopped.')).toBeTruthy()
  })

  it('Escape and Close hide the panel without deleting anything', async () => {
    renderPanel(false)
    open()
    const panel = await screen.findByRole('region', { name: 'Side question' })
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(state().open).toBe(false)

    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Close side question' }))
    expect(state().open).toBe(false)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('Clear deletes only on the confirming second press', async () => {
    renderPanel(false)
    open()
    await screen.findByText('second answer')
    fireEvent.click(screen.getByRole('button', { name: 'Clear side questions' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: delete all side questions' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === BASE)).toBe(true))
    expect(await screen.findByText(/No side questions yet/)).toBeTruthy()
  })

  it('Copy writes the raw answer to the clipboard', async () => {
    const writeText = mock(async (..._args: unknown[]) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    items = [row('a', '**bold** answer')]
    renderPanel(false)
    open()
    await screen.findByText('question a')
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    expect(writeText).toHaveBeenCalledWith('**bold** answer')
  })
})
