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
      label: '$1.25 / $10 / 1M',
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

    expect(screen.getByText('$1.25 / $10 / 1M')).toBeTruthy()
    expect(screen.getByText('Free')).toBeTruthy()
  })

  it('supports model costs keyed by qualified ID', () => {
    renderPanel({
      models: ['gpt-5'],
      modelCosts: {
        'openai:gpt-5': { input: 1.25, output: 10 },
      },
    })

    expect(screen.getByText('$1.25 / $10 / 1M')).toBeTruthy()
  })
})

describe('ModelsPanel — stale visible models', () => {
  afterEach(cleanup)

  it('counts only visible models that are still in the provider model list', () => {
    renderPanel({ visibleModels: ['gpt-4o', 'gpt-4-turbo'] })
    expect(screen.getByText('2 models available')).toBeTruthy()
    expect(screen.getByText('1 visible')).toBeTruthy()
  })

  it('treats a provider whose visible models are all stale as all-visible', () => {
    renderPanel({ visibleModels: ['gpt-4-turbo'] })
    expect(screen.getByText('2 models available')).toBeTruthy()
    expect(screen.getByText('All visible')).toBeTruthy()
  })

  it('drops stale visible entries when saving a toggle', () => {
    const save = mock(() => Promise.resolve())
    renderPanel({ visibleModels: ['gpt-4o', 'gpt-4-turbo'], onSaveVisibleModels: save })
    fireEvent.click(screen.getByRole('button', { name: 'Show openai:gpt-5 in model pickers' }))
    expect(save).toHaveBeenCalledWith(['gpt-4o', 'gpt-5'])
  })
})
