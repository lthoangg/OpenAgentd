import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SessionModeToggle } from '@/components/SessionModeToggle'

afterEach(cleanup)

describe('SessionModeToggle', () => {
  test('grows to the composer 36px touch height on a phone', () => {
    render(<SessionModeToggle mode="code" onChange={() => {}} />)

    expect(screen.getByRole('group', { name: 'Interaction mode' }).className).toContain('max-md:pointer-coarse:h-9')
  })

  test('shows the active mode and selects the other mode directly', () => {
    const onChange = mock(() => {})

    render(<SessionModeToggle mode="code" onChange={onChange} />)

    expect(screen.getByRole('button', { name: 'Code mode' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }))
    expect(onChange).toHaveBeenCalledWith('plan')
  })

  test('marks a queued switch as not yet in force', () => {
    // The backend defers a mid-turn switch instead of stopping the turn, so
    // the toggle has to show the pick without claiming it is already active.
    render(<SessionModeToggle mode="plan" pending onChange={() => {}} />)

    const queued = screen.getByRole('button', { name: 'Plan mode (applies after the current turn)' })
    expect(queued.getAttribute('aria-pressed')).toBe('true')
    expect(queued.getAttribute('title')).toBe('Applies when the current turn finishes')
  })

  test('does not annotate the mode when nothing is queued', () => {
    render(<SessionModeToggle mode="plan" onChange={() => {}} />)

    const active = screen.getByRole('button', { name: 'Plan mode' })
    expect(active.getAttribute('title')).toBeNull()
  })

  test('keeps the chosen mode pressable but inert, so a press never steals focus', () => {
    const onChange = mock(() => {})
    render(<SessionModeToggle mode="code" onChange={onChange} />)

    const active = screen.getByRole('button', { name: 'Code mode' }) as HTMLButtonElement
    expect(active.disabled).toBe(false)
    expect(active.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(active)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('ignores clicks on every segment while disabled', () => {
    const onChange = mock(() => {})
    render(<SessionModeToggle mode="code" disabled onChange={onChange} />)

    const other = screen.getByRole('button', { name: 'Plan mode' }) as HTMLButtonElement
    expect(other.disabled).toBe(false)
    expect(other.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(other)
    expect(onChange).not.toHaveBeenCalled()
  })
})
