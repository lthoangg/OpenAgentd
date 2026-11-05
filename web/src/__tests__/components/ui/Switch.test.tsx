import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Switch } from '@/components/ui/switch'

afterEach(cleanup)

const toggle = () => screen.getByRole('switch')
const thumb = () => toggle().querySelector('span')!

function press(x: number) {
  fireEvent.pointerDown(toggle(), { clientX: x, button: 0, pointerId: 1 })
}

describe('Switch', () => {
  it('toggles once on a plain click', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(10)
    fireEvent.pointerUp(toggle(), { clientX: 10, pointerId: 1 })
    fireEvent.click(toggle())
    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('toggles from the keyboard (a key press arrives as a click)', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    fireEvent.click(toggle())
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it('lets the thumb go on the click even when no pointerup arrived', () => {
    render(<Switch checked={false} aria-label="Wi-Fi" />)
    press(10)
    expect(toggle().hasAttribute('data-pressed')).toBe(true)
    fireEvent.click(toggle())
    expect(toggle().hasAttribute('data-pressed')).toBe(false)
    expect(thumb().className).toContain('w-4')
  })

  it('keeps the data attributes and role', () => {
    render(<Switch checked aria-label="Wi-Fi" />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(toggle().hasAttribute('data-checked')).toBe(true)
    expect(toggle().getAttribute('data-slot')).toBe('switch')
  })

  it('stretches the thumb toward the side it will travel to while pressed', () => {
    const { rerender } = render(<Switch checked={false} aria-label="Wi-Fi" />)
    expect(thumb().className).toContain('w-4')
    expect(thumb().className).toContain('translate-x-0')
    press(10)
    expect(toggle().hasAttribute('data-pressed')).toBe(true)
    // Off: it grows rightwards from the left edge.
    expect(thumb().className).toContain('w-[22px]')
    expect(thumb().className).toContain('translate-x-0')
    fireEvent.pointerUp(toggle(), { clientX: 10, pointerId: 1 })
    expect(toggle().hasAttribute('data-pressed')).toBe(false)

    rerender(<Switch checked aria-label="Wi-Fi" />)
    expect(thumb().className).toContain('translate-x-[18px]')
    press(10)
    // On: it grows leftwards from the right edge (22px thumb rests at 12px).
    expect(thumb().className).toContain('w-[22px]')
    expect(thumb().className).toContain('translate-x-[12px]')
  })

  it('drags to the other side and sets it on release', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(10)
    fireEvent.pointerMove(toggle(), { clientX: 30, pointerId: 1 })
    expect(thumb().className).toContain('translate-x-[12px]')
    fireEvent.pointerUp(toggle(), { clientX: 30, pointerId: 1 })
    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
    // The click that follows a drag is not a second toggle.
    fireEvent.click(toggle(), { detail: 1 })
    expect(onCheckedChange).toHaveBeenCalledTimes(1)
  })

  it('a drag that ends on the side it started on changes nothing', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(30)
    fireEvent.pointerMove(toggle(), { clientX: 20, pointerId: 1 })
    fireEvent.pointerMove(toggle(), { clientX: 36, pointerId: 1 })
    fireEvent.pointerUp(toggle(), { clientX: 36, pointerId: 1 })
    expect(onCheckedChange).not.toHaveBeenCalled()
    fireEvent.click(toggle(), { detail: 1 })
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('ignores motion under the 4px threshold', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(10)
    fireEvent.pointerMove(toggle(), { clientX: 13, pointerId: 1 })
    fireEvent.pointerUp(toggle(), { clientX: 13, pointerId: 1 })
    expect(onCheckedChange).not.toHaveBeenCalled()
    fireEvent.click(toggle(), { detail: 1 })
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('a cancelled press settles back without toggling', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(10)
    fireEvent.pointerMove(toggle(), { clientX: 30, pointerId: 1 })
    fireEvent.pointerCancel(toggle(), { pointerId: 1 })
    expect(toggle().hasAttribute('data-pressed')).toBe(false)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const onCheckedChange = mock(() => {})
    render(<Switch checked={false} disabled onCheckedChange={onCheckedChange} aria-label="Wi-Fi" />)
    press(10)
    fireEvent.pointerMove(toggle(), { clientX: 30, pointerId: 1 })
    fireEvent.pointerUp(toggle(), { clientX: 30, pointerId: 1 })
    fireEvent.click(toggle())
    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(toggle().hasAttribute('data-pressed')).toBe(false)
  })
})

describe('Switch — motion tokens', () => {
  it('slides the thumb with translate and width on the spring token', () => {
    render(<Switch checked aria-label="Wi-Fi" />)
    expect(thumb().className).toContain('transition-[translate,width]')
    expect(thumb().className).toContain('ease-(--ease-spring-soft)')
  })
})
