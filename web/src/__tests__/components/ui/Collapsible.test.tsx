import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

import { Collapsible } from '@/components/ui/collapsible'
import { useFakeTimers } from '../../fake-timers'

let timers: ReturnType<typeof useFakeTimers> | null = null
afterEach(() => {
  cleanup()
  timers?.restore()
  timers = null
})

function fold(open: boolean, keepMounted = false) {
  return (
    <Collapsible open={open} keepMounted={keepMounted} data-testid="fold">
      <button type="button">Inside</button>
    </Collapsible>
  )
}

describe('Collapsible', () => {
  it('renders nothing while closed', () => {
    render(fold(false))
    expect(screen.queryByTestId('fold')).toBeNull()
  })

  it('shows open with no entry motion when it mounts open', () => {
    render(fold(true))
    const el = screen.getByTestId('fold')
    expect(el.className).toContain('grid-rows-[1fr]')
    expect(screen.getByRole('button', { name: 'Inside' })).toBeTruthy()
  })

  it('opens to its full rows when toggled open', () => {
    const view = render(fold(false))
    act(() => view.rerender(fold(true)))
    expect(screen.getByTestId('fold').className).toContain('grid-rows-[1fr]')
    expect(screen.getByTestId('fold').dataset.state).toBe('open')
  })

  it('keeps the content through the closing motion, hidden and out of the tab order, then unmounts it', () => {
    const view = render(fold(true))
    timers = useFakeTimers()
    act(() => view.rerender(fold(false)))

    const el = screen.getByTestId('fold')
    expect(el.dataset.state).toBe('closed')
    expect(el.className).toContain('grid-rows-[0fr]')
    expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull()
    expect((el.firstElementChild as HTMLElement).inert).toBe(true)

    act(() => timers!.tick(300))
    expect(screen.queryByTestId('fold')).toBeNull()
  })

  it('keeps closed content mounted when asked to', () => {
    const view = render(fold(true, true))
    timers = useFakeTimers()
    act(() => view.rerender(fold(false, true)))
    act(() => timers!.tick(300))
    expect(screen.getByTestId('fold').dataset.state).toBe('closed')
    expect(screen.getByText('Inside')).toBeTruthy()
  })

  it('clips only while moving, so focus outlines show at rest', () => {
    const view = render(fold(false))
    timers = useFakeTimers()
    act(() => view.rerender(fold(true)))
    const inner = screen.getByTestId('fold').firstElementChild as HTMLElement
    expect(inner.className).toContain('overflow-hidden')
    act(() => timers!.tick(300))
    expect(inner.className).not.toContain('overflow-hidden')
  })
})
