/**
 * The run picker's model list: models sit under their provider's display name
 * ("Claude", not `anthropic`), a row is just the model, and a search still
 * matches the whole `provider:model` id.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ProviderInfo } from '@/api/client'
import type { ModelCatalogEntry } from '@/api/types'
import { RunPicker } from '@/components/composer/RunPicker'
import { useRunSettings } from '@/components/composer/useRunSettings'
import { resetHoverIntent } from '@/hooks/use-hover-intent'
import { queryKeys } from '@/queries'
import { agentRegistryQueryOptions } from '@/queries/agent-registry'
import { useAgentStore } from '@/stores/useAgentStore'

const WORKSPACE = '/repo'

function model(id: string): ModelCatalogEntry {
  const [provider, name] = id.split(':')
  return { id, provider, model: name, vision: false, output_image: false, output_video: false, thinking_levels: ['low', 'high'], summary_trigger_tokens: 0, fast_mode: false }
}

function provider(id: string, label: string): ProviderInfo {
  return { id, label, stored_credentials: [], supports_multiple_credentials: false, supports_credential_usage: false } as unknown as ProviderInfo
}

function Harness() {
  const settings = useRunSettings(WORKSPACE)
  return <RunPicker settings={settings} focus="model" onDone={() => {}} />
}

function mountPicker({ withProviders = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (withProviders) {
    client.setQueryData(queryKeys.settings.providers(), {
      providers: [provider('anthropic', 'Claude'), provider('codex', 'Codex'), provider('openai', 'OpenAI')],
    })
  }
  client.setQueryData(queryKeys.agentFiles.registry(), {
    models: [model('anthropic:sonnet'), model('anthropic:haiku'), model('codex:gpt-5'), model('openai:gpt-5')],
  })
  client.setQueryData(agentRegistryQueryOptions(WORKSPACE).queryKey, { agents: [{ name: 'code', model: 'anthropic:sonnet', thinking_level: 'high' }] })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
}

const optionTexts = () => screen.getAllByRole('option').map((option) => option.textContent)
const headings = () => Array.from(document.querySelectorAll('[role="listbox"] > div > div.select-none')).map((node) => node.textContent)
const search = () => screen.getByRole('searchbox', { name: 'Search models' })

beforeEach(() => {
  window.localStorage.clear()
  globalThis.fetch = mock(async () => new Response('{}')) as unknown as typeof fetch
  useAgentStore.setState({ sessionId: null, sessionModel: null, sessionThinkingLevel: null, sessionCredentialId: null })
})

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

describe('RunPicker — provider names', () => {
  it("groups models under the provider's display name and shows only the model in each row", () => {
    mountPicker()
    expect(headings()).toEqual(['Claude', 'Codex', 'OpenAI'])
    // The running model also says "default" (it is the agent's).
    expect(optionTexts()).toEqual(['sonnetdefault', 'haiku', 'gpt-5', 'gpt-5'])
    // No `provider:` prefix in any row.
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toMatch(/anthropic:|codex:|openai:/)
  })

  it('falls back to the provider id for a heading until the providers list loads', () => {
    mountPicker({ withProviders: false })
    expect(headings()).toEqual(['anthropic', 'codex', 'openai'])
  })

  it('still matches a typed "provider:" to that provider\'s models, ranked, each naming its provider', () => {
    mountPicker()
    fireEvent.change(search(), { target: { value: 'codex:' } })

    expect(optionTexts()).toEqual(['gpt-5Codex'])
    // Ranked results have no headings of their own.
    expect(headings()).toEqual([])
  })

  it('tells two providers\' same-named models apart in a search by the provider\'s display name', () => {
    mountPicker()
    fireEvent.change(search(), { target: { value: 'gpt-5' } })

    expect(optionTexts().sort()).toEqual(['gpt-5Codex', 'gpt-5OpenAI'])
  })

  it('says "No model matches" with straight quotes', () => {
    mountPicker()
    fireEvent.change(search(), { target: { value: 'zzzzzz' } })
    expect(screen.getByText('No model matches "zzzzzz".')).toBeTruthy()
  })
})
