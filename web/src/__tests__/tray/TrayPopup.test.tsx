/**
 * Tests for the macOS tray popup's usage rendering.
 *
 * The tray is a tiny webview window served from its own HTML entry, so it
 * talks to the backend only through the Rust `get_tray_usage_summary`
 * command. `itemRows` is the pure shape-for-UI function; the component test
 * drives it end-to-end with the Tauri IPC mocked out.
 */

import { describe, it, expect, afterEach, mock, beforeEach } from 'bun:test'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import {
  type TrayUsageItem,
  type TrayUsageLimit,
  clampPercent,
  formatCheckedAt,
  formatResetIn,
  meterTone,
} from '@/tray/usage'
import { TrayPopup, itemRows } from '@/tray/TrayPopup'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Pure formatting helpers
// ---------------------------------------------------------------------------

describe('tray usage helpers', () => {
  it('meterTone maps the 70/90 thresholds like the native badge', () => {
    expect(meterTone(69.9)).toBe('ok')
    expect(meterTone(70)).toBe('warn')
    expect(meterTone(89)).toBe('warn')
    expect(meterTone(90)).toBe('crit')
  })

  it('clampPercent bounds the bar while the text stays raw', () => {
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(42)).toBe(42)
  })

  it('formatResetIn renders minutes, hours and days countdowns', () => {
    const now = Date.now() / 1000
    expect(formatResetIn(now - 10)).toBe('Resetting now')
    expect(formatResetIn(now + 4 * 60)).toBe('Resets in 4m')
    expect(formatResetIn(now + (2 * 3600 + 14 * 60))).toBe('Resets in 2h 14m')
    expect(formatResetIn(now + 3 * 86400)).toBe('Resets in 3d')
    expect(formatResetIn(null)).toBeNull()
  })

  it('formatCheckedAt renders relative age', () => {
    const now = Date.now() / 1000
    expect(formatCheckedAt(now - 30)).toBe('Checked just now')
    expect(formatCheckedAt(now - 120)).toBe('Checked 2m ago')
    expect(formatCheckedAt(0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// itemRows — summary item -> renderable rows
// ---------------------------------------------------------------------------

function itemWith(overrides: Partial<TrayUsageItem>, limits: TrayUsageLimit[]): TrayUsageItem {
  return {
    provider: 'codex',
    label: 'OpenAI Codex',
    status: 'ok',
    stale: false,
    usage: { provider: 'codex', limits },
    ...overrides,
  } as TrayUsageItem
}

describe('itemRows', () => {
  it('renders a single window as one meter row with the provider label', () => {
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: null,
            primary: { used_percent: 42, window_minutes: 300, resets_at: null },
            secondary: null,
            credits: null,
            spend: null,
          },
        ],
      ),
    )
    expect(rows).toHaveLength(1)
    const meter = rows[0]
    expect(meter.kind).toBe('meter')
    if (meter.kind === 'meter') {
      expect(meter.label).toBe('OpenAI Codex')
      expect(meter.percent).toBe(42)
      expect(meter.tone).toBe('ok')
    }
  })

  it('marks a near-limit provider critical', () => {
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: null,
            primary: { used_percent: 95, window_minutes: 60, resets_at: null },
            secondary: null,
            credits: null,
            spend: null,
          },
        ],
      ),
    )
    if (rows[0].kind === 'meter') {
      expect(rows[0].tone).toBe('crit')
    }
  })

  it('suffixes the window duration when a provider has two windows', () => {
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: 'Codex',
            primary: { used_percent: 42, window_minutes: 5 * 60, resets_at: null },
            secondary: { used_percent: 8, window_minutes: 7 * 24 * 60, resets_at: null },
            credits: null,
            spend: null,
          },
        ],
      ),
    )
    expect(rows).toHaveLength(2)
    if (rows[0].kind === 'meter') expect(rows[0].label).toBe('OpenAI Codex · 5h')
    if (rows[1].kind === 'meter') expect(rows[1].label).toBe('OpenAI Codex · 7d')
  })

  it('places the now-line at the time-axis position within a rolling window', () => {
    // 5h window, started 1h ago, resets in 4h -> now sits at 20%.
    const now = 1_000
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: 'Codex',
            primary: { used_percent: 42, window_minutes: 5 * 60, resets_at: now + 4 * 3600 },
            secondary: null,
            credits: null,
            spend: null,
          },
        ],
      ),
      now,
    )
    if (rows[0].kind === 'meter') {
      expect(rows[0].nowLine).toBeCloseTo(20, 5)
    } else {
      throw new Error('expected a meter row')
    }
  })

  it('omits the now-line when there is no window or period to anchor it', () => {
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: null,
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '12,000' },
            spend: null,
          },
        ],
      ),
    )
    // Credits-only rows carry no meter, only value rows.
    expect(rows.every((r) => r.kind !== 'meter' || r.nowLine === null)).toBe(true)
  })

  it('anchors the now-line to an explicit period range when present', () => {
    // Period spans 7 days (604800s); now is 1 day (86400s) into it -> ~14.29%.
    const now = 1_000_000
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: 'Spend cap',
            primary: null,
            secondary: null,
            credits: null,
            spend: {
              reached: false,
              used: 90,
              limit: 100,
              remaining: 10,
              used_percent: 90,
              resets_at: null,
            },
            period_start_at: now - 86400,
            period_end_at: now + 6 * 86400,
          },
        ],
      ),
      now,
    )
    const meter = rows.find((r) => r.kind === 'meter')
    if (meter && meter.kind === 'meter') {
      expect(meter.nowLine).toBeCloseTo((1 / 7) * 100, 5)
    } else {
      throw new Error('expected a meter row')
    }
  })

  it('renders a spend cap with the raw (unclamped) percent and amount detail', () => {
    const rows = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: 'Codex',
            primary: null,
            secondary: null,
            credits: null,
            spend: {
              reached: true,
              used: 1811.97,
              limit: 700,
              remaining: 0,
              used_percent: 259,
              resets_at: null,
            },
          },
        ],
      ),
    )
    expect(rows).toHaveLength(1)
    const meter = rows[0]
    if (meter.kind === 'meter') {
      expect(meter.percent).toBe(259)
      expect(meter.tone).toBe('crit')
      expect(meter.detail).toBe('1,811.97 of 700 used')
    }
  })

  it('renders credits-only and period-only providers as info rows', () => {
    const credits = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: null,
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '12,000' },
            spend: null,
          },
        ],
      ),
    )
    expect(credits[0]).toMatchObject({ kind: 'value', value: '12,000' })

    const period = itemRows(
      itemWith(
        {},
        [
          {
            limit_name: 'Weekly usage period',
            primary: null,
            secondary: null,
            credits: null,
            spend: null,
            period_start_at: 1,
            period_end_at: 1 + 6 * 86400,
          },
        ],
      ),
    )
    expect(period[0].kind).toBe('value')
  })

  it('shows the credit balance value for credits-only providers (DeepSeek)', () => {
    const rows = itemRows(
      itemWith(
        { label: 'DeepSeek' },
        [
          {
            limit_name: 'DeepSeek Balance',
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '$12.34' },
            spend: null,
          },
        ],
      ),
    )
    expect(rows[0]).toMatchObject({ kind: 'value', label: 'DeepSeek Balance', value: '$12.34', tone: 'ok' })
  })

  it('keeps the provider name on named limits (Grok multi-limit)', () => {
    const rows = itemRows(
      itemWith(
        { label: 'Grok' },
        [
          {
            limit_name: 'Weekly usage period',
            primary: { used_percent: 55, window_minutes: 7 * 24 * 60, resets_at: null },
            secondary: null,
            credits: null,
            spend: null,
          },
          {
            limit_name: 'On-demand cap',
            primary: { used_percent: 30, window_minutes: 7 * 24 * 60, resets_at: null },
            secondary: null,
            credits: null,
            spend: null,
          },
        ],
      ),
    )
    expect(rows).toHaveLength(2)
    if (rows[0].kind === 'meter') expect(rows[0].label).toBe('Grok · Weekly usage period')
    if (rows[1].kind === 'meter') expect(rows[1].label).toBe('Grok · On-demand cap')
  })

  it('shows both the spend cap meter and the credit balance for OpenRouter', () => {
    const rows = itemRows(
      itemWith(
        { label: 'OpenRouter' },
        [
          {
            limit_name: 'OpenRouter Credits',
            primary: null,
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: '$8.50' },
            spend: {
              reached: false,
              used: 90,
              limit: 100,
              remaining: 10,
              used_percent: 90,
              resets_at: null,
            },
          },
        ],
      ),
    )
    expect(rows).toHaveLength(2)
    expect(
      rows.some((r) => r.kind === 'meter' && r.label === 'OpenRouter Credits · Spend cap'),
    ).toBe(true)
    expect(
      rows.some((r) => r.kind === 'value' && r.label === 'OpenRouter Credits' && r.value === '$8.50'),
    ).toBe(true)
  })

  it('renders reconnect/unavailable/no-data states as info rows', () => {
    expect(itemRows({ provider: 'x', label: 'X', status: 'credentials_missing', stale: false } as TrayUsageItem)[0]).toMatchObject({
      kind: 'status',
      text: 'Reconnect',
    })
    expect(itemRows({ provider: 'x', label: 'X', status: 'unavailable', stale: false } as TrayUsageItem)[0]).toMatchObject({
      kind: 'status',
      text: 'Unavailable',
    })
    expect(itemRows({ provider: 'x', label: 'X', status: 'ok', stale: false, usage: null } as TrayUsageItem)[0]).toMatchObject({
      kind: 'status',
      text: 'No usage data',
    })
  })
})

