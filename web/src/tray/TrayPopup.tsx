import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, ChevronDown, RefreshCw, Server } from 'lucide-react'
import {
  type MeterTone,
  type TrayUsageItem,
  type TrayUsageLimit,
  type TrayUsageWindow,
  type TrayUsageSummary,
  type TrayUsageResult,
  clampPercent,
  formatAmount,
  formatCheckedAt,
  formatResetIn,
  meterTone,
} from './usage'

const USAGE_COMMAND = 'get_tray_usage_summary'
const ACTION_COMMAND = 'tray_action'
const TRAY_REFRESH_EVENT = 'tray-popup-refresh'

type StatusTone = 'loading' | 'ok' | 'warn' | 'crit'

type Row =
  | {
      key: string
      kind: 'meter'
      label: string
      percent: number
      tone: MeterTone
      reset: string | null
      nowLine: number | null
      detail?: string
    }
  | { key: string; kind: 'value'; label: string; value: string; tone: MeterTone }
  | { key: string; kind: 'status'; label: string; text: string; critical: boolean }

function windowDuration(minutes?: number | null): string {
  if (typeof minutes !== 'number') return ''
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (60 * 24))}d`
}

function spendPercent(limit: TrayUsageLimit): number {
  const spend = limit.spend
  if (typeof spend?.used_percent === 'number') return spend.used_percent
  if (
    typeof spend?.used === 'number' &&
    typeof spend?.limit === 'number' &&
    spend.limit > 0
  ) {
    return (spend.used / spend.limit) * 100
  }
  return 0
}

function hasSpendFigures(limit: TrayUsageLimit): boolean {
  return typeof limit.spend?.limit === 'number' || typeof limit.spend?.used === 'number'
}

/**
 * Position (0–100) of a small "now" marker along a usage meter, showing
 * how far through the current quota window the wall clock sits. This is
 * the time axis, distinct from `percent` (usage consumed). For a 5h window
 * that started 1h ago and resets in 4h, the marker lands at 20%.
 *
 * Uses `resets_at` plus `window_minutes` when the quota is a rolling
 * window; falls back to an explicit period range (used by period-aligned
 * spend caps). Returns null when neither can pin a window start.
 */
function nowLinePosition(
  window?: TrayUsageWindow | null,
  periodStart?: number | null,
  periodEnd?: number | null,
  now: number = Date.now() / 1000,
): number | null {
  if (
    window &&
    typeof window.resets_at === 'number' &&
    typeof window.window_minutes === 'number' &&
    window.window_minutes > 0
  ) {
    const total = window.window_minutes * 60
    const start = window.resets_at - total
    return clampPercent(((now - start) / total) * 100)
  }
  if (
    typeof periodStart === 'number' &&
    typeof periodEnd === 'number' &&
    periodEnd > periodStart
  ) {
    return clampPercent(((now - periodStart) / (periodEnd - periodStart)) * 100)
  }
  return null
}

/**
 * Row label that always keeps the provider identifiable without duplicating
 * it: if the limit name already names the provider (e.g. "DeepSeek Balance",
 * "OpenRouter Credits") use it; if it is a generic capability name (Grok's
 * "Weekly usage period", "On-demand cap") prefix the provider; otherwise
 * fall back to the provider label alone (Codex's unnamed windows).
 */
function rowLabel(item: TrayUsageItem, limit: TrayUsageLimit, suffix?: string): string {
  const provider = item.label
  const name = limit.limit_name?.trim() ?? ''
  let base = provider
  if (name && name !== provider) {
    if (provider.includes(name)) base = provider
    else if (name.includes(provider)) base = name
    else base = `${provider} · ${name}`
  }
  return suffix ? `${base} · ${suffix}` : base
}

/** Convert one provider's summary item into renderable rows. Pure + tested. */
export function itemRows(item: TrayUsageItem, now: number = Date.now() / 1000): Row[] {
  if (item.status === 'credentials_missing') {
    return [{ key: `${item.provider}-missing`, kind: 'status', label: item.label, text: 'Reconnect', critical: false }]
  }
  if (item.status === 'unavailable') {
    return [{ key: `${item.provider}-unavailable`, kind: 'status', label: item.label, text: 'Unavailable', critical: false }]
  }
  const usage = item.usage
  if (!usage || usage.limits.length === 0) {
    return [{ key: `${item.provider}-empty`, kind: 'status', label: item.label, text: 'No usage data', critical: false }]
  }

  const rows: Row[] = []
  for (const limit of usage.limits) {
    const bothWindows = Boolean(limit.primary && limit.secondary)

    if (limit.primary) {
      const window = limit.primary
      const percent = window.used_percent
      rows.push({
        key: `${item.provider}-p`,
        kind: 'meter',
        label: rowLabel(item, limit, bothWindows ? windowDuration(window.window_minutes) : undefined),
        percent,
        tone: meterTone(percent),
        reset: formatResetIn(window.resets_at),
        nowLine: nowLinePosition(window, limit.period_start_at, limit.period_end_at, now),
      })
    }
    if (limit.secondary) {
      const window = limit.secondary
      const percent = window.used_percent
      rows.push({
        key: `${item.provider}-s`,
        kind: 'meter',
        label: rowLabel(item, limit, windowDuration(window.window_minutes)),
        percent,
        tone: meterTone(percent),
        reset: formatResetIn(window.resets_at),
        nowLine: nowLinePosition(window, limit.period_start_at, limit.period_end_at, now),
      })
    }
    if (hasSpendFigures(limit)) {
      const spend = limit.spend!
      const percent = spendPercent(limit)
      const detail =
        typeof spend.used === 'number' && typeof spend.limit === 'number'
          ? `${formatAmount(spend.used)} of ${formatAmount(spend.limit)} used${
              typeof spend.remaining === 'number' && spend.remaining > 0
                ? ` · ${formatAmount(spend.remaining)} left`
                : ''
            }`
          : undefined
      rows.push({
        key: `${item.provider}-spend`,
        kind: 'meter',
        label: `${rowLabel(item, limit)} · Spend cap`,
        percent,
        tone: spend.reached ? 'crit' : meterTone(percent),
        reset: formatResetIn(spend.resets_at),
        detail,
        nowLine: nowLinePosition(null, limit.period_start_at, limit.period_end_at, now),
      })
    }
    // Credits are the signal when there are no measurable quota windows, so
    // surface the balance (DeepSeek/OpenRouter) instead of hiding it behind
    // a generic "Credits available". A reached spend cap outranks it.
    if (limit.credits && !limit.primary && !limit.secondary) {
      const reached = Boolean(limit.spend?.reached)
      const value = reached
        ? 'Limit reached'
        : limit.credits.unlimited
          ? 'Unlimited'
          : limit.credits.has_credits
            ? (limit.credits.balance ?? 'Credits available')
            : 'No usage credits left'
      rows.push({
        key: `${item.provider}-credits`,
        kind: 'value',
        label: rowLabel(item, limit),
        value,
        tone: reached || !limit.credits.has_credits ? 'crit' : 'ok',
      })
    }
    if (
      !limit.primary &&
      !limit.secondary &&
      !hasSpendFigures(limit) &&
      !limit.credits &&
      (typeof limit.period_start_at === 'number' || typeof limit.period_end_at === 'number')
    ) {
      rows.push({
        key: `${item.provider}-period`,
        kind: 'value',
        label: rowLabel(item, limit),
        value: formatResetIn(limit.period_end_at) ?? 'Period available',
        tone: 'ok',
      })
    }
  }

  if (rows.length === 0) {
    return [{ key: `${item.provider}-empty`, kind: 'status', label: item.label, text: 'No usage data', critical: false }]
  }
  return rows
}

function rowIsCritical(row: Row): boolean {
  if (row.kind === 'meter') return row.tone === 'crit'
  if (row.kind === 'value') return row.tone === 'crit'
  return row.critical
}

function itemIsCritical(item: TrayUsageItem): boolean {
  return itemRows(item).some(rowIsCritical)
}

function deriveStatus(summary: TrayUsageSummary | null): StatusTone {
  if (!summary || summary.items.length === 0) return 'ok'
  if (summary.items.some(itemIsCritical)) return 'crit'
  if (summary.items.some((item) => itemRows(item).some((row) => row.kind === 'meter' && row.tone === 'warn'))) return 'warn'
  return 'ok'
}

const STATUS_LABEL: Record<StatusTone, string> = {
  loading: 'Checking',
  ok: 'Ready',
  warn: 'Watch',
  crit: 'Near limit',
}

export function TrayPopup() {
  const [usageResult, setUsageResult] = useState<TrayUsageResult | null>(null)
  const [selectedServer, setSelectedServer] = useState<string>('auto')
  const [menuOpen, setMenuOpen] = useState(false)
  const [status, setStatus] = useState<StatusTone>('loading')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (force = false, targetServer?: string) => {
    try {
      const serverToQuery = targetServer ?? selectedServer
      const data = await invoke<TrayUsageResult>(USAGE_COMMAND, { force, targetServer: serverToQuery })
      setUsageResult(data)
      if (data.error) {
        setError(data.error)
      } else {
        setError(null)
      }
      setStatus(deriveStatus(data.summary ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus((prev) => (prev === 'loading' ? 'ok' : prev))
    }
  }, [selectedServer])

  useEffect(() => {
    void load()
    let unlisten: (() => void) | undefined
    void (async () => {
      unlisten = await listen(TRAY_REFRESH_EVENT, () => void load())
    })()
    return () => unlisten?.()
  }, [load])

  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.server-selector-container')) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handleClickOutside)
    return () => document.removeEventListener('pointerdown', handleClickOutside)
  }, [menuOpen])

  const runAction = (action: string) => {
    void invoke(ACTION_COMMAND, { action })
  }

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void load(true).finally(() => setRefreshing(false))
  }

  const summary = usageResult?.summary
  const footer = error
    ? `Refresh failed: ${error}`
    : formatCheckedAt(summary?.checked_at ?? 0) ?? 'Not checked yet'

  const hasMultipleServers = Boolean(usageResult?.servers && usageResult.servers.length > 1)

  return (
    <div className="tray">
      <header className="tray-header">
        <span className="brand">OpenAgentd</span>
        <span className="status" data-tone={status}>
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="usage">
        <div className="usage-head">
          <p className="section-label">Usage Limits</p>
          <div className="usage-controls">
            <div className="server-selector-container">
              <button
                type="button"
                className="server-selector-trigger"
                data-open={menuOpen}
                data-interactive={hasMultipleServers}
                onClick={() => hasMultipleServers && setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                title={usageResult?.server_name || 'Select server'}
              >
                <Server size={11} className="server-icon" />
                <span className="server-name">{usageResult?.server_name || 'Local'}</span>
                {hasMultipleServers && (
                  <ChevronDown size={10} className={`server-chevron ${menuOpen ? 'open' : ''}`} />
                )}
              </button>

              {menuOpen && hasMultipleServers && (
                <div className="server-dropdown-menu">
                  {usageResult?.servers.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className="server-dropdown-item"
                      data-selected={selectedServer === server.id}
                      onClick={() => {
                        setSelectedServer(server.id)
                        setMenuOpen(false)
                        void load(false, server.id)
                      }}
                    >
                      <div className="server-item-content">
                        <span className="server-item-name">{server.name}</span>
                        {server.detail && <span className="server-item-detail">{server.detail}</span>}
                      </div>
                      {selectedServer === server.id && (
                        <Check size={12} strokeWidth={2.5} className="server-item-check" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="refresh"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh usage"
              title="Refresh usage"
            >
              <RefreshCw size={12} strokeWidth={2} className={refreshing ? 'spin' : undefined} />
            </button>
          </div>
        </div>
        {summary && summary.items.length > 0 ? (
          summary.items.map((item) => (
            <ProviderBlock key={item.provider} item={item} stale={item.stale} />
          ))
        ) : (
          <div className="empty">
            <div>No connected providers</div>
            <div className="empty-hint">
              {status === 'loading' ? 'Checking usage…' : 'Connect a provider to track limits.'}
            </div>
          </div>
        )}
        <p className="footer" data-error={Boolean(error)}>
          {footer}
        </p>
      </div>

      <div className="tray-actions">
        <button type="button" className="action action-primary" onClick={() => runAction('show')}>
          Open App
        </button>
        <button type="button" className="action" onClick={() => runAction('settings')}>
          Settings
          <span className="action-kbd">⌘,</span>
        </button>
        <button type="button" className="action action-danger" onClick={() => runAction('quit')}>
          Quit
        </button>
      </div>
    </div>
  )
}

function ProviderBlock({ item, stale }: { item: TrayUsageItem; stale: boolean }) {
  const rows = itemRows(item)
  const critical = rows.some(rowIsCritical)
  return (
    <section className="provider" data-critical={critical}>
      {rows.map((row) => {
        if (row.kind === 'meter') {
          return (
            <div key={row.key} className="meter-row">
              <div className="meter-top">
                <span className="meter-label">
                  {row.label}
                  {stale ? ' (old)' : ''}
                </span>
                <span className="meter-meta">
                  <span className="meter-percent" data-tone={row.tone}>
                    {Math.round(row.percent)}%
                  </span>
                  {row.reset && <span className="meter-reset">{row.reset}</span>}
                </span>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  data-tone={row.tone}
                  style={{ width: `${clampPercent(row.percent)}%` }}
                />
                <div
                  className="meter-dot"
                  data-tone={row.tone}
                  style={{ left: `${clampPercent(row.percent)}%` }}
                />
                {row.nowLine !== null && (
                  <div
                    className="meter-now"
                    style={{ left: `${row.nowLine}%` }}
                  />
                )}
              </div>
              {row.detail && <p className="meter-detail">{row.detail}</p>}
            </div>
          )
        }
        return (
          <div key={row.key} className="info-row">
            <span className="info-label">
              {row.label}
              {stale ? ' (old)' : ''}
            </span>
            {row.kind === 'value' ? (
              <span className="info-value" data-tone={row.tone}>
                {row.value}
              </span>
            ) : (
              <span className="info-text">{row.text}</span>
            )}
          </div>
        )
      })}
    </section>
  )
}
