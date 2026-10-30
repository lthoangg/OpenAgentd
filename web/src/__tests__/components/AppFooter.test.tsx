import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppFooter } from '@/components/AppFooter'
import { HealthDot } from '@/components/HealthDot'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { queryKeys } from '@/queries/keys'

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
    expect(screen.getByRole('button', { name: /Connected\. Change server/ }).textContent).toBe('built-in')
  })

  it('shows the backend indicator for an external server', () => {
    backendExternal = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Connected\. Change server/ })).toBeTruthy()
  })

  it('names the server in the label when the dot has no visible name (phone drawer)', () => {
    renderWithQueryClient(<HealthDot />)
    const dot = screen.getByRole('button', { name: 'Built-in server. Connected. Change server' })
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
    expect(screen.getByRole('button', { name: /Server not reachable\. Change server/ })).toBeTruthy()
  })

  it('shows the git branch for a coding workspace', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, {})

    expect(await screen.findByText('main')).toBeTruthy()
  })

  it('shows ahead/behind sync counts beside the branch', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />, undefined, { commits_ahead: 2, commits_behind: 1, upstream: 'origin/main' })

    expect(await screen.findByLabelText('2 commits to push')).toBeTruthy()
    expect(screen.getByLabelText('1 commits to pull')).toBeTruthy()
    expect(screen.getByText('*3')).toBeTruthy()
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

  it('renders model name and thinking level when provided and triggers session settings', async () => {
    const user = userEvent.setup()
    const onToggleSessionSettings = mock(() => {})
    renderWithQueryClient(
      <AppFooter
        sessionModel="anthropic/claude-3-7-sonnet"
        sessionThinkingLevel="high"
        onToggleSessionSettings={onToggleSessionSettings}
      />
    )
    const modelButton = screen.getByRole('button', { name: /anthropic\/claude-3-7-sonnet/i })
    expect(modelButton).toBeTruthy()
    expect(screen.getByText('claude-3-7-sonnet')).toBeTruthy()
    expect(screen.getByText('high')).toBeTruthy()

    await user.hover(modelButton)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/anthropic\/claude-3-7-sonnet.*Thinking: high.*Change model/)

    fireEvent.click(modelButton)
    expect(onToggleSessionSettings).toHaveBeenCalledTimes(1)
  })

  it('falls back to the agent default model when the session has no override', () => {
    renderWithQueryClient(
      <AppFooter sessionModel={null} defaultModel="openai/gpt-5" onToggleSessionSettings={() => {}} />
    )
    expect(screen.getByRole('button', { name: /openai\/gpt-5/i })).toBeTruthy()
  })

  it('shows the agent thinking level when the session sets none', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <AppFooter sessionModel={null} defaultModel="openai/gpt-5" defaultThinkingLevel="high" />
    )
    const button = screen.getByRole('button', { name: /openai\/gpt-5/i })
    expect(screen.getByText('high')).toBeTruthy()

    await user.hover(button)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/openai\/gpt-5Thinking: high/)
  })

  it('drops the agent thinking level once the session picks another model', () => {
    renderWithQueryClient(
      <AppFooter sessionModel="anthropic/claude-sonnet" defaultModel="openai/gpt-5" defaultThinkingLevel="high" />
    )
    expect(screen.getByText('claude-sonnet')).toBeTruthy()
    expect(screen.queryByText('high')).toBeNull()
  })

  it('prefers the session thinking level over the agent one', () => {
    renderWithQueryClient(
      <AppFooter sessionModel={null} sessionThinkingLevel="low" defaultModel="openai/gpt-5" defaultThinkingLevel="high" />
    )
    expect(screen.getByText('low')).toBeTruthy()
    expect(screen.queryByText('high')).toBeNull()
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


  it('keeps only the settings gear among the utilities', () => {
    renderWithQueryClient(<AppFooter />)

    for (const gone of ['Scheduled tasks', 'Telemetry', 'Help and shortcuts']) {
      expect(screen.queryByLabelText(gone)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /^Theme:/ })).toBeNull()

    fireEvent.click(screen.getByLabelText('Settings'))
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the last 24 hours of spend and opens Telemetry on that range', () => {
    useTelemetryStore.setState({ traceId: 'stale-trace' })
    renderWithQueryClient(<AppFooter />, 1.234)
    const button = screen.getByRole('button', { name: 'Spend in the last 24 hours: $1.23' })
    expect(button.textContent).toContain('$1.23')
    expect(button.textContent).toContain('24h')

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

  it('fetches no spend while the footer is hidden on a narrow window', () => {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    mount([{ running: true }], { seedSpend: false })
    expect(spendRequests()).toBe(0)
  })
})
