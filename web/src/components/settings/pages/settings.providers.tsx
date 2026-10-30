import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProviderInfo } from '@/api/client'
import { useProvidersQuery } from '@/queries'
import { eagerlyWarmProviderModels } from './settings.providers/eagerModels'
import { SearchBar } from '@/components/ui/search-bar'
import { Callout } from '@/components/ui/callout'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { providerKindLabel } from './settings.providers/providerUtils'
import { ProviderCard } from './settings.providers/ProviderCard'

// ─── Filter types ───────────────────────────────────────────────────────────

type ProviderStatus = 'connected' | 'hidden' | 'not-connected'
type StatusFilter = 'all' | ProviderStatus
type KindFilter = 'all' | ProviderInfo['kind']

/** Every provider sits in exactly one status bucket; hidden wins. */
function providerStatus(p: ProviderInfo): ProviderStatus {
  if (p.is_disconnected) return 'hidden'
  return p.is_configured ? 'connected' : 'not-connected'
}

function matchesQuery(p: ProviderInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return p.label.toLowerCase().includes(q) ||
    p.id.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q)
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ProvidersSettingsPage() {
  const providersQ = useProvidersQuery()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')

  const providers = useMemo(() => providersQ.data?.providers ?? [], [providersQ.data?.providers])
  const connectedCount = providers.filter((p) => providerStatus(p) === 'connected').length

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
      if (statusFilter !== 'all' && providerStatus(p) !== statusFilter) return false
      return matchesQuery(p, query)
    })
    const counts: Record<string, number> = {}
    for (const p of base) counts[p.kind] = (counts[p.kind] ?? 0) + 1
    return counts as Record<ProviderInfo['kind'], number>
  }, [providers, statusFilter, query])

  // Status counts (unaffected by status filter)
  const statusCounts = useMemo(() => {
    const base = providers.filter((p) => {
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false
      return matchesQuery(p, query)
    })
    const counts: Record<ProviderStatus, number> = { connected: 0, hidden: 0, 'not-connected': 0 }
    for (const p of base) counts[providerStatus(p)] += 1
    return counts
  }, [providers, kindFilter, query])

  // Final filtered list — all three dimensions compose
  const filtered = useMemo(() => {
    return providers.filter((p) => {
      if (statusFilter !== 'all' && providerStatus(p) !== statusFilter) return false
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false
      return matchesQuery(p, query)
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
    { value: 'oauth',        label: 'Sign-in' },
    { value: 'local',        label: 'Local server' },
    { value: 'cloud_creds',  label: providerKindLabel('cloud_creds') },
  ]

  const kindOptions = KIND_OPTIONS.filter((o) => presentKinds.has(o.value))
  const showFilterBar = !providersQ.isLoading && providers.length > 0

  return (
    <SettingsPage
      title="Providers"
      description={
        <>
          Connect the model providers OpenAgentd may use. Keys stay on this computer.
        </>
      }
      actions={
        providers.length > 0 ? (
          <span className="text-xs text-(--color-text-muted) tabular-nums">
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

          {/* ── Filter bar: one status control, one type picker ──────── */}
          {showFilterBar && (
            <div className="flex flex-wrap items-center gap-2">
              {/* Phones wrap the segments: a sideways scroll with no visible
                  bar hid "Not connected" and "Hidden" off-screen. */}
              <SegmentedControl
                label="Filter by status"
                value={statusFilter}
                onChange={setStatusFilter}
                className="max-md:h-auto max-md:flex-wrap max-md:overflow-visible"
                itemClassName="max-md:min-h-7"
                options={([
                  { value: 'all', label: `All ${providers.length}` },
                  { value: 'connected', label: `Connected ${statusCounts.connected}` },
                  { value: 'not-connected', label: `Not connected ${statusCounts['not-connected']}` },
                  { value: 'hidden', label: `Hidden ${statusCounts.hidden}` },
                ] as const).filter((o) => o.value === 'all' || o.value === statusFilter || statusCounts[o.value] > 0)}
              />
              {kindOptions.length > 1 && (
                <Dropdown
                  aria-label="Filter by type"
                  value={kindFilter}
                  onValueChange={(v) => setKindFilter(v as KindFilter)}
                  trigger="Any type"
                  className="h-8 w-auto min-w-32 text-xs"
                >
                  {[
                    <DropdownItem key="all" value="all">Any type</DropdownItem>,
                    ...kindOptions.map((o) => (
                      <DropdownItem key={o.value} value={o.value}>
                        {o.label} <span className="text-(--color-text-subtle) tabular-nums">{kindCounts[o.value] ?? 0}</span>
                      </DropdownItem>
                    )),
                  ]}
                </Dropdown>
              )}
            </div>
          )}

          {/* ── Body ────────────────────────────────────────────────── */}
          {providersQ.isLoading ? (
            <div role="status" aria-label="Loading providers" className="divide-y divide-(--color-border-subtle) rounded-sm border border-(--color-border-subtle)">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex min-h-14 items-center gap-3 px-4">
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-[18px] w-20" />
                </div>
              ))}
            </div>
          ) : providersQ.error ? (
            <Callout
              tone="error"
              role="alert"
              title="Couldn't load providers"
              action={<Button type="button" size="xs" onClick={() => void providersQ.refetch()}>Retry</Button>}
            >
              {providersQ.error instanceof Error
                ? providersQ.error.message
                : String(providersQ.error)}
            </Callout>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-xs text-(--color-text-muted)">
                No providers match the current filters.
              </p>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-xs text-xs font-medium text-(--color-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card)">
                {filtered.map((provider) => (
                  <ProviderCard key={`${provider.id}:${filtered.length === 1}`} provider={provider} defaultExpanded={filtered.length === 1} />
                ))}
              </div>
              <p className="text-xs text-(--color-text-subtle)">
                Open a provider to manage keys, hide it from pickers, or choose which models show.
              </p>
            </>
          )}
        </div>
    </SettingsPage>
  )
}
