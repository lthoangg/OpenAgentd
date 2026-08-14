/**
 * SessionSettingsPanel — keyboard entry point.
 *
 * Opening the panel should put the caret in the model field, because that is
 * what the panel is for. The default focus-trap behaviour (first focusable in
 * DOM order) lands on the header close button instead.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionSettingsPanel } from '@/components/SessionSettingsPanel'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const AGENT = {
  name: 'lead',
  description: 'Lead agent.',
  model: 'openai:gpt-4o',
  tools: [{ name: 'read', description: 'Read a file.' }],
  mcp_servers: ['github'],
  is_lead: true,
  capabilities: {
    input: { vision: true, document_text: true, audio: false, video: false },
    output: { text: true, image: false, audio: false },
  },
}

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  server.use(
    http.get('http://localhost/api/team/agents', () =>
      HttpResponse.json({ agents: [AGENT], blueprints: [] }),
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
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionSettingsPanel
        open
        workspace={null}
        sessionModel={null}
        sessionThinkingLevel={null}
        onSessionModelSettingsChange={() => undefined}
        onClose={() => undefined}
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
})
