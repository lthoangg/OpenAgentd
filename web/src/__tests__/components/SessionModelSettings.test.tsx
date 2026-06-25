import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SessionModelSettings } from '@/components/SessionModelSettings'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionModelSettings
        defaultModel={null}
        sessionModel={null}
        sessionThinkingLevel={null}
        sessionFastMode={false}
        onChange={() => undefined}
      />
    </QueryClientProvider>,
  )
}

describe('SessionModelSettings', () => {
  it('shows cached registry models in the session model picker when available', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5.5-mini', provider: 'openai', model: 'gpt-5.5-mini', vision: false, output_image: false, output_video: false, summary_trigger_tokens: 0 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    fireEvent.focus(input)

    expect(await screen.findByText('openai:gpt-5.5-mini')).toBeTruthy()
  })

  it('shows warmed registry models when the backend populates cache on first load', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', vision: false, output_image: false, output_video: false, summary_trigger_tokens: 0 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    fireEvent.focus(input)

    expect(await screen.findByText('openai:gpt-5')).toBeTruthy()
  })
})
