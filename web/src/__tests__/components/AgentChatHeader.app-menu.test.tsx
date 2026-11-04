import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

// The ☰ button exists only in the Windows and Linux desktop apps, where the
// OS menu bar is hidden.
// A snapshot, taken before the mock: the module namespace is live and would
// otherwise point back at the mock itself.
const actualPlatform = { ...(await import('@/hooks/use-platform')) }
let platform: { isTauri: boolean; os: string; isFullscreen?: boolean } = { isTauri: true, os: 'windows' }
const platformInfo = () => ({ ...actualPlatform.getPlatform(), ...platform })
mock.module('@/hooks/use-platform', () => ({
  ...actualPlatform,
  getPlatform: platformInfo,
  usePlatform: platformInfo,
}))

let menuClosed: (() => void) | null = null
const invoke = mock((..._args: unknown[]) => new Promise<void>((resolve) => { menuClosed = resolve }))
mock.module('@tauri-apps/api/core', () => ({ invoke }))

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'

beforeEach(() => {
  platform = { isTauri: true, os: 'windows' }
  invoke.mockClear()
  menuClosed = null
})
afterEach(() => {
  // Close a menu a test left open so the next test starts clean.
  act(() => { menuClosed?.() })
  cleanup()
})

function renderHeader(overrides: Partial<ComponentProps<typeof AgentChatHeader>> = {}) {
  const props: ComponentProps<typeof AgentChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: false,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    onSidebarToggle: () => undefined,
    sessionId: 'session-1',
    todos: [],
    onToggleTasks: () => undefined,
    tasksViewActive: false,
    workspacePanel: null,
    onWorkspaceFiles: () => undefined,
    ...overrides,
  }
  return render(<AgentChatHeader {...props} />)
}

/** Place the button where a real layout would, so the menu's anchor is checkable. */
function placeAppMenuButton(left: number, bottom: number): void {
  const button = screen.getByRole('button', { name: 'Application menu' })
  button.getBoundingClientRect = () => ({ left, bottom, top: bottom - 28, right: left + 28, width: 28, height: 28, x: left, y: bottom - 28, toJSON: () => ({}) })
}

function tapAlt(): void {
  fireEvent.keyDown(window, { key: 'Alt', altKey: true })
  fireEvent.keyUp(window, { key: 'Alt' })
}

// The menu is opened through a dynamic import of the Tauri API.
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe('AgentChatHeader application menu', () => {
  it.each(['windows', 'linux'])('puts a ☰ button left of the sidebar button in the %s app', (os) => {
    platform = { isTauri: true, os }
    const { container } = renderHeader()

    const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
    expect(names.slice(0, 2)).toEqual(['Application menu', 'Toggle sidebar'])
  })

  const unsupported: [string, { isTauri: boolean; os: string }][] = [
    ['macOS app', { isTauri: true, os: 'macos' }],
    ['browser', { isTauri: false, os: 'windows' }],
    ['phone app', { isTauri: true, os: 'ios' }],
  ]
  it.each(unsupported)('has no ☰ button in the %s', (_name, value) => {
    platform = value
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Application menu' })).toBeNull()
  })

  it('pops the application menu up at the buttons bottom-left when clicked', async () => {
    renderHeader()
    placeAppMenuButton(12, 36)

    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }))
    await flush()

    expect(invoke.mock.calls).toEqual([['show_app_menu', { x: 12, y: 36 }]])
  })

  it('opens it from a bare Alt tap, at the same place', async () => {
    renderHeader()
    placeAppMenuButton(12, 36)

    tapAlt()
    await flush()

    expect(invoke.mock.calls).toEqual([['show_app_menu', { x: 12, y: 36 }]])
  })

  it('leaves Alt chords and a tap inside a text field alone', async () => {
    renderHeader()
    fireEvent.keyDown(window, { key: 'Alt', altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true })
    fireEvent.keyUp(window, { key: 'ArrowUp' })
    fireEvent.keyUp(window, { key: 'Alt' })
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    tapAlt()
    field.remove()
    await flush()

    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not open a second menu while one is open', async () => {
    renderHeader()

    tapAlt()
    await flush()
    tapAlt()
    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }))
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)

    await act(async () => { menuClosed?.() })
    await flush()
    tapAlt()
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('hides the button in a narrow window, whose ☰ is the sidebar drawer, but Alt still opens the menu', async () => {
    renderHeader({ isMobile: true })
    expect(screen.queryByRole('button', { name: 'Application menu' })).toBeNull()

    tapAlt()
    await flush()

    expect(invoke.mock.calls).toEqual([['show_app_menu', { x: 8, y: 36 }]])
  })

  it('stops listening for Alt when the header unmounts', async () => {
    const view = renderHeader()
    view.unmount()
    tapAlt()
    await flush()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('AgentChatHeader as the Windows title bar', () => {
  // The room sits inside the Review panel's cap, so the cap's left edge
  // still lines up with the panel's.
  it('leaves the three caption buttons room at its right end in the Windows app', () => {
    const { container } = renderHeader()
    expect(container.querySelector('[data-header-cap="dock"]')).toHaveClass('pr-[138px]')
    expect(container.querySelector('header')).not.toHaveClass('pr-[138px]')
  })

  const framed: [string, { isTauri: boolean; os: string; isFullscreen?: boolean }][] = [
    ['Linux app', { isTauri: true, os: 'linux' }],
    ['browser on Windows', { isTauri: false, os: 'windows' }],
    ['full-screen Windows app', { isTauri: true, os: 'windows', isFullscreen: true }],
  ]
  it.each(framed)('keeps its usual right edge in the %s', (_name, value) => {
    platform = value
    const { container } = renderHeader()
    expect(container.querySelector('header')).not.toHaveClass('pr-[138px]')
    expect(container.querySelector('[data-header-cap="dock"]')).not.toHaveClass('pr-[138px]')
  })
})
