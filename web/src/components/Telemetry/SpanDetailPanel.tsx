/**
 * Side panel showing the attribute bag and computed metadata for one span.
 * Null attributes are dropped so the panel lists only keys the span set.
 */

import { Button } from '@/components/ui/button'
import { useMemo, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { SpanDetail } from '@/api/client'
import { formatInt, formatMs, formatShortId, formatTps, formatUsd } from '@/utils/telemetryFormat'
import { formatFullDateTime } from '@/utils/format'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const SECTION_LABEL_CLASS = 'mb-2 mt-5 label-caps text-(--color-text-muted)'

function Kv({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-(--color-text-muted)">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-(--color-text) ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

export function SpanDetailPanel({
  span,
  onClose,
  fullWidth = false,
}: {
  span: SpanDetail
  onClose: () => void
  /** When true, renders as a full-width block (mobile overlay) instead of a fixed w-96 sidebar. */
  fullWidth?: boolean
}) {
  const attrs = useMemo(() => flattenAttributes(span.attributes), [span.attributes])
  const tokens = useMemo(() => extractTokens(span.attributes), [span.attributes])
  const estimatedCost = useMemo(
    () => extractEstimatedCost(span.attributes),
    [span.attributes],
  )
  const speed = useMemo(() => extractSpeed(span.attributes), [span.attributes])

  return (
    <aside className={`flex shrink-0 flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) ${fullWidth ? 'w-full' : 'w-96'}`}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-sidebar) px-3">
        <Tooltip className="min-w-0">
          <TooltipTrigger
            render={
              <h3 className="truncate text-sm font-semibold text-(--color-text)">
                {span.name}
              </h3>
            }
          />
          <TooltipContent>{span.name}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-dense" onClick={onClose} aria-label="Close span detail">
          <X size={14} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <dl className="flex flex-col gap-3 text-xs">
          <Kv label="Kind" value={span.kind || '-'} />
          <Kv
            label="Status"
            value={
              span.status === 'ERROR' ? (
                <span className="text-(--color-error)">{span.status}</span>
              ) : (
                span.status || 'OK'
              )
            }
          />
          <Kv label="Duration" value={formatMs(span.duration_ms)} />
          {speed.firstChunkMs !== null && <Kv label="First token" value={formatMs(speed.firstChunkMs)} />}
          {speed.tokensPerSecond !== null && <Kv label="Output speed" value={formatTps(speed.tokensPerSecond)} />}
          <Kv label="Started" value={formatFullDateTime(new Date(span.start_ms))} />
          <Kv label="Span ID" value={formatShortId(span.span_id)} mono />
          <Kv
            label="Parent"
            value={span.parent_span_id ? formatShortId(span.parent_span_id) : 'root'}
            mono
          />
        </dl>

        {tokens.length > 0 && (
          <>
            <h4 className={SECTION_LABEL_CLASS}>Token usage</h4>
            <div className="grid grid-cols-2 gap-2">
              {tokens.map((t) => (
                <div
                  key={t.label}
                  className="rounded-sm border border-(--color-border) bg-(--bg-card) p-2"
                >
                  <p className="text-[11px] text-(--color-text-muted)">{t.label}</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-(--color-text)">
                    {formatInt(t.value)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {estimatedCost !== null && (
          <>
            <h4 className={SECTION_LABEL_CLASS}>Estimated cost</h4>
            <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
              <p className="text-lg font-semibold tabular-nums text-(--color-text)">
                {formatUsd(estimatedCost)}
              </p>
              <p className="mt-1 text-[11px] text-(--color-text-muted)">
                Based on registry pricing and provider usage tokens.
              </p>
            </div>
          </>
        )}

        <h4 className={SECTION_LABEL_CLASS}>Attributes</h4>
        {attrs.length === 0 ? (
          <p className="text-xs text-(--color-text-muted)">No attributes.</p>
        ) : (
          <dl className="flex flex-col divide-y divide-(--color-border) rounded-sm border border-(--color-border) bg-(--bg-card) text-[11px]">
            {attrs.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5 px-3 py-2">
                <dt className="font-medium text-(--color-text-muted)">{key}</dt>
                <dd className="break-words font-mono text-(--color-text-2)">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </aside>
  )
}

function extractEstimatedCost(attrs: Record<string, unknown>): number | null {
  const raw = attrs['gen_ai.usage.estimated_cost_usd']
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Streaming speed the backend records on `chat` spans; `null` when absent. */
function extractSpeed(attrs: Record<string, unknown>): { firstChunkMs: number | null; tokensPerSecond: number | null } {
  const positive = (raw: unknown) => {
    const n = typeof raw === 'number' ? raw : Number(raw)
    return raw !== undefined && raw !== null && Number.isFinite(n) && n > 0 ? n : null
  }
  const firstChunkS = positive(attrs['gen_ai.response.time_to_first_chunk'])
  return {
    firstChunkMs: firstChunkS === null ? null : firstChunkS * 1000,
    tokensPerSecond: positive(attrs['openagentd.response.output_tokens_per_second']),
  }
}

/**
 * Pull the subset of `gen_ai.usage.*` attributes into a compact display list.
 * Returns an empty array when the span has no token data — the UI uses that
 * to hide the entire section (keeps non-LLM spans uncluttered).
 */
function extractTokens(
  attrs: Record<string, unknown>,
): Array<{ label: string; value: number }> {
  const pairs: Array<[string, string]> = [
    ['gen_ai.usage.input_tokens', 'Input'],
    ['gen_ai.usage.output_tokens', 'Output'],
    ['gen_ai.usage.cache_read.input_tokens', 'Cached'],
    ['gen_ai.usage.cache_creation.input_tokens', 'Cache write'],
    ['gen_ai.usage.reasoning_tokens', 'Reasoning'],
    ['gen_ai.usage.tool_use_tokens', 'Tool use'],
  ]
  const out: Array<{ label: string; value: number }> = []
  for (const [key, label] of pairs) {
    const raw = attrs[key]
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) out.push({ label, value: n })
  }
  return out
}

/**
 * Flatten a possibly-nested attribute bag into `[key, stringified]` pairs so
 * the UI can render a flat key/value list. Nested objects collapse to JSON;
 * null and undefined values are skipped.
 */
function flattenAttributes(obj: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === null || raw === undefined) continue
    rows.push([key, stringifyAttr(raw)])
  }
  rows.sort(([a], [b]) => a.localeCompare(b))
  return rows
}

function stringifyAttr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
