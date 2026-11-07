/**
 * On a phone the run deck has one chip for how a message runs: the model in
 * sans, its sheet picks Model and Thinking; Code / Plan stays a separate toggle (Phone system; mockup C6 / J3 3.5).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
  MOBILE_QUERY: '(max-width: 767px), (max-height: 580px)',
}))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
mock.module('@/lib/haptics', () => ({
  selectionHapticFeedback: () => undefined,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: () => undefined,
  alignmentHapticFeedback: () => undefined,
  outcomeHapticFeedback: () => undefined,
  haptic: () => undefined,
}))

const { RunChip } = await import('@/components/composer/RunChip')
const { useUIStore } = await import('@/stores/useUIStore')
type RunSettings = import('@/components/composer/useRunSettings').RunSettings

afterEach(() => {
  cleanup()
  useUIStore.setState({ runPickerOpen: false })
})

function settings(): RunSettings {
  return {
    agentName: 'code', agentModel: 'anthropic:claude-sonnet-4-5', agentThinkingLevel: null,
    model: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', thinkingLevel: 'high', customized: false,
    thinkingLevels: ['low', 'high'], models: [], modelsLoading: false, providerInfo: undefined,
    accounts: null, credentialId: null, pinnedAccount: null, inUseAccount: null,
  }
}

function renderChip() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  render(
    <QueryClientProvider client={client}>
      <RunChip settings={settings()} />
    </QueryClientProvider>,
  )
}

describe('RunChip on a phone', () => {
  it('names only the model, in sans: Code / Plan is its own toggle', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: /^Model / })
    expect(chip.textContent).not.toContain('Code')
    const model = chip.querySelector('[data-run-chip-model]') as HTMLElement
    expect(model.className).not.toContain('font-mono')
  })

  it('has no Mode control in the sheet', () => {
    renderChip()
    fireEvent.click(screen.getByRole('button', { name: /^Model / }))
    const sheet = document.querySelector<HTMLElement>('[data-bottom-sheet]')!
    expect(within(sheet).queryByRole('radiogroup', { name: 'Mode' })).toBeNull()
  })
})
