import type { ProviderUsageLimit } from '@/api/client'
import { cn } from '@/lib/utils'

/**
 * CodexBar-style usage panel — bold section labels, a thin flat progress
 * bar with a leading dot, and a plain "N% used · Resets in Xh Ym" line.
 * See https://github.com/steipete/CodexBar for the reference aesthetic.
 */

function formatUpdatedAgo(updatedAt?: number): string | null {
  if (!updatedAt) return null
  const ageMs = Date.now() - updatedAt
  if (ageMs < 45_000) return 'Updated just now'
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `Updated ${hours}h ago`
}

function formatResetIn(resetsAt?: number | null): string | null {
  if (typeof resetsAt !== 'number') return null
  const remainingS = resetsAt - Date.now() / 1000
  if (remainingS <= 0) return 'Resetting now'
  const minutes = Math.round(remainingS / 60)
  if (minutes < 1) return 'Resets in <1m'
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  if (hours < 24) return remMinutes === 0 ? `Resets in ${hours}h` : `Resets in ${hours}h ${remMinutes}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours === 0 ? `Resets in ${days}d` : `Resets in ${days}d ${remHours}h`
}

function formatPeriodEndIn(periodEndAt?: number | null): string | null {
  if (typeof periodEndAt !== 'number') return null
  const remainingS = periodEndAt - Date.now() / 1000
  if (remainingS <= 0) return 'Ending now'
  const minutes = Math.round(remainingS / 60)
  if (minutes < 1) return 'Ends in <1m'
  if (minutes < 60) return `Ends in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  if (hours < 24) return remMinutes === 0 ? `Ends in ${hours}h` : `Ends in ${hours}h ${remMinutes}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours === 0 ? `Ends in ${days}d` : `Ends in ${days}d ${remHours}h`
}

function usageLabel(limit: ProviderUsageLimit): string {
  if (limit.limit_name) return limit.limit_name
  if (limit.limit_id === 'codex') return 'Codex'
  return limit.limit_id || 'Usage'
}

function formatWindowDuration(minutes?: number | null): string {
  if (typeof minutes !== 'number') return ''
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (60 * 24))}d`
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-(--color-error)'
  if (percent >= 70) return 'bg-(--accent-orange)'
  return 'bg-(--accent-green)'
}

function UsageRow({
  label,
  window,
}: {
  label: string
  window: NonNullable<ProviderUsageLimit['primary']>
}) {
  const percent = Math.max(0, Math.min(100, window.used_percent))
  const reset = formatResetIn(window.resets_at)
  const color = barColor(percent)

  return (
    <div className="px-4 py-3 space-y-1.5">
      <p className="text-[13px] font-semibold leading-none text-(--color-text)">{label}</p>
      <div className="relative h-1.5 rounded-full bg-(--bg-key)">
        {percent > 0 && (
          <>
            <div
              className={cn('absolute inset-y-0 left-0 rounded-full', color)}
              style={{ width: `${percent}%` }}
            />
            <div
              className={cn('absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full', color)}
              style={{ left: `${percent}%` }}
            />
          </>
        )}
        <div
          className="absolute inset-0"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-(--color-text-muted)">
        <span className="tabular-nums">{Math.round(percent)}% used</span>
        {reset && <span className="tabular-nums">{reset}</span>}
      </div>
    </div>
  )
}

function CreditsRow({
  label,
  credits,
}: {
  label: string
  credits: NonNullable<ProviderUsageLimit['credits']>
}) {
  const text = credits.unlimited
    ? 'Unlimited usage'
    : credits.has_credits
      ? 'Credits available'
      : 'No usage credits left'
  return (
    <div className="px-4 py-3 space-y-1.5">
      <p className="text-[13px] font-semibold leading-none text-(--color-text)">{label}</p>
      <div className="h-1.5 rounded-full bg-(--bg-key)" />
      <div className="flex items-center justify-between text-[11px] text-(--color-text-muted)">
        <span>{text}</span>
        {credits.balance && <span className="tabular-nums">{credits.balance}</span>}
      </div>
    </div>
  )
}

function PeriodRow({ label, periodEndAt }: { label: string; periodEndAt?: number | null }) {
  const periodEnd = formatPeriodEndIn(periodEndAt)
  return (
    <div className="px-4 py-3 space-y-1.5">
      <p className="text-[13px] font-semibold leading-none text-(--color-text)">{label}</p>
      <div className="h-1.5 rounded-full bg-(--bg-key)" />
      <div className="flex items-center justify-between text-[11px] text-(--color-text-muted)">
        <span>Usage period available</span>
        {periodEnd && <span className="tabular-nums">{periodEnd}</span>}
      </div>
    </div>
  )
}

function LimitSections({ limit }: { limit: ProviderUsageLimit }) {
  const base = usageLabel(limit)
  const primaryDuration = formatWindowDuration(limit.primary?.window_minutes)
  const secondaryDuration = formatWindowDuration(limit.secondary?.window_minutes)
  return (
    <>
      {limit.primary && (
        <UsageRow label={primaryDuration ? `${base} \u00B7 ${primaryDuration}` : base} window={limit.primary} />
      )}
      {limit.secondary && (
        <UsageRow label={secondaryDuration ? `${base} \u00B7 ${secondaryDuration}` : base} window={limit.secondary} />
      )}
      {limit.credits && !limit.primary && !limit.secondary && <CreditsRow label={base} credits={limit.credits} />}
      {!limit.primary && !limit.secondary && !limit.credits &&
        (typeof limit.period_start_at === 'number' || typeof limit.period_end_at === 'number') && (
          <PeriodRow label={base} periodEndAt={limit.period_end_at} />
        )}
    </>
  )
}

export function UsagePanel({ limits, updatedAt }: { limits: ProviderUsageLimit[]; updatedAt?: number }) {
  if (limits.length === 0) return null
  const primary = limits[0]
  const updated = formatUpdatedAgo(updatedAt)

  return (
    <div className="overflow-hidden rounded border border-(--color-border) bg-(--bg-card)">
      {/* Header strip */}
      <div className="flex items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key)/30 px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-none text-(--color-text)">Usage</p>
          {updated && <p className="mt-1 text-[10.5px] text-(--color-text-subtle)">{updated}</p>}
        </div>
        {primary?.plan_type && (
          <span className="shrink-0 text-[11px] font-medium text-(--color-text-muted)">{primary.plan_type}</span>
        )}
      </div>

      {/* Usage rows */}
      <div className="divide-y divide-(--color-border)/60 py-0.5">
        {limits.map((limit, index) => (
          <LimitSections key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} />
        ))}
      </div>

      {/* Rate-limit warning */}
      {primary?.rate_limit_reached_type && (
        <div className="border-t border-(--color-error)/20 bg-(--color-error-subtle) px-4 py-2.5">
          <p className="text-[11px] font-medium text-(--color-error)">
            Limit reached · {primary.rate_limit_reached_type.replaceAll('_', ' ')}
          </p>
        </div>
      )}
    </div>
  )
}
