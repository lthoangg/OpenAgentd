/**
 * The in-app update notice: one line in the notices column.
 *
 * - The desktop downloads an update on its own and asks once, to restart.
 * - Android asks before the download (an APK on what may be mobile data) and
 *   hands the install to the system.
 * - `updater_install` restarts the process, so its promise never resolves;
 *   a failure (or the 60-second timeout) must leave "Installing update…" and
 *   say so in a toast.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// ---------------------------------------------------------------------------
// Tauri API mocks — must be declared before importing UpdateCard so that
// mock.module hoisting takes effect.
// ---------------------------------------------------------------------------

type StatusListener = (event: { payload: unknown }) => void

let capturedStatusListener: StatusListener | null = null
let capturedCheckListener: (() => void) | null = null

const unlistenStatusMock = mock(() => {})
const unlistenCheckMock = mock(() => {})

const listenMock = mock(async (...args: unknown[]) => {
  const event = String(args[0])
  const cb = args[1]
  if (event === 'updater-status') capturedStatusListener = cb as StatusListener
  else capturedCheckListener = cb as () => void
  return event === 'updater-status' ? unlistenStatusMock : unlistenCheckMock
})

mock.module('@tauri-apps/api/event', () => ({ listen: listenMock }))

// Track all invocations so tests can assert on them.
type InvokeCall = { command: string; args?: unknown }
const invokeCalls: InvokeCall[] = []

// Configurable per-test: what does `updater_install` do?
let installBehaviour: 'hang' | 'resolve-ok' | 'reject' = 'hang'
let installRejectMessage = 'install failed'
let checkResponse: Record<string, unknown> = { status: 'downloaded', version: '1.71.0', current_version: '1.70.0' }
let checkError: string | null = null
let downloadError: string | null = null

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  invokeCalls.push({ command, args: args[1] })

  if (command === 'updater_check') {
    if (checkError) throw new Error(checkError)
    return checkResponse
  }

  if (command === 'updater_download') {
    if (downloadError) throw new Error(downloadError)
    return { status: 'downloaded', version: '1.71.0', current_version: '1.70.0' }
  }

  if (command === 'updater_install') {
    if (installBehaviour === 'hang') {
      // Simulate the process restarting: the promise never resolves.
      return new Promise<never>(() => {})
    }
    if (installBehaviour === 'reject') {
      throw new Error(installRejectMessage)
    }
    // 'resolve-ok': command returned Ok(()) but process did NOT restart.
    // This is the buggy old behaviour — the timeout should catch it.
    return undefined
  }

  if (command === 'updater_release_notes') {
    const version = (args[1] as { version?: string } | undefined)?.version ?? 'unknown'
    return {
      version,
      url: `https://github.com/openagentd/openagentd/releases/tag/v${version}`,
      body: `# Release ${version}`,
    }
  }

  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const openExternalUrlMock = mock(async (_url: unknown) => {})

mock.module('@/lib/open-external', () => ({
  openExternalUrl: openExternalUrlMock,
}))

mock.module('@/utils/markdown', () => ({
  MarkdownBlock: ({ content }: { content: string }) => <div>{content}</div>,
}))

let platform = { isTauri: true, os: 'macos', isMacOverlay: true }
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => platform,
}))

// ---------------------------------------------------------------------------
// Import component after mocks are set up
// ---------------------------------------------------------------------------
import { UpdateCard } from '@/components/UpdateCard'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitStatus(payload: unknown) {
  capturedStatusListener?.({ payload })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  invokeCalls.length = 0
  capturedStatusListener = null
  capturedCheckListener = null
  checkError = null
  downloadError = null
  useToastStore.setState({ toasts: [] })
  installBehaviour = 'hang'
  installRejectMessage = 'install failed'
  checkResponse = { status: 'downloaded', version: '1.71.0', current_version: '1.70.0' }
  unlistenStatusMock.mockClear()
  unlistenCheckMock.mockClear()
  invokeMock.mockClear()
  openExternalUrlMock.mockClear()
  window.localStorage.clear()
  platform = { isTauri: true, os: 'macos', isMacOverlay: true }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

/** Seed the active-sessions list the sidebar keeps live. */
function seedActiveSessions(sessions: Array<{ running: boolean; needs_input?: boolean }>) {
  queryClient.setQueryData(queryKeys.session.sessions.active(), {
    pages: [{
      data: sessions.map((session, index) => ({ id: `s${index}`, workspace: '/w', ...session })),
      has_more: false,
    }],
    pageParams: [null],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DOWNLOADED = { status: 'downloaded', version: '1.71.0', current_version: '1.70.0' }
const AVAILABLE = { status: 'available', version: '1.71.0', current_version: '1.70.0' }
const installs = () => invokeCalls.filter((c) => c.command === 'updater_install')
const downloads = () => invokeCalls.filter((c) => c.command === 'updater_download')
const toasts = () => useToastStore.getState().toasts

/** Mount with the startup check finding nothing, then emit ``payload``. */
async function mountWith(payload: unknown) {
  checkResponse = { status: 'up_to_date', current_version: '1.70.0' }
  const view = render(<UpdateCard />)
  await waitFor(() => expect(capturedStatusListener).not.toBeNull())
  await act(async () => { emitStatus(payload) })
  return view
}

describe('UpdateCard — platform lifecycle', () => {
  it('does not initialize updater commands in the browser build', async () => {
    platform = { isTauri: false, os: 'macos', isMacOverlay: false }
    render(<UpdateCard />)

    await act(async () => {})

    expect(listenMock).not.toHaveBeenCalled()
    expect(invokeCalls).toHaveLength(0)
  })

  it('never checks for updates on iOS', async () => {
    platform = { isTauri: true, os: 'ios', isMacOverlay: false }
    checkResponse = AVAILABLE
    render(<UpdateCard />)

    await act(async () => {})

    expect(listenMock).not.toHaveBeenCalled()
    expect(invokeCalls).toHaveLength(0)
  })

  it('asks before downloading on Android, where the download is an APK', async () => {
    platform = { isTauri: true, os: 'android', isMacOverlay: false }
    await mountWith({ ...AVAILABLE, channel: 'apk' })

    expect(screen.getByText('OpenAgentd 1.71.0 is available')).toBeInTheDocument()
    expect(downloads()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloads()).toHaveLength(1))
    expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument()
  })

  it('installs an Android APK without a restart and stays ready to retry', async () => {
    platform = { isTauri: true, os: 'android', isMacOverlay: false }
    installBehaviour = 'resolve-ok'
    await mountWith({ ...DOWNLOADED, channel: 'apk' })

    expect(screen.getByText('OpenAgentd 1.71.0 is ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /restart/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(installs()).toHaveLength(1))
    // Android's installer took over; the line is back for another try.
    expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument()
    expect(toasts()).toHaveLength(0)
  })

  it('waits six hours after Later before showing the update again', async () => {
    const view = render(<UpdateCard />)
    const laterButton = await screen.findByRole('button', { name: 'Later' })

    const realDateNow = Date.now
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const clickedAt = 1_000_000
    const sixHoursMs = 6 * 60 * 60 * 1000
    let now = clickedAt
    let reminderCallback: (() => void) | undefined

    Date.now = () => now
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (delay === sixHoursMs) reminderCallback = callback as () => void
      return 99 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout

    try {
      invokeCalls.length = 0
      fireEvent.click(laterButton)

      expect(window.localStorage.getItem('openagentd.updater.dismissedUntil')).toBeNull()
      expect(reminderCallback).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument()

      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await Promise.resolve() })
      expect(invokeCalls.some((call) => call.command === 'updater_check')).toBe(false)

      now += sixHoursMs
      await act(async () => {
        reminderCallback?.()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(invokeCalls.filter((call) => call.command === 'updater_check')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
    } finally {
      view.unmount()
      Date.now = realDateNow
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })

  it('checks on startup after the app is relaunched during a prior Later cooldown', async () => {
    const firstRun = render(<UpdateCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }))

    invokeCalls.length = 0
    firstRun.unmount()
    capturedStatusListener = null

    render(<UpdateCard />)

    await waitFor(() => {
      expect(invokeCalls.filter((call) => call.command === 'updater_check')).toHaveLength(1)
    })
  })
})

describe('UpdateCard — one line, one decision', () => {
  it('downloads an available update on its own and shows nothing until it is ready', async () => {
    await mountWith(AVAILABLE)

    await waitFor(() => expect(downloads()).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()

    expect(await screen.findByText('OpenAgentd 1.71.0 is ready')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Later', 'Restart to update'])
  })

  it('downloads a version once, however often it is announced', async () => {
    await mountWith(AVAILABLE)
    await act(async () => { emitStatus(AVAILABLE) })
    await act(async () => { emitStatus({ ...AVAILABLE, status: 'downloading', downloaded_bytes: 1, total_bytes: 2 }) })

    expect(downloads()).toHaveLength(1)
  })

  it('shows nothing while the download runs or when it fails; the next check tries again', async () => {
    downloadError = 'network down'
    await mountWith(AVAILABLE)
    await act(async () => { emitStatus({ ...AVAILABLE, status: 'downloading', downloaded_bytes: 10, total_bytes: 50 }) })

    await waitFor(() => expect(downloads()).toHaveLength(1))
    expect(screen.queryByRole('button')).toBeNull()
    expect(toasts()).toHaveLength(0)
  })

  it('has no pill, no drag handle and no second step', async () => {
    await mountWith(DOWNLOADED)

    expect(screen.queryByRole('button', { name: /minimize|expand|drag|download|install/i })).toBeNull()
    expect(screen.queryByText(/ready to install/i)).toBeNull()
  })

  it('goes away on Later', async () => {
    await mountWith(DOWNLOADED)

    await userEvent.click(screen.getByRole('button', { name: 'Later' }))

    await waitFor(() => expect(screen.queryByText('OpenAgentd 1.71.0 is ready')).toBeNull())
  })
})

describe('UpdateCard — restarting', () => {
  it('says "Installing update…" as soon as the restart is asked for, and installs once', async () => {
    await mountWith(DOWNLOADED)

    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    expect(await screen.findByText('Installing update…')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(installs()).toHaveLength(1)
  })

  it('clears the restart timeout when unmounted during a pending install', async () => {
    const { unmount } = await mountWith(DOWNLOADED)

    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    let timeoutCallback: (() => void) | undefined
    let timeoutCleared = false
    globalThis.setTimeout = ((callback: TimerHandler) => {
      timeoutCallback = callback as () => void
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => { timeoutCleared = true }) as unknown as typeof clearTimeout
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
      await act(async () => { await Promise.resolve() })
      unmount()
      expect(timeoutCleared).toBe(true)
      act(() => timeoutCallback?.())
      expect(toasts()).toHaveLength(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })

  it('leaves "Installing update…" and says why in a toast when the install is refused', async () => {
    // A Tauri-side error (version mismatch, missing cache file) must not
    // leave the line on "Installing update…".
    installBehaviour = 'reject'
    installRejectMessage = 'Update has not been downloaded yet.'
    await mountWith(DOWNLOADED)

    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(["Couldn't update OpenAgentd"]))
    expect(toasts()[0].description).toBe('Update has not been downloaded yet.')
    expect(screen.queryByText('Installing update…')).toBeNull()
  })

  it('checks again after a refused install, so a stale download is fetched anew', async () => {
    installBehaviour = 'reject'
    installRejectMessage = 'Downloaded version 1.71.0 no longer matches the available version 1.72.0. Download the update again.'
    await mountWith(DOWNLOADED)
    checkResponse = { status: 'available', version: '1.72.0', current_version: '1.70.0' }
    invokeCalls.length = 0

    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    await waitFor(() => expect(downloads()).toHaveLength(1))
    expect(invokeCalls.filter((c) => c.command === 'updater_check')).toHaveLength(1)
  })
})

describe('UpdateCard — a check the user asked for', () => {
  async function mountAndCheck(response: Record<string, unknown>) {
    checkResponse = { status: 'up_to_date', current_version: '1.70.0' }
    render(<UpdateCard />)
    await waitFor(() => expect(capturedCheckListener).not.toBeNull())
    checkResponse = response
    await act(async () => { capturedCheckListener?.() })
  }

  it('answers "up to date" in a toast', async () => {
    await mountAndCheck({ status: 'up_to_date', current_version: '1.70.0' })

    await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(['OpenAgentd is up to date']))
    expect(toasts()[0].description).toBe('1.70.0 is the latest version.')
  })

  it('says a download started, since nothing else shows until it is ready', async () => {
    await mountAndCheck(AVAILABLE)

    await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(['Downloading OpenAgentd 1.71.0']))
    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeInTheDocument()
  })

  it('says so when the check fails', async () => {
    checkError = 'Updater unavailable: no endpoint'
    await mountAndCheck({})

    await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(["Couldn't check for updates"]))
  })
})

describe('UpdateCard — listener lifecycle', () => {
  it('registers both updater-status and updater-check-requested listeners on mount', async () => {
    render(<UpdateCard />)

    await waitFor(() => {
      const events = listenMock.mock.calls.map((c) => String(c[0]))
      expect(events).toContain('updater-status')
      expect(events).toContain('updater-check-requested')
    })
    await screen.findByRole('button', { name: 'Later' })
  })

  it('unlistens both listeners on unmount', async () => {
    const { unmount } = render(<UpdateCard />)
    await waitFor(() => expect(capturedStatusListener).not.toBeNull())

    unmount()

    // Give microtasks a chance to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(unlistenStatusMock).toHaveBeenCalled()
    expect(unlistenCheckMock).toHaveBeenCalled()
  })
})

describe('UpdateCard — restarting while agents work', () => {
  it('offers to restart when agents finish, and does so once they have', async () => {
    seedActiveSessions([{ running: true }])
    await mountWith(DOWNLOADED)

    await userEvent.click(screen.getByRole('button', { name: 'Restart when agents finish' }))

    expect(screen.getByText('Restarts to update when agents finish')).toBeInTheDocument()
    expect(installs()).toHaveLength(0)

    act(() => seedActiveSessions([]))
    await waitFor(() => expect(installs()).toHaveLength(1))
  })

  it('restarts now when asked to while it waits', async () => {
    seedActiveSessions([{ running: true }])
    await mountWith(DOWNLOADED)
    await userEvent.click(screen.getByRole('button', { name: 'Restart when agents finish' }))

    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))

    await waitFor(() => expect(installs()).toHaveLength(1))
  })

  it('stops waiting on Cancel and keeps the update ready', async () => {
    seedActiveSessions([{ running: true }])
    await mountWith(DOWNLOADED)
    await userEvent.click(screen.getByRole('button', { name: 'Restart when agents finish' }))

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    act(() => seedActiveSessions([]))

    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeInTheDocument()
    expect(installs()).toHaveLength(0)
  })

  it('restarts right away when sessions only wait on the user', async () => {
    seedActiveSessions([{ running: true, needs_input: true }])
    await mountWith(DOWNLOADED)

    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    await waitFor(() => expect(installs()).toHaveLength(1))
  })
})
