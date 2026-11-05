import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'

import { useFakeTimers } from '../../fake-timers'

// Reduced motion makes a release snap, so most tests read the resting place
// at once; the animated one turns it off to watch the spring arrive.
let reduced = true
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => reduced }))

const tick = mock(() => undefined)
mock.module('@/lib/haptics', () => ({
  selectionHapticFeedback: tick,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: () => undefined,
  alignmentHapticFeedback: () => undefined,
  outcomeHapticFeedback: () => undefined,
  haptic: () => undefined,
}))

const { PullToRefresh } = await import('@/components/phone/PullToRefresh')

/**
 * Finger travel for a pull of ``p`` px: the 8px slop the gesture waits out,
 * then every px of pull costs two of finger (resistance 0.5). The threshold
 * is 64px of pull, so 200px of finger is past it (96) and 100px is not (46).
 */
const PAST = 200
const SHORT = 100

let timers: ReturnType<typeof useFakeTimers> | null = null

beforeEach(() => {
  reduced = true
  tick.mockClear()
})
afterEach(() => {
  timers?.restore()
  timers = null
  cleanup()
})

type TouchKind = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'

/** Returns false when the event was ``preventDefault``-ed, like ``fireEvent``. */
function touch(type: TouchKind, el: Element, y: number, x = 100): boolean {
  const touches = type === 'touchEnd' || type === 'touchCancel' ? [] : [{ clientX: x, clientY: y }]
  return fireEvent[type](el, { touches })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function view(props: Partial<ComponentProps<typeof PullToRefresh>> = {}) {
  return (
    <PullToRefresh data-testid="scroller" onRefresh={() => Promise.resolve()} {...props}>
      <p>Rows</p>
    </PullToRefresh>
  )
}

const scrollerEl = () => screen.getByTestId('scroller')
const contentEl = () => scrollerEl().querySelector<HTMLElement>('[data-pull-to-refresh-content]')!
const indicatorEl = () => scrollerEl().firstElementChild as HTMLElement

/** Let a refresh that has been resolved run out its 400ms minimum, inside ``act``. */
async function finishRefresh(resolve?: () => void, ms = 400) {
  await act(async () => {
    resolve?.()
    timers!.tick(ms)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

/** Pull past the threshold and let go: a refresh begins. */
function pullAndRelease(finger = PAST) {
  touch('touchStart', scrollerEl(), 100)
  touch('touchMove', scrollerEl(), 100 + finger)
  touch('touchEnd', scrollerEl(), 100 + finger)
}

describe('PullToRefresh', () => {
  it('refreshes when released past the threshold, showing the status until it settles', async () => {
    timers = useFakeTimers()
    const refresh = deferred()
    const onRefresh = mock(() => refresh.promise)
    render(view({ onRefresh }))
    expect(screen.queryByRole('status')).toBeNull()

    touch('touchStart', scrollerEl(), 100)
    // Finger 200px down is a pull of (200 - 8) * 0.5 = 96px: the page is held still.
    expect(touch('touchMove', scrollerEl(), 100 + PAST)).toBe(false)
    expect(contentEl().style.translate).toBe('0 96px')
    expect(onRefresh).not.toHaveBeenCalled()

    touch('touchEnd', scrollerEl(), 100 + PAST)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
    // Held at 44px, not left where the finger let go.
    expect(contentEl().style.translate).toBe('0 44px')

    await finishRefresh(refresh.resolve)
    expect(screen.queryByRole('status')).toBeNull()
    expect(contentEl().style.translate).toBe('')
  })

  it('springs back without refreshing when released under the threshold', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh }))
    touch('touchStart', scrollerEl(), 100)
    // (100 - 8) * 0.5 = 46px of pull, under the 64px threshold.
    expect(touch('touchMove', scrollerEl(), 100 + SHORT)).toBe(false)
    expect(contentEl().style.translate).toBe('0 46px')
    touch('touchEnd', scrollerEl(), 100 + SHORT)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(contentEl().style.translate).toBe('')
  })

  it('fades the indicator in and turns the spinner with the pull', () => {
    render(view())
    expect(indicatorEl().style.opacity).toBe('0')
    touch('touchStart', scrollerEl(), 100)
    // 52px of finger = 22px of pull, half the indicator's 44px.
    touch('touchMove', scrollerEl(), 152)
    expect(parseFloat(indicatorEl().style.opacity)).toBeCloseTo(0.5, 2)
    // Centred in the gap the content has opened: 11px down, in a 44px box.
    expect(indicatorEl().style.translate).toBe('0 -11px')
    const spinner = indicatorEl().querySelector<HTMLElement>('span')!
    expect(parseFloat(spinner.style.rotate)).toBeCloseTo((22 / 64) * 270, 1)
    // Decoration while pulling: not announced.
    expect(spinner.getAttribute('role')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    touch('touchMove', scrollerEl(), 100 + PAST)
    expect(indicatorEl().style.opacity).toBe('1')
  })

  it('draws a 16px muted spinner that spins only while refreshing', async () => {
    timers = useFakeTimers()
    const refresh = deferred()
    render(view({ onRefresh: () => refresh.promise }))
    const icon = () => indicatorEl().querySelector('svg')!
    expect(icon().getAttribute('width')).toBe('16')
    expect(indicatorEl().className).toContain('text-(--color-text-muted)')
    expect(icon().getAttribute('class')).not.toContain('animate-spin')
    pullAndRelease()
    expect(icon().getAttribute('class')).toContain('animate-spin')
    await finishRefresh(refresh.resolve)
    expect(icon().getAttribute('class')).not.toContain('animate-spin')
  })

  it('ignores a pull when the list is scrolled down', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh }))
    Object.defineProperty(scrollerEl(), 'scrollTop', { configurable: true, value: 50 })
    touch('touchStart', scrollerEl(), 100)
    // Not ours: the list scrolls, nothing is prevented.
    expect(touch('touchMove', scrollerEl(), 100 + PAST)).toBe(true)
    expect(contentEl().style.translate).toBe('')
    touch('touchEnd', scrollerEl(), 100 + PAST)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('leaves an upward drag to the list, even one that later turns down', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh }))
    touch('touchStart', scrollerEl(), 300)
    expect(touch('touchMove', scrollerEl(), 200)).toBe(true)
    // Given up at the first move: coming back down is not a pull.
    expect(touch('touchMove', scrollerEl(), 500)).toBe(true)
    touch('touchEnd', scrollerEl(), 500)
    expect(contentEl().style.translate).toBe('')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('leaves a sideways drag alone', () => {
    render(view())
    touch('touchStart', scrollerEl(), 100, 100)
    // 60 across, 30 down: more sideways than down.
    expect(touch('touchMove', scrollerEl(), 130, 160)).toBe(true)
    expect(contentEl().style.translate).toBe('')
  })

  it('does nothing under the slop, so a tap never moves the page', () => {
    render(view())
    touch('touchStart', scrollerEl(), 100)
    expect(touch('touchMove', scrollerEl(), 105)).toBe(true)
    expect(contentEl().style.translate).toBe('')
  })

  it('lets a pull that came back up past where it began fall through to the list', () => {
    render(view())
    touch('touchStart', scrollerEl(), 300)
    expect(touch('touchMove', scrollerEl(), 400)).toBe(false)
    // Back above the point the pull began at: no pull left to hold the page for.
    expect(touch('touchMove', scrollerEl(), 280)).toBe(true)
    expect(contentEl().style.translate).toBe('')
  })

  it('ignores a new pull while refreshing', async () => {
    timers = useFakeTimers()
    const refresh = deferred()
    const onRefresh = mock(() => refresh.promise)
    render(view({ onRefresh }))
    pullAndRelease()
    expect(onRefresh).toHaveBeenCalledTimes(1)

    touch('touchStart', scrollerEl(), 100)
    expect(touch('touchMove', scrollerEl(), 100 + PAST)).toBe(true)
    touch('touchEnd', scrollerEl(), 100 + PAST)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    // Still held at the spinner, not dragged further.
    expect(contentEl().style.translate).toBe('0 44px')

    await finishRefresh(refresh.resolve)
    // Free again: the next pull refreshes.
    pullAndRelease()
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it('does nothing when disabled', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh, disabled: true }))
    touch('touchStart', scrollerEl(), 100)
    expect(touch('touchMove', scrollerEl(), 100 + PAST)).toBe(true)
    expect(contentEl().style.translate).toBe('')
    touch('touchEnd', scrollerEl(), 100 + PAST)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('lets a pull go when it becomes disabled mid-gesture', () => {
    const onRefresh = mock(() => Promise.resolve())
    const { rerender } = render(view({ onRefresh }))
    touch('touchStart', scrollerEl(), 100)
    touch('touchMove', scrollerEl(), 100 + PAST)
    expect(contentEl().style.translate).toBe('0 96px')
    rerender(view({ onRefresh, disabled: true }))
    touch('touchMove', scrollerEl(), 100 + PAST + 20)
    expect(contentEl().style.translate).toBe('')
    touch('touchEnd', scrollerEl(), 100 + PAST + 20)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('lets a pull go when a second finger lands', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh }))
    touch('touchStart', scrollerEl(), 100)
    touch('touchMove', scrollerEl(), 100 + PAST)
    fireEvent.touchMove(scrollerEl(), {
      touches: [
        { clientX: 100, clientY: 100 + PAST },
        { clientX: 200, clientY: 300 },
      ],
    })
    expect(contentEl().style.translate).toBe('')
    touch('touchEnd', scrollerEl(), 100 + PAST)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('springs back without refreshing when the touch is cancelled', () => {
    const onRefresh = mock(() => Promise.resolve())
    render(view({ onRefresh }))
    touch('touchStart', scrollerEl(), 100)
    touch('touchMove', scrollerEl(), 100 + PAST)
    touch('touchCancel', scrollerEl(), 100 + PAST)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(contentEl().style.translate).toBe('')
  })

  it('ticks once as the pull crosses the threshold, each way', () => {
    render(view())
    touch('touchStart', scrollerEl(), 100)
    touch('touchMove', scrollerEl(), 100 + SHORT)
    expect(tick).toHaveBeenCalledTimes(0)
    touch('touchMove', scrollerEl(), 100 + PAST)
    expect(tick).toHaveBeenCalledTimes(1)
    touch('touchMove', scrollerEl(), 100 + PAST + 30)
    expect(tick).toHaveBeenCalledTimes(1)
    touch('touchMove', scrollerEl(), 100 + SHORT)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  describe('the refresh', () => {
    it('holds the spinner for at least 400ms even when onRefresh settles at once', async () => {
      timers = useFakeTimers()
      render(view({ onRefresh: () => Promise.resolve() }))
      pullAndRelease()
      await finishRefresh(undefined, 399)
      expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
      expect(contentEl().style.translate).toBe('0 44px')
      await finishRefresh(undefined, 1)
      expect(screen.queryByRole('status')).toBeNull()
      expect(contentEl().style.translate).toBe('')
    })

    it('keeps the spinner past 400ms until a slow onRefresh settles', async () => {
      timers = useFakeTimers()
      const refresh = deferred()
      render(view({ onRefresh: () => refresh.promise }))
      pullAndRelease()
      await finishRefresh(undefined, 2000)
      expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
      await finishRefresh(refresh.resolve, 0)
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('stops the spinner when onRefresh rejects', async () => {
      timers = useFakeTimers()
      render(view({ onRefresh: () => Promise.reject(new Error('offline')) }))
      pullAndRelease()
      expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
      await finishRefresh()
      expect(screen.queryByRole('status')).toBeNull()
      expect(contentEl().style.translate).toBe('')
    })

    it('stops the spinner when onRefresh throws before returning a promise', async () => {
      timers = useFakeTimers()
      render(
        view({
          onRefresh: () => {
            throw new Error('not ready')
          },
        }),
      )
      pullAndRelease()
      await finishRefresh()
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('does not touch React state if the list unmounts while refreshing', async () => {
      timers = useFakeTimers()
      const refresh = deferred()
      const { unmount } = render(view({ onRefresh: () => refresh.promise }))
      pullAndRelease()
      unmount()
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      await finishRefresh(refresh.resolve)
      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
    })
  })

  describe('motion', () => {
    it('under reduced motion, snaps instead of animating, and still shows the status', async () => {
      timers = useFakeTimers()
      const raf = spyOn(globalThis, 'requestAnimationFrame')
      const refresh = deferred()
      render(view({ onRefresh: () => refresh.promise }))
      pullAndRelease()
      expect(contentEl().style.translate).toBe('0 44px')
      expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
      await finishRefresh(refresh.resolve)
      expect(contentEl().style.translate).toBe('')
      expect(raf).not.toHaveBeenCalled()
      raf.mockRestore()
    })

    it('springs to the 44px hold when motion is allowed', async () => {
      reduced = false
      render(view({ onRefresh: () => new Promise(() => {}) }))
      pullAndRelease()
      // Released at 96px: the spring has not run a frame yet.
      expect(contentEl().style.translate).toBe('0 96px')
      expect(screen.getByRole('status', { name: 'Refreshing' })).toBeTruthy()
      await waitFor(() => expect(contentEl().style.translate).toBe('0 44px'))
    })
  })

  describe('the scroll container', () => {
    it('is a scroll container that contains overscroll, and passes props and class through', () => {
      render(view({ className: 'h-40 bg-(--bg-page)', 'aria-label': 'Sessions' }))
      expect(scrollerEl().className).toContain('overflow-y-auto')
      expect(scrollerEl().className).toContain('overscroll-contain')
      expect(scrollerEl().className).toContain('h-40')
      expect(scrollerEl().getAttribute('aria-label')).toBe('Sessions')
      expect(screen.getByText('Rows')).toBeTruthy()
    })

    it('forwards an object ref to the scroll container', () => {
      const ref = createRef<HTMLDivElement>()
      render(view({ ref }))
      expect(ref.current).toBe(scrollerEl())
    })

    it('forwards a callback ref to the scroll container', () => {
      let node: HTMLDivElement | null = null
      render(
        view({
          ref: (el) => {
            node = el
          },
        }),
      )
      expect(node).toBe(scrollerEl())
    })

    it('lets the caller read the scroll position, which is what a pull is checked against', () => {
      const ref = createRef<HTMLDivElement>()
      render(view({ ref }))
      Object.defineProperty(ref.current!, 'scrollTop', { configurable: true, value: 12 })
      touch('touchStart', scrollerEl(), 100)
      expect(touch('touchMove', scrollerEl(), 100 + PAST)).toBe(true)
    })
  })
})
