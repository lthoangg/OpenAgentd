import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

  it('resets thinking level to default when switching from a model supporting xhigh to one that does not', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai', 'anthropic'],
        models: [
          {
            id: 'anthropic:claude-3-7-sonnet',
            provider: 'anthropic',
            model: 'claude-3-7-sonnet',
            vision: false,
            output_image: false,
            output_video: false,
            thinking_levels: ['none', 'low', 'medium', 'high', 'xhigh'],
            summary_trigger_tokens: 0,
          },
          {
            id: 'openai:gpt-4o',
            provider: 'openai',
            model: 'gpt-4o',
            vision: false,
            output_image: false,
            output_video: false,
            thinking_levels: [],
            summary_trigger_tokens: 0,
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    const onChange = mock(() => undefined)

    render(
      <QueryClientProvider client={queryClient}>
        <SessionModelSettings
          defaultModel={null}
          sessionModel="anthropic:claude-3-7-sonnet"
          sessionThinkingLevel="xhigh"
          sessionFastMode={false}
          onChange={onChange}
        />
      </QueryClientProvider>,
    )

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))

    const thinkingButton = await screen.findByRole('button', { name: 'Thinking level' })
    expect(thinkingButton.textContent).toBe('Xhigh')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'openai:gpt-4o' } })

    const option = await screen.findByText('openai:gpt-4o')
    fireEvent.click(option)

    await waitFor(() => expect(thinkingButton.textContent).toBe('Default'))

    const saveButton = await screen.findByRole('button', { name: 'Save' })
    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(saveButton)

    expect(onChange).toHaveBeenCalledWith('openai:gpt-4o', null, false)
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

// Registry stub with two known models used across the combobox injection tests.
function stubRegistry(models = [
  { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 },
  { id: 'anthropic:claude-3-5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet', vision: true, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0 },
]) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ tools: [], skills: [], providers: ['openai', 'anthropic'], models }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as typeof fetch
}

describe('SessionModelSettings — model combobox injection guard', () => {
  afterEach(cleanup)

  // ── Core regression: partial input must never become a list item ───────────

  it('partial text without a colon does not appear as a dropdown option', async () => {
    const user = userEvent.setup()
    stubRegistry()
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    // Wait for registry to load then type a partial string
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'gpt')

    // The typed string "gpt" must not appear as a selectable option
    // (it appears in the input itself but not in the listbox)
    const listbox = document.querySelector('[role="listbox"]')
    expect(listbox).toBeTruthy()
    const options = Array.from(listbox!.querySelectorAll('[role="option"]'))
    const optionTexts = options.map((o) => o.textContent?.trim() ?? '')
    expect(optionTexts).not.toContain('gpt')
  })

  it('provider-only input (no colon) does not appear as a dropdown option', async () => {
    const user = userEvent.setup()
    stubRegistry()
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'openai')

    const listbox = document.querySelector('[role="listbox"]')
    const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
    expect(options.map((o) => o.textContent?.trim())).not.toContain('openai')
  })

  it('first dropdown item is always a real registry entry, not the typed query', async () => {
    const user = userEvent.setup()
    stubRegistry()
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'openai')

    const listbox = document.querySelector('[role="listbox"]')
    const firstOption = listbox?.querySelector('[role="option"]')
    if (firstOption) {
      // Whatever is shown first must be one of the real registry ids
      const text = firstOption.textContent?.trim() ?? ''
      expect(['openai:gpt-4o', 'anthropic:claude-3-5-sonnet']).toContain(text)
    }
    // If no options shown, that is also acceptable — empty list, not fake item
  })

  it('no-match query shows empty list, not a synthetic item', async () => {
    const user = userEvent.setup()
    stubRegistry()
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'zzznomatch')

    const listbox = document.querySelector('[role="listbox"]')
    expect(listbox).toBeTruthy()
    const options = Array.from(listbox!.querySelectorAll('[role="option"]'))
    // No real options match, so the typed value must not be injected either
    expect(options.map((o) => o.textContent?.trim())).not.toContain('zzznomatch')
  })

  // ── Preserved behaviour: previously-saved model kept in the list ──────────

  it('a previously-saved fully-qualified model not in the registry is kept in options', async () => {
    const user = userEvent.setup()
    stubRegistry() // registry does NOT contain the saved model
    renderPanel({ sessionModel: 'openai:o3-mini' })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    // Just focus — don't clear. The input already shows the saved model value,
    // and focusing opens the dropdown with the full options list (empty query).
    await user.click(input)

    // The saved model entry should appear as a real option in the dropdown
    await waitFor(() => {
      const listbox = document.querySelector('[role="listbox"]')
      const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
      expect(options.map((o) => o.textContent?.trim())).toContain('openai:o3-mini')
    })
  })

  it('a saved model that IS in the registry is not duplicated in the list', async () => {
    const user = userEvent.setup()
    stubRegistry() // openai:gpt-4o is in the registry
    renderPanel({ sessionModel: 'openai:gpt-4o' })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'gpt-4o')

    await waitFor(() => {
      const listbox = document.querySelector('[role="listbox"]')
      const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
      const matching = options.filter((o) => o.textContent?.trim() === 'openai:gpt-4o')
      expect(matching).toHaveLength(1) // exactly once, not duplicated
    })
  })
})
