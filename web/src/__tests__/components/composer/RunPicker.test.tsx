/**
 * The run picker: model, thinking level and account for the next message,
 * each saved on the session as it is picked.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import type { ProviderInfo, ProviderUsageResponse, StoredCredential } from '@/api/client'
import type { ModelCatalogEntry } from '@/api/types'
import { RunPicker } from '@/components/composer/RunPicker'
import type { RunSettings } from '@/components/composer/useRunSettings'
import { resetHoverIntent } from '@/hooks/use-hover-intent'
import { queryKeys } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { RunSettingsPatch } from '@/stores/useAgentStore/types'

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

const setRun = mock(async (_patch: unknown) => true)
const lastPatch = (i = 0) => setRun.mock.calls[i][0] as RunSettingsPatch

beforeEach(() => {
  setRun.mockClear()
  window.localStorage.clear()
  useAgentStore.setState({ setSessionRunSettings: setRun as (patch: RunSettingsPatch) => Promise<boolean> })
})

function model(id: string, levels: string[] = ['low', 'medium', 'high']): ModelCatalogEntry {
  const [provider, name] = id.split(':')
  return { id, provider, model: name, vision: false, output_image: false, output_video: false, thinking_levels: levels, summary_trigger_tokens: 0, fast_mode: false }
}

function credential(id: string, label: string, extra: Partial<StoredCredential> = {}): StoredCredential {
  return { id, label, disabled: false, kind: 'oauth', hint: null, settings: {}, status: 'ready', in_use: false, cooldown_until: null, cooldown_reason: null, ...extra }
}

function settings(over: Partial<RunSettings> = {}): RunSettings {
  return {
    agentName: 'code',
    agentModel: 'anthropic:sonnet',
    agentThinkingLevel: 'medium',
    model: 'anthropic:sonnet',
    provider: 'anthropic',
    thinkingLevel: 'medium',
    customized: false,
    thinkingLevels: ['low', 'medium', 'high'],
    models: [model('anthropic:sonnet'), model('anthropic:opus'), model('openai:gpt-5', ['minimal', 'high'])],
    modelsLoading: false,
    providerInfo: undefined,
    accounts: null,
    credentialId: null,
    pinnedAccount: null,
    ...over,
  }
}

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

async function frame() {
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
}

/** The account picker with each account's usage already in the cache, so no request goes out. */
function renderAccounts(usageByAccount: Record<string, ProviderUsageResponse['limits']>) {
  const accounts = Object.keys(usageByAccount).map((id) => credential(id, id[0].toUpperCase() + id.slice(1)))
  const providerInfo = { id: 'openai', label: 'OpenAI', stored_credentials: accounts, supports_credential_usage: true } as ProviderInfo
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [id, limits] of Object.entries(usageByAccount)) {
    client.setQueryData(queryKeys.settings.providerUsage('openai', id), { provider: 'openai', limits } satisfies ProviderUsageResponse)
  }
  render(
    <QueryClientProvider client={client}>
      <RunPicker settings={settings({ accounts, providerInfo, provider: 'openai' })} focus="model" onDone={() => {}} />
    </QueryClientProvider>,
  )
  return (id: string) => screen.getByRole('radio', { name: new RegExp(id, 'i') })
}

