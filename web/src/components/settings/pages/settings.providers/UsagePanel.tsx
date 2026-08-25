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
    <div className="px-3 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
        <span className="font-medium truncate text-(--color-text)">{label}</span>
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-(--color-text-muted) tabular-nums">
          <span>{Math.round(percent)}% used</span>
          {reset && (
            <>
              <span className="text-(--color-text-subtle)">·</span>
              <span>{reset}</span>
            </>
          )}
        </div>
      </div>
      <div className="relative h-1 rounded-full bg-(--bg-key)">
        {percent > 0 && (
          <>
            <div
              className={cn('absolute inset-y-0 left-0 rounded-full', color)}
              style={{ width: `${percent}%` }}
            />
            <div
              className={cn('absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full', color)}
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
    </div>
  )
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

function SpendRow({
  label,
  spend,
}: {
  label: string
  spend: NonNullable<ProviderUsageLimit['spend']>
}) {
  const rawPercent =
    typeof spend.used_percent === 'number'
      ? spend.used_percent
      : typeof spend.used === 'number' && typeof spend.limit === 'number' && spend.limit > 0
        ? (spend.used / spend.limit) * 100
        : 0
  const percent = Math.max(0, Math.min(100, rawPercent))
  const reset = formatResetIn(spend.resets_at)
  const color = spend.reached ? 'bg-(--color-error)' : barColor(percent)
  const detail =
    typeof spend.used === 'number' && typeof spend.limit === 'number'
      ? `${formatAmount(spend.used)} of ${formatAmount(spend.limit)} used${
          typeof spend.remaining === 'number' ? ` \u00B7 ${formatAmount(spend.remaining)} left` : ''
        }`
      : null

  return (
    <div className="px-3 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
        <span className="font-medium truncate text-(--color-text)">{label}</span>
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-(--color-text-muted) tabular-nums">
          {/* Unclamped — an overage is the whole point of this row. */}
          <span>{Math.round(rawPercent)}% used</span>
          {reset && (
            <>
              <span className="text-(--color-text-subtle)">·</span>
              <span>{reset}</span>
            </>
          )}
        </div>
      </div>
      <div className="relative h-1 rounded-full bg-(--bg-key)">
        {percent > 0 && (
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', color)}
            style={{ width: `${percent}%` }}
          />
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
      {detail && <p className="text-[11px] text-(--color-text-subtle) tabular-nums">{detail}</p>}
    </div>
  )
}

function CreditsRow({
  label,
  credits,
  spend,
}: {
  label: string
  credits: NonNullable<ProviderUsageLimit['credits']>
  spend?: ProviderUsageLimit['spend']
}) {
  // A reached cap outranks has_credits, which stays true while blocked.
  const text = spend?.reached
    ? 'Usage limit reached'
    : credits.unlimited
      ? 'Unlimited usage'
      : credits.has_credits
        ? 'Credits available'
        : 'No usage credits left'
  return (
    <div className="px-3 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
        <span className="font-medium truncate text-(--color-text)">{label}</span>
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-(--color-text-muted) tabular-nums">
          <span>{text}</span>
          {credits.balance && (
            <>
              <span className="text-(--color-text-subtle)">·</span>
              <span>{credits.balance}</span>
            </>
          )}
        </div>
      </div>
      <div className="h-1 rounded-full bg-(--bg-key)" />
    </div>
  )
}

function PeriodRow({ label, periodEndAt }: { label: string; periodEndAt?: number | null }) {
  const periodEnd = formatPeriodEndIn(periodEndAt)
  return (
    <div className="px-3 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
        <span className="font-medium truncate text-(--color-text)">{label}</span>
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-(--color-text-muted) tabular-nums">
          <span>Usage period available</span>
          {periodEnd && (
            <>
              <span className="text-(--color-text-subtle)">·</span>
              <span>{periodEnd}</span>
            </>
          )}
        </div>
      </div>
      <div className="h-1 rounded-full bg-(--bg-key)" />
    </div>
  )
}

function LimitSections({ limit }: { limit: ProviderUsageLimit }) {
  const base = usageLabel(limit)
  const primaryDuration = formatWindowDuration(limit.primary?.window_minutes)
  const secondaryDuration = formatWindowDuration(limit.secondary?.window_minutes)
  const spend = limit.spend
  const hasSpendFigures = typeof spend?.limit === 'number' || typeof spend?.used === 'number'
  const hasBalance = Boolean(limit.credits?.balance)
  const shouldRenderCredits = Boolean(
    limit.credits &&
      (!hasSpendFigures || hasBalance) &&
      ((!limit.primary && !limit.secondary) || hasBalance),
  )
  return (
    <>
      {limit.primary && (
        <UsageRow label={primaryDuration ? `${base} \u00B7 ${primaryDuration}` : base} window={limit.primary} />
      )}
      {limit.secondary && (
        <UsageRow label={secondaryDuration ? `${base} \u00B7 ${secondaryDuration}` : base} window={limit.secondary} />
      )}
      {spend && hasSpendFigures && <SpendRow label={`${base} \u00B7 Spend cap`} spend={spend} />}
      {shouldRenderCredits && limit.credits && (
        <CreditsRow label={base} credits={limit.credits} spend={spend} />
      )}
      {!limit.primary && !limit.secondary && !limit.credits && !hasSpendFigures &&
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
  const resetCredits = primary?.reset_credits_available

  return (
    <div className="overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)">
      {/* Header strip */}
      <div className="flex items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key)/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-xs font-semibold leading-none text-(--color-text)">Usage</p>
          {updated && (
            <>
              <span className="text-[11px] text-(--color-text-subtle)">·</span>
              <span className="text-[11px] text-(--color-text-subtle)">{updated}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {typeof resetCredits === 'number' && resetCredits > 0 && (
            <span className="text-[11px] font-medium text-(--accent-green)">
              {resetCredits} {resetCredits === 1 ? 'reset' : 'resets'} available
            </span>
          )}
          {primary?.plan_type && (
            <span className="text-[11px] font-medium text-(--color-text-muted)">{primary.plan_type}</span>
          )}
        </div>
      </div>

      {/* Usage rows */}
      <div className="divide-y divide-(--color-border)/60 py-0.5">
        {limits.map((limit, index) => (
          <LimitSections key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} />
        ))}
      </div>

      {/* Rate-limit warning */}
      {primary?.rate_limit_reached_type && (
        <div className="flex items-center justify-between gap-2 border-t border-(--color-error)/20 bg-(--color-error-subtle) px-3 py-1.5">
          <p className="text-[11px] font-medium text-(--color-error)">
            Limit reached · {primary.rate_limit_reached_type.replaceAll('_', ' ')}
          </p>
          {typeof resetCredits === 'number' && resetCredits > 0 && (
            <span className="shrink-0 text-[11px] font-semibold text-(--color-error)">
              {resetCredits} {resetCredits === 1 ? 'reset' : 'resets'} available
            </span>
          )}
        </div>
      )}
    </div>
  )
}
