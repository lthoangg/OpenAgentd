/**
 * On a phone the run deck has one chip for how a message runs: the mode and
 * the model on one line ("Code · sonnet-4-5", sans), and one sheet that
 * picks Mode, Model and Thinking (Phone system; mockup C6 / J3 3.5).
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

function renderChip(onChange = mock((mode: unknown) => { void mode })) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  render(
    <QueryClientProvider client={client}>
      <RunChip settings={settings()} mode={{ mode: 'code', onChange }} />
    </QueryClientProvider>,
  )
  return onChange
}

describe('RunChip on a phone with a mode', () => {
  it('names the mode and the model on one line, the model in sans', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: /^Code mode, model/ })
    expect(chip.textContent).toContain('Code')
    const model = chip.querySelector('[data-run-chip-model]') as HTMLElement
    expect(model.className).not.toContain('font-mono')
  })

  it('picks the mode in the sheet', () => {
    const onChange = renderChip()
    fireEvent.click(screen.getByRole('button', { name: /^Code mode, model/ }))
    const sheet = document.querySelector<HTMLElement>('[data-bottom-sheet]')!
    const group = within(sheet).getByRole('radiogroup', { name: 'Mode' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Plan' }))
    expect(onChange).toHaveBeenCalledWith('plan')
  })
})
