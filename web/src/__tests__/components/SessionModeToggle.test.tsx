/**
 * Code / Plan is one button: it names the mode in force and a tap switches
 * to the other, so the run deck spends one word on it, not two segments.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SessionModeToggle } from '@/components/SessionModeToggle'

afterEach(cleanup)

const classes = (el: Element) => el.className.toString().split(/\s+/)

describe('SessionModeToggle', () => {
  test('is one button naming the mode, and a tap switches to the other', () => {
    const onChange = mock((..._args: unknown[]) => {})
    const { rerender } = render(<SessionModeToggle mode="code" onChange={onChange} />)

    expect(screen.getAllByRole('button')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: 'Code mode. Switch to Plan' })
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith('plan')

    rerender(<SessionModeToggle mode="plan" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan mode. Switch to Code' }))
    expect(onChange).toHaveBeenLastCalledWith('code')
  })

  test('fills Plan with the selection tone and leaves Code on the keycap wash', () => {
    const { rerender } = render(<SessionModeToggle mode="code" onChange={() => {}} />)
    expect(classes(screen.getByRole('button'))).toContain('bg-(--bg-key)')

    rerender(<SessionModeToggle mode="plan" onChange={() => {}} />)
    expect(classes(screen.getByRole('button'))).toEqual(
      expect.arrayContaining(['bg-(--color-fill-selected)', 'text-(--color-text-on-selected)']),
    )
  })

  test('keeps its width across a switch: both words hold the slot, the other one unseen', () => {
    render(<SessionModeToggle mode="code" onChange={() => {}} />)
    const words = Array.from(screen.getByRole('button').querySelectorAll('[data-mode-word]'))
    expect(words.map((w) => [w.textContent, w.classList.contains('invisible'), w.getAttribute('aria-hidden')])).toEqual([
      ['Code', false, 'true'],
      ['Plan', true, 'true'],
    ])
  })

  test('marks a queued switch as not yet in force', () => {
    // The backend defers a mid-turn switch instead of stopping the turn, so
    // the toggle has to show the pick without claiming it is already active.
    render(<SessionModeToggle mode="plan" pending onChange={() => {}} />)

    const queued = screen.getByRole('button', { name: 'Plan mode (applies after the current turn). Switch to Code' })
    expect(queued.getAttribute('title')).toBe('Applies when the current turn finishes')
    expect(classes(queued)).toContain('italic')
  })

  test('does not annotate the mode when nothing is queued', () => {
    render(<SessionModeToggle mode="plan" onChange={() => {}} />)

    const active = screen.getByRole('button', { name: 'Plan mode. Switch to Code' })
    expect(active.getAttribute('title')).toBeNull()
    expect(classes(active)).not.toContain('italic')
  })

  test('ignores a tap while disabled, but stays pressable so a press never steals focus', () => {
    const onChange = mock(() => {})
    render(<SessionModeToggle mode="code" disabled onChange={onChange} />)

    const toggle = screen.getByRole('button', { name: 'Code mode. Switch to Plan' }) as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})
