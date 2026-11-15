import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppFooter } from '@/components/AppFooter'
import { HealthDot } from '@/components/HealthDot'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useTerminalStore, _resetTerminalStoreForTests, type TerminalSessionMeta } from '@/stores/useTerminalStore'
import { useUIStore } from '@/stores/useUIStore'
import { APP_EVENTS } from '@/lib/app-events'
import { queryKeys } from '@/queries/keys'
import { queryClient as appQueryClient } from '@/lib/query-client'
import { useConnectPhoneStore } from '@/lib/connect-phone'

const navigate = mock(() => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
const mockOpenSettings = mock(() => {})

// ``getState`` too: opening telemetry closes Settings through the UI store,
// which calls back into this module.
mock.module('@/stores/useSettingsStore', () => {
  const state = { openSettings: mockOpenSettings, closeSettings: () => {} }
  return {
    useSettingsStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  }
})

let healthError = false
let backendExternal = false
mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => ({ isSuccess: !healthError, isError: healthError, isLoading: false }),
  useBackendStatusQuery: () => ({
    data: {
      mode: backendExternal ? 'external' : 'bundled',
      base_url: backendExternal ? 'https://agents.example.com' : 'http://127.0.0.1:4082',
      sidecar_running: true,
      external: backendExternal,
      supports_bundled: true,
      servers: [],
    },
    isSuccess: true,
  }),
}))

let requested: string[] = []

