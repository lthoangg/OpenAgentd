import type { ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { ProviderUsageError, formatRetryIn, isSnapshotExpired, snapshotUpdatedAtMs } from '@/lib/provider-usage'
import { useProviderUsageQuery } from '@/queries'
import { UsagePanel, usagePlan } from './UsagePanel'
import { useNowMs } from './useNowMs'

type UsageQuery = ReturnType<typeof useProviderUsageQuery>

/**
 * Milliseconds left of a "retry later" answer. Ticks once a second only while
 * one is counting down, so a quiet profile costs nothing.
 */
export function useRetryCountdown(error: unknown): number {
  const retryAt = error instanceof ProviderUsageError && error.kind === 'rate_limited' ? error.retryAtMs : null
  const now = useNowMs(retryAt !== null, 1000, retryAt ?? undefined)
  return retryAt === null ? 0 : Math.max(0, retryAt - now)
}

function UsageRefresh({ query, label, cooling, needsSignIn }: { query: UsageQuery; label: string; cooling: boolean; needsSignIn: boolean }) {
  const busy = query.isFetching
  const paused = cooling || needsSignIn
  const reason = needsSignIn ? 'Paused until you sign in again' : cooling ? 'Paused until the provider allows another request' : null
  // Touch: a glyph beside the ⋯, a pair of quiet icons, rather than one word
  // standing in for every action the ⋯ sheet holds.
  const touch = useTouchFirst()
  if (touch) {
    return (
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Refresh usage for ${label}`}
        disabled={busy || paused}
        className="touch-hit relative text-(--color-text-muted)"
        onClick={() => void query.refresh()}
      >
        <RefreshCw size={16} className={busy ? 'animate-spin' : undefined} aria-hidden="true" />
      </Button>
    )
  }
  const button = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={`Refresh usage for ${label}`}
      disabled={busy || paused}
      className="pointer-coarse:min-h-9"
      // The one request that asks the daemon to skip its short cache.
      onClick={() => void query.refresh()}
    >
      {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
      Refresh
    </Button>
  )
  if (!reason) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function UsageSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">Loading usage…</span>
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-1 w-full" />
    </div>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-meta text-(--color-text-subtle)">{children}</p>
}

interface BodyProps {
  query: UsageQuery
  remainingMs: number
  label: string
  providerId: string
  /** The provider's catalogue name, so a limit named after it is not shown as a model. */
  providerLabel?: string
  credentialId?: string
  onReconnect?: () => void
  /** Panel heading; the API-key block keeps one, profiles do not. */
  title?: string
  /** Say something when the source reports nothing; otherwise stay silent. */
  emptyText?: string
  /** Say nothing for a provider without usage (the API-key block's old behaviour). */
  quietUnsupported?: boolean
}

function UsageBody({ query, remainingMs, label, providerId, providerLabel, credentialId, onReconnect, title, emptyText, quietUnsupported }: BodyProps) {
  const error = query.error
  const data = query.data
  const kind = error?.kind
  // Held numbers are only shown for 30 minutes once a refresh has failed; checked on a slow clock.
  const now = useNowMs(Boolean(error && data), 30_000)
  const expired = Boolean(error && data) && isSnapshotExpired(snapshotUpdatedAtMs(data!, query.dataUpdatedAt), now)

  // Needs a new sign-in: not "stale", and not worth showing numbers from before.
  if (kind === 'credentials') {
    return (
      <Callout
        tone="error"
        role="alert"
        title="Sign-in needs attention"
        action={onReconnect ? <Button type="button" size="xs" variant="primary" onClick={onReconnect}>Reconnect</Button> : undefined}
      >
        The provider asked for a new sign-in before it would report usage.
      </Callout>
    )
  }
  if (!data && query.isLoading) return <UsageSkeleton />

  const hasData = Boolean(data && data.limits.length > 0) && !expired
  // Held numbers survive any refresh failure; they are only ever labelled "last updated".
  const stale = hasData && Boolean(error)

  let notice: ReactNode = null
  let empty: ReactNode = null
  if (kind === 'rate_limited') {
    notice = (
      <Callout tone="warning" role="status" title="Usage is rate-limited">
        {remainingMs > 0 ? `Retry in ${formatRetryIn(remainingMs)}.` : 'Retrying now.'}
        {hasData ? ' Showing the last successful update.' : ''}
      </Callout>
    )
    if (!hasData) {
      empty = (
        <div className="space-y-0.5">
          <p className="text-xs text-(--color-text)">No usage snapshot yet.</p>
          <Quiet>This does not mean the account is out of quota. Sign-in is still active.</Quiet>
        </div>
      )
    }
  } else if (kind === 'unsupported') {
    if (!hasData && !quietUnsupported) empty = <Quiet>Usage is not available for this provider.</Quiet>
  } else if (kind === 'rejected' || kind === 'unavailable') {
    if (hasData) {
      notice = (
        <Callout tone="warning" role="status" title="Could not refresh usage">
          Showing the last successful update.
        </Callout>
      )
    } else {
      empty = <Quiet>Usage is unavailable right now.</Quiet>
    }
  } else if (!hasData && data && !expired && emptyText) {
    empty = <Quiet>{emptyText}</Quiet>
  }

  if (!notice && !empty && !hasData) return null
  return (
    <div className="space-y-2.5">
      {notice}
      {empty}
      {hasData && data && (
        <UsagePanel
          providerId={providerId}
          providerLabel={providerLabel}
          credentialId={credentialId}
          limits={data.limits}
          updatedAt={snapshotUpdatedAtMs(data, query.dataUpdatedAt)}
          stale={stale}
          footnote={stale && kind === 'rate_limited' ? 'Updates paused until retry time' : undefined}
          title={title}
          ariaLabel={title ? undefined : `Usage for ${label}`}
          // A profile's header carries the plan; the headed API-key block shows it itself.
          showPlan={Boolean(title)}
        />
      )}
    </div>
  )
}

/**
 * Owns one usage query and hands the caller its three visible parts, so a
 * profile header can place the plan and Refresh while the body sits below.
 * Mounting it is what starts requests: render it only for a profile that
 * should have usage.
 */
export function UsageScope({
  providerId,
  credentialId,
  label,
  providerLabel,
  onReconnect,
  title,
  emptyText,
  quietUnsupported,
  children,
}: Omit<BodyProps, 'query' | 'remainingMs'> & {
  children: (parts: { plan: string | null; refresh: ReactNode; body: ReactNode }) => ReactNode
}) {
  const query = useProviderUsageQuery(providerId, true, credentialId)
  const remainingMs = useRetryCountdown(query.error)
  const cooling = remainingMs > 0
  const plan = query.data && query.error?.kind !== 'credentials' ? usagePlan(query.data.limits) : null
  return children({
    plan,
    refresh: <UsageRefresh query={query} label={label} cooling={cooling} needsSignIn={query.error?.kind === 'credentials'} />,
    body: (
      <UsageBody
        query={query}
        remainingMs={remainingMs}
        label={label}
        providerId={providerId}
        providerLabel={providerLabel}
        credentialId={credentialId}
        onReconnect={onReconnect}
        title={title}
        emptyText={emptyText}
        quietUnsupported={quietUnsupported}
      />
    ),
  })
}

/**
 * Provider-wide usage for a provider that is not an OAuth sign-in (API key,
 * local, cloud): the block it always had, headed "Usage". Mount it only while
 * the provider's details are open.
 */
export function ProviderUsageBlock({ providerId, label }: { providerId: string; label: string }) {
  return (
    <UsageScope providerId={providerId} providerLabel={label} label={label} title="Usage" quietUnsupported>
      {({ body }) => body}
    </UsageScope>
  )
}
