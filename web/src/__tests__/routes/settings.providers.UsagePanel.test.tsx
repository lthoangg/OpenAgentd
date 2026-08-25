import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'

import type { ProviderUsageLimit } from '@/api/client'
import { UsagePanel } from '@/components/settings/pages/settings.providers/UsagePanel'

afterEach(cleanup)

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function makeLimit(overrides: Partial<ProviderUsageLimit> = {}): ProviderUsageLimit {
  return {
    limit_id: 'primary',
    limit_name: null,
    primary: { used_percent: 42, window_minutes: 300, resets_at: null },
    secondary: null,
    credits: null,
    spend: null,
    plan_type: null,
    rate_limit_reached_type: null,
    ...overrides,
  }
}

describe('UsagePanel', () => {
  it('renders nothing when there are no limits', () => {
    const { container } = renderWithQuery(<UsagePanel limits={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('can transition from no limits to populated usage without changing hook order', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const queryClient = new QueryClient()
    try {
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <UsagePanel limits={[]} />
        </QueryClientProvider>,
      )

      rerender(
        <QueryClientProvider client={queryClient}>
          <UsagePanel limits={[makeLimit()]} />
        </QueryClientProvider>,
      )

      expect(screen.getByText('42% used')).toBeTruthy()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders a labeled row per limit window with rounded percent', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit({ limit_name: 'Session', primary: { used_percent: 41.6, window_minutes: 300, resets_at: null } })]} />)
    expect(screen.getByText('Session \u00B7 5h')).toBeTruthy()
    expect(screen.getByText('42% used')).toBeTruthy()
  })

  it('renders both primary and secondary windows for the same limit', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            limit_name: 'Claude',
            primary: { used_percent: 2, window_minutes: 300, resets_at: null },
            secondary: { used_percent: 3, window_minutes: 60 * 24 * 7, resets_at: null },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Claude \u00B7 5h')).toBeTruthy()
    expect(screen.getByText('Claude \u00B7 7d')).toBeTruthy()
    expect(screen.getByText('2% used')).toBeTruthy()
    expect(screen.getByText('3% used')).toBeTruthy()
  })

  it('falls back to "Codex" / limit_id / "Usage" when limit_name is absent', () => {
    const { rerender } = renderWithQuery(<UsagePanel limits={[makeLimit({ limit_id: 'codex', limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} />)
    expect(screen.getByText('Codex')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ limit_id: 'custom-limit', limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} /></QueryClientProvider>)
    expect(screen.getByText('custom-limit')).toBeTruthy()

    // "Usage" also appears as the static panel header, so the fallback
    // label row renders it a second time.
    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ limit_id: null, limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} /></QueryClientProvider>)
    expect(screen.getAllByText('Usage')).toHaveLength(2)
  })

  it('clamps out-of-range percentages into the progressbar aria attributes', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit({ primary: { used_percent: 150, window_minutes: 60, resets_at: null } })]} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByText('100% used')).toBeTruthy()
  })

  it('shows "Resetting now" once the reset timestamp has passed', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    renderWithQuery(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: past } })]} />)
    expect(screen.getByText('Resetting now')).toBeTruthy()
  })

  it('formats future resets in minutes, hours, and days', () => {
    const nowS = Math.floor(Date.now() / 1000)
    const { rerender } = renderWithQuery(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 5 * 60 } })]} />)
    expect(screen.getByText('Resets in 5m')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 2 * 3600 + 10 * 60 } })]} /></QueryClientProvider>)
    expect(screen.getByText('Resets in 2h 10m')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 3 * 86400 } })]} /></QueryClientProvider>)
    expect(screen.getByText('Resets in 3d')).toBeTruthy()
  })

  it('omits the reset column when resets_at is absent', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: null } })]} />)
    expect(screen.queryByText(/Resets in/)).toBeNull()
    expect(screen.queryByText(/Resetting/)).toBeNull()
  })

  it('renders a credits-only row when a limit has no primary/secondary window', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            limit_name: 'Credits',
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '$12.50' },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Credits')).toBeTruthy()
    expect(screen.getByText('Credits available')).toBeTruthy()
    expect(screen.getByText('$12.50')).toBeTruthy()
  })

  it('renders credit balance alongside spend figures when balance is present', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            limit_id: 'openrouter',
            limit_name: 'OpenRouter (Production)',
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '$84.50' },
            spend: {
              reached: false,
              source: null,
              limit: 50,
              used: 15.5,
              remaining: 34.5,
              used_percent: 31,
              resets_at: null,
            },
          }),
        ]}
      />,
    )
    expect(screen.getByText('OpenRouter (Production) \u00B7 Spend cap')).toBeTruthy()
    expect(screen.getByText('31% used')).toBeTruthy()
    expect(screen.getByText('15.5 of 50 used \u00B7 34.5 left')).toBeTruthy()
    expect(screen.getByText('OpenRouter (Production)')).toBeTruthy()
    expect(screen.getByText('Credits available')).toBeTruthy()
    expect(screen.getByText('$84.50')).toBeTruthy()
  })

  it('renders unlimited and depleted credits copy', () => {
    const { rerender } = renderWithQuery(
      <UsagePanel limits={[makeLimit({ primary: null, secondary: null, credits: { has_credits: true, unlimited: true, balance: null } })]} />,
    )
    expect(screen.getByText('Unlimited usage')).toBeTruthy()

    rerender(
      <QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null } })]} /></QueryClientProvider>,
    )
    expect(screen.getByText('No usage credits left')).toBeTruthy()
  })

  it('renders a period-only limit as neutral availability rather than unlimited usage', () => {
    const nowS = Math.floor(Date.now() / 1000)
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            limit_name: 'Weekly usage period',
            primary: null,
            secondary: null,
            credits: null,
            period_start_at: nowS - 24 * 60 * 60,
            period_end_at: nowS + 6 * 24 * 60 * 60,
          }),
        ]}
      />,
    )
    expect(screen.getByText('Weekly usage period')).toBeTruthy()
    expect(screen.getByText('Usage period available')).toBeTruthy()
    expect(screen.getByText('Ends in 6d')).toBeTruthy()
    expect(screen.queryByText('Unlimited usage')).toBeNull()
  })

  it('renders spend cap figures for a limit with no rate-limit windows', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            limit_id: 'codex',
            limit_name: null,
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: null },
            spend: {
              reached: true,
              source: 'workspace_spend_controls',
              limit: 700,
              used: 1811.965924501419,
              remaining: 0,
              used_percent: 259,
              resets_at: null,
            },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Codex \u00B7 Spend cap')).toBeTruthy()
    expect(screen.getByText('1,811.97 of 700 used \u00B7 0 left')).toBeTruthy()
    // The true overage is the point — do not clamp it out of the copy.
    expect(screen.getByText('259% used')).toBeTruthy()
    expect(screen.queryByText('Credits available')).toBeNull()
  })

  it('clamps the spend bar at 100 while still reporting the real percent', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            primary: null,
            secondary: null,
            spend: { reached: true, source: null, limit: 700, used: 1812, remaining: 0, used_percent: 259, resets_at: null },
          }),
        ]}
      />,
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByText('259% used')).toBeTruthy()
  })

  it('renders an unbreached spend cap with its remaining amount', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            primary: null,
            secondary: null,
            spend: { reached: false, source: null, limit: 700, used: 250.5, remaining: 449.5, used_percent: 36, resets_at: null },
          }),
        ]}
      />,
    )
    expect(screen.getByText('36% used')).toBeTruthy()
    expect(screen.getByText('250.5 of 700 used \u00B7 449.5 left')).toBeTruthy()
  })

  it('does not claim credits are available when the spend cap is reached', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: null },
            spend: { reached: true, source: null, limit: null, used: null, remaining: null, used_percent: null, resets_at: null },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Usage limit reached')).toBeTruthy()
    expect(screen.queryByText('Credits available')).toBeNull()
  })

  it('shows the plan type badge from the first limit', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit({ plan_type: 'Max' })]} />)
    expect(screen.getByText('Max')).toBeTruthy()
  })

  it('renders the rate-limit-reached banner using the first limit', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit({ rate_limit_reached_type: 'workspace_member_usage_limit_reached' })]} />)
    expect(screen.getByText('Limit reached \u00B7 workspace member usage limit reached')).toBeTruthy()
  })

  it('does not render the rate-limit banner when unset', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit()]} />)
    expect(screen.queryByText(/Limit reached/)).toBeNull()
  })

  it('shows a relative "Updated" timestamp based on updatedAt', () => {
    const { rerender } = renderWithQuery(<UsagePanel limits={[makeLimit()]} updatedAt={Date.now()} />)
    expect(screen.getByText('Updated just now')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit()]} updatedAt={Date.now() - 5 * 60_000} /></QueryClientProvider>)
    expect(screen.getByText('Updated 5m ago')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit()]} updatedAt={Date.now() - 3 * 3_600_000} /></QueryClientProvider>)
    expect(screen.getByText('Updated 3h ago')).toBeTruthy()
  })

  it('omits the "Updated" line when updatedAt is not provided', () => {
    renderWithQuery(<UsagePanel limits={[makeLimit()]} />)
    expect(screen.queryByText(/Updated/)).toBeNull()
  })

  it('shows available reset credits in the header strip', () => {
    const { rerender } = renderWithQuery(<UsagePanel limits={[makeLimit({ reset_credits_available: 1, plan_type: 'Plus' })]} />)
    expect(screen.getByText('1 reset available')).toBeTruthy()
    expect(screen.getByText('Plus')).toBeTruthy()
    expect(screen.getByText('Redeem reset')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ reset_credits_available: 2, plan_type: 'Plus' })]} /></QueryClientProvider>)
    expect(screen.getByText('2 resets available')).toBeTruthy()

    rerender(<QueryClientProvider client={new QueryClient()}><UsagePanel limits={[makeLimit({ reset_credits_available: 0, plan_type: 'Plus' })]} /></QueryClientProvider>)
    expect(screen.queryByText(/available/)).toBeNull()
  })

  it('shows alert dialog when reset button clicked on usage below 99%', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            primary: { used_percent: 50, window_minutes: 60, resets_at: null },
            reset_credits_available: 1,
          }),
        ]}
      />,
    )

    const resetBtn = screen.getByText('Redeem reset')
    fireEvent.click(resetBtn)

    expect(screen.getByText('Cannot Redeem Reset Yet')).toBeTruthy()
    expect(screen.getByText(/Your current usage is 50%/)).toBeTruthy()
    expect(screen.getByText('Got it')).toBeTruthy()
  })

  it('shows confirm dialog when reset button clicked on usage >= 99%', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            primary: { used_percent: 99, window_minutes: 60, resets_at: null },
            reset_credits_available: 1,
          }),
        ]}
      />,
    )

    const resetBtn = screen.getByText('Redeem reset')
    fireEvent.click(resetBtn)

    expect(screen.getByText('Redeem Rate Limit Reset?')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(screen.getByText('Confirm reset')).toBeTruthy()
  })

  it('shows confirm dialog when rate limit is reached even if usage percent < 99', () => {
    renderWithQuery(
      <UsagePanel
        limits={[
          makeLimit({
            rate_limit_reached_type: 'usage_limit_reached',
            primary: { used_percent: 80, window_minutes: 60, resets_at: null },
            reset_credits_available: 1,
          }),
        ]}
      />,
    )

    const bannerResetBtn = screen.getByText('Redeem reset (1)')
    fireEvent.click(bannerResetBtn)

    expect(screen.getByText('Redeem Rate Limit Reset?')).toBeTruthy()
  })
})