function renderWithQueryClient(ui: React.ReactElement, spendUsd?: number, gitStatus?: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  })
  if (spendUsd !== undefined) {
    client.setQueryData(queryKeys.observability.summary(1, { workspace: null, model: null, session: null }), {
      totals: { estimated_cost_usd: spendUsd },
    })
  }
  if (gitStatus) {
    client.setQueryData(queryKeys.coding.status('/path/to/project'), {
      workspace: '/path/to/project',
      name: 'project',
      is_git_repo: true,
      branch: 'main',
      dirty: { staged: 1, unstaged: 2, untracked: 0 },
      ...gitStatus,
    })
  }
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AppFooter', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    mockOpenSettings.mockClear()
    healthError = false
    backendExternal = false
    requested = []
    // Requests stay pending unless a test seeds the cache.
    globalThis.fetch = ((input: unknown) => {
      requested.push(String(input))
      return new Promise(() => {})
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('names the connected backend even when it is the healthy bundled one', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByLabelText('Status bar')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Connected\. Change computer/ }).textContent).toBe('This computer')
  })

  it('shows the backend indicator for an external server', () => {
    backendExternal = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Connected\. Change computer/ })).toBeTruthy()
  })

  it('names the server in the label when the dot has no visible name (phone drawer)', () => {
    renderWithQueryClient(<HealthDot />)
    const dot = screen.getByRole('button', { name: 'This computer. Connected. Change computer' })
    expect(dot.textContent).toBe('')
  })

  it('keeps every status item in Tab order', () => {
    renderWithQueryClient(<AppFooter />)
    const footer = screen.getByLabelText('Status bar')
    const buttons = Array.from(footer.querySelectorAll<HTMLElement>('button'))
    expect(buttons.length).toBeGreaterThan(1)
    expect(buttons.every((el) => el.tabIndex === 0)).toBe(true)
  })

  it('shows the backend indicator when the backend is unhealthy', () => {
    healthError = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Can't reach\. Change computer/ })).toBeTruthy()
  })

  // Desktop mockup 12.1: the dot alone was the only sign, and easy to miss.
  it("says Can't reach beside the server's name while it does not answer", () => {
    healthError = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Can't reach\. Change computer/ }).textContent).toBe("This computerCan't reach")
  })

  it('adds no word while the server answers', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.queryByText("Can't reach")).toBeNull()
  })

  it('shows the git branch for a coding workspace', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, {})

    expect(await screen.findByText('main')).toBeTruthy()
  })

  it('shows ahead/behind sync counts beside the branch', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, { commits_ahead: 2, commits_behind: 1, upstream: 'origin/main' })

    expect(await screen.findByLabelText('2 commits to push')).toBeTruthy()
    expect(screen.getByLabelText('1 commits to pull')).toBeTruthy()
    expect(screen.getByText('3 changed')).toBeTruthy()
  })

  it('says "N changed" for the dirty files, not a bare "*N", and leaves the chip out when clean', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, { dirty: { staged: 0, unstaged: 0, untracked: 0 } })

    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.queryByText(/changed/)).toBeNull()
    expect(screen.queryByText(/^\*/)).toBeNull()
  })

  it('names the branch action "Open Git" with its shortcut, in the muted tone', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, {})
    const branch = await screen.findByRole('button', { name: /^Git branch main/ })

    fireEvent.mouseEnter(branch.parentElement!)
    const tooltip = await screen.findByRole('tooltip')
    const action = within(tooltip).getByText(/^Open Git \(.+\)$/)
    expect(action.textContent).toMatch(/^Open Git \((⌘⇧G|⇧⌘G|Ctrl\+Shift\+G)\)$/)
    expect(action.className).toContain('text-(--color-text-muted)')
  })

  it('skips the git branch and its probe for the chat workspace', () => {
    renderWithQueryClient(<AppFooter workspace="/Users/name" chatWorkspace />)

    expect(screen.getByLabelText('Status bar')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    expect(requested.some((url) => url.includes('/workspace/status'))).toBe(false)
  })

  it('sits on the page tone in light mode and the recessed rail only in dark', () => {
    renderWithQueryClient(<AppFooter />)
    const footer = screen.getByLabelText('Status bar')
    expect(footer.className).toContain('bg-(--bg-page)')
    expect(footer.className).toContain('dark:bg-(--bg-sidebar)')
    expect(footer.className.split(' ')).not.toContain('bg-(--bg-sidebar)')
  })

  it('leaves the model to the run deck under the composer', () => {
    renderWithQueryClient(<AppFooter workspace="/tmp/repo" sessionId="s1" />)
    expect(screen.queryByRole('button', { name: /model/i })).toBeNull()
  })

  it('renders fast mode pill when fast mode is enabled', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <AppFooter sessionFastMode={true} />
    )
    expect(screen.getByText('fast')).toBeTruthy()
    await user.hover(screen.getByText('fast'))
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/^Fast mode is on/)
  })

  it('keeps the fast mode badge out of the Tab order: it is a badge, not a control', () => {
    renderWithQueryClient(<AppFooter sessionFastMode={true} />)
    const badge = screen.getByRole('img', { name: 'Fast mode is on' })
    expect(badge.hasAttribute('tabindex')).toBe(false)
    expect(badge.tabIndex).toBe(-1)
    // Every real control in the bar stays reachable.
    const footer = screen.getByLabelText('Status bar')
    const buttons = Array.from(footer.querySelectorAll<HTMLElement>('button'))
    expect(buttons.every((el) => el.tabIndex === 0)).toBe(true)
  })


  it('keeps only the settings gear among the utilities', () => {
    renderWithQueryClient(<AppFooter />)

    for (const gone of ['Scheduled tasks', 'Telemetry', 'Help and shortcuts']) {
      expect(screen.queryByLabelText(gone)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /^Theme:/ })).toBeNull()

    fireEvent.click(screen.getByLabelText('Settings'))
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the last 24 hours of spend', () => {
    renderWithQueryClient(<AppFooter />, 1.234)
    const button = screen.getByRole('button', { name: 'Spend in the last 24 hours: $1.23' })
    expect(button.textContent).toContain('$1.23')
    expect(button.textContent).toContain('24h')
  })

  it('names the spend action "Open usage", in sentence case', async () => {
    renderWithQueryClient(<AppFooter />, 1.234)
    const button = screen.getByRole('button', { name: 'Spend in the last 24 hours: $1.23' })

    fireEvent.mouseEnter(button.parentElement!)
    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('Open usage')).toBeTruthy()
    expect(tooltip.textContent).not.toContain('Open Usage')
  })

  it('opens Telemetry on that range from the spend item', () => {
    useTelemetryStore.setState({ traceId: 'stale-trace' })
    renderWithQueryClient(<AppFooter />, 1.234)
    const button = screen.getByRole('button', { name: 'Spend in the last 24 hours: $1.23' })

    fireEvent.click(button)
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    // Entry points land on the overview, not the last trace.
    expect(useTelemetryStore.getState().traceId).toBeNull()
    expect(useTelemetryStore.getState().days).toBe(1)
    useUIStore.getState().closeTelemetry()
  })

  it('leaves the spend out until the summary loads', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.queryByRole('button', { name: /Spend in the last 24 hours/ })).toBeNull()
  })

  it('shows no spend figure with the Detail setting on Simple', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    try {
      renderWithQueryClient(<AppFooter />, 1.234)
      expect(screen.queryByRole('button', { name: /Spend in the last 24 hours/ })).toBeNull()
      expect(screen.queryByText(/24h/)).toBeNull()
      // The rest of the bar is as in Full.
      expect(screen.getByLabelText('Settings')).toBeTruthy()
    } finally {
      useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
    }
  })
})

