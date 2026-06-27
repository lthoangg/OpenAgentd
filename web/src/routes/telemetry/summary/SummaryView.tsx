/**
 * Aggregate summary panels (totals, latency, daily turns, by-model, by-tool).
 * Renders the data shape returned by `useObservabilitySummaryQuery`.
 */

import { Info } from 'lucide-react'
import type { ObservabilitySummary } from '@/api/client'
import {
  formatCompact,
  formatInt,
  formatPercent,
  formatUsd,
} from '@/utils/telemetryFormat'
import { EmptyTable, SectionHeader, Stat, Table } from '../primitives'

export function SummaryView({ data }: { data: ObservabilitySummary }) {
  const sampled = data.sample_ratio < 1.0
  const { totals } = data
  const cacheMissTokens = Math.max(totals.input_tokens - totals.cached_tokens, 0)

  return (
    <div className="flex flex-col gap-5">
      {sampled && (
        <div className="flex items-start gap-2 rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
          <Info size={14} className="mt-0.5 shrink-0 text-(--color-accent)" />
          <p className="text-xs text-(--color-text-2)">
            Spans are sampled at <strong>{Math.round(data.sample_ratio * 100)}%</strong>.
            Figures for non-error, non-slow spans are approximate. Set{' '}
            <code className="rounded bg-(--bg-card) px-1 py-0.5 text-[10px]">
              OTEL_SPAN_SAMPLE_RATIO=1.0
            </code>{' '}
            to disable sampling.
          </p>
        </div>
      )}

      <section>
        <SectionHeader>Usage</SectionHeader>
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-5">
          <Stat label="Input" value={formatCompact(totals.input_tokens)} />
          <Stat label="Output" value={formatCompact(totals.output_tokens)} />
          <Stat label="Cache hit" value={formatPercent(totals.cache_percent)} />
          <Stat label="Est. cost" value={formatUsd(totals.estimated_cost_usd)} />
          <Stat
            label="Errors"
            value={formatInt(totals.errors)}
            tone={totals.errors > 0 ? 'danger' : undefined}
          />
        </div>
      </section>

      <section>
        <SectionHeader>Provider:model</SectionHeader>
        {data.by_model.length === 0 ? (
          <EmptyTable label="No LLM calls recorded in this window." />
        ) : (
          <Table
            headers={['Provider:model', 'Calls', 'Input', 'Output', 'Cache hit', 'Cost']}
            rows={data.by_model.map((m) => [
              m.provider_model,
              formatInt(m.calls),
              formatCompact(m.input_tokens),
              formatCompact(m.output_tokens),
              formatPercent(m.cache_percent),
              formatUsd(m.estimated_cost_usd),
            ])}
            align={['left', 'right', 'right', 'right', 'right', 'right']}
          />
        )}
      </section>

      <section>
        <SectionHeader>Cache hit/miss</SectionHeader>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Hit tokens" value={formatCompact(totals.cached_tokens)} />
          <Stat label="Miss tokens" value={formatCompact(cacheMissTokens)} />
          <Stat label="Hit rate" value={formatPercent(totals.cache_percent)} />
        </div>
        {data.cache_by_step.length === 0 ? (
          <EmptyTable label="No cache usage recorded in this window." />
        ) : (
          <Table
            headers={['Step', 'Provider:model', 'Calls', 'Hit', 'Miss', 'Hit rate', 'Cost']}
            rows={data.cache_by_step.map((step) => {
              return [
                step.step,
                step.provider_model,
                formatInt(step.calls),
                formatCompact(step.cached_tokens),
                formatCompact(step.miss_tokens),
                formatPercent(step.cache_percent),
                formatUsd(step.estimated_cost_usd),
              ]
            })}
            align={['left', 'left', 'right', 'right', 'right', 'right', 'right']}
          />
        )}
      </section>
    </div>
  )
}
