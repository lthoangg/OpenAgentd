import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SegmentedControl } from '@/components/ui/segmented-control'

afterEach(cleanup)

type Box = { x: number; y: number; w: number; h: number }

/** happy-dom has no layout: give each segment (found by its text) a box. */
function stubLayout(boxes: Record<string, Box>): () => void {
  const props = { offsetLeft: 'x', offsetTop: 'y', offsetWidth: 'w', offsetHeight: 'h' } as const
  const saved = Object.keys(props).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const)
  for (const [name, key] of Object.entries(props)) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) { return boxes[this.textContent ?? '']?.[key] ?? 0 },
    })
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  }
}

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
  { value: 'd', label: 'Delta' },
] as const

const BOXES = {
  Alpha: { x: 0, y: 0, w: 50, h: 32 },
  Beta: { x: 50, y: 0, w: 40, h: 32 },
  Gamma: { x: 90, y: 0, w: 60, h: 32 },
  Delta: { x: 150, y: 0, w: 50, h: 32 },
}

const track = () => screen.getByRole('radiogroup')
const fill = () => document.querySelector<HTMLElement>('[data-segment-indicator]')!
const alpha = () => screen.getByRole('radio', { name: 'Alpha' })

function setup(onChange = mock(() => {})) {
  const restore = stubLayout(BOXES)
  render(<SegmentedControl label="Letters" value="a" onChange={onChange} options={OPTIONS} />)
  return { onChange, restore }
}

describe('SegmentedControl — press and drag', () => {
  it('shrinks the fill while the chosen segment is pressed and restores it on release', () => {
    const { restore } = setup()
    try {
      const inner = () => fill().firstElementChild as HTMLElement
      expect(inner().style.scale).toBe('1')
      fireEvent.pointerDown(alpha(), { clientX: 10, button: 0, pointerId: 1 })
      expect(fill().hasAttribute('data-pressed')).toBe(true)
      expect(inner().style.scale).toBe('0.92')
      fireEvent.pointerUp(alpha(), { clientX: 10, pointerId: 1 })
      expect(inner().style.scale).toBe('1')
      expect(inner().className).toContain('transition-[scale]')
      expect(inner().className).toContain('duration-(--motion-fast)')
    } finally {
      restore()
    }
  })

  it('carries the fill to the segment under the pointer and picks it on release', () => {
    const { onChange, restore } = setup()
    try {
      fireEvent.pointerDown(alpha(), { clientX: 10, button: 0, pointerId: 1 })
      // Over Gamma (x 90–150).
      fireEvent.pointerMove(track(), { clientX: 120, clientY: 10, pointerId: 1 })
      expect(fill().style.translate).toBe('90px 0px')
      expect(fill().style.scale).toBe('60 32')
      expect(onChange).not.toHaveBeenCalled()
      fireEvent.pointerUp(track(), { clientX: 120, clientY: 10, pointerId: 1 })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('c')
    } finally {
      restore()
    }
  })

  it('skips a disabled segment and takes the nearest enabled one', () => {
    const { onChange, restore } = setup()
    try {
      fireEvent.pointerDown(alpha(), { clientX: 10, button: 0, pointerId: 1 })
      // Over Beta (disabled, x 50–90) just left of Gamma.
      fireEvent.pointerUp(track(), { clientX: 85, clientY: 10, pointerId: 1 })
      expect(onChange).toHaveBeenCalledWith('c')
    } finally {
      restore()
    }
  })

  it('picks nothing when released on the chosen segment or cancelled', () => {
    const { onChange, restore } = setup()
    try {
      fireEvent.pointerDown(alpha(), { clientX: 10, button: 0, pointerId: 1 })
      fireEvent.pointerMove(track(), { clientX: 190, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(track(), { clientX: 20, clientY: 10, pointerId: 1 })
      fireEvent.pointerUp(track(), { clientX: 20, clientY: 10, pointerId: 1 })
      expect(onChange).not.toHaveBeenCalled()

      fireEvent.pointerDown(alpha(), { clientX: 10, button: 0, pointerId: 2 })
      fireEvent.pointerMove(track(), { clientX: 190, clientY: 10, pointerId: 2 })
      fireEvent.pointerCancel(track(), { pointerId: 2 })
      expect(onChange).not.toHaveBeenCalled()
      expect(fill().hasAttribute('data-pressed')).toBe(false)
    } finally {
      restore()
    }
  })

  it('leaves a press on another segment to its plain click', () => {
    const { onChange, restore } = setup()
    try {
      const delta = screen.getByRole('radio', { name: 'Delta' })
      fireEvent.pointerDown(delta, { clientX: 170, button: 0, pointerId: 1 })
      expect(fill().hasAttribute('data-pressed')).toBe(false)
      fireEvent.pointerUp(delta, { clientX: 170, pointerId: 1 })
      expect(onChange).not.toHaveBeenCalled()
      fireEvent.click(delta)
      expect(onChange).toHaveBeenCalledWith('d')
    } finally {
      restore()
    }
  })
})
