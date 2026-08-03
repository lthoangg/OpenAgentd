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
  defaultModel: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  onChange: (model: string | null, thinkingLevel: string | null) => void
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
        defaultModel={overrides.defaultModel ?? null}
        sessionModel={overrides.sessionModel ?? null}
        sessionThinkingLevel={overrides.sessionThinkingLevel ?? null}
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
        models: [{ id: 'openai:gpt-5.5-mini', provider: 'openai', model: 'gpt-5.5-mini', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    // Focus alone no longer opens the list (the panel focuses this field on
    // entry and must not cover itself); a click or ArrowDown does.
    fireEvent.click(input)

    expect(await screen.findByText('openai:gpt-5.5-mini')).toBeTruthy()
  })

  it('shows warmed registry models when the backend populates cache on first load', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch

    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    fireEvent.click(input)

    expect(await screen.findByText('openai:gpt-5')).toBeTruthy()
  })

  it('limits thinking choices to the selected model metadata when available', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        tools: [],
        skills: [],
        providers: ['openai'],
        models: [{ id: 'openai:gpt-5.5', provider: 'openai', model: 'gpt-5.5', vision: false, output_image: false, output_video: false, thinking_levels: ['none', 'low', 'medium', 'high'], summary_trigger_tokens: 0, fast_mode: false }],
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
        models: [{ id: 'openai:gpt-5', provider: 'openai', model: 'gpt-5', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false }],
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
            summary_trigger_tokens: 0, fast_mode: false,
          },
          {
            id: 'openai:gpt-4o',
            provider: 'openai',
            model: 'gpt-4o',
            vision: false,
            output_image: false,
            output_video: false,
            thinking_levels: [],
            summary_trigger_tokens: 0, fast_mode: false,
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

    // The dropdown label follows the committed session prop, which this test
    // holds fixed, so assert on what the component reports upstream: the model
    // and the cleared level arrive in a single commit, so the session never
    // holds a level the new model can't serve.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('openai:gpt-4o', null))
  })
})

describe('SessionModelSettings — instant apply', () => {
  afterEach(cleanup)

  const REGISTRY = {
    tools: [],
    skills: [],
    providers: ['openai'],
    models: [
      { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: true, output_image: false, output_video: false, thinking_levels: ['none', 'low', 'high'], summary_trigger_tokens: 0, fast_mode: false },
      { id: 'openai:o3-mini', provider: 'openai', model: 'o3-mini', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false },
    ],
  }

  function stub() {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(REGISTRY), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch
  }

  it('has no apply or cancel controls', async () => {
    stub()
    renderPanel({ sessionModel: 'openai:gpt-4o' })

    await screen.findByRole('combobox', { name: 'Search session model' })
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('does not commit a half-typed model id', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => undefined)
    stub()
    renderPanel({ onChange })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.type(input, 'openai:gpt-4')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/choose a model from the list/i)).toBeTruthy()
  })

  it('commits a thinking level the moment it is picked', async () => {
    const onChange = mock(() => undefined)
    stub()
    renderPanel({ sessionModel: 'openai:gpt-4o', onChange })

    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    fireEvent.click(await screen.findByRole('button', { name: 'Thinking level' }))
    fireEvent.click(await screen.findByText('High'))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('openai:gpt-4o', 'high'))
  })

  it('offers a reset back to the agent default only while overridden', async () => {
    stub()
    const { unmount } = renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o' })
    expect(await screen.findByRole('button', { name: /use agent default/i })).toBeTruthy()
    unmount()

    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: null })
    await screen.findByRole('combobox', { name: 'Search session model' })
    expect(screen.queryByRole('button', { name: /use agent default/i })).toBeNull()
  })

  it('clears the override when the reset control is used', async () => {
    const onChange = mock(() => undefined)
    stub()
    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o', onChange })

    fireEvent.click(await screen.findByRole('button', { name: /use agent default/i }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, null))
  })

  it('moves focus to the model field when the reset control removes itself', async () => {
    stub()
    // The reset button only exists while overridden, so activating it unmounts
    // the very element that has focus. Without a handoff, focus lands on
    // <body> and a keyboard user loses their place.
    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o' })

    const reset = await screen.findByRole('button', { name: /use agent default/i })
    reset.focus()
    fireEvent.click(reset)

    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Search session model'),
    )
  })

  it('leaves the field empty after clearing it, instead of refilling the default', async () => {
    const onChange = mock(() => undefined)
    stub()
    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o', onChange })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear model' }))

    // An empty field is someone about to type, not a request to fall back to
    // the agent default. Committing here would refill the input instantly.
    expect((input as HTMLInputElement).value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits the model typed after a clear', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => undefined)
    stub()
    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o', onChange })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear model' }))
    await user.type(input, 'openai:o3-mini')

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, null))
  })

  it('does not treat an emptied field as an error', async () => {
    stub()
    renderPanel({ defaultModel: 'openai:o3-mini', sessionModel: 'openai:gpt-4o' })

    await screen.findByRole('combobox', { name: 'Search session model' })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear model' }))

    expect(screen.queryByText(/choose a model from the list/i)).toBeNull()
  })

  it('flags the effective model as vision-capable', async () => {
    stub()
    renderPanel({ sessionModel: 'openai:gpt-4o' })

    expect(await screen.findByText(/vision/i)).toBeTruthy()
  })

  it('does not claim vision for a model without it', async () => {
    stub()
    renderPanel({ sessionModel: 'openai:o3-mini' })

    await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    expect(screen.queryByText(/vision/i)).toBeNull()
  })
})

function stubRegistry(models = [
  { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: false, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false },
  { id: 'anthropic:claude-3-5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet', vision: true, output_image: false, output_video: false, thinking_levels: [], summary_trigger_tokens: 0, fast_mode: false },
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

  it('fuzzy fully-qualified text only shows matching registry models', async () => {
    const user = userEvent.setup()
    stubRegistry()
    renderPanel()

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'opnai:gpt4o')

    const listbox = document.querySelector('[role="listbox"]')
    expect(listbox).toBeTruthy()
    const options = Array.from(listbox!.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent?.trim())).toEqual(['openai:gpt-4o'])
  })

  it('applies a fuzzy result as soon as Enter selects it', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => undefined)
    stubRegistry()
    renderPanel({ onChange })

    const input = await screen.findByRole('combobox', { name: 'Search session model' })
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0))
    await user.click(input)
    await user.clear(input)
    await user.type(input, 'opnai:gpt4o')

    // Nothing is committed while the typed text is not a real model id.
    expect(onChange).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect((input as HTMLInputElement).value).toBe('openai:gpt-4o')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('openai:gpt-4o', null))
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
