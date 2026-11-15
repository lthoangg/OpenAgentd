import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProviderInfo } from '@/api/client'
import { useProvidersQuery } from '@/queries'
import { eagerlyWarmProviderModels } from './settings.models/eagerModels'
import { SearchBar } from '@/components/ui/search-bar'
import { Callout } from '@/components/ui/callout'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useIsPhone } from '@/hooks/use-is-phone'
import { ProviderCard } from './settings.models/ProviderCard'

// ─── Filter types ───────────────────────────────────────────────────────────

type ProviderStatus = 'connected' | 'hidden' | 'not-connected'
type StatusFilter = 'all' | ProviderStatus

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

export function ModelsSettingsPage() {
  const providersQ = useProvidersQuery()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const isPhone = useIsPhone()

  const providers = useMemo(() => providersQ.data?.providers ?? [], [providersQ.data?.providers])
  const connectedCount = providers.filter((p) => providerStatus(p) === 'connected').length

  // Eagerly warm every uncached configured provider in parallel. The registry
  // only needs one refresh after every request has settled.
  useEffect(() => {
    if (!providersQ.data) return
    void eagerlyWarmProviderModels(providersQ.data.providers, queryClient)
  }, [providersQ.data, queryClient])

  // Counts follow the search box, not the status filter, so a segment keeps
  // its number while it is the one chosen.
  const statusCounts = useMemo(() => {
    const counts: Record<ProviderStatus, number> = { connected: 0, hidden: 0, 'not-connected': 0 }
    for (const p of providers) if (matchesQuery(p, query)) counts[providerStatus(p)] += 1
    return counts
  }, [providers, query])

  const filtered = useMemo(() => {
    return providers.filter((p) => {
      if (statusFilter !== 'all' && providerStatus(p) !== statusFilter) return false
      return matchesQuery(p, query)
    })
  }, [providers, statusFilter, query])

  const hasFilters = query.trim() !== '' || statusFilter !== 'all'

  const clearFilters = () => {
    setQuery('')
    setStatusFilter('all')
  }

  const showFilterBar = !providersQ.isLoading && providers.length > 0

  return (
    <SettingsPage
      title="Models"
      description="Connect the accounts your models come from. Keys stay on this computer."
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
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              count={providers.length}
            />
          )}

          {/* One filter on every width: All, or what is connected. Hidden ones
              are a link under the list, and a third segment only while chosen. */}
          {showFilterBar && (
            <div data-provider-filter="" className={isPhone ? 'sticky top-0 z-10 -mx-1 bg-(--bg-page) px-1 py-1' : 'flex'}>
              <SegmentedControl
                label="Filter by status"
                value={statusFilter}
                onChange={setStatusFilter}
                fill={isPhone}
                options={[
                  { value: 'all' as const, label: 'All' },
                  { value: 'connected' as const, label: `Connected · ${statusCounts.connected}` },
                  ...(statusFilter === 'hidden' ? [{ value: 'hidden' as const, label: `Hidden · ${statusCounts.hidden}` }] : []),
                ]}
              />
            </div>
          )}

          {/* ── Body ────────────────────────────────────────────────── */}
          {providersQ.isLoading ? (
            <div role="status" aria-label="Loading models" className="divide-y divide-(--color-border-subtle) rounded-sm border border-(--color-border-subtle)">
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
              title="Couldn't load your models"
              action={<Button type="button" size="xs" onClick={() => void providersQ.refetch()}>Retry</Button>}
            >
              {providersQ.error instanceof Error
                ? providersQ.error.message
                : String(providersQ.error)}
            </Callout>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-xs text-(--color-text-muted)">
                Nothing matches.
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
                Open one to manage its keys, hide it from pickers, or choose which models show.
                {statusCounts.hidden > 0 && statusFilter !== 'hidden' && (
                  <>
                    {' '}
                    <button type="button" onClick={() => setStatusFilter('hidden')} className="font-medium text-(--color-text) underline-offset-2 hover:underline">
                      {`${statusCounts.hidden} hidden`}
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </div>
    </SettingsPage>
  )
}
