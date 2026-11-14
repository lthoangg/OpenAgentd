/**
 * The run chip under the Detail setting: Full names the model, the thinking
 * level and the account; Simple names the model only. Its accessible name and
 * the picker say the rest in both.
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

function renderChip() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  render(<QueryClientProvider client={client}><RunChip settings={settings()} /></QueryClientProvider>)
  return screen.getByRole('button', { name: /^Model / })
}

describe('RunChip and the Detail setting', () => {
  it('in Full names the model, the thinking level and the account', () => {
    const chip = renderChip()
    expect(chip.textContent).toContain('gpt-6-luna')
    expect(chip.textContent).toContain('Low · work')
  })

  it('in Simple names the model only, and still says the rest to a screen reader', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    const chip = renderChip()
    expect(chip.textContent).toContain('gpt-6-luna')
    expect(chip.textContent).not.toContain('Low')
    expect(chip.textContent).not.toContain('work')
    expect(chip.getAttribute('aria-label')).toContain('thinking Low, account work')
  })
})