describe('RunPicker', () => {
  describe('account quota', () => {
    it('shows percent left for a window, as before', () => {
      const row = renderAccounts({ work: [{ primary: { used_percent: 30 } }], home: [] })
      expect(row('Work').textContent).toContain('70% left')
      expect(row('Home').textContent).not.toContain('left')
    })

    it('shows what is left of a spend cap on an Enterprise account with no windows', () => {
      const row = renderAccounts({
        work: [{ plan_type: 'enterprise', spend: { reached: false, currency: 'USD', limit: 50, used: 38, remaining: 12, used_percent: 76 } }],
        home: [{ primary: { used_percent: 10 } }],
      })
      expect(row('Work').textContent).toContain('$12.00 of $50.00 left')
    })

    it('shows a credit balance, unlimited credits and an empty account', () => {
      const row = renderAccounts({
        work: [{ credits: { has_credits: true, unlimited: false, balance: '$84.50' } }],
        home: [{ credits: { has_credits: true, unlimited: true, balance: null } }],
        spare: [{ credits: { has_credits: false, unlimited: false, balance: null } }],
      })
      expect(row('Work').textContent).toContain('$84.50 left')
      expect(row('Home').textContent).toContain('Unlimited')
      expect(row('Spare').textContent).toContain('No credits left')
    })

    it('says Limit reached in the error tone, between the label and the check', () => {
      const row = renderAccounts({ work: [{ spend: { reached: true, limit: 700, used: 800, remaining: 0 } }], home: [] })
      const state = screen.getByText('Limit reached')
      expect(state.className).toContain('text-(--color-error)')
      const parts = Array.from(row('Work').children)
      expect(parts[0].textContent).toBe('Work')
      expect(parts[1]).toBe(state)
    })

    it('keeps the balance in the tooltip when a percent window leads, and truncates a long one', () => {
      renderAccounts({
        work: [{ primary: { used_percent: 20 }, credits: { has_credits: true, unlimited: false, balance: '$84.50' } }],
        home: [{ credits: { has_credits: true, unlimited: true, balance: 'Unlimited until the end of the billing period' } }],
      })
      expect(screen.getByText('80% left').getAttribute('title')).toBe('Balance $84.50')
      const long = screen.getByText('Unlimited until the end of the billing period')
      expect(long.className).toContain('truncate')
      expect(long.getAttribute('title')).toBe('Unlimited until the end of the billing period')
    })
  })

  it('lists every model as provider:model and marks the one that runs', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent?.replace(/default$/, ''))).toEqual(['anthropic:sonnet', 'anthropic:opus', 'openai:gpt-5'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('opens on the model that runs, not the first row', () => {
    wrap(<RunPicker settings={settings({ model: 'openai:gpt-5', provider: 'openai', customized: true })} focus="model" onDone={() => {}} />)
    const highlighted = screen.getAllByRole('option').filter((o) => o.hasAttribute('data-highlighted'))
    expect(highlighted.map((o) => o.textContent)).toEqual(['openai:gpt-5'])
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    expect(document.getElementById(search.getAttribute('aria-activedescendant') ?? '')?.textContent).toBe('openai:gpt-5')
  })

  it('picks the highlighted running model with Enter and closes', () => {
    const onDone = mock(() => {})
    wrap(<RunPicker settings={settings({ model: 'anthropic:opus', customized: true })} focus="model" onDone={onDone} />)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search models' }), { key: 'Enter' })
    expect(lastPatch().model).toBe('anthropic:opus')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('keeps the provider part whole: it never truncates to a stub like "ag…"', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const provider = screen.getAllByText('anthropic:')[0]
    expect(provider.className).not.toContain('truncate')
    expect(provider.className).toContain('whitespace-nowrap')
  })

  it('saves another model on the session and keeps a level it supports', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('option', { name: /opus/ }))
    expect(setRun).toHaveBeenCalledWith({ model: 'anthropic:opus', thinkingLevel: 'medium' })
  })

  it('moves to Auto when the model comes from another provider', () => {
    wrap(<RunPicker settings={settings({ credentialId: 'work' })} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('option', { name: /gpt-5/ }))
    expect(setRun).toHaveBeenCalledWith({ model: 'openai:gpt-5', thinkingLevel: null, credentialId: null })
  })

  it('stores the agent default as no override', () => {
    wrap(<RunPicker settings={settings({ model: 'anthropic:opus', customized: true })} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('option', { name: /sonnet/ }))
    expect(lastPatch().model).toBeNull()
  })

  it('searches, picks with Enter and closes', async () => {
    const onDone = mock(() => {})
    wrap(<RunPicker settings={settings()} focus="model" onDone={onDone} />)
    await frame()
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'gpt' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(lastPatch().model).toBe('openai:gpt-5')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  // The palette, Settings' model field and the @ picker all match loosely.
  it('finds a model by a loose query, as the other pickers do', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'gpt5' } })

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['openai:gpt-5'])
  })

  it('ranks the closest match first, in one list without provider headings, so Enter picks it', () => {
    const onDone = mock(() => {})
    const models = [model('agy:antigravity-claude-opus-4-6-thinking'), model('anthropic:sonnet'), model('anthropic:opus')]
    wrap(<RunPicker settings={settings({ models })} focus="model" onDone={onDone} />)
    const search = screen.getByRole('searchbox', { name: 'Search models' })

    fireEvent.change(search, { target: { value: 'opus' } })

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['anthropic:opus', 'agy:antigravity-claude-opus-4-6-thinking'])
    expect(screen.queryByText('anthropic')).toBeNull()
    expect(screen.queryByText('agy')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(lastPatch().model).toBe('anthropic:opus')
  })

  // The picker opens upward from the chip: a list that shrank as a search
  // narrowed it moved the search field down under the typing.
  it('keeps the list as tall as it was while a search narrows it', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const list = screen.getByRole('listbox', { name: 'Models' })
    list.getBoundingClientRect = () => ({ height: 240 }) as DOMRect
    const search = screen.getByRole('searchbox', { name: 'Search models' })

    fireEvent.change(search, { target: { value: 'g' } })
    fireEvent.change(search, { target: { value: 'gpt' } })
    expect(list.style.minHeight).toBe('240px')

    fireEvent.change(search, { target: { value: '' } })
    expect(list.style.minHeight).toBe('')
  })

  it('steps the thinking level with ←/→ while the search is empty', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    expect(setRun).toHaveBeenLastCalledWith({ thinkingLevel: 'high' })
    fireEvent.keyDown(search, { key: 'ArrowLeft' })
    expect(setRun).toHaveBeenLastCalledWith({ thinkingLevel: 'low' })
  })

  it('offers no "Default" thinking level: only the levels the model has', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: 'Thinking level' })
    expect(Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual(['Low', 'Medium', 'High'])
  })

  // "Extra high" was twice as wide as its neighbours and pushed the last
  // levels off a phone's row; the segment says XHigh, the name stays whole.
  it('labels Extra high as XHigh on its segment, keeping the full name for screen readers', () => {
    wrap(<RunPicker settings={settings({ thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })} focus="model" onDone={() => {}} />)
    const xhigh = screen.getByRole('radio', { name: 'Extra high' })
    expect(xhigh.textContent).toBe('XHigh')
  })

  // Six levels (Off … XHigh) need the sheet's whole width on an iPhone mini.
  it('puts the Thinking label above its levels in the phone sheet, beside them on desktop', () => {
    const { unmount } = wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} touch />)
    const row = () => screen.getByRole('radiogroup', { name: 'Thinking level' }).parentElement!
    expect(row().className.split(/\s+/)).toContain('flex-col')
    unmount()
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    expect(row().className.split(/\s+/)).not.toContain('flex-col')
  })

  it('says the model decides when no thinking level is set, so an empty control is not a mystery', () => {
    const { unmount } = wrap(<RunPicker settings={settings({ thinkingLevel: null, agentThinkingLevel: null })} focus="model" onDone={() => {}} />)
    expect(screen.getByText(/model's own default/)).toBeTruthy()
    unmount()
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    expect(screen.queryByText(/model's own default/)).toBeNull()
  })

  it('pins an account, says when one is cooling down, and goes back to Auto', () => {
    const accounts = [credential('work', 'Work'), credential('home', 'Home', { status: 'cooling_down' })]
    const providerInfo = { id: 'anthropic', label: 'Anthropic', stored_credentials: accounts, supports_credential_usage: false } as ProviderInfo
    wrap(<RunPicker settings={settings({ accounts, providerInfo, credentialId: 'work', pinnedAccount: accounts[0] })} focus="model" onDone={() => {}} />)

    const group = screen.getByRole('radiogroup', { name: 'Anthropic account' })
    expect(screen.getByRole('radio', { name: /Work/ }).getAttribute('aria-checked')).toBe('true')
    expect(group.textContent).toContain('Cooling down')

    fireEvent.click(screen.getByRole('radio', { name: /Home/ }))
    expect(setRun).toHaveBeenLastCalledWith({ credentialId: 'home' })
    fireEvent.click(screen.getByRole('radio', { name: /Auto/ }))
    expect(setRun).toHaveBeenLastCalledWith({ credentialId: null })
  })

  it('offers Reconnect for a signed-out account, opening Settings → Providers', () => {
    const openSettings = mock((..._args: unknown[]) => {})
    const original = useSettingsStore.getState().openSettings
    useSettingsStore.setState({ openSettings })
    try {
      const onDone = mock(() => {})
      const accounts = [credential('work', 'Work', { status: 'needs_reconnect' })]
      const providerInfo = { id: 'anthropic', label: 'Anthropic', stored_credentials: accounts, supports_credential_usage: false } as ProviderInfo
      wrap(<RunPicker settings={settings({ accounts, providerInfo })} focus="model" onDone={onDone} />)

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect Work…' }))
      expect(openSettings).toHaveBeenCalledWith('providers')
      expect(onDone).toHaveBeenCalledTimes(1)
    } finally {
      useSettingsStore.setState({ openSettings: original })
    }
  })

  it('resets every override at once, and only when there is one', () => {
    const { unmount } = wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    expect((screen.getByRole('button', { name: /Reset to default/ }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    wrap(<RunPicker settings={settings({ customized: true })} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/ }))
    expect(setRun).toHaveBeenCalledWith({ model: null, thinkingLevel: null, credentialId: null })
  })

  it('lists recent models first', () => {
    window.localStorage.setItem('oa.recentModels.v1', JSON.stringify(['openai:gpt-5']))
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    expect(screen.getAllByRole('option')[0].textContent).toContain('openai:gpt-5')
    expect(screen.getByText('Recent')).toBeTruthy()
  })

  it('keeps the list in place when a model is clicked: the row under the pointer stays the one picked', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const before = screen.getAllByRole('option').map((o) => o.textContent)
    fireEvent.click(screen.getByRole('option', { name: /opus/ }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(before)
    expect(screen.queryByText('Recent')).toBeNull()
    // Remembered for the next time the picker opens.
    expect(JSON.parse(window.localStorage.getItem('oa.recentModels.v1') ?? '[]')).toEqual(['anthropic:opus'])
  })

  it('keeps the keyboard in the search after a mouse pick, so Enter and the arrows still work', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    // A row takes no focus on press (WebKit would drop it on the body).
    expect(fireEvent.mouseDown(screen.getByRole('option', { name: /opus/ }))).toBe(false)
  })

  it('picks the highlighted row with Enter after a mouse pick, not whatever moved into its place', () => {
    const onDone = mock(() => {})
    wrap(<RunPicker settings={settings()} focus="model" onDone={onDone} />)
    const gpt = screen.getByRole('option', { name: /gpt-5/ })
    fireEvent.mouseMove(gpt, { clientX: 20, clientY: 40 })
    fireEvent.click(gpt)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search models' }), { key: 'Enter' })
    expect(lastPatch(1).model).toBe('openai:gpt-5')
  })

  // As in the palette: a list that opens, filters or scrolls under a parked
  // pointer sends a mouse move without the mouse moving.
  it('leaves the highlight to the keyboard while the pointer rests on a row', () => {
    wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    const highlighted = () => screen.getAllByRole('option').filter((o) => o.hasAttribute('data-highlighted')).map((o) => o.textContent)
    fireEvent.mouseMove(document.body, { clientX: 30, clientY: 30 })

    fireEvent.mouseMove(screen.getByRole('option', { name: /gpt-5/ }), { clientX: 30, clientY: 30 })
    // Still the running model (its row also says "default").
    expect(highlighted()).toEqual(['anthropic:sonnetdefault'])

    fireEvent.mouseMove(screen.getByRole('option', { name: /gpt-5/ }), { clientX: 32, clientY: 34 })
    expect(highlighted()).toEqual(['openai:gpt-5'])
  })

  it('keeps the highlight on the same model when the list changes under it', () => {
    const { rerender } = wrap(<RunPicker settings={settings()} focus="model" onDone={() => {}} />)
    fireEvent.mouseMove(screen.getByRole('option', { name: /opus/ }), { clientX: 20, clientY: 60 })
    const client = new QueryClient()
    rerender(
      <QueryClientProvider client={client}>
        <RunPicker settings={settings({ models: [model('openai:gpt-5'), model('anthropic:sonnet'), model('anthropic:opus')] })} focus="model" onDone={() => {}} />
      </QueryClientProvider>,
    )
    const highlighted = screen.getAllByRole('option').filter((o) => o.hasAttribute('data-highlighted'))
    expect(highlighted.map((o) => o.textContent)).toEqual(['anthropic:opus'])
  })

  it('keeps the level while the model list is still loading and the new model\'s levels are unknown', () => {
    const loading = settings({ modelsLoading: true, thinkingLevels: [], models: [model('anthropic:sonnet', []), model('anthropic:opus', [])] })
    wrap(<RunPicker settings={loading} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('option', { name: /opus/ }))
    expect(setRun).toHaveBeenCalledWith({ model: 'anthropic:opus', thinkingLevel: 'medium' })
  })

  it('does not pin the agent\'s own level when going back to the agent\'s model', () => {
    wrap(<RunPicker settings={settings({ model: 'anthropic:opus', customized: true })} focus="model" onDone={() => {}} />)
    fireEvent.click(screen.getByRole('option', { name: /sonnet/ }))
    expect(setRun).toHaveBeenCalledWith({ model: null, thinkingLevel: null })
  })

  it('shows no thinking control when the model has no levels to pick', () => {
    wrap(<RunPicker settings={settings({ thinkingLevels: [] })} focus="model" onDone={() => {}} />)
    expect(screen.queryByRole('radiogroup', { name: 'Thinking level' })).toBeNull()
    expect(screen.queryByText(/model's own default/)).toBeNull()
  })
})
