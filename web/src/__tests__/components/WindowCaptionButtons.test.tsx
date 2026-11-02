import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useFakeTimers } from '../fake-timers'

// The Windows app has no system frame: the page draws the caption buttons.
// A snapshot, taken before the mock: the module namespace is live and would
// otherwise point back at the mock itself.
const actualPlatform = { ...(await import('@/hooks/use-platform')) }
let platform: { isTauri: boolean; os: string; isFullscreen: boolean } = { isTauri: true, os: 'windows', isFullscreen: false }
const platformInfo = () => ({ ...actualPlatform.getPlatform(), ...platform })
mock.module('@/hooks/use-platform', () => ({
  ...actualPlatform,
  getPlatform: platformInfo,
  usePlatform: platformInfo,
}))

let maximized = false
let resized: (() => void) | null = null
const minimize = mock(async () => {})
const toggleMaximize = mock(async () => {})
const close = mock(async () => {})
mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized: async () => maximized,
    onResized: async (handler: () => void) => {
      resized = handler
      return () => { resized = null }
    },
  }),
}))
const invoke = mock(async (..._args: unknown[]) => undefined)
mock.module('@tauri-apps/api/core', () => ({ invoke }))

import { WindowCaptionButtons } from '@/components/WindowCaptionButtons'

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  platform = { isTauri: true, os: 'windows', isFullscreen: false }
  maximized = false
  resized = null
  minimize.mockClear()
  toggleMaximize.mockClear()
  close.mockClear()
  invoke.mockClear()
})
afterEach(cleanup)

describe('WindowCaptionButtons', () => {
  it('draws Minimize, Maximize and Close, in that order, in the Windows app', async () => {
    render(<WindowCaptionButtons />)
    await flush()

    const names = screen.getAllByRole('button').map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Minimize', 'Maximize', 'Close'])
    expect(document.documentElement).toHaveAttribute('data-window-caption')
  })

  const framed: [string, typeof platform][] = [
    ['macOS app', { isTauri: true, os: 'macos', isFullscreen: false }],
    ['Linux app', { isTauri: true, os: 'linux', isFullscreen: false }],
    ['browser on Windows', { isTauri: false, os: 'windows', isFullscreen: false }],
    ['full-screen Windows app', { isTauri: true, os: 'windows', isFullscreen: true }],
  ]
  it.each(framed)('draws nothing in the %s', (_name, value) => {
    platform = value
    render(<WindowCaptionButtons />)
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(document.documentElement).not.toHaveAttribute('data-window-caption')
  })

  it('minimizes, maximizes and closes the window', async () => {
    render(<WindowCaptionButtons />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(minimize).toHaveBeenCalledTimes(1)
    expect(toggleMaximize).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('turns Maximize into Restore Down while the window is maximized', async () => {
    render(<WindowCaptionButtons />)
    await flush()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()

    maximized = true
    await act(async () => { resized?.() })
    await flush()
    expect(screen.getByRole('button', { name: 'Restore Down' })).toBeInTheDocument()

    maximized = false
    await act(async () => { resized?.() })
    await flush()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
  })

  it('takes the window-caption marker off when it unmounts', async () => {
    const view = render(<WindowCaptionButtons />)
    await flush()
    view.unmount()
    await flush()
    expect(document.documentElement).not.toHaveAttribute('data-window-caption')
    expect(resized).toBeNull()
  })

  describe('Snap Layouts', () => {
    let timers: ReturnType<typeof useFakeTimers> | null = null
    afterEach(() => {
      timers?.restore()
      timers = null
    })

    async function renderWithTimers() {
      render(<WindowCaptionButtons />)
      await flush()
      timers = useFakeTimers()
      return screen.getByRole('button', { name: 'Maximize' })
    }

    it('opens them when the mouse rests on Maximize', async () => {
      const button = await renderWithTimers()

      fireEvent.pointerEnter(button, { pointerType: 'mouse' })
      act(() => timers?.tick(499))
      expect(invoke).not.toHaveBeenCalled()
      await act(async () => { timers?.tick(1) })

      expect(invoke.mock.calls).toEqual([['show_snap_layouts']])
    })

    it('does not open them when the mouse moves on first', async () => {
      const button = await renderWithTimers()

      fireEvent.pointerEnter(button, { pointerType: 'mouse' })
      act(() => timers?.tick(300))
      fireEvent.pointerLeave(button, { pointerType: 'mouse' })
      await act(async () => { timers?.tick(1000) })

      expect(invoke).not.toHaveBeenCalled()
    })

    it('does not open them once the button is pressed', async () => {
      const button = await renderWithTimers()

      fireEvent.pointerEnter(button, { pointerType: 'mouse' })
      fireEvent.pointerDown(button, { pointerType: 'mouse' })
      await act(async () => { timers?.tick(1000) })

      expect(invoke).not.toHaveBeenCalled()
    })

    it('does not open them for a touch', async () => {
      const button = await renderWithTimers()

      fireEvent.pointerEnter(button, { pointerType: 'touch' })
      await act(async () => { timers?.tick(1000) })

      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
