import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProviderInfo } from '@/api/client'
import { useProvidersQuery } from '@/queries'
import { eagerlyWarmProviderModels } from './settings.providers/eagerModels'
import { SearchBar } from '@/components/ui/search-bar'
import { cn } from '@/lib/utils'
import { providerKindLabel } from './settings.providers/providerUtils'
import { ProviderCard } from './settings.providers/ProviderCard'

// ─── Filter types ───────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'connected' | 'not-connected'
type KindFilter = 'all' | ProviderInfo['kind']

// ─── FilterBar ──────────────────────────────────────────────────────────────

function FilterChip({
  active,
  count,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  count?: number
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-10 items-center gap-1 rounded-xs border px-2 sm:min-h-6',
        'text-[10.5px] font-medium transition-colors select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
        active
          ? 'border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
          : 'border-(--color-border) bg-(--bg-card) text-(--color-text-muted) hover:border-(--color-border) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      {children}
      {count !== undefined && (
        <span className={cn(
          'tabular-nums',
          active ? 'text-(--color-text-muted)' : 'text-(--color-text-subtle)',
        )}>
          {count}
        </span>
      )}
    </button>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ProvidersSettingsPage() {
  const providersQ = useProvidersQuery()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')

  const providers = useMemo(() => providersQ.data?.providers ?? [], [providersQ.data?.providers])
  const connectedCount = providers.filter((p) => p.is_configured).length

  // Eagerly warm every uncached configured provider in parallel. The registry
  // only needs one refresh after every request has settled.
  useEffect(() => {
    if (!providersQ.data) return
    void eagerlyWarmProviderModels(providersQ.data.providers, queryClient)
  }, [providersQ.data, queryClient])

  // Counts per kind (unaffected by kind filter, so chips don't vanish while
  // the user explores — only status + search narrow the kind counts)
  const kindCounts = useMemo<Record<ProviderInfo['kind'], number>>(() => {
    const base = providers.filter((p) => {
      if (statusFilter === 'connected' && !p.is_configured) return false
      if (statusFilter === 'not-connected' && p.is_configured) return false
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        if (!p.label.toLowerCase().includes(q) &&
            !p.id.toLowerCase().includes(q) &&
            !p.description.toLowerCase().includes(q)) return false
      }
      return true
    })
    const counts: Record<string, number> = {}
    for (const p of base) counts[p.kind] = (counts[p.kind] ?? 0) + 1
    return counts as Record<ProviderInfo['kind'], number>
  }, [providers, statusFilter, query])

  // Status counts (unaffected by status filter)
  const statusCounts = useMemo(() => {
    const base = providers.filter((p) => {
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        if (!p.label.toLowerCase().includes(q) &&
            !p.id.toLowerCase().includes(q) &&
            !p.description.toLowerCase().includes(q)) return false
      }
      return true
    })
    return {
      connected: base.filter((p) => p.is_configured).length,
      'not-connected': base.filter((p) => !p.is_configured).length,
    }
  }, [providers, kindFilter, query])

  // Final filtered list — all three dimensions compose
  const filtered = useMemo(() => {
    return providers.filter((p) => {
      if (statusFilter === 'connected' && !p.is_configured) return false
      if (statusFilter === 'not-connected' && p.is_configured) return false
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        if (!p.label.toLowerCase().includes(q) &&
            !p.id.toLowerCase().includes(q) &&
            !p.description.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [providers, statusFilter, kindFilter, query])

  const hasFilters = query.trim() !== '' || statusFilter !== 'all' || kindFilter !== 'all'

  const clearFilters = () => {
    setQuery('')
    setStatusFilter('all')
    setKindFilter('all')
  }

  // Which kinds actually have providers (ever, regardless of filters)
  const presentKinds = useMemo(
    () => new Set(providers.map((p) => p.kind)),
    [providers],
  )

  const KIND_OPTIONS: { value: ProviderInfo['kind']; label: string }[] = [
    { value: 'api_key',      label: 'API key' },
    { value: 'oauth',        label: 'OAuth' },
    { value: 'local',        label: 'Local' },
    { value: 'cloud_creds',  label: providerKindLabel('cloud_creds') },
  ]

  const showFilterBar = !providersQ.isLoading && providers.length > 0

  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-3 select-none sm:px-4">
        <KeyRound size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="truncate text-xs font-semibold text-(--color-text)">Providers</h1>
        <div className="min-w-1 flex-1" />
        <span className="hidden shrink-0 text-[10px] font-medium text-(--color-text-subtle) sm:inline">
          {connectedCount} connected
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Add the model provider OpenAgentd should use. API keys are written to your local config; OAuth tokens are stored in your local cache. Click{' '}
            <span className="font-medium">List models</span> to verify a key before saving.
          </p>

          {showFilterBar && (
            <SearchBar
              placeholder="Filter providers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              count={providers.length}
            />
          )}

          {/* ── Filter bar ──────────────────────────────────────────── */}
          {showFilterBar && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Status group */}
              <div className="flex items-center gap-1">
                <FilterChip
                  active={statusFilter === 'all'}
                  onClick={() => setStatusFilter('all')}
                  count={providers.length}
                >
                  All
                </FilterChip>
                <FilterChip
                  active={statusFilter === 'connected'}
                  count={statusCounts.connected}
                  disabled={statusCounts.connected === 0}
                  onClick={() => setStatusFilter(
                    statusFilter === 'connected' ? 'all' : 'connected'
                  )}
                >
                  Connected
                </FilterChip>
                <FilterChip
                  active={statusFilter === 'not-connected'}
                  count={statusCounts['not-connected']}
                  disabled={statusCounts['not-connected'] === 0}
                  onClick={() => setStatusFilter(
                    statusFilter === 'not-connected' ? 'all' : 'not-connected'
                  )}
                >
                  Not connected
                </FilterChip>
              </div>

              {/* Divider */}
              <span className="h-4 w-px bg-(--color-border)" aria-hidden="true" />

              {/* Kind group — only show kinds that actually exist */}
              <div className="flex items-center gap-1">
                <FilterChip
                  active={kindFilter === 'all'}
                  onClick={() => setKindFilter('all')}
                >
                  All types
                </FilterChip>
                {KIND_OPTIONS.filter((o) => presentKinds.has(o.value)).map((o) => (
                  <FilterChip
                    key={o.value}
                    active={kindFilter === o.value}
                    count={kindCounts[o.value] ?? 0}
                    disabled={(kindCounts[o.value] ?? 0) === 0}
                    onClick={() => setKindFilter(
                      kindFilter === o.value ? 'all' : o.value
                    )}
                  >
                    {o.label}
                  </FilterChip>
                ))}
              </div>
            </div>
          )}

          {/* ── Body ────────────────────────────────────────────────── */}
          {providersQ.isLoading ? (
            <div className="flex items-center gap-2 text-xs font-mono text-(--color-text-muted)">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading providers…
            </div>
          ) : providersQ.error ? (
            <div className="rounded-sm border border-(--color-error)/25 bg-(--color-error-subtle) p-3 text-xs text-(--color-error)">
              {providersQ.error instanceof Error
                ? providersQ.error.message
                : String(providersQ.error)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-xs text-(--color-text-muted)">
                No providers match the current filters.
              </p>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs font-medium text-(--color-text) underline-offset-2 hover:underline focus-visible:outline-none"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              {filtered.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
