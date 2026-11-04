import { useState } from 'react'
import type { ProviderUsageLimit } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatUsageAmount, moneyFormatter } from '@/lib/usage-format'
import { useResetProviderUsageMutation } from '@/queries/useProvidersQuery'
import { useNowMs } from './useNowMs'
import { formatResetIn } from '@/tray/usage'
import { useToastStore } from '@/stores/useToastStore'

/**
 * One profile's usage: quota bars, spend and credits, then a single footer
 * line (when it was read, plan, resets). Compact on purpose: the profile's
 * header names whose it is, so there is no "Usage" heading here unless the
 * caller asks for one (the API-key block does). Quotas sit in two columns when
 * the panel itself is wide enough, one when it is narrow.
 */

function ago(ms: number, now: number): string {
  const ageMs = now - ms
  if (ageMs < 45_000) return 'just now'
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** `Updated 4m ago`, or for a held-over snapshot `Last updated 4m ago` (never "just now" as if fresh). */
function formatUpdatedAgo(updatedAt: number | undefined, stale: boolean, now: number): string | null {
  if (!updatedAt) return null
  return `${stale ? 'Last updated' : 'Updated'} ${ago(updatedAt, now)}`
}

function formatPeriodEndIn(periodEndAt: number | null | undefined, now: number): string | null {
  if (typeof periodEndAt !== 'number') return null
  const remainingS = periodEndAt - now / 1000
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

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** The name already says how long the window is ("Five Hour", "5-hour", "Weekly"). */
function nameCarriesDuration(name: string, minutes?: number | null): boolean {
  if (typeof minutes !== 'number' || minutes <= 0) return false
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const says = (n: number, units: string) => {
    const words = NUMBER_WORDS[n] ? `|${NUMBER_WORDS[n]}` : ''
    return new RegExp(`(^|[^0-9])(${n}${words})(${units})`).test(flat)
  }
  if (minutes < 60) return says(minutes, 'm|min|mins|minute|minutes')
  if (minutes < 60 * 24) return minutes % 60 === 0 && says(minutes / 60, 'h|hr|hrs|hour|hours')
  if (minutes % (60 * 24) !== 0) return false
  const days = minutes / (60 * 24)
  if (says(days, 'd|day|days')) return true
  if (days === 7) return /week/.test(flat)
  if (days === 1) return /daily/.test(flat)
  if (days >= 28 && days <= 31) return /month/.test(flat)
  return false
}

function windowLabel(base: string, minutes?: number | null): string {
  const duration = formatWindowDuration(minutes)
  return !duration || nameCarriesDuration(base, minutes) ? base : `${base} \u00B7 ${duration}`
}

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const NUMBER = `(?:\\d+|${NUMBER_WORDS.slice(1).join('|')})`
const WINDOW_ONLY = new RegExp(
  `^(?:${NUMBER}(?:min|minute|hour|hr|day|week|month)s?|(?:hourly|daily|weekly|monthly))(?:window|limit|usage)?$`,
)

/**
 * A limit name that tells nothing a person could not read off the window
 * ("Five Hour", "Seven Day", "Weekly") or that is just the provider's own name.
 * A name that tells models or products apart ("Opus", "Sonnet") is kept.
 */
function isGenericLimitName(name: string, providerId?: string, providerLabel?: string): boolean {
  const n = flat(name)
  if (n.length === 0) return true
  if (WINDOW_ONLY.test(n)) return true
  const id = providerId ? flat(providerId) : ''
  const label = providerLabel ? flat(providerLabel) : ''
  return (id !== '' && n === id) || (label !== '' && n.length >= 3 && label.startsWith(n))
}

function genericWindowLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}-minute window`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour window`
  return `${Math.round(minutes / (60 * 24))}-day window`
}

interface Naming {
  generic: boolean
}

/** Window rows: a generic name becomes "5-hour window"; any other keeps its name plus the length. */
function quotaLabel(base: string, minutes: number | null | undefined, { generic }: Naming): string {
  if (generic && typeof minutes === 'number' && minutes > 0) return genericWindowLabel(minutes)
  return windowLabel(base, minutes)
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-(--color-error)'
  if (percent >= 70) return 'bg-(--accent-orange-text)'
  return 'bg-(--accent-green-text)'
}

