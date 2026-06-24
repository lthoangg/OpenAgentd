import type { ProviderUsageLimit } from '@/api/client'

function formatResetTime(timestamp?: number | null): string | null {
  if (typeof timestamp !== 'number') return null
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function usageLabel(limit: ProviderUsageLimit): string {
  if (limit.limit_name) return limit.limit_name
  if (limit.limit_id === 'codex') return 'Codex'
  return limit.limit_id || 'Usage'
}

function formatWindowDuration(minutes?: number | null): string {
  if (typeof minutes !== 'number') return 'window'
  if (minutes < 60) return `${minutes}m window`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h window`
  return `${Math.round(minutes / (60 * 24))}d window`
}

function UsageBar({ label, window }: { label: string; window: NonNullable<ProviderUsageLimit['primary']> }) {
  const percent = Math.max(0, Math.min(100, window.used_percent))
  const reset = formatResetTime(window.resets_at)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-(--color-text-muted)">
        <span>{label}</span>
        <span>{Math.round(percent)}% used{reset ? `, resets ${reset}` : ''}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-(--bg-key)">
        <div
          className="h-full rounded-full bg-(--color-accent)"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function UsageLimitRows({ limit }: { limit: ProviderUsageLimit }) {
  const base = usageLabel(limit)
  const credits = limit.credits
  return (
    <>
      {limit.primary && (
        <UsageBar label={`${base} · ${formatWindowDuration(limit.primary.window_minutes)}`} window={limit.primary} />
      )}
      {limit.secondary && (
        <UsageBar label={`${base} · ${formatWindowDuration(limit.secondary.window_minutes)}`} window={limit.secondary} />
      )}
      {credits && !limit.primary && !limit.secondary && (
        <p className="text-[11px] text-(--color-text-muted)">
          {credits.unlimited ? 'Unlimited usage available' : credits.has_credits ? 'Usage credits available' : 'No usage credits available'}
        </p>
      )}
    </>
  )
}

export function UsagePanel({ limits }: { limits: ProviderUsageLimit[] }) {
  if (limits.length === 0) return null
  const primary = limits[0]
  const credits = primary?.credits
  return (
    <div className="space-y-2 rounded-md border border-(--color-border) bg-(--bg-subtle) p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-(--color-text)">Active usage</p>
        <p className="text-[11px] text-(--color-text-muted)">
          {primary?.plan_type ? `Plan: ${primary.plan_type}` : 'Live usage'}
          {credits?.unlimited ? ' · unlimited' : credits?.balance ? ` · credits ${credits.balance}` : ''}
        </p>
      </div>
      <div className="space-y-2">
        {limits.map((limit, index) => (
          <UsageLimitRows key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} />
        ))}
      </div>
      {primary?.rate_limit_reached_type && (
        <p className="text-[11px] font-medium text-(--color-error)">
          Limit reached: {primary.rate_limit_reached_type.replaceAll('_', ' ')}
        </p>
      )}
    </div>
  )
}
