import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, render, waitFor } from '@testing-library/react'

// In the desktop app, the View → Text Size items show the page's size.
let isTauri = true
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri, os: 'windows' }) }))
mock.module('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: async () => {} }) }))
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
const invoke = mock(async (..._args: unknown[]) => {})
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { useDesktopCommands } = await import('@/lib/desktop-commands')
const { useDisplayPrefsStore } = await import('@/stores/useDisplayPrefsStore')

function Harness() {
  useDesktopCommands()
  return null
}

const sizeReports = () => invoke.mock.calls.filter((call) => call[0] === 'set_menu_text_size').map((call) => call[1])
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  isTauri = true
  invoke.mockClear()
  useDisplayPrefsStore.setState({ textSize: 'default' })
})
afterEach(() => {
  useDisplayPrefsStore.setState({ textSize: 'default' })
})

describe('useDesktopCommands text size reporting', () => {
  it('tells the shell the current size at once, whenever it changes, and when the window takes focus', async () => {
    useDisplayPrefsStore.setState({ textSize: 'large' })
    const view = render(<Harness />)
    await waitFor(() => expect(sizeReports()).toEqual([{ size: 'large' }]))

    act(() => useDisplayPrefsStore.getState().setTextSize('compact'))
    await settle()
    expect(sizeReports().at(-1)).toEqual({ size: 'compact' })

    const before = sizeReports().length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(sizeReports().length).toBe(before + 1)

    view.unmount()
    act(() => useDisplayPrefsStore.getState().setTextSize('default'))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(sizeReports().length).toBe(before + 1)
  })

  it('does not report outside the desktop app', async () => {
    isTauri = false
    render(<Harness />)
    await settle()
    act(() => useDisplayPrefsStore.getState().setTextSize('compact'))
    await settle()
    expect(sizeReports()).toEqual([])
  })
})
