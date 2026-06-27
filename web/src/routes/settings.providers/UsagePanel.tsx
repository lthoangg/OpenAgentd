import type { ProviderUsageLimit } from '@/api/client'
import { cn } from '@/lib/utils'

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

function UsageBar({
  label,
  window,
}: {
  label: string
  window: NonNullable<ProviderUsageLimit['primary']>
}) {
  const percent = Math.max(0, Math.min(100, window.used_percent))
  const reset = formatResetTime(window.resets_at)

  // Colour steps: green → amber → red
  const barColor =
    percent >= 90 ? 'bg-(--color-error)' :
    percent >= 70 ? 'bg-(--accent-orange)' :
    'bg-(--accent-green)'

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10.5px] text-(--color-text-muted)">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums">
          {Math.round(percent)}%{reset ? ` · resets ${reset}` : ''}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-(--bg-key)">
        <div
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
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
        <UsageBar
          label={`${base} · ${formatWindowDuration(limit.primary.window_minutes)}`}
          window={limit.primary}
        />
      )}
      {limit.secondary && (
        <UsageBar
          label={`${base} · ${formatWindowDuration(limit.secondary.window_minutes)}`}
          window={limit.secondary}
        />
      )}
      {credits && !limit.primary && !limit.secondary && (
        <p className="text-[10.5px] text-(--color-text-muted)">
          {credits.unlimited
            ? 'Unlimited usage available'
            : credits.has_credits
              ? 'Usage credits available'
              : 'No usage credits available'}
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
    <div className="rounded-xs border border-(--color-border) bg-(--bg-key)/30 px-3 py-2.5 space-y-2.5">
      {/* Header strip */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-(--color-text-muted) select-none">
          Active usage
        </p>
        <p className="text-[10.5px] text-(--color-text-subtle) tabular-nums">
          {primary?.plan_type ? `Plan: ${primary.plan_type}` : 'Live'}
          {credits?.unlimited
            ? ' · unlimited'
            : credits?.balance
              ? ` · ${credits.balance} credits`
              : ''}
        </p>
      </div>

      {/* Usage bars */}
      <div className="space-y-2">
        {limits.map((limit, index) => (
          <UsageLimitRows key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} />
        ))}
      </div>

      {/* Rate-limit warning */}
      {primary?.rate_limit_reached_type && (
        <p className="text-[10.5px] font-medium text-(--color-error)">
          Limit reached: {primary.rate_limit_reached_type.replaceAll('_', ' ')}
        </p>
      )}
    </div>
  )
}