// ---------------------------------------------------------------------------
// Component — Tauri IPC mocked
// ---------------------------------------------------------------------------

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  if (command === 'get_tray_usage_summary') {
    const now = Date.now() / 1000
    return {
      items: [
        {
          provider: 'codex',
          label: 'OpenAI Codex',
          status: 'ok',
          stale: false,
          usage: {
            provider: 'codex',
            limits: [
              {
                limit_name: null,
                primary: { used_percent: 42, window_minutes: 300, resets_at: now + (2 * 3600 + 14 * 60) },
                secondary: null,
                credits: null,
                spend: null,
              },
            ],
          },
        },
      ],
      checked_at: now - 120,
      cached: false,
    }
  }
  throw new Error(`unexpected command: ${command}`)
})

const listenMock = mock(async () => () => {})

mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
mock.module('@tauri-apps/api/event', () => ({ listen: listenMock }))

describe('TrayPopup', () => {
  beforeEach(() => {
    invokeMock.mockClear()
  })

  it('fetches usage on mount and renders meters + actions', async () => {
    render(<TrayPopup />)

    expect(invokeMock).toHaveBeenCalledWith('get_tray_usage_summary', { force: false })
    expect(screen.getByText('OpenAgentd')).toBeInTheDocument()
    expect(screen.getByText('Usage Limits')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('OpenAI Codex')).toBeInTheDocument())
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('Resets in 2h 14m')).toBeInTheDocument()
    expect(screen.getByText('Checked 2m ago')).toBeInTheDocument()

    // Actions present.
    expect(screen.getByText('Open App')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('Quit')).toBeInTheDocument()
  })

  it('re-fetches with force when the refresh button is clicked', async () => {
    render(<TrayPopup />)
    await waitFor(() => expect(screen.getByText('OpenAI Codex')).toBeInTheDocument())
    invokeMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          (call) =>
            String(call[0]) === 'get_tray_usage_summary' &&
            (call[1] as { force?: boolean } | undefined)?.force === true,
        ),
      ).toBe(true),
    )
  })
})
