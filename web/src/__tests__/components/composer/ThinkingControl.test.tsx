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

// The slider reads the finger against its box; happy-dom lays nothing out.
const sized = (slider: HTMLElement, width = 300) => {
  slider.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 56, width, height: 56, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return slider
}

describe('ThinkingControl', () => {
  it('opens a centred slider and saves the segment it is let go on', () => {
    render(<ThinkingControl settings={settings('low')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking Low. Change' }))
    const slider = sized(screen.getByRole('slider', { name: 'Thinking level' }))
    fireEvent.pointerDown(slider, { clientX: 150, pointerId: 1 })
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium')
    expect(saved).toEqual([])
    fireEvent.pointerDown(slider, { clientX: 290, pointerId: 1 })
    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect(saved).toEqual([{ thinkingLevel: 'high' }])
  })

  it('steps with the arrow keys and saves each step', () => {
    render(<ThinkingControl settings={settings('medium')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking Medium. Change' }))
    const slider = screen.getByRole('slider', { name: 'Thinking level' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(saved).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'low' }])
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

  it('points the chip\'s gauge at the level and fills the track through the chosen segment', () => {
    render(<ThinkingControl settings={settings('medium', ['low', 'medium', 'high', 'max'])} />)
    const chip = screen.getByRole('button', { name: 'Thinking Medium. Change' })
    const needle = chip.querySelector('[data-thinking-gauge] g') as SVGGElement
    expect(needle.style.transform).toBe('rotate(-45deg)')
    fireEvent.click(chip)
    const fill = document.querySelector('[data-thinking-fill]') as HTMLElement
    expect(fill.style.transform).toBe('translateX(-50%)')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thinking level' }), { key: 'End' })
    expect(fill.style.transform).toBe('translateX(0%)')
  })
})