/** A real but sub-percent use reads "<1%", never a false "0%"; only a true zero is 0%. */
function formatPercent(raw: number): string {
  return raw > 0 && raw < 1 ? '<1%' : `${Math.round(raw)}%`
}

function Meta({ children }: { children: string }) {
  return <p className="text-meta text-(--color-text-subtle) tabular-nums">{children}</p>
}

function UsageRow({
  label,
  window,
  now,
}: {
  label: string
  window: NonNullable<ProviderUsageLimit['primary']>
  now: number
}) {
  const percent = Math.max(0, Math.min(100, window.used_percent))
  const reset = formatResetIn(window.resets_at, now)
  const color = barColor(percent)

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-(--color-text)">{label}</span>
        <span className="shrink-0 text-meta text-(--color-text-muted) tabular-nums">{formatPercent(percent)} used</span>
      </div>
      <div className="relative h-1 rounded-full bg-(--bg-key)">
        {percent > 0 && (
          <>
            <div className={cn('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${percent}%` }} />
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
      {reset && <Meta>{reset}</Meta>}
    </div>
  )
}

function SpendRow({
  label,
  spend,
  now,
}: {
  label: string
  spend: NonNullable<ProviderUsageLimit['spend']>
  now: number
}) {
  const rawPercent =
    typeof spend.used_percent === 'number'
      ? spend.used_percent
      : typeof spend.used === 'number' && typeof spend.limit === 'number' && spend.limit > 0
        ? (spend.used / spend.limit) * 100
        : 0
  const percent = Math.max(0, Math.min(100, rawPercent))
  const reset = formatResetIn(spend.resets_at, now)
  const color = spend.reached ? 'bg-(--color-error)' : barColor(percent)
  const money = moneyFormatter(spend.currency)
  const fmt = (n: number) => formatUsageAmount(n, spend.currency)

  // A known currency: the used amount leads, the cap and what is left are secondary.
  if (money && typeof spend.used === 'number' && typeof spend.limit === 'number') {
    return (
      <div className="min-w-0 space-y-1 @md:col-span-2">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="truncate text-xs font-medium text-(--color-text)">{label}</span>
          <span className="shrink-0 tabular-nums">
            <span className="text-sm font-semibold text-(--color-text)">{fmt(spend.used)}</span>
            {' '}
            <span className="text-meta text-(--color-text-muted)">{`/ ${fmt(spend.limit)}`}</span>
          </span>
        </div>
        <div className="relative h-1 rounded-full bg-(--bg-key)">
          {percent > 0 && <div className={cn('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${percent}%` }} />}
          <div
            className="absolute inset-0"
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-meta text-(--color-text-subtle) tabular-nums">
          <span>{formatPercent(rawPercent)} used</span>
          {typeof spend.remaining === 'number' && (
            <>
              <span aria-hidden="true">·</span>
              <span>{`${fmt(spend.remaining)} remaining in this cap`}</span>
            </>
          )}
        </div>
        {reset && <Meta>{reset}</Meta>}
      </div>
    )
  }
  const detail =
    typeof spend.used === 'number' && typeof spend.limit === 'number'
      ? `${fmt(spend.used)} of ${fmt(spend.limit)} used${
          typeof spend.remaining === 'number' ? ` \u00B7 ${fmt(spend.remaining)} left` : ''
        }`
      : null

  return (
    <div className="min-w-0 space-y-1 @md:col-span-2">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-(--color-text)">{label}</span>
        {/* Unclamped — an overage is the whole point of this row. */}
        <span className="shrink-0 text-meta text-(--color-text-muted) tabular-nums">{formatPercent(rawPercent)} used</span>
      </div>
      <div className="relative h-1 rounded-full bg-(--bg-key)">
        {percent > 0 && <div className={cn('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${percent}%` }} />}
        <div
          className="absolute inset-0"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
      {detail && <Meta>{detail}</Meta>}
      {reset && <Meta>{reset}</Meta>}
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
      ? (credits.balance ?? 'Unlimited usage')
      : credits.has_credits
        ? 'Credits available'
        : 'No usage credits left'
  const showBalance = Boolean(credits.balance) && text !== credits.balance
  return (
    <div className="min-w-0 space-y-1 @md:col-span-2">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
        <span className="truncate font-medium text-(--color-text)">{label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 text-meta text-(--color-text-muted) tabular-nums">
          <span>{text}</span>
          {showBalance && (
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

function PeriodRow({ label, periodEndAt, now }: { label: string; periodEndAt?: number | null; now: number }) {
  const periodEnd = formatPeriodEndIn(periodEndAt, now)
  return (
    <div className="min-w-0 space-y-1 @md:col-span-2">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
        <span className="truncate font-medium text-(--color-text)">{label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 text-meta text-(--color-text-muted) tabular-nums">
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

function LimitSections({ limit, providerId, providerLabel, now }: { limit: ProviderUsageLimit; providerId?: string; providerLabel?: string; now: number }) {
  const base = usageLabel(limit)
  const generic = isGenericLimitName(limit.limit_name || limit.limit_id || '', providerId, providerLabel)
  // Spend and credits rows named for the provider or a window just say what they are.
  const spendLabel = generic ? 'Spend cap' : `${base} \u00B7 Spend cap`
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
      {limit.primary && <UsageRow label={quotaLabel(base, limit.primary.window_minutes, { generic })} window={limit.primary} now={now} />}
      {limit.secondary && <UsageRow label={quotaLabel(base, limit.secondary.window_minutes, { generic })} window={limit.secondary} now={now} />}
      {spend && hasSpendFigures && <SpendRow label={spendLabel} spend={spend} now={now} />}
      {shouldRenderCredits && limit.credits && (
        <CreditsRow label={generic ? 'Credits' : base} credits={limit.credits} spend={spend} />
      )}
      {!limit.primary && !limit.secondary && !limit.credits && !hasSpendFigures &&
        (typeof limit.period_start_at === 'number' || typeof limit.period_end_at === 'number') && (
          <PeriodRow label={base} periodEndAt={limit.period_end_at} now={now} />
        )}
    </>
  )
}

/** The plan name as the source reports it, or null: never guessed. */
export function usagePlan(limits: ProviderUsageLimit[]): string | null {
  return limits[0]?.plan_type || null
}

export function UsagePanel({
  providerId,
  providerLabel,
  credentialId,
  limits,
  updatedAt,
  stale = false,
  footnote,
  title,
  ariaLabel,
  showPlan = true,
}: {
  providerId?: string
  /** The provider's catalogue name; a limit named after it is shown as a plain window. */
  providerLabel?: string
  /** The account the usage belongs to (a reset redeems on that account). */
  credentialId?: string
  limits: ProviderUsageLimit[]
  /** When the numbers were read (ms). */
  updatedAt?: number
  /** The numbers are held over from an earlier read, not just fetched. */
  stale?: boolean
  /** A short note beside the "updated" time, e.g. that refreshing is paused. */
  footnote?: string
  /** An optional heading; per-profile panels leave it off. */
  title?: string
  ariaLabel?: string
  /** Show the plan name here; a profile header may show it instead. */
  showPlan?: boolean
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const resetMutation = useResetProviderUsageMutation()
  // Relative times are computed from this, so they keep moving between fetches.
  const now = useNowMs(true, 30_000)

  if (limits.length === 0) return null
  const primary = limits[0]
  const updated = formatUpdatedAgo(updatedAt, stale, now)
  const resetCredits = primary?.reset_credits_available
  const plan = showPlan ? usagePlan(limits) : null
  const hasResets = typeof resetCredits === 'number' && resetCredits > 0
  const targetProviderId = providerId || primary?.limit_id || 'codex'

  const primaryUsed = primary?.primary?.used_percent ?? 0
  const secondaryUsed = primary?.secondary?.used_percent ?? 0
  const spendUsed =
    typeof primary?.spend?.used_percent === 'number'
      ? primary.spend.used_percent
      : typeof primary?.spend?.used === 'number' && typeof primary?.spend?.limit === 'number' && primary.spend.limit > 0
        ? (primary.spend.used / primary.spend.limit) * 100
        : 0
  const maxUsedPercent = Math.max(primaryUsed, secondaryUsed, spendUsed)
  const isEligibleToReset =
    maxUsedPercent >= 99 ||
    Boolean(primary?.rate_limit_reached_type) ||
    Boolean(primary?.spend?.reached)

  const handleResetClick = () => {
    if (!isEligibleToReset) {
      setAlertOpen(true)
    } else {
      setConfirmOpen(true)
    }
  }

  const handleConfirmReset = () => {
    resetMutation.mutate(
      { providerId: targetProviderId, credentialId },
      {
        onSuccess: () => {
          setConfirmOpen(false)
          useToastStore.getState().push({
            tone: 'success',
            title: 'Rate limit reset redeemed',
            description: 'Your rate limit has been successfully reset.',
          })
        },
        onError: () => {
          useToastStore.getState().push({
            tone: 'error',
            title: 'Reset failed',
            // Fixed words: the server's text is not shown.
            description: 'The reset could not be redeemed. Try again later.',
          })
        },
      },
    )
  }

  return (
    // A plain section inside the profile, not a card in a card. `@container`:
    // columns follow the panel's own width, not the viewport's.
    <section aria-label={ariaLabel ?? title ?? 'Usage'} className="@container space-y-2.5">
      {title && <p className="text-xs font-medium leading-none text-(--color-text)">{title}</p>}

      <div data-slot="usage-grid" className="grid grid-cols-1 gap-x-6 gap-y-3 @md:grid-cols-2">
        {limits.map((limit, index) => (
          <LimitSections key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} providerId={providerId} providerLabel={providerLabel} now={now} />
        ))}
      </div>

      {primary?.rate_limit_reached_type && (
        <Callout tone="error" title="Limit reached">
          {/* Only a plain snake_case code is shown, never free-form text. */}
          {/^[a-z][a-z0-9_]{0,59}$/i.test(primary.rate_limit_reached_type) ? primary.rate_limit_reached_type.replaceAll('_', ' ') : null}
        </Callout>
      )}

      {(updated || plan || hasResets || footnote) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {updated && <span className="text-meta text-(--color-text-subtle)">{updated}</span>}
            {footnote && <span className="text-meta text-(--color-text-subtle)">{footnote}</span>}
            {plan && <Chip>{plan}</Chip>}
          </div>
          {hasResets && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="text-meta font-medium text-(--accent-green-text)"
                title="A reset clears this usage limit right away. Redeem one once you reach the limit."
              >
                {resetCredits} {resetCredits === 1 ? 'reset' : 'resets'} available
              </span>
              <Button variant="default" size="xs" className="pointer-coarse:min-h-9" onClick={handleResetClick}>
                Redeem reset
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Alert Dialog when usage is below 99% */}
      <Dialog open={alertOpen} onOpenChange={setAlertOpen}>
        <DialogContent className="gap-3">
          <DialogHeader className="gap-1.5">
            <DialogTitle>Can&apos;t redeem a reset yet</DialogTitle>
            <DialogDescription className="text-xs text-(--color-text-muted)">
              Your current usage is {Math.round(maxUsedPercent)}%. A reset can be redeemed once usage reaches 99% or the limit is hit, so a credit is not spent early.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="justify-end pt-2">
            <Button variant="primary" onClick={() => setAlertOpen(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog when usage is 99-100% */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="gap-3">
          <DialogHeader className="gap-1.5">
            <DialogTitle>Redeem a usage reset?</DialogTitle>
            <DialogDescription className="text-xs text-(--color-text-muted)">
              Uses 1 of your {resetCredits} reset credit{resetCredits === 1 ? '' : 's'} to clear the usage limit now. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end gap-2 pt-2">
            <Button variant="default" onClick={() => setConfirmOpen(false)} disabled={resetMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleConfirmReset} disabled={resetMutation.isPending}>
              {resetMutation.isPending ? 'Redeeming…' : 'Redeem reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
