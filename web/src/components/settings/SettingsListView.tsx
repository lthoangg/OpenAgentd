/**
 * SettingsListView — single-column list rendered inside the settings modal.
 * Navigation is entirely callback-driven; no router Links are used so this
 * component works correctly inside the overlay without any URL changes.
 */
import { AlertCircle, Plus, Search } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ListViewRow {
  /** Stable key per row. */
  key: string
  /** Whether the row is selected (controls highlight). */
  active?: boolean
  /** Render as a non-clickable group header. */
  kind?: 'item' | 'group'
  /** Main label of the card. */
  title: string
  /** Optional secondary inline tag (e.g. role badge). */
  badge?: string
  /** Short description rendered below the title. */
  description?: string
  /** File path or other monospace meta line shown under the description. */
  meta?: string
  /** Validation error message. When set, an error icon is shown next to the title. */
  invalidReason?: string
  /** Optional trailing content (e.g. status dot). */
  trailing?: ReactNode
  /** Called when the row is clicked. */
  onClick?: () => void
}

export interface SettingsListViewProps {
  title: string
  description: string
  newLabel: string
  /** Called when the "+ New" button is clicked. */
  onNew: () => void
  /** Optional custom element to replace the default "+ New" button. */
  newAction?: ReactNode
  /** Placeholder for the filter input. */
  filterPlaceholder: string
  /** Optional tab strip rendered above the filter input. */
  tabs?: ReactNode
  rows: ListViewRow[]
  isLoading: boolean
  isError: boolean
  /** Empty-state body when there are no rows at all (before filtering). */
  emptyTitle: string
  emptyBody: string
}

// ─── View ──────────────────────────────────────────────────────────────────

export function SettingsListView({
  title,
  description,
  newLabel,
  onNew,
  newAction,
  filterPlaceholder,
  tabs,
  rows,
  isLoading,
  isError,
  emptyTitle,
  emptyBody,
}: SettingsListViewProps) {
  const filterId = useId()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const t = query.trim().toLowerCase()
    if (!t) return rows
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(t) ||
        (r.description ?? '').toLowerCase().includes(t) ||
        (r.meta ?? '').toLowerCase().includes(t),
    )
  }, [rows, query])

  const total = rows.length
  const countLabel = total === 1 ? '1 item' : `${total} items`

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pt-8 pb-12 sm:px-8">
        {/* ── Title row ─────────────────────────────────────────────────── */}
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-(--color-text)">
              {title}
            </h1>
            <p className="mt-1 text-sm text-(--color-text-muted)">
              {description}
            </p>
          </div>
          {newAction ?? (
            <Button size="sm" onClick={onNew}>
              <Plus size={13} aria-hidden="true" />
              {newLabel}
            </Button>
          )}
        </header>

        {/* ── Optional tabs ─────────────────────────────────────────────── */}
        {tabs && <div className="mt-6">{tabs}</div>}

        {/* ── Filter ────────────────────────────────────────────────────── */}
        {(isLoading || rows.length > 0) && (
          <div className="mt-4">
            <label htmlFor={filterId} className="sr-only">
              {filterPlaceholder}
            </label>
            <div className="relative flex h-9 items-center rounded-lg border border-(--color-border) bg-(--bg-card) focus-within:border-(--focus-ring) focus-within:ring-3 focus-within:ring-(--focus-ring)/30">
              <Search
                size={13}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-(--color-text-muted)"
                aria-hidden="true"
              />
              <Input
                id={filterId}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                className="h-full flex-1 border-0 bg-transparent pr-3 pl-9 text-sm focus:ring-0 focus-visible:ring-0"
              />
              {!isLoading && (
                <span className="pr-3 font-mono text-[11px] tabular-nums text-(--color-text-muted)">
                  {countLabel}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="mt-3 space-y-2">
          {isLoading && (
            <p className="py-10 text-center text-sm text-(--color-text-muted)">
              Loading…
            </p>
          )}
          {isError && (
            <p className="py-10 text-center text-sm text-(--color-error)">
              Failed to load.
            </p>
          )}
          {!isLoading && !isError && total === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-(--color-border) bg-(--bg-card) px-4 py-12 text-center">
              <p className="text-sm font-medium text-(--color-text)">{emptyTitle}</p>
              <p className="max-w-md text-xs leading-relaxed text-(--color-text-muted)">
                {emptyBody}
              </p>
              <Button size="sm" onClick={onNew}>
                <Plus size={12} aria-hidden="true" />
                {newLabel}
              </Button>
            </div>
          )}
          {!isLoading && !isError && total > 0 && filtered.length === 0 && (
            <p className="py-10 text-center text-sm text-(--color-text-muted)">
              No matches for &ldquo;{query}&rdquo;.
            </p>
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <ul className="space-y-2">
              {filtered.map((row) => (
                <li key={row.key}>
                  <ListCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Card ──────────────────────────────────────────────────────────────────

function ListCard({ row }: { row: ListViewRow }) {
  if (row.kind === 'group') {
    return (
      <div className="px-1 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-(--color-text-muted)">
        {row.title}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={row.onClick}
      aria-current={row.active ? 'page' : undefined}
      className={cn(
        'group flex min-h-11 w-full items-start gap-3 rounded-lg border bg-(--bg-card) px-4 py-3 text-left transition-colors',
        'hover:border-(--color-border-strong)',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-(--focus-ring)/40',
        row.active
          ? 'border-(--color-accent)'
          : 'border-(--color-border)',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-(--color-text)">
            {row.title}
          </span>
          {row.badge && (
            <span className="rounded-md bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted) ring-1 ring-(--color-border)">
              {row.badge}
            </span>
          )}
          {row.invalidReason && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-(--color-error)">
                    <AlertCircle size={12} aria-label="Invalid configuration" />
                  </span>
                }
              />
              <TooltipContent>{row.invalidReason}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {row.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-(--color-text-muted)">
            {row.description}
          </p>
        )}
        {row.meta && (
          <p className="mt-1 truncate font-mono text-[10px] text-(--color-text-muted)/70">
            {row.meta}
          </p>
        )}
      </div>
      {row.trailing && <div className="shrink-0">{row.trailing}</div>}
    </button>
  )
}
