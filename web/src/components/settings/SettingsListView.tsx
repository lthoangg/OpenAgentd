/**
 * SettingsListView — single-column list rendered inside the settings modal.
 * Navigation is entirely callback-driven; no router Links are used so this
 * component works correctly inside the overlay without any URL changes.
 */
import { AlertCircle, Plus } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { SearchBar } from '@/components/ui/search-bar'
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
  /** Icon rendered in the left icon-well. Replaces the generic trailing icon slot. */
  icon?: ReactNode
  /** Validation error message. When set, an error icon is shown next to the title. */
  invalidReason?: string
  /** Optional trailing content (e.g. status dot). Kept for back-compat; prefer icon. */
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
      <div className="px-6 py-5 space-y-4">
        {/* ── Title row ─────────────────────────────────────────────────── */}
        <header className="flex items-start gap-4 select-none">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold tracking-tight text-(--color-text)">
              {title}
            </h1>
            <p className="mt-1 text-xs text-(--color-text-muted) leading-relaxed">
              {description}
            </p>
          </div>
          {newAction ?? (
            <Button size="sm" onClick={onNew} className="h-8 text-xs">
              <Plus size={13} aria-hidden="true" />
              {newLabel}
            </Button>
          )}
        </header>

        {/* ── Optional tabs ─────────────────────────────────────────────── */}
        {tabs && <div className="mt-2">{tabs}</div>}

        {/* ── Filter ────────────────────────────────────────────────────── */}
        {(isLoading || rows.length > 0) && (
          <SearchBar
            placeholder={filterPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            count={total}
            loading={isLoading}
          />
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="space-y-1">
          {isLoading && (
            <p className="py-8 text-center text-xs text-(--color-text-muted) font-mono">
              Loading…
            </p>
          )}
          {isError && (
            <p className="py-8 text-center text-xs text-(--color-error) font-mono">
              Failed to load.
            </p>
          )}
          {!isLoading && !isError && total === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-(--color-border) bg-(--bg-card) px-4 py-8 text-center">
              <p className="text-xs font-semibold text-(--color-text)">{emptyTitle}</p>
              <p className="max-w-md text-[11px] leading-relaxed text-(--color-text-muted)">
                {emptyBody}
              </p>
              <Button size="sm" onClick={onNew} className="h-8 text-xs">
                <Plus size={12} aria-hidden="true" />
                {newLabel}
              </Button>
            </div>
          )}
          {!isLoading && !isError && total > 0 && filtered.length === 0 && (
            <p className="py-8 text-center text-xs text-(--color-text-muted) font-mono">
              No matches for &ldquo;{query}&rdquo;.
            </p>
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <ul className="space-y-1.5">
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
      <div className="px-1 pt-3 pb-1 font-mono text-[9px] font-bold uppercase tracking-wider text-(--color-text-subtle) select-none">
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
        // Base layout — rounded-sm = 8px, crisp enough for a dense list card
        'group flex w-full items-center gap-3 rounded-sm border px-3 py-2.5 text-left',
        // Surface & transition
        'bg-(--bg-card) transition-colors duration-100',
        // Hover — gentle warm lift, no border jump
        'hover:bg-(--bg-key)/30',
        // Focus ring
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
        // Active vs rest border
        row.active
          ? 'border-(--color-border-strong) bg-(--bg-key)/40'
          : 'border-(--color-border) hover:border-(--color-border)',
      )}
    >
      {/* ── Left icon well ──────────────────────────────────────────── */}
      {row.icon && (
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xs',
            'border border-(--color-border) bg-(--bg-key)',
            'text-(--color-text-muted) transition-colors duration-100',
            // Warm lift when the card is active
            row.active && 'border-(--color-border-strong) bg-(--bg-key)/70',
          )}
          aria-hidden="true"
        >
          {row.icon}
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1">
        {/* Title row */}
        <div className="flex items-center gap-1.5">
          <span className={cn(
            'truncate text-xs font-semibold leading-tight',
            row.active ? 'text-(--color-text)' : 'text-(--color-text)',
          )}>
            {row.title}
          </span>

          {/* Role / type badge */}
          {row.badge && (
            <span className="shrink-0 rounded border border-(--color-border) bg-(--bg-key) px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-(--color-text-muted) select-none">
              {row.badge}
            </span>
          )}

          {/* Invalid config warning */}
          {row.invalidReason && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="shrink-0 text-(--color-error)">
                    <AlertCircle size={11} aria-label="Invalid configuration" />
                  </span>
                }
              />
              <TooltipContent>{row.invalidReason}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Description */}
        {row.description && (
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-(--color-text-muted)">
            {row.description}
          </p>
        )}

        {/* Meta / path line */}
        {row.meta && (
          <p className="mt-0.5 truncate font-mono text-[9px] text-(--color-text-subtle)">
            {row.meta}
          </p>
        )}
      </div>

      {/* ── Trailing right-side content (status dots, etc.) ─────────── */}
      {row.trailing && (
        <div className="shrink-0 self-center text-(--color-text-muted)">
          {row.trailing}
        </div>
      )}
    </button>
  )
}
