import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ModelCostInfo } from '@/api/client'
import {
  ModelsPanel,
  formatModelPriceBadge,
  formatModelPriceTooltip,
  formatTokenPrice,
} from '@/components/settings/pages/settings.providers/ModelsPanel'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

function renderPanel({
  models = ['gpt-5', 'gpt-4o'],
  modelCosts,
  visibleModels = [],
  onSaveVisibleModels = mock(() => Promise.resolve()),
}: {
  models?: string[]
  modelCosts?: Record<string, ModelCostInfo>
  visibleModels?: string[]
  onSaveVisibleModels?: (models: string[]) => Promise<void>
} = {}) {
  return render(
    <ModelsPanel
      providerId="openai"
      models={models}
      modelCosts={modelCosts}
      visibleModels={visibleModels}
      search=""
      onSearchChange={() => undefined}
      expanded
      onToggle={() => undefined}
      onSaveVisibleModels={onSaveVisibleModels}
      savingVisibleModels={false}
    />,
  )
}

describe('formatTokenPrice & price badge helpers', () => {
  it('formats token price numbers accurately', () => {
    expect(formatTokenPrice(0)).toBe('$0')
    expect(formatTokenPrice(2.5)).toBe('$2.50')
    expect(formatTokenPrice(10)).toBe('$10')
    expect(formatTokenPrice(0.44)).toBe('$0.44')
    expect(formatTokenPrice(0.014)).toBe('$0.014')
    expect(formatTokenPrice(0.007)).toBe('$0.007')
  })

  it('formats model price badges for free and paid models', () => {
    expect(formatModelPriceBadge({ input: 0, output: 0 })).toEqual({
      label: 'Free',
      isFree: true,
    })
    expect(formatModelPriceBadge({ input: 1.25, output: 10 })).toEqual({
      label: '$1.25 in · $10 out / 1M',
      isFree: false,
    })
    expect(formatModelPriceBadge({ input: 2.5, output: null })).toEqual({
      label: '$2.50 in / 1M',
      isFree: false,
    })
    expect(formatModelPriceBadge({ input: null, output: 5 })).toEqual({
      label: '$5 out / 1M',
      isFree: false,
    })
    expect(formatModelPriceBadge({ input: null, output: null })).toBeNull()
    expect(formatModelPriceBadge(undefined)).toBeNull()
  })

  it('formats model price tooltips with detailed token breakdown', () => {
    expect(formatModelPriceTooltip({ input: 0, output: 0 })).toBe('Free (no token cost)')
    expect(
      formatModelPriceTooltip({
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75,
      }),
    ).toBe(
      'Input: $3 / 1M tokens · Output: $15 / 1M tokens · Cache read: $0.30 / 1M tokens · Cache write: $3.75 / 1M tokens',
    )
    expect(formatModelPriceTooltip(undefined)).toBeNull()
  })
})

describe('ModelsPanel — price display', () => {
  afterEach(cleanup)

  it('renders prices for priced models and Free badge for free models', () => {
    renderPanel({
      models: ['gpt-5', 'free-model', 'unpriced-model'],
      modelCosts: {
        'gpt-5': { input: 1.25, output: 10, cache_read: 0.125 },
        'free-model': { input: 0, output: 0 },
      },
    })

    expect(screen.getByText('$1.25 in · $10 out / 1M')).toBeTruthy()
    expect(screen.getByText('Free')).toBeTruthy()
  })

  it('supports model costs keyed by qualified ID', () => {
    renderPanel({
      models: ['gpt-5'],
      modelCosts: {
        'openai:gpt-5': { input: 1.25, output: 10 },
      },
    })

    expect(screen.getByText('$1.25 in · $10 out / 1M')).toBeTruthy()
  })
})

describe('ModelsPanel — stale visible models', () => {
  afterEach(cleanup)

  it('counts only visible models that are still in the provider model list', () => {
    renderPanel({ visibleModels: ['gpt-4o', 'gpt-4-turbo'] })
    expect(screen.getByText('· 2 available')).toBeTruthy()
    expect(screen.getByText('1 shown in pickers')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Only selected (1)' }).getAttribute('aria-checked')).toBe('true')
  })

  it('treats a provider whose visible models are all stale as all-visible', () => {
    renderPanel({ visibleModels: ['gpt-4-turbo'] })
    expect(screen.getByText('· 2 available')).toBeTruthy()
    expect(screen.getByText('All shown in pickers')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'All models' }).getAttribute('aria-checked')).toBe('true')
  })

  it('drops stale visible entries when saving a toggle', () => {
    const save = mock(() => Promise.resolve())
    renderPanel({ visibleModels: ['gpt-4o', 'gpt-4-turbo'], onSaveVisibleModels: save })
    fireEvent.click(screen.getByRole('button', { name: 'Show openai:gpt-5 in model pickers' }))
    expect(save).toHaveBeenCalledWith(['gpt-4o', 'gpt-5'])
  })
})

describe('ModelsPanel — picker mode', () => {
  afterEach(cleanup)

  it('shows the header counts and no per-model toggles while every model is shown', () => {
    renderPanel()
    expect(screen.getByText('· 2 available')).toBeTruthy()
    expect(screen.getByText('All shown in pickers')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Models shown in pickers' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'All models' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Only selected' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryAllByRole('button', { name: /model pickers$/ })).toHaveLength(0)
  })

  it('shows Shown/Hidden toggles with aria-pressed only in Only selected mode', () => {
    const save = mock(() => Promise.resolve())
    renderPanel({ onSaveVisibleModels: save })
    fireEvent.click(screen.getByRole('radio', { name: 'Only selected' }))

    const show = screen.getByRole('button', { name: 'Show openai:gpt-5 in model pickers' })
    expect(show.getAttribute('aria-pressed')).toBe('false')
    expect(show.textContent).toBe('Hidden')
    // Choosing the mode saves nothing until a model is picked
    expect(save).not.toHaveBeenCalled()

    fireEvent.click(show)
    expect(save).toHaveBeenCalledWith(['gpt-5'])
  })

  it('names a selected model "Hide … from model pickers" and pressed', () => {
    renderPanel({ visibleModels: ['gpt-5'] })
    const hide = screen.getByRole('button', { name: 'Hide openai:gpt-5 from model pickers' })
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    expect(hide.textContent).toBe('Shown')
    expect(screen.getByRole('button', { name: 'Show openai:gpt-4o in model pickers' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('goes back to every model shown by saving an empty selection', () => {
    const save = mock(() => Promise.resolve())
    renderPanel({ visibleModels: ['gpt-5'], onSaveVisibleModels: save })
    fireEvent.click(screen.getByRole('radio', { name: 'All models' }))
    expect(save).toHaveBeenCalledWith([])
  })
})

describe('ModelsPanel — long model lists', () => {
  afterEach(cleanup)
  // Per-model toggles only render in "Only selected" mode
  const rows = () => screen.queryAllByRole('button', { name: /in model pickers$/ }).length
  const onlySelected = () => fireEvent.click(screen.getByRole('radio', { name: 'Only selected' }))

  it('shows the first 50 models and the rest on request', () => {
    renderPanel({ models: Array.from({ length: 120 }, (_, i) => `model-${i}`) })
    onlySelected()
    expect(rows()).toBe(50)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 120 models' }))
    expect(rows()).toBe(120)
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })

  it('shows a short list whole', () => {
    renderPanel({ models: Array.from({ length: 50 }, (_, i) => `model-${i}`) })
    onlySelected()
    expect(rows()).toBe(50)
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })
})
