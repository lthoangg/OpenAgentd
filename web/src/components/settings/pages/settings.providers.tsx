import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProviderInfo } from '@/api/client'
import { useProvidersQuery } from '@/queries'
import { eagerlyWarmProviderModels } from './settings.providers/eagerModels'
import { SearchBar } from '@/components/ui/search-bar'
import { SettingsCallout } from '@/components/settings/SettingsCallout'
import { SettingsPage } from '@/components/settings/SettingsPage'
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
        'inline-flex min-h-10 items-center gap-1.5 rounded-sm border px-2.5 sm:min-h-7',
        'text-xs font-medium transition-colors select-none',
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
    <SettingsPage
      title="Providers"
      description={
        <>
          Connect the model providers OpenAgentd may use. Keys and tokens stay on this machine.
        </>
      }
      actions={
        providers.length > 0 ? (
          <span className="rounded-full border border-(--color-border) bg-(--bg-card) px-2.5 py-1 text-[11px] font-medium text-(--color-text-muted)">
            {connectedCount} connected
          </span>
        ) : null
      }
    >
        <div className="space-y-4">
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              {/* Status group */}
              <div className="flex flex-wrap items-center gap-1.5">
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
              <div className="flex flex-wrap items-center gap-1.5">
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
            <SettingsCallout tone="error" role="alert">
              {providersQ.error instanceof Error
                ? providersQ.error.message
                : String(providersQ.error)}
            </SettingsCallout>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-xs text-(--color-text-muted)">
                No providers match the current filters.
              </p>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-xs text-xs font-medium text-(--color-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 pt-2">
              {filtered.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
            </div>
          )}
        </div>
    </SettingsPage>
  )
}
