/**
 * SettingsListView — the list page shared by Agents, Skills and MCP servers:
 * page header with a New action, a filter, then one card of rows.
 * Navigation is entirely callback-driven; no router Links are used so this
 * component works correctly inside the overlay without any URL changes.
 */
import { FolderOpen, Plus, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBar } from '@/components/ui/search-bar'
import { SectionCard } from '@/components/ui/section-card'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
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
  /** Render the title in mono: it is an identifier (agent name, server id). */
  titleMono?: boolean
  /** Secondary words beside the title (an agent's display name). */
  subtitle?: string
  /** Optional secondary inline tag (e.g. role badge). */
  badge?: string
  /** Tone of the badge chip. */
  badgeTone?: ChipTone
  /** Let the description run to two lines instead of one. */
  descriptionLines?: 1 | 2
  /** Short description rendered below the title. */
  description?: string
  /** File path or other monospace meta line shown under the description. */
  meta?: string
  /** A word tag on the meta line instead of mono text (e.g. "session model"). */
  metaChip?: string
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
  /** Load error detail shown under the error title. */
  error?: unknown
  /** Refetch after a load error. */
  onRetry?: () => void
  /** Empty-state body when there are no rows at all (before filtering). */
  emptyTitle: string
  emptyBody: string
  /** Glyph for the empty state. */
  emptyIcon?: LucideIcon
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
  error,
  onRetry,
  emptyTitle,
  emptyBody,
  emptyIcon = FolderOpen,
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
  const newButton = (
    <Button size="sm" onClick={onNew}>
      <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
      {newLabel}
    </Button>
  )

  return (
    <SettingsPage title={title} description={description} actions={newAction ?? newButton}>
      <div className="space-y-4">
        {tabs}

        {(isLoading || rows.length > 0) && (
          <SearchBar
            placeholder={filterPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            count={total}
            loading={isLoading}
          />
        )}

        {isLoading && (
          <SectionCard role="status" aria-label={`Loading ${title.toLowerCase()}`}>
            <div className="divide-y divide-(--color-border-subtle)">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex min-h-14 flex-col justify-center gap-1.5 px-4 py-3">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-64 max-w-full" />
                </div>
              ))}
            </div>
          </SectionCard>
        )}
        {isError && (
          <Callout
            tone="error"
            role="alert"
            title={`Couldn't load ${title.toLowerCase()}`}
            action={onRetry ? <Button size="xs" onClick={onRetry}>Retry</Button> : undefined}
          >
            {error instanceof Error ? error.message : 'Check the server connection, then try again.'}
          </Callout>
        )}
        {!isLoading && !isError && total === 0 && (
          <SectionCard className="border-dashed">
            <EmptyState fill={false} className="px-6 py-10" icon={emptyIcon} title={emptyTitle} body={emptyBody} action={newButton} />
          </SectionCard>
        )}
        {!isLoading && !isError && total > 0 && filtered.length === 0 && (
          <p className="py-10 text-center text-xs text-(--color-text-muted)">
            No matches for &ldquo;{query}&rdquo;.
          </p>
        )}
        {!isLoading && !isError && filtered.length > 0 && (
          <SectionCard>
            <ul className="divide-y divide-(--color-border-subtle)">
              {filtered.map((row) => (
                <li key={row.key}>
                  <ListRow row={row} />
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
      </div>
    </SettingsPage>
  )
}

// ─── Row ───────────────────────────────────────────────────────────────────

function ListRow({ row }: { row: ListViewRow }) {
  if (row.kind === 'group') {
    return (
      <div className="bg-(--bg-key)/25 px-4 pt-3 pb-1.5 text-xs font-medium text-(--color-text-muted) select-none">
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
        'group flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left',
        'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
        row.active && 'bg-(--bg-key)/60',
      )}
    >
      {row.icon && (
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-key) text-(--color-text-muted)"
          aria-hidden="true"
        >
          {row.icon}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate', TEXT.label, row.titleMono && 'font-mono')}>{row.title}</span>
          {row.subtitle && <span className={cn('truncate', TEXT.hint)}>{row.subtitle}</span>}
          {row.badge && <Chip tone={row.badgeTone}>{row.badge}</Chip>}
          {row.invalidReason && <Chip tone="error">Invalid</Chip>}
        </span>
        {row.invalidReason && (
          <span className="mt-0.5 line-clamp-2 text-xs text-(--color-error)">{row.invalidReason}</span>
        )}
        {row.description && (
          <span className={cn('mt-0.5', row.descriptionLines === 2 ? 'line-clamp-2' : 'line-clamp-1', TEXT.hint)}>{row.description}</span>
        )}
        {row.meta && (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-(--color-text-subtle)">{row.meta}</span>
        )}
        {row.metaChip && (
          <span className="mt-1 flex"><Chip variant="outline">{row.metaChip}</Chip></span>
        )}
      </span>

      {row.trailing && (
        <span className="shrink-0 text-(--color-text-muted)">{row.trailing}</span>
      )}
    </button>
  )
}
