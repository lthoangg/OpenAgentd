import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// Strip framer-motion's real animation/drag machinery down to plain DOM
// nodes. Without this, AnimatePresence keeps a "removed" toast mounted
// during its exit transition, which races with the fake timers below and
// has nothing to do with the auto-dismiss/status-message behavior under
// test here.
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      style: _style,
      variants: _variants,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      layout: _layout,
      drag: _drag,
      dragConstraints: _dragConstraints,
      dragElastic: _dragElastic,
      dragMomentum: _dragMomentum,
      onDragEnd: _onDragEnd,
      whileDrag: _whileDrag,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
  },
  useMotionValue: () => ({ get: () => 0, set: () => {} }),
  useTransform: () => 1,
  useReducedMotion: () => false,
}))

// Deterministic fake timers — see App.bootstrap.test.tsx for the same
// pattern. Bun's test runner has no built-in jest-style fake timer API.
function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realDateNow = Date.now
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
  Date.now = () => now

  return {
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      Date.now = realDateNow
    },
  }
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
})

describe('ToastStack auto-dismiss', () => {
  it('dismisses a toast after its duration elapses with no interaction', () => {
    const timers = useFakeTimers()
    try {
      useToastStore.setState({
        toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 4500 }],
      })
      render(<ToastStack />)
      expect(screen.getByText('Saved')).toBeTruthy()

      act(() => timers.tick(4500))
      expect(screen.queryByText('Saved')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('pauses the countdown while the pointer is over the toast', () => {
    const timers = useFakeTimers()
    try {
      useToastStore.setState({
        toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 4500 }],
      })
      render(<ToastStack />)
      const toast = screen.getByText('Saved').closest('[role]')!

      fireEvent.mouseEnter(toast)
      // Well past the original duration — must not dismiss while hovered.
      act(() => timers.tick(10_000))
      expect(screen.getByText('Saved')).toBeTruthy()

      fireEvent.mouseLeave(toast)
      act(() => timers.tick(4500))
      expect(screen.queryByText('Saved')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('preserves only the remaining time after a pause, not a full reset', () => {
    const timers = useFakeTimers()
    try {
      useToastStore.setState({
        toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 4500 }],
      })
      render(<ToastStack />)
      const toast = screen.getByText('Saved').closest('[role]')!

      // Burn 4000ms of the 4500ms budget before pausing.
      act(() => timers.tick(4000))
      fireEvent.mouseEnter(toast)
      fireEvent.mouseLeave(toast)

      // Only ~500ms should remain — not a fresh 4500ms window.
      act(() => timers.tick(500))
      expect(screen.queryByText('Saved')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('pauses the countdown while the toast has keyboard focus', () => {
    const timers = useFakeTimers()
    try {
      useToastStore.setState({
        toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 4500 }],
      })
      render(<ToastStack />)
      const toast = screen.getByText('Saved').closest('[role]')!

      fireEvent.focus(toast)
      act(() => timers.tick(10_000))
      expect(screen.getByText('Saved')).toBeTruthy()

      fireEvent.blur(toast)
      act(() => timers.tick(4500))
      expect(screen.queryByText('Saved')).toBeNull()
    } finally {
      timers.restore()
    }
  })
})

describe('ToastStack status-message semantics (WCAG 4.1.3)', () => {
  it('keeps an error toast up until the user closes it', () => {
    const timers = useFakeTimers()
    try {
      useToastStore.getState().push({ tone: 'error', title: 'Could not save' })
      render(<ToastStack />)
      act(() => timers.tick(60_000))
      expect(screen.getByText('Could not save')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText('Could not save')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('runs the toast action and closes the toast', () => {
    const retry = mock(() => {})
    useToastStore.getState().push({ tone: 'error', title: 'Could not load', action: { label: 'Retry', onAction: retry } })
    render(<ToastStack />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Could not load')).toBeNull()
  })

  it('gives an error toast role="alert" and aria-live="assertive" so it interrupts assistive tech', () => {
    useToastStore.setState({
      toasts: [{ id: 't-err', tone: 'error', title: 'Something failed', durationMs: 4500 }],
    })
    render(<ToastStack />)
    const toast = screen.getByText('Something failed').closest('[role]')!
    expect(toast.getAttribute('role')).toBe('alert')
    expect(toast.getAttribute('aria-live')).toBe('assertive')
  })

  it('gives success and info toasts role="status" and aria-live="polite" so they do not preempt the user', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-ok', tone: 'success', title: 'Saved successfully', durationMs: 4500 },
        { id: 't-info', tone: 'info', title: 'Heads up', durationMs: 4500 },
      ],
    })
    render(<ToastStack />)

    const success = screen.getByText('Saved successfully').closest('[role]')!
    expect(success.getAttribute('role')).toBe('status')
    expect(success.getAttribute('aria-live')).toBe('polite')

    const info = screen.getByText('Heads up').closest('[role]')!
    expect(info.getAttribute('role')).toBe('status')
    expect(info.getAttribute('aria-live')).toBe('polite')
  })
})

describe('ToastStack placement', () => {
  it('lists the newest toast first, so it sits nearest the top edge of its column', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-1', tone: 'info', title: 'First', durationMs: null },
        { id: 't-2', tone: 'error', title: 'Second', durationMs: null },
        { id: 't-3', tone: 'success', title: 'Third', durationMs: null },
      ],
    })
    render(<ToastStack />)

    const shown = Array.from(document.querySelectorAll('[role="status"], [role="alert"]')).map((el) => el.querySelector('p')?.textContent)
    expect(shown).toEqual(['Third', 'Second', 'First'])
  })

  it('keeps each toast live-region role when the order flips', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-1', tone: 'info', title: 'First', durationMs: null },
        { id: 't-2', tone: 'error', title: 'Second', durationMs: null },
      ],
    })
    render(<ToastStack />)

    expect(screen.getByText('Second').closest('[role]')?.getAttribute('role')).toBe('alert')
    expect(screen.getByText('First').closest('[role]')?.getAttribute('role')).toBe('status')
  })

  it('does not reorder the store while reversing for display', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-1', tone: 'info', title: 'First', durationMs: null },
        { id: 't-2', tone: 'info', title: 'Second', durationMs: null },
      ],
    })
    render(<ToastStack />)

    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(['t-1', 't-2'])
  })

  it('leaves positioning to the notice column: not fixed itself, full width on phones', () => {
    const { container } = render(<ToastStack />)
    const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/)

    expect(classes).not.toContain('fixed')
    expect(classes).not.toContain('mobile-safe-toast')
    expect(classes).toContain('w-full')
    expect(classes).toContain('sm:max-w-sm')
  })
})
