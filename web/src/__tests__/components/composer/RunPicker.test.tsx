/**
 * The run picker: model, thinking level and account for the next message,
 * each saved on the session as it is picked.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import type { ProviderInfo, StoredCredential } from '@/api/client'
import type { ModelCatalogEntry } from '@/api/types'
import { RunPicker } from '@/components/composer/RunPicker'
import type { RunSettings } from '@/components/composer/useRunSettings'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { RunSettingsPatch } from '@/stores/useAgentStore/types'

afterEach(cleanup)

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

describe('RunPicker', () => {
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
})
