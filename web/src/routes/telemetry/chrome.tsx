/**
 * Page-level chrome: header, loading/error states.
 * Used by both the summary and trace-detail routes inside `/telemetry`.
 */

import { AlertTriangle, Loader2 } from 'lucide-react'

import { AppHeader } from '@/components/AppHeader'

export function PageHeader({
  isFetching,
  left,
  subtitle,
  right,
}: {
  isFetching: boolean
  left?: React.ReactNode
  subtitle?: string
  right?: React.ReactNode
}) {
  return (
    <AppHeader
      title="Telemetry"
      center={
        <div className="ml-2 flex min-w-0 items-center gap-2 text-(--color-text-muted) sm:ml-4">
          {left}
          <span className="hidden truncate text-xs sm:inline">{subtitle ?? 'Span aggregates & latency'}</span>
          {isFetching && (
            <Loader2
              size={13}
              className="shrink-0 animate-spin"
              aria-label="Refreshing"
            />
          )}
        </div>
      }
      right={
        right ? (
          <div className="flex shrink-0 items-center gap-1 pr-2 sm:gap-2 sm:pr-3">{right}</div>
        ) : undefined
      }
    />
  )
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-(--color-text-muted)">
      <Loader2 size={18} className="mr-2 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="rounded-sm border border-(--color-error)/25 bg-(--color-error-subtle) p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-(--color-error)" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-(--color-text)">
            Could not load observability data
          </p>
          <p className="mt-1 text-xs text-(--color-text-muted)">{message}</p>
          <button
            onClick={onRetry}
            className="mt-3 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 text-xs font-medium text-(--color-text) transition-colors hover:bg-(--bg-key)"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  )
}
