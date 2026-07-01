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

function renderPanel(overrides: Partial<{
  sessionModel: string | null
  sessionFastMode: boolean
  onChange: (model: string | null, thinkingLevel: string | null, fastMode: boolean) => void
}> = {}) {
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
        sessionModel={overrides.sessionModel ?? null}
        sessionThinkingLevel={null}
        sessionFastMode={overrides.sessionFastMode ?? false}
        onChange={overrides.onChange ?? (() => undefined)}
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
        models: [{ id: 'openai:gpt-5.5-mini', provider: 'openai', model: 'gpt-5.5-mini', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 }],
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
        models: [{ id: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 }],
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

  it('limits thinking choices to the selected model metadata when available', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5.5', provider: 'openai', model: 'gpt-5.5', vision: false, output_image: false, output_video: false, thinking_levels: ['none', 'low', 'medium', 'high'], summary_trigger_tokens: 0 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel({ sessionModel: 'openai:gpt-5.5' })

    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Thinking level' }))

    expect(await screen.findByText('None')).toBeTruthy()
    expect(await screen.findByText('Low')).toBeTruthy()
    expect(await screen.findByText('Medium')).toBeTruthy()
    expect(await screen.findByText('High')).toBeTruthy()
    expect(screen.queryByText('Xhigh')).toBeNull()
    expect(screen.queryByText('Minimal')).toBeNull()
    expect(screen.queryByText('Max')).toBeNull()
  })

  it('shows only fallback levels (none) when model has no thinking_levels', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel({ sessionModel: 'openai:gpt-5' })

    fireEvent.click(await screen.findByRole('button', { name: 'Thinking level' }))

    expect(await screen.findByText('None')).toBeTruthy()
    expect(screen.queryByText('Low')).toBeNull()
    expect(screen.queryByText('Medium')).toBeNull()
    expect(screen.queryByText('High')).toBeNull()
    expect(screen.queryByText('Minimal')).toBeNull()
    expect(screen.queryByText('Extra high')).toBeNull()
    expect(screen.queryByText('Max')).toBeNull()
  })
})

describe('SessionModelSettings — Fast mode', () => {
  it('renders Fast mode as a checkbox (not a raw inline note)', () => {
    renderPanel({ sessionModel: 'codex:gpt-5' })

    const checkbox = screen.getByRole('checkbox', { name: 'Fast mode' })
    expect(checkbox).toBeTruthy()
    expect((checkbox as HTMLInputElement).type).toBe('checkbox')

    // The descriptive note now lives inside the (i) tooltip, so it must not
    // be rendered inline in the row by default — keeps the control compact.
    expect(
      screen.queryByText('Use Fast/Priority mode for messages in this session.'),
    ).toBeNull()
  })

  it('exposes an (i) info trigger for the Fast mode explanation', () => {
    renderPanel({ sessionModel: 'codex:gpt-5' })
    expect(screen.getByLabelText('About Fast mode')).toBeTruthy()
  })

  it('toggling the checkbox enables fast mode on save', async () => {
    // The model must resolve in the registry for Save to be enabled
    // (modelValid gate), so serve a matching codex model.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['codex'],
        models: [{ id: 'codex:gpt-5', provider: 'codex', model: 'gpt-5', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch

    const onChange = mock(() => undefined)
    renderPanel({ sessionModel: 'codex:gpt-5', sessionFastMode: false, onChange })

    const save = await screen.findByRole('button', { name: 'Save' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fast mode' }))
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(save)

    expect(onChange).toHaveBeenCalledWith('codex:gpt-5', null, true)
  })

  it('disables the checkbox when the session model is not supported', () => {
    renderPanel({ sessionModel: 'deepseek:deepseek-v4-pro' })
    const checkbox = screen.getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
  })
})
