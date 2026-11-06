/** The phone's thinking button: a slider over the blurred screen; letting go saves. */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const saved: unknown[] = []
mock.module('@/stores/useAgentStore', () => ({
  useAgentStore: { getState: () => ({ setSessionRunSettings: async (patch: unknown) => { saved.push(patch) } }) },
}))

const { ThinkingControl } = await import('@/components/composer/ThinkingControl')

afterEach(() => {
  cleanup()
  saved.length = 0
})

const settings = (level: string | null, levels = ['low', 'medium', 'high']) =>
  ({ thinkingLevel: level, thinkingLevels: levels }) as unknown as Parameters<typeof ThinkingControl>[0]['settings']

describe('ThinkingControl', () => {
  it('opens a centred slider and saves the level it is let go on', () => {
    render(<ThinkingControl settings={settings('low')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking Low. Change' }))
    const slider = screen.getByRole('slider', { name: 'Thinking level' })
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.pointerUp(slider)
    expect(saved).toEqual([{ thinkingLevel: 'high' }])
  })

  it('closes on a tap outside the slider', () => {
    render(<ThinkingControl settings={settings('medium')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking Medium. Change' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Thinking level' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is absent for a model with no levels', () => {
    const { container } = render(<ThinkingControl settings={settings(null, [])} />)
    expect(container.firstChild).toBeNull()
  })

  it('draws a gauge whose needle sweeps with the level, and fills the track up to the knob', () => {
    render(<ThinkingControl settings={settings('medium')} />)
    const chip = screen.getByRole('button', { name: 'Thinking Medium. Change' })
    const needle = () => chip.querySelector('[data-thinking-gauge] g') as SVGGElement
    expect(needle().style.transform).toBe('rotate(0deg)')
    fireEvent.click(chip)
    const fill = document.querySelector('[data-thinking-fill]') as HTMLElement
    expect(fill.style.transform).toBe('scaleX(0.5)')
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking level' }), { target: { value: '2' } })
    expect(fill.style.transform).toBe('scaleX(1)')
  })

  it('saves a level tapped by its label', () => {
    render(<ThinkingControl settings={settings('low')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking Low. Change' }))
    fireEvent.click(screen.getByText('High'))
    expect(saved).toEqual([{ thinkingLevel: 'high' }])
  })
})