/** Shells keep running with the terminal group hidden: the status bar says so. */
describe('AppFooter terminals', () => {
  const WORKSPACE = '/path/to/project'
  const realFetch = globalThis.fetch

  /** Metadata only: no PTY, no socket, so the footer is the only thing under test. */
  function seedTerminals(...sessions: Array<{ contextKey: string; status: TerminalSessionMeta['status'] }>) {
    useTerminalStore.setState({
      sessions: Object.fromEntries(sessions.map((session, i) => {
        const id = `term-${i + 1}`
        return [id, { id, title: `Terminal ${i + 1}`, order: i + 1, ...session }]
      })),
    })
  }
  const item = () => screen.queryByRole('button', { name: /terminals? running$/ })

  beforeEach(() => {
    _resetTerminalStoreForTests()
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  })
  afterEach(() => {
    cleanup()
    _resetTerminalStoreForTests()
    globalThis.fetch = realFetch
  })

  it('says "1 terminal running" for a single live shell', () => {
    seedTerminals({ contextKey: WORKSPACE, status: 'connected' })
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()?.textContent).toBe('1 terminal running')
  })

  it('names its action "Open terminal", as the palette does, in the muted tone (no faded words)', async () => {
    seedTerminals({ contextKey: WORKSPACE, status: 'connected' })
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    fireEvent.mouseEnter(item()!.parentElement!)
    const tooltip = await screen.findByRole('tooltip')
    const action = within(tooltip).getByText('Open terminal')
    expect(action.className).toContain('text-(--color-text-muted)')
    expect(action.className).not.toMatch(/opacity-/)
  })

  it('says "N terminals running" for several, connecting ones included', () => {
    seedTerminals(
      { contextKey: WORKSPACE, status: 'connected' },
      { contextKey: WORKSPACE, status: 'connecting' },
      { contextKey: WORKSPACE, status: 'connected' },
    )
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()?.textContent).toBe('3 terminals running')
  })

  it('is hidden while the workspace has no terminals', () => {
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()).toBeNull()
    expect(screen.queryByText(/running/)).toBeNull()
  })

  it('does not count shells that ended or failed', () => {
    seedTerminals(
      { contextKey: WORKSPACE, status: 'exited' },
      { contextKey: WORKSPACE, status: 'error' },
    )
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()).toBeNull()

    cleanup()
    seedTerminals(
      { contextKey: WORKSPACE, status: 'exited' },
      { contextKey: WORKSPACE, status: 'connected' },
    )
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()?.textContent).toBe('1 terminal running')
  })

  it("does not count another workspace's terminals", () => {
    seedTerminals(
      { contextKey: '/path/to/other', status: 'connected' },
      { contextKey: '/path/to/other', status: 'connected' },
    )
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()).toBeNull()

    cleanup()
    seedTerminals(
      { contextKey: '/path/to/other', status: 'connected' },
      { contextKey: WORKSPACE, status: 'connected' },
    )
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()?.textContent).toBe('1 terminal running')
  })

  it('shows none when no workspace is attached', () => {
    seedTerminals({ contextKey: WORKSPACE, status: 'connected' })
    renderWithQueryClient(<AppFooter />)
    expect(item()).toBeNull()
  })

  it('follows shells as they start and end', () => {
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    expect(item()).toBeNull()

    act(() => seedTerminals({ contextKey: WORKSPACE, status: 'connecting' }))
    expect(item()?.textContent).toBe('1 terminal running')

    act(() => seedTerminals({ contextKey: WORKSPACE, status: 'connected' }, { contextKey: WORKSPACE, status: 'connected' }))
    expect(item()?.textContent).toBe('2 terminals running')

    act(() => seedTerminals({ contextKey: WORKSPACE, status: 'exited' }))
    expect(item()).toBeNull()
  })

  it('is a focusable 24px status item like the others', () => {
    seedTerminals({ contextKey: WORKSPACE, status: 'connected' })
    renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
    const button = item()!
    expect(screen.getByLabelText('Status bar').contains(button)).toBe(true)
    expect(button.tabIndex).toBe(0)
    expect(button.className.split(' ')).toContain('h-6')
  })

  it('shows the terminals on click, once', () => {
    seedTerminals({ contextKey: WORKSPACE, status: 'connected' })
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openTerminal, opened)
    try {
      renderWithQueryClient(<AppFooter workspace={WORKSPACE} />)
      fireEvent.click(item()!)
      expect(opened).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(APP_EVENTS.openTerminal, opened)
    }
  })
})

