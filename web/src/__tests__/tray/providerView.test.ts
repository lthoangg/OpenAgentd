import { describe, expect, it } from 'bun:test'
import { TRAY_STATUS_LABEL, failureReason, hasNoServer, providerView, trayStatus, windowLabel } from '@/tray/providerView'
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

  it('names the account in use when the provider pools several', () => {
    expect(providerView({ ...codex, account: 'Work' }, NOW).name).toBe('OpenAI Codex · Work')
    expect(providerView({ ...codex, account: null }, NOW).name).toBe('OpenAI Codex')
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

  // "Can't reach No Server Connected": every failure used to read as offline.
  it('tells having no server apart from not reaching one', () => {
    const none: TrayUsageResult = { ...result([]), summary: null, server_name: 'No server connected', server_id: 'auto', error: 'No server is connected.' }
    expect(hasNoServer(none)).toBe(true)
    expect(trayStatus(none, null)).toBe('no-server')
    expect(hasNoServer({ ...none, server_id: 'bundled' })).toBe(false)
    expect(hasNoServer(result([]))).toBe(false)
    expect(hasNoServer(null)).toBe(false)
  })

  it('uses one vocabulary with the notch and the pet', () => {
    expect(TRAY_STATUS_LABEL.offline).toBe("Can't reach")
    expect(TRAY_STATUS_LABEL['no-server']).toBe('No server connected')
    expect(Object.values(TRAY_STATUS_LABEL)).not.toContain('Offline')
  })

  it('says in words why a refresh failed, without the raw error', () => {
    expect(failureReason('operation timed out')).toBe('The server took too long to answer.')
    expect(failureReason('provider usage summary returned an error status: 401 Unauthorized')).toBe('The server rejected the access key.')
    expect(failureReason('error sending request for url (http://127.0.0.1:4082)')).toBe("The server didn't answer. It may be stopped or asleep.")
    expect(failureReason(null)).toBe("The server didn't answer. It may be stopped or asleep.")
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

  it('does not read a throttled usage check as the inference quota being hit', () => {
    const hot = item({
      provider: 'hot',
      label: 'Hot',
      status: 'rate_limited',
      stale: true,
      usage: { provider: 'hot', limits: [{ primary: { used_percent: 100 } }] },
    })
    const calm = item({ provider: 'calm', label: 'Calm', usage: { provider: 'calm', limits: [{ primary: { used_percent: 10 } }] } })
    expect(trayStatus(result([hot, calm]), null)).toBe('ok')
    expect(trayStatus(result([hot]), null)).toBe('delayed')
    expect(TRAY_STATUS_LABEL.delayed).toBe('Usage delayed')
  })
})

describe('providerView rate limiting', () => {
  const staleUnavailable = (over: Partial<TrayUsageItem> = {}) => item({
    provider: 'openai',
    label: 'OpenAI Codex',
    status: 'unavailable',
    error: 'timeout',
    stale: true,
    usage: {
      provider: 'openai',
      updated_at: NOW - 120,
      limits: [{ primary: { used_percent: 96, window_minutes: 300, resets_at: NOW + 3600 } }],
    },
    ...over,
  })

  it('keeps last-good numbers of an unavailable provider, marked old, without alerting', () => {
    const view = providerView(staleUnavailable(), NOW)
    expect(view.status).toBeNull()
    expect(view.stale).toBe(true)
    expect(view.held).toBe(true)
    expect(view.rateLimited).toBe(false)
    expect(view.retry).toBeNull()
    expect(view.updated).toBe('2m ago')
    expect(view.rows.map((row) => row.kind === 'meter' && Math.round(row.percent))).toEqual([96])
    expect(view.reached).toBe(false)
    expect(view.tone).toBe('ok')
  })

  it('never presents unavailable numbers as fresh, whatever the stale flag says', () => {
    expect(providerView(staleUnavailable({ stale: false }), NOW).stale).toBe(true)
  })

  it('still reads plain unavailable when there are no numbers to keep', () => {
    expect(providerView(staleUnavailable({ usage: null }), NOW)).toMatchObject({ status: 'unavailable', held: false, rows: [] })
    expect(providerView(staleUnavailable({ usage: { provider: 'openai', limits: [] } }), NOW).status).toBe('unavailable')
  })

  it('ranks the topline without a stale unavailable provider', () => {
    const stale = staleUnavailable()
    const calm = item({ provider: 'calm', label: 'Calm', usage: { provider: 'calm', limits: [{ primary: { used_percent: 10 } }] } })
    const result = (items: TrayUsageItem[]): TrayUsageResult => ({
      summary: { items, checked_at: NOW, cached: false },
      server_name: 'Local Bundled',
      server_id: 'bundled',
      servers: [],
      selected_server_id: 'auto',
    })
    expect(trayStatus(result([stale, calm]), null)).toBe('ok')
    expect(trayStatus(result([stale]), null)).toBe('delayed')
  })

  const limited = (over: Partial<TrayUsageItem> = {}) => item({
    provider: 'openai',
    label: 'OpenAI Codex',
    status: 'rate_limited',
    error: 'HTTP 429',
    stale: true,
    retry_at: NOW + 300,
    retry_after: 300,
    ...over,
  })
  const lastGood = {
    provider: 'openai',
    updated_at: NOW - 720,
    limits: [{ primary: { used_percent: 96, window_minutes: 300, resets_at: NOW + 3600 } }],
  }

  it('with no last-good snapshot is its own status with the retry time', () => {
    expect(providerView(limited({ stale: false }), NOW)).toMatchObject({
      name: 'OpenAI Codex',
      status: 'rate-limited',
      rateLimited: true,
      retry: 'Retry in 5m',
      reached: false,
      tone: 'ok',
      rows: [],
    })
  })

  it('keeps last-good numbers, marked old, without claiming a limit is reached', () => {
    const view = providerView(limited({ usage: lastGood }), NOW)
    expect(view.status).toBeNull()
    expect(view.rateLimited).toBe(true)
    expect(view.stale).toBe(true)
    expect(view.retry).toBe('Retry in 5m')
    expect(view.updated).toBe('12m ago')
    expect(view.rows.map((row) => row.kind === 'meter' && Math.round(row.percent))).toEqual([96])
    expect(view.reached).toBe(false)
    expect(view.tone).toBe('ok')
  })

  it('never presents a throttled snapshot as fresh, whatever the stale flag says', () => {
    expect(providerView(limited({ stale: false, usage: lastGood }), NOW).stale).toBe(true)
  })

  it('treats missing, past or odd timing as safe', () => {
    const retry = (over: Partial<TrayUsageItem>) => providerView(limited({ retry_at: null, retry_after: null, ...over }), NOW).retry
    expect(retry({})).toBe('Retry later')
    expect(retry({ retry_after: 7200 })).toBe('Retry in 2h')
    expect(retry({ retry_at: NOW - 5, retry_after: 999 })).toBe('Retrying soon')
    expect(retry({ retry_after: 0 })).toBe('Retrying soon')
    expect(retry({ retry_at: NOW + 20 })).toBe('Retry in <1m')
    expect(retry({ retry_at: Number.NaN, retry_after: -1 })).toBe('Retrying soon')
    expect(retry({ retry_at: undefined, retry_after: undefined })).toBe('Retry later')
  })

  it('bounds absurd timing instead of printing it', () => {
    const retry = (over: Partial<TrayUsageItem>) => providerView(limited({ retry_at: null, retry_after: null, ...over }), NOW).retry
    expect(retry({ retry_after: Number.MAX_VALUE })).toBe('Retry later')
    expect(retry({ retry_at: Number.MAX_VALUE })).toBe('Retry later')
    expect(retry({ retry_after: 40 * 86_400 })).toBe('Retry later')
    expect(retry({ retry_after: Number.POSITIVE_INFINITY })).toBe('Retry later')
    expect(retry({ retry_at: Number.MIN_SAFE_INTEGER })).toBe('Retrying soon')
    expect(retry({ retry_after: 3 * 86_400 })).toBe('Retry in 3d')
  })

  it('tolerates a missing or non-numeric updated_at', () => {
    expect(providerView(limited({ usage: { ...lastGood, updated_at: undefined } }), NOW).updated).toBeNull()
    expect(providerView(limited({ usage: { ...lastGood, updated_at: null } }), NOW).updated).toBeNull()
  })

  it('does not show retry or an age on ordinary providers', () => {
    const view = providerView(codex, NOW)
    expect(view).toMatchObject({ rateLimited: false, retry: null, updated: null })
  })

  it('keeps showing the usage of a status it does not know', () => {
    const future = item({ provider: 'p', label: 'P', status: 'some_future_status', usage: { provider: 'p', limits: [{ primary: { used_percent: 30 } }] } })
    const view = providerView(future, NOW)
    expect(view.rows).toHaveLength(1)
    expect(view.rateLimited).toBe(false)
    expect(providerView(item({ provider: 'p', label: 'P', status: 'some_future_status' }), NOW).status).toBe('no-data')
  })
})
