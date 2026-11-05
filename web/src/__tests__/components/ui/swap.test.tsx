/**
 * IconSwap / RollingNumber — content replaced in place: the old copy leaves
 * as the new one enters, only when the key changes, never on first render,
 * and the number reads once for assistive tech.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { IconSwap, RollingNumber } from '@/components/ui/swap'

let calls: { el: Element; frames: Keyframe[] }[] = []
const original = HTMLElement.prototype.animate

beforeEach(() => {
  calls = []
  HTMLElement.prototype.animate = function (this: HTMLElement, frames, options) {
    calls.push({ el: this, frames: frames as Keyframe[] })
    return original.call(this, frames, options)
  }
})
afterEach(() => {
  HTMLElement.prototype.animate = original
  cleanup()
})

describe('IconSwap', () => {
  it('does not animate the first icon', () => {
    render(<IconSwap swapKey="copy"><i data-testid="copy" /></IconSwap>)
    expect(screen.getByTestId('copy')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('keeps the old icon, hidden from assistive tech, while the new one springs in', () => {
    const { rerender } = render(<IconSwap swapKey="copy"><i data-testid="copy" /></IconSwap>)
    rerender(<IconSwap swapKey="copied"><i data-testid="check" /></IconSwap>)
    const check = screen.getByTestId('check')
    const leaving = screen.getByTestId('copy').parentElement!
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    // One enter (from small and blurred) and one exit.
    expect(calls).toHaveLength(2)
    const enter = calls.find((c) => c.el === check.parentElement)!
    expect(enter.frames[0]).toMatchObject({ opacity: 0, transform: 'scale(0.5)' })
  })

  it('re-renders with the same key without animating', () => {
    const { rerender } = render(<IconSwap swapKey="copy"><i data-testid="copy" /></IconSwap>)
    rerender(<IconSwap swapKey="copy"><i data-testid="copy" /></IconSwap>)
    expect(calls).toHaveLength(0)
  })
})

describe('RollingNumber', () => {
  it('reads the number once', () => {
    render(<RollingNumber text="12,480" value={12480} />)
    expect(screen.getByText('12,480')).toBeTruthy()
  })

  it('rolls only the digits that changed', () => {
    const { rerender } = render(<RollingNumber text="12,480" value={12480} />)
    rerender(<RollingNumber text="12,517" value={12517} />)
    // Three places changed (4→5, 8→1, 0→7): an enter and an exit each.
    expect(calls).toHaveLength(6)
    const enters = calls.filter((c) => c.frames[0].transform === 'translateY(70%)')
    expect(enters).toHaveLength(3)
  })

  it('rolls down when the number falls', () => {
    const { rerender } = render(<RollingNumber text="20" value={20} />)
    rerender(<RollingNumber text="19" value={19} />)
    const enters = calls.filter((c) => c.frames[0].opacity === 0)
    expect(enters.every((c) => c.frames[0].transform === 'translateY(-70%)')).toBe(true)
  })
})
