/**
 * useHistoryBackForwardShortcuts — ⌘[ / ⌘] step backward/forward through
 * the router's history stack, mirroring browser back/forward.
 *
 * Happy DOM resolves to os='unknown' → isPrimaryShortcut expects Ctrl.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, cleanup } from '@testing-library/react'

const backMock = mock(() => {})
const forwardMock = mock(() => {})

mock.module('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { back: backMock, forward: forwardMock } }),
}))

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: false, os: 'linux' }),
}))

const { useHistoryBackForwardShortcuts } = await import('@/hooks/useHistoryBackForwardShortcuts')

afterEach(() => {
  cleanup()
  backMock.mockClear()
  forwardMock.mockClear()
})

function Harness() {
  useHistoryBackForwardShortcuts()
  return null
}

function keydown(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...opts })
  window.dispatchEvent(e)
  return e
}

describe('useHistoryBackForwardShortcuts', () => {
  it('calls history.back() on Ctrl+[', () => {
    render(<Harness />)
    const e = keydown('[')
    expect(backMock).toHaveBeenCalledTimes(1)
    expect(forwardMock).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('calls history.forward() on Ctrl+]', () => {
    render(<Harness />)
    const e = keydown(']')
    expect(forwardMock).toHaveBeenCalledTimes(1)
    expect(backMock).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('does not fire without the primary modifier', () => {
    render(<Harness />)
    const e = keydown('[', { ctrlKey: false })
    expect(backMock).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores unrelated keys even with the primary modifier', () => {
    render(<Harness />)
    keydown('p')
    expect(backMock).not.toHaveBeenCalled()
    expect(forwardMock).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount', () => {
    const { unmount } = render(<Harness />)
    unmount()
    keydown('[')
    expect(backMock).not.toHaveBeenCalled()
  })
})
