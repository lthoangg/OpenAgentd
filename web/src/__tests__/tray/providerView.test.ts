import { describe, expect, it } from 'bun:test'
import { providerView, trayStatus, windowLabel } from '@/tray/providerView'
import type { TrayUsageItem, TrayUsageResult } from '@/tray/usage'

const NOW = 1_700_000_000

function item(over: Partial<TrayUsageItem> & Pick<TrayUsageItem, 'provider' | 'label'>): TrayUsageItem {
  return { status: 'ok', stale: false, usage: null, ...over }
}

const codex = item({
  provider: 'openai',
  label: 'OpenAI Codex',
  usage: {
    provider: 'openai',
    limits: [{
      limit_name: 'Codex',
      plan_type: 'plus',
      primary: { used_percent: 42, window_minutes: 300, resets_at: NOW + 3600 },
      secondary: { used_percent: 76, window_minutes: 10_080, resets_at: NOW + 86_400 },
    }],
  },
})

describe('windowLabel', () => {
  it('names common quota windows the way people say them', () => {
    expect([45, 300, 1440, 10_080, 43_200, 4320].map(windowLabel)).toEqual(
      ['45-minute', '5-hour', 'Daily', 'Weekly', 'Monthly', '3-day'],
    )
    expect(windowLabel(null)).toBeNull()
  })
})

describe('providerView', () => {
  it('names the provider once and labels its limits by window', () => {
    const view = providerView(codex, NOW)

    expect(view.name).toBe('OpenAI Codex')
    expect(view.plan).toBe('Plus')
    expect(view.rows.map((row) => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(view.tone).toBe('warn')
  })

  it('keeps a limit name that says more than the provider name', () => {
    const grok = item({
      provider: 'xai',
      label: 'Grok',
      usage: {
        provider: 'xai',
        limits: [{ limit_name: 'On-demand cap', spend: { reached: false, used: 12, limit: 40, remaining: 28 } }],
      },
    })

    const [row] = providerView(grok, NOW).rows
    expect(row.label).toBe('On-demand cap · Spend cap')
    expect(row.kind === 'meter' && row.detail).toBe('12 of 40 used · 28 left')
  })

  it('shows a balance as a value, without repeating the provider in its label', () => {
    const deepseek = item({
      provider: 'deepseek',
      label: 'DeepSeek',
      stale: true,
      usage: { provider: 'deepseek', limits: [{ limit_name: 'DeepSeek Balance', credits: { has_credits: true, unlimited: false, balance: '$12.40' } }] },
    })

    const view = providerView(deepseek, NOW)
    expect(view.stale).toBe(true)
    expect(view.rows).toEqual([{ key: 'deepseek-0-credits', kind: 'value', label: 'Balance', value: '$12.40', tone: 'ok' }])
  })

  it('turns a reached spend cap critical whatever its percent', () => {
    const capped = item({
      provider: 'openai',
      label: 'OpenAI',
      // An organisation cap can stop usage before the figures say 100%.
      usage: { provider: 'openai', limits: [{ spend: { reached: true, used: 40, limit: 100 } }] },
    })

    const view = providerView(capped, NOW)
    expect(view.tone).toBe('crit')
    expect(view.reached).toBe(true)
    expect(view.rows.map((row) => row.kind === 'meter' && Math.round(row.percent))).toEqual([40])
  })

  it('asks to reconnect a provider whose credentials are gone', () => {
    expect(providerView(item({ provider: 'copilot', label: 'GitHub Copilot', status: 'credentials_missing' }), NOW))
      .toMatchObject({ name: 'GitHub Copilot', status: 'reconnect', rows: [] })
    expect(providerView(item({ provider: 'x', label: 'X', status: 'unavailable' }), NOW).status).toBe('unavailable')
    expect(providerView(item({ provider: 'y', label: 'Y' }), NOW).status).toBe('no-data')
  })

  it('places the now tick at the share of the window gone', () => {
    const [fiveHour] = providerView(codex, NOW).rows
    // 5h window resetting in 1h: 4h of 5h gone.
    expect(fiveHour.kind === 'meter' && fiveHour.nowLine).toBe(80)
  })
})

describe('trayStatus', () => {
  const result = (items: TrayUsageItem[], error?: string): TrayUsageResult => ({
    summary: { items, checked_at: NOW, cached: false },
    server_name: 'Local Bundled',
    server_id: 'bundled',
    servers: [],
    selected_server_id: 'auto',
    error,
  })

  it('reads Checking before the first answer and Offline when the server never answered', () => {
    expect(trayStatus(null, null)).toBe('loading')
    expect(trayStatus(null, 'connection refused')).toBe('offline')
    expect(trayStatus({ ...result([]), summary: null, error: 'connection refused' }, null)).toBe('offline')
  })

  it('ranks providers by their worst limit', () => {
    const at = (percent: number) => item({
      provider: `p${percent}`,
      label: `P${percent}`,
      usage: { provider: 'p', limits: [{ primary: { used_percent: percent } }] },
    })
    expect(trayStatus(result([]), null)).toBe('none')
    expect(trayStatus(result([at(10)]), null)).toBe('ok')
    expect(trayStatus(result([at(10), at(75)]), null)).toBe('warn')
    expect(trayStatus(result([at(75), at(93)]), null)).toBe('crit')
    expect(trayStatus(result([at(93), at(100)]), null)).toBe('reached')
  })

  it('keeps showing the last reading when only a refresh failed', () => {
    const at = item({ provider: 'p', label: 'P', usage: { provider: 'p', limits: [{ primary: { used_percent: 10 } }] } })
    expect(trayStatus(result([at], 'timeout'), null)).toBe('ok')
  })
})
