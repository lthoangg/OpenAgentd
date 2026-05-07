/**
 * Page-level chrome: header, loading/error states.
 * Used by both the summary and trace-detail routes inside `/telemetry`.
 */

import { Link } from '@tanstack/react-router'
import { Activity, AlertTriangle, Loader2 } from 'lucide-react'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'

export function PageHeader({
  isFetching,
  left,
  subtitle,
  right,
}: {
  isFetching: boolean
  left?: React.ReactNode
  subtitle?: string
  right: React.ReactNode
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface-2) px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/"
          className="flex items-center gap-2.5 overflow-hidden rounded-md p-1 -ml-1 transition-colors hover:bg-(--color-accent-subtle)"
          title="Home"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-(--color-accent-subtle) ring-1 ring-(--color-border-strong)">
            <img src={OpenAgentdAppIcon} width={28} height={28} alt="OpenAgentd logo" className="rounded-md" />
          </div>
          <span className="text-sm font-semibold text-(--color-text)">Telemetry</span>
        </Link>
        {left}
        <div className="flex items-center gap-1.5 text-(--color-text-muted)">
          <Activity size={14} className="text-(--color-accent)" />
          <span className="text-xs">{subtitle ?? 'Span aggregates & latency'}</span>
          {isFetching && (
            <Loader2
              size={13}
              className="ml-1 animate-spin"
              aria-label="Refreshing"
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </header>
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
    <div className="rounded-xl border border-(--color-danger-subtle) bg-(--color-danger-subtle)/30 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-(--color-danger)" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-(--color-text)">
            Could not load observability data
          </p>
          <p className="mt-1 text-xs text-(--color-text-muted)">{message}</p>
          <button
            onClick={onRetry}
            className="mt-3 rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs font-medium text-(--color-text) transition-colors hover:bg-(--color-accent-subtle)"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  )
}
