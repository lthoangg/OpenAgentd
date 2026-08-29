import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppFooter } from '@/components/AppFooter'
const mockOpenSettings = mock(() => {})

mock.module('@/stores/useSettingsStore', () => ({
  useSettingsStore: (selector: (s: { openSettings: () => void }) => unknown) =>
    selector({ openSettings: mockOpenSettings }),
}))

mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => ({ isSuccess: true, isError: false, isLoading: false }),
}))

mock.module('@/api/client', () => ({
  getCodingWorkspaceStatus: mock(async () => ({
    workspace: '/path/to/project',
    name: 'project',
    is_git_repo: true,
    branch: 'main',
    dirty: { staged: 1, unstaged: 2, untracked: 0 },
  })),
}))

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AppFooter', () => {
  beforeEach(() => {
    mockOpenSettings.mockClear()
  })

  it('renders backend status indicator', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('status', { name: 'Application status' })).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
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
    expect(screen.getByText('anthropic/claude-3-7-sonnet')).toBeTruthy()
    expect(screen.getByText('(high)')).toBeTruthy()

    await user.hover(modelButton)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/Active Model: anthropic\/claude-3-7-sonnet/i)

    fireEvent.click(modelButton)
    expect(onToggleSessionSettings).toHaveBeenCalledTimes(1)
  })

  it('renders fast mode pill when fast mode is enabled', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <AppFooter sessionFastMode={true} />
    )
    expect(screen.getByText('fast')).toBeTruthy()
    await user.hover(screen.getByText('fast'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Fast mode active')
  })


  it('renders scheduler and help palette buttons and triggers actions', () => {
    const onToggleScheduler = mock(() => {})
    const onTogglePalette = mock(() => {})

    renderWithQueryClient(
      <AppFooter
        onToggleScheduler={onToggleScheduler}
        onTogglePalette={onTogglePalette}
      />
    )

    const schedulerBtn = screen.getByLabelText('Scheduler')
    fireEvent.click(schedulerBtn)
    expect(onToggleScheduler).toHaveBeenCalledTimes(1)

    const helpBtn = screen.getByLabelText('Help and shortcuts')
    fireEvent.click(helpBtn)
    expect(onTogglePalette).toHaveBeenCalledTimes(1)

    const settingsBtn = screen.getByLabelText('Settings')
    fireEvent.click(settingsBtn)
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('exposes telemetry navigation in the utility cluster', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('link', { name: 'Telemetry' })).toBeTruthy()
  })
})
