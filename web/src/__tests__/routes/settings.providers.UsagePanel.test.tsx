import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import type { ProviderUsageLimit } from '@/api/client'
import { UsagePanel } from '@/components/settings/pages/settings.providers/UsagePanel'

afterEach(cleanup)

function makeLimit(overrides: Partial<ProviderUsageLimit> = {}): ProviderUsageLimit {
  return {
    limit_id: 'primary',
    limit_name: null,
    primary: { used_percent: 42, window_minutes: 300, resets_at: null },
    secondary: null,
    credits: null,
    plan_type: null,
    rate_limit_reached_type: null,
    ...overrides,
  }
}

describe('UsagePanel', () => {
  it('renders nothing when there are no limits', () => {
    const { container } = render(<UsagePanel limits={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a labeled row per limit window with rounded percent', () => {
    render(<UsagePanel limits={[makeLimit({ limit_name: 'Session', primary: { used_percent: 41.6, window_minutes: 300, resets_at: null } })]} />)
    expect(screen.getByText('Session \u00B7 5h')).toBeTruthy()
    expect(screen.getByText('42% used')).toBeTruthy()
  })

  it('renders both primary and secondary windows for the same limit', () => {
    render(
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
    const { rerender } = render(<UsagePanel limits={[makeLimit({ limit_id: 'codex', limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} />)
    expect(screen.getByText('Codex')).toBeTruthy()

    rerender(<UsagePanel limits={[makeLimit({ limit_id: 'custom-limit', limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} />)
    expect(screen.getByText('custom-limit')).toBeTruthy()

    // "Usage" also appears as the static panel header, so the fallback
    // label row renders it a second time.
    rerender(<UsagePanel limits={[makeLimit({ limit_id: null, limit_name: null, primary: { used_percent: 1, window_minutes: null, resets_at: null } })]} />)
    expect(screen.getAllByText('Usage')).toHaveLength(2)
  })

  it('clamps out-of-range percentages into the progressbar aria attributes', () => {
    render(<UsagePanel limits={[makeLimit({ primary: { used_percent: 150, window_minutes: 60, resets_at: null } })]} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByText('100% used')).toBeTruthy()
  })

  it('shows "Resetting now" once the reset timestamp has passed', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    render(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: past } })]} />)
    expect(screen.getByText('Resetting now')).toBeTruthy()
  })

  it('formats future resets in minutes, hours, and days', () => {
    const nowS = Math.floor(Date.now() / 1000)
    const { rerender } = render(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 5 * 60 } })]} />)
    expect(screen.getByText('Resets in 5m')).toBeTruthy()

    rerender(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 2 * 3600 + 10 * 60 } })]} />)
    expect(screen.getByText('Resets in 2h 10m')).toBeTruthy()

    rerender(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: nowS + 3 * 86400 } })]} />)
    expect(screen.getByText('Resets in 3d')).toBeTruthy()
  })

  it('omits the reset column when resets_at is absent', () => {
    render(<UsagePanel limits={[makeLimit({ primary: { used_percent: 10, window_minutes: 60, resets_at: null } })]} />)
    expect(screen.queryByText(/Resets in/)).toBeNull()
    expect(screen.queryByText(/Resetting/)).toBeNull()
  })

  it('renders a credits-only row when a limit has no primary/secondary window', () => {
    render(
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

  it('renders unlimited and depleted credits copy', () => {
    const { rerender } = render(
      <UsagePanel limits={[makeLimit({ primary: null, secondary: null, credits: { has_credits: true, unlimited: true, balance: null } })]} />,
    )
    expect(screen.getByText('Unlimited usage')).toBeTruthy()

    rerender(
      <UsagePanel limits={[makeLimit({ primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null } })]} />,
    )
    expect(screen.getByText('No usage credits left')).toBeTruthy()
  })

  it('renders a period-only limit as neutral availability rather than unlimited usage', () => {
    const nowS = Math.floor(Date.now() / 1000)
    render(
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

  it('shows the plan type badge from the first limit', () => {
    render(<UsagePanel limits={[makeLimit({ plan_type: 'Max' })]} />)
    expect(screen.getByText('Max')).toBeTruthy()
  })

  it('renders the rate-limit-reached banner using the first limit', () => {
    render(<UsagePanel limits={[makeLimit({ rate_limit_reached_type: 'workspace_member_usage_limit_reached' })]} />)
    expect(screen.getByText('Limit reached \u00B7 workspace member usage limit reached')).toBeTruthy()
  })

  it('does not render the rate-limit banner when unset', () => {
    render(<UsagePanel limits={[makeLimit()]} />)
    expect(screen.queryByText(/Limit reached/)).toBeNull()
  })

  it('shows a relative "Updated" timestamp based on updatedAt', () => {
    const { rerender } = render(<UsagePanel limits={[makeLimit()]} updatedAt={Date.now()} />)
    expect(screen.getByText('Updated just now')).toBeTruthy()

    rerender(<UsagePanel limits={[makeLimit()]} updatedAt={Date.now() - 5 * 60_000} />)
    expect(screen.getByText('Updated 5m ago')).toBeTruthy()

    rerender(<UsagePanel limits={[makeLimit()]} updatedAt={Date.now() - 3 * 3_600_000} />)
    expect(screen.getByText('Updated 3h ago')).toBeTruthy()
  })

  it('omits the "Updated" line when updatedAt is not provided', () => {
    render(<UsagePanel limits={[makeLimit()]} />)
    expect(screen.queryByText(/Updated/)).toBeNull()
  })
})
