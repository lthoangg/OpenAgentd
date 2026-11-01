import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ModelName } from '@/components/ui/model-name'

afterEach(cleanup)

describe('ModelName', () => {
  it('reads provider:model in mono, without a native title', () => {
    const { container } = render(<ModelName id="openrouter:anthropic/claude-sonnet-4-6" />)
    const name = container.querySelector('[data-model-name]') as HTMLElement
    expect(name.textContent).toBe('openrouter:anthropic/claude-sonnet-4-6')
    expect(name.className).toContain('font-mono')
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('lets the provider part give way before the model part', () => {
    const { container } = render(<ModelName id="googlegenai:gemini-3.7-flash" />)
    const [provider, model] = Array.from(container.querySelectorAll('[data-model-name] > span')) as HTMLElement[]
    expect(provider.textContent).toBe('googlegenai:')
    expect(provider.className).toMatch(/(^| )shrink( |$)/)
    // Never shrinks (a sliver would already cut it); capped, it truncates
    // only once the provider part is gone.
    expect(model.className).toContain('shrink-0')
    expect(model.className).toContain('max-w-full')
  })

  // Narrower than its ellipsis, a truncating box shows a clipped sliver of
  // its first letter ("ıfake-model" at Android's 125% text); one character
  // wide, it always has room for the "…".
  it('keeps the provider part at least an ellipsis wide', () => {
    const { container } = render(<ModelName id="router9:fake-model" />)
    const provider = container.querySelector('[data-model-name] > span') as HTMLElement
    expect(provider.className).toContain('min-w-[1ch]')
    expect(provider.className).not.toContain('min-w-0')
  })

  it('shows a bare ID as it is', () => {
    const { container } = render(<ModelName id="local-model" />)
    expect(container.textContent).toBe('local-model')
    expect(container.querySelectorAll('[data-model-name] > span')).toHaveLength(1)
  })
})
