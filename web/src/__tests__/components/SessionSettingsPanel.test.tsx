/**
 * SessionSettingsPanel — keyboard entry point.
 *
 * Opening the panel should put the caret in the model field, because that is
 * what the panel is for. The default focus-trap behaviour (first focusable in
 * DOM order) lands on the header close button instead.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionSettingsPanel } from '@/components/SessionSettingsPanel'
import { getPlatform } from '@/hooks/use-platform'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'

const MOD = getPlatform().os === 'macos' ? { metaKey: true } : { ctrlKey: true }

const server = setupServer()
let originalFetch: typeof fetch | undefined

const AGENT = {
  name: 'code',
  description: 'Lead agent.',
  model: 'openai:gpt-4o',
  tools: [{ name: 'read', description: 'Read a file.' }],
  mcp_servers: ['github'],
  capabilities: {
    input: { vision: true, document_text: true, audio: false, video: false },
    output: { text: true, image: false, audio: false },
  },
}

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'bypass' })
  server.use(
    http.get('http://localhost/api/agent/agents', () =>
      HttpResponse.json({ agents: [AGENT] }),
    ),
    http.get('http://localhost/api/mcp/servers', () =>
      HttpResponse.json({
        servers: [{
          name: 'github',
          transport: 'stdio',
          enabled: true,
          state: 'ready',
          error: null,
          tool_names: ['read'],
          started_at: null,
          config: { transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true },
        }],
      }),
    ),
    http.get('http://localhost/api/agents/registry', () =>
      HttpResponse.json({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: true, output_image: false, output_video: false, thinking_levels: ['none', 'high'], summary_trigger_tokens: 0, fast_mode: false }],
      }),
    ),
  )
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPanel(onClose: () => void = () => undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionSettingsPanel
        open
        workspace="/repo/project"
        sessionModel={null}
        sessionThinkingLevel={null}
        onSessionModelSettingsChange={() => undefined}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

describe('SessionSettingsPanel — keyboard entry', () => {
  it('puts focus in the model field once the panel has content', async () => {
    renderPanel()

    await screen.findByRole('combobox', { name: 'Search session model' })
    // Compare labels, not nodes: a failed node comparison dumps the whole
    // fiber tree and buries the actual reason.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search session model'),
    )
  })

  it('leaves the model field unfocused on touch so the keyboard stays down', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    try {
      renderPanel()
      await screen.findByRole('combobox', { name: 'Search session model' })
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      expect(document.activeElement?.getAttribute('aria-label')).not.toBe('Search session model')
    } finally {
      window.matchMedia = original
    }
  })

  it('does not cover the panel with an open option list on entry', async () => {
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search session model'),
    )

    // Focus alone must not open the list: the MCP rows below stay visible.
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('listitem', { name: /github/i })).toBeTruthy()
  })

  it('auto opens the tool list when panel loads', async () => {
    renderPanel()

    await screen.findByRole('combobox', { name: 'Search session model' })
    const toolsButton = screen.getByRole('button', { name: /^tools/i })
    expect(toolsButton.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('read')).toBeTruthy()
  })

  it('has no "Esc or click outside" footer hint', async () => {
    renderPanel()

    await screen.findByRole('combobox', { name: 'Search session model' })
    expect(screen.queryByText(/Esc or click outside to close/i)).toBeNull()
    expect(screen.queryByText(/to toggle/i)).toBeNull()
  })

  it('closes on its own toggle shortcut, even with focus in the model field', async () => {
    const onClose = mock(() => {})
    renderPanel(onClose)

    await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search session model'),
    )

    const event = new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true, ...MOD })
    act(() => { document.activeElement?.dispatchEvent(event) })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })
})
