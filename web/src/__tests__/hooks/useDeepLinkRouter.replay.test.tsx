/**
 * The deep-link plugin reports the last link the app was opened with for the
 * life of the app, so a reloaded page reads it again. A link this app run
 * already handled is not run twice; the same link opened again while the
 * page could not listen (iOS ended it in the background, or it was
 * reloading) is a new one, which the phone shell's link count tells apart.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
let os = 'ios'
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => ({ isTauri: true, os, isMacOverlay: false, isFullscreen: false }) }))

const WIDGET_LINK = 'openagentd://session/s1'
/** What the plugin reports as the link the app was last opened with. */
let lastOpened: string[] = [WIDGET_LINK]
const getCurrent = mock(() => Promise.resolve(lastOpened))
let openUrl: ((urls: string[]) => void) | null = null
mock.module('@tauri-apps/plugin-deep-link', () => ({
  getCurrent,
  onOpenUrl: async (cb: (urls: string[]) => void) => {
    openUrl = cb
    return () => { openUrl = null }
  },
}))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
/** Links the shell has seen arrive this app run; null: a shell without the count. */
let linksOpened: number | null = 1
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'deep_link_sequence' && linksOpened !== null) return linksOpened
    throw new Error(`unexpected command: ${command}`)
  },
}))
const navigate = mock((..._args: unknown[]) => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }))

const { useDeepLinkRouter } = await import('@/hooks/useDeepLinkRouter')

function DeepLinkRouter() {
  useDeepLinkRouter()
  return null
}

/** A page load: the router mounts and reads the link the app was last opened with. */
async function loadPage() {
  getCurrent.mockClear()
  render(<DeepLinkRouter />)
  await waitFor(() => expect(getCurrent).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  os = 'ios'
  linksOpened = 1
  lastOpened = [WIDGET_LINK]
  openUrl = null
  localStorage.clear()
  sessionStorage.clear()
  navigate.mockClear()
})

afterEach(cleanup)

describe('the link the app was last opened with, read again by a reloaded page', () => {
  it('is not run twice', async () => {
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(1)
    cleanup()
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('runs when the same link was opened again while no page was listening', async () => {
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(1)
    cleanup()
    // The same widget row, tapped again: the shell counted another link.
    linksOpened = 2
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(navigate.mock.calls[1][0]).toEqual({ href: '/s1' })
    // And that one is not run a third time by the next reload.
    cleanup()
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('is not run again after it arrived while the page was listening', async () => {
    lastOpened = []
    await loadPage()
    linksOpened = 2
    lastOpened = [WIDGET_LINK]
    openUrl?.([WIDGET_LINK])
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    cleanup()
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('is told apart by the link alone on a shell without the count', async () => {
    linksOpened = null
    await loadPage()
    cleanup()
    await loadPage()
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
