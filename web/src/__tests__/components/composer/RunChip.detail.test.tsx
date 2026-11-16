/**
 * The run chip under the Detail setting: Full and Simple both name the
 * model, the thinking level and the account. Simple folds the transcript,
 * not the settings the next message runs with.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { RunChip } from '@/components/composer/RunChip'
import type { RunSettings } from '@/components/composer/useRunSettings'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
})

function settings(): RunSettings {
  return {
    agentName: 'code', agentModel: 'openai:gpt-6-luna', agentThinkingLevel: null,
    model: 'openai:gpt-6-luna', provider: 'openai', thinkingLevel: 'low', customized: false,
    thinkingLevels: ['low', 'high'], models: [], modelsLoading: false, providerInfo: undefined,
    accounts: null, credentialId: null, pinnedAccount: null,
    inUseAccount: { id: 'cred-1', label: 'work' } as RunSettings['inUseAccount'],
  }
}

function renderChip(overrides: Partial<RunSettings> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  render(<QueryClientProvider client={client}><RunChip settings={{ ...settings(), ...overrides }} /></QueryClientProvider>)
  return screen.getByRole('button', { name: /^Model / })
}

describe('RunChip and the Detail setting', () => {
  it('in Full names the model, the thinking level and the account', () => {
    const chip = renderChip()
    expect(chip.textContent).toContain('gpt-6-luna')
    expect(chip.textContent).toContain('Low · work')
  })

  it('in Simple still names the model, the thinking level and the account', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    const chip = renderChip()
    expect(chip.textContent).toContain('gpt-6-luna')
    expect(chip.textContent).toContain('Low · work')
    expect(chip.getAttribute('aria-label')).toContain('thinking Low, account work')
  })

  it('reads "No model" on a new install, never the placeholder the agent file starts with', () => {
    const chip = renderChip({ model: '__PROVIDER_MODEL__', agentModel: '__PROVIDER_MODEL__', thinkingLevel: null, inUseAccount: null })

    expect(chip.textContent).toBe('No model')
    expect(chip.getAttribute('aria-label')).toContain('Model not set')
    expect(chip.getAttribute('aria-label')).not.toContain('PROVIDER_MODEL')
  })
})
