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
    // Never shrinks (a sliver would already cut it); capped, it truncates
    // only once the provider part is gone.
    expect(model.className).toContain('shrink-0')
    expect(model.className).toContain('max-w-full')
    expect(model.className).toContain('truncate')
  })

  // A truncating provider part showed a sliver of its first letter
  // ("ıfake-model" at Android's 125% text): CSS clips a line's first
  // character rather than replace it with "…". The part now wraps whole
  // onto a second line that the one-line box clips away.
  it('shows the provider part whole or not at all', () => {
    const { container } = render(<ModelName id="router9:fake-model" />)
    const name = container.querySelector('[data-model-name]') as HTMLElement
    const [provider, model] = Array.from(name.children) as HTMLElement[]
    expect(provider.className).toContain('shrink-0')
    expect(provider.className).toContain('whitespace-nowrap')
    expect(provider.className).not.toContain('truncate')
    // One line tall and clipped below it; the model wraps first so its line
    // is the visible one (and the box's baseline), drawn after the provider.
    for (const cls of ['flex-wrap', 'flex-row-reverse', 'justify-end', 'h-[1lh]', 'overflow-y-clip']) {
      expect(name.className).toContain(cls)
    }
    expect(model.className).toContain('order-first')
    // Copy and screen readers still get provider:model in order.
    expect(name.textContent).toBe('router9:fake-model')
  })

  it('shows a bare ID as it is', () => {
    const { container } = render(<ModelName id="local-model" />)
    expect(container.textContent).toBe('local-model')
    expect(container.querySelectorAll('[data-model-name] > span')).toHaveLength(1)
  })
})
