import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelsPanel } from '@/components/settings/pages/settings.providers/ModelsPanel'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

function renderPanel({
  models = ['gpt-5', 'gpt-4o'],
  visibleModels = [],
  onSaveVisibleModels = mock(() => Promise.resolve()),
}: {
  models?: string[]
  visibleModels?: string[]
  onSaveVisibleModels?: (models: string[]) => Promise<void>
} = {}) {
  return render(
    <ModelsPanel
      providerId="openai"
      models={models}
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
