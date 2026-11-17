/**
 * The run picker's account list is on a model's page, under its levels, and
 * follows the model picked while the picker is open: a model from another
 * provider lists that provider's accounts at once, so one can be picked
 * without reopening the picker.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ProviderInfo, StoredCredential } from '@/api/client'
import type { ModelCatalogEntry } from '@/api/types'
import { RunPicker } from '@/components/composer/RunPicker'
import { useRunSettings } from '@/components/composer/useRunSettings'
import { resetHoverIntent } from '@/hooks/use-hover-intent'
import { queryKeys } from '@/queries'
import { agentRegistryQueryOptions } from '@/queries/agent-registry'
import { useAgentStore } from '@/stores/useAgentStore'

const WORKSPACE = '/repo'

function model(id: string, levels: string[] = ['low', 'high']): ModelCatalogEntry {
  const [provider, name] = id.split(':')
  return { id, provider, model: name, vision: false, output_image: false, output_video: false, thinking_levels: levels, summary_trigger_tokens: 0, fast_mode: false }
}

function credential(id: string, label: string): StoredCredential {
  return { id, label, disabled: false, kind: 'oauth', hint: null, settings: {}, status: 'ready', in_use: false, cooldown_until: null, cooldown_reason: null }
}

function provider(id: string, label: string, accounts: StoredCredential[]): ProviderInfo {
  return { id, label, stored_credentials: accounts, supports_multiple_credentials: true, supports_credential_usage: false } as unknown as ProviderInfo
}

function Harness({ onDone }: { onDone: () => void }) {
  const settings = useRunSettings(WORKSPACE)
  return <RunPicker settings={settings} focus="model" onDone={onDone} />
}

function mount(onDone = () => {}, models = [model('anthropic:sonnet'), model('codex:gpt-5')]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.settings.providers(), {
    providers: [
      provider('anthropic', 'Claude', [credential('c1', 'Claude Work'), credential('c2', 'Claude Home')]),
      provider('codex', 'Codex', [credential('x1', 'Codex Team'), credential('x2', 'Codex Personal')]),
    ],
  })
  client.setQueryData(queryKeys.agentFiles.registry(), { models })
  client.setQueryData(agentRegistryQueryOptions(WORKSPACE).queryKey, { agents: [{ name: 'code', model: 'anthropic:sonnet', thinking_level: 'high' }] })
  render(
    <QueryClientProvider client={client}>
      <Harness onDone={onDone} />
    </QueryClientProvider>,
  )
}

const accountList = () => screen.getByRole('radiogroup', { name: /account/ })
const accountNames = () => within(accountList()).getAllByRole('radio').map((radio) => radio.textContent)

beforeEach(() => {
  window.localStorage.clear()
  globalThis.fetch = mock(async () => new Response('{}')) as unknown as typeof fetch
  useAgentStore.setState({ sessionId: null, sessionModel: null, sessionThinkingLevel: null, sessionCredentialId: null })
})

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

describe('RunPicker — accounts follow the model', () => {
  it("lists the new provider's accounts on its page as soon as its model is clicked", () => {
    mount()
    // The models page lists models only.
    expect(screen.queryByRole('radiogroup', { name: /account/ })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: /gpt-5/ }))

    expect(accountList().getAttribute('aria-label')).toBe('Codex account')
    expect(accountNames().join('|')).toContain('Codex Team')
    expect(accountNames().join('|')).not.toContain('Claude')
    // The new provider starts on its account in use, and an account can be picked right away.
    expect(within(accountList()).getByRole('radio', { name: /Codex Team/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(accountList()).getByRole('radio', { name: /Codex Personal/ }))
    expect(useAgentStore.getState().sessionCredentialId).toBe('x2')
  })

  it('keeps the picker open on Enter for a model of another provider, with its levels and accounts', async () => {
    const onDone = mock(() => {})
    mount(onDone)
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'gpt-5' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onDone).not.toHaveBeenCalled()
    expect(useAgentStore.getState().sessionModel).toBe('codex:gpt-5')
    expect(screen.getByRole('listbox', { name: 'Thinking for codex:gpt-5' })).toBeTruthy()

    // Enter on an account picks it and closes, as Enter on a model does.
    const personal = within(accountList()).getByRole('radio', { name: /Codex Personal/ })
    fireEvent.keyDown(personal, { key: 'Enter' })
    expect(useAgentStore.getState().sessionCredentialId).toBe('x2')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("opens the running model's page on Enter, so its account changes without changing model", () => {
    const onDone = mock(() => {})
    mount(onDone)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search models' }), { key: 'Enter' })
    expect(onDone).not.toHaveBeenCalled()
    expect(accountList().getAttribute('aria-label')).toBe('Claude account')
    fireEvent.click(within(accountList()).getByRole('radio', { name: /Claude Home/ }))
    expect(useAgentStore.getState().sessionCredentialId).toBe('c2')
  })

  it('opens an accounts-only page for a model with no levels, with the checked account focused', async () => {
    mount(() => {}, [model('anthropic:sonnet'), model('codex:gpt-5', [])])
    fireEvent.click(screen.getByRole('option', { name: /gpt-5/ }))

    expect(screen.queryByRole('listbox', { name: /^Thinking for / })).toBeNull()
    expect(accountList().getAttribute('aria-label')).toBe('Codex account')
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(document.activeElement).toBe(within(accountList()).getByRole('radio', { name: /Codex Team/ }))
  })
})