/** Spend only changes while a model call runs, so the footer polls on activity. */
describe('AppFooter spend refresh', () => {
  const summaryKey = queryKeys.observability.summary(1, { workspace: null, model: null, session: null })
  const realFetch = globalThis.fetch
  const realMatchMedia = window.matchMedia
  let requested: string[] = []

  beforeEach(() => {
    requested = []
    globalThis.fetch = ((input: unknown) => {
      requested.push(String(input))
      return new Promise(() => {})
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    window.matchMedia = realMatchMedia
    cleanup()
  })

  const activePage = (rows: Array<{ running?: boolean; needs_input?: boolean }>) => ({
    pages: [{ data: rows.map((r, i) => ({ id: `s${i}`, title: null, agent_name: null, created_at: null, updated_at: null, workspace: '/w', ...r })), next_cursor: null, has_more: false }],
    pageParams: [null],
  })

  function mount(rows: Array<{ running?: boolean; needs_input?: boolean }>, { seedSpend = true } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    if (seedSpend) client.setQueryData(summaryKey, { totals: { estimated_cost_usd: 1 } })
    client.setQueryData(queryKeys.session.sessions.active(), activePage(rows))
    render(<QueryClientProvider client={client}><AppFooter /></QueryClientProvider>)
    const interval = () => client.getQueryCache().find({ queryKey: summaryKey })?.observers[0]?.options.refetchInterval
    return { client, interval }
  }
  const spendRequests = () => requested.filter((url) => url.includes('/observability/summary')).length

  it('polls every minute while a turn runs and slowly while idle', () => {
    expect(mount([{ running: true }]).interval()).toBe(60_000)
    cleanup()
    expect(mount([]).interval()).toBe(15 * 60_000)
  })

  it('does not count a session waiting on the user as spending', () => {
    expect(mount([{ running: true, needs_input: true }]).interval()).toBe(15 * 60_000)
  })

  it('refreshes spend once when the last running turn finishes', async () => {
    const { client } = mount([{ running: true }])
    expect(spendRequests()).toBe(0)
    act(() => { client.setQueryData(queryKeys.session.sessions.active(), activePage([{ running: false }])) })
    await waitFor(() => expect(spendRequests()).toBe(1))
  })

  it('fetches no spend with the Detail setting on Simple, where none is shown', async () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    try {
      const { client } = mount([{ running: true }], { seedSpend: false })
      expect(spendRequests()).toBe(0)
      // Nor when the last running turn ends, which refreshes it in Full.
      act(() => { client.setQueryData(queryKeys.session.sessions.active(), activePage([{ running: false }])) })
      await act(async () => { await Promise.resolve() })
      expect(spendRequests()).toBe(0)
    } finally {
      useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
    }
  })

  it('fetches no spend while the footer is hidden on a narrow window', () => {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    mount([{ running: true }], { seedSpend: false })
    expect(spendRequests()).toBe(0)
  })
})

/** Connect your phone: one click from the desktop's status bar to the QR code. */
describe('AppFooter Connect your phone', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')
  const realFetch = globalThis.fetch
  let cloudState: Record<string, unknown> = { state: 'guest', notice: null }
  let cloudCalls: string[] = []

  /** The desktop app on a Mac: account calls go through the shell to the built-in server. */
  function inDesktopApp() {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command !== 'desktop_cloud_call') throw new Error(`unexpected command: ${command}`)
        cloudCalls.push(`${String(args.method)} ${String(args.path)}`)
        return { status: 200, body: JSON.stringify(cloudState) }
      },
      transformCallback: () => 0,
    }
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  }
  const button = () => screen.queryByRole('button', { name: 'Connect your phone' })

  beforeEach(() => {
    cloudState = { state: 'guest', notice: null }
    cloudCalls = []
    backendExternal = false
    mockOpenSettings.mockClear()
    useConnectPhoneStore.setState({ requested: 0, handled: 0 })
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  })
  afterEach(() => {
    cleanup()
    appQueryClient.clear()
    globalThis.fetch = realFetch
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    if (realPlatform) Object.defineProperty(window.navigator, 'platform', realPlatform)
    else delete (window.navigator as unknown as Record<string, unknown>).platform
  })

  it('is offered to a desktop on its own server that is not in an account', async () => {
    inDesktopApp()
    renderWithQueryClient(<AppFooter />)
    expect(await screen.findByRole('button', { name: 'Connect your phone' })).toBeTruthy()
  })

  it('opens Account and asks it to sign in, without signing in itself', async () => {
    inDesktopApp()
    renderWithQueryClient(<AppFooter />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect your phone' }))

    expect(mockOpenSettings).toHaveBeenCalledWith('account')
    expect(useConnectPhoneStore.getState().requested).toBe(1)
    expect(cloudCalls).not.toContain('POST /login')
  })

  it('returns to a sign-in under way without starting another', async () => {
    inDesktopApp()
    cloudState = { state: 'signing_in', user_code: 'BCDF-GHJK', url: 'https://a.example/device', fingerprint: 'f', expires_in: 600 }
    renderWithQueryClient(<AppFooter />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect your phone' }))

    expect(mockOpenSettings).toHaveBeenCalledWith('account')
    expect(useConnectPhoneStore.getState().requested).toBe(0)
  })

  it('goes away once this computer is in an account', async () => {
    inDesktopApp()
    cloudState = { state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 }
    renderWithQueryClient(<AppFooter />)
    await waitFor(() => expect(cloudCalls).toContain('GET /status'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(button()).toBeNull()
  })

  it('is not offered while the window is on another server', async () => {
    inDesktopApp()
    backendExternal = true
    renderWithQueryClient(<AppFooter />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(button()).toBeNull()
    expect(cloudCalls).toEqual([])
  })

  it('is not offered outside the desktop app', async () => {
    renderWithQueryClient(<AppFooter />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(button()).toBeNull()
  })
})
