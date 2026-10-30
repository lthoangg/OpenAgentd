/**
 * Headline strip: the numbers a user checks first. Spend, turns (and how
 * many failed), turn duration, time to first token, output speed, token
 * volume, and the cache hit rate (the main cost lever).
 *
 * Every tile has the same shape (DESIGN.md → Copy, "technical but
 * legible"): a label, with a dotted underline when it is a term that has a
 * definition; the main number with its percentile key and a muted unit; and
 * one detail line of named pairs (`p95 35.2 s`, `in 1.5M`). Industry terms
 * stay; nothing is a bare number.
 */
import type { ReactNode } from 'react'

import { Term, TERMS } from '@/components/ui/term'
import { cn } from '@/lib/utils'
import { formatCompact, formatMs, formatPercent, formatSpend, formatTps } from '@/utils/telemetryFormat'
import type { Headline } from './model'

/** "10.0 s" → ["10.0", "s"]; "-" (unmeasured) stays whole. */
function splitUnit(text: string): [string, string | null] {
  const i = text.indexOf(' ')
  return i === -1 ? [text, null] : [text.slice(0, i), text.slice(i + 1)]
}

/** A named pair on the detail line: muted key, then the value. */
function Pair({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono text-(--color-text-subtle)">{k}</span>{' '}
      <span className="font-mono text-(--color-text-muted)">{children}</span>
    </span>
  )
}

function Stat({
  label,
  definition,
  value,
  valueKey,
  detail,
  detailTone = 'muted',
  className,
}: {
  label: string
  /** Definition shown on hover; makes the label a dotted-underline term. */
  definition?: ReactNode
  value: string
  /** Percentile key written before the number ("p50"). */
  valueKey?: string
  detail: ReactNode
  detailTone?: 'muted' | 'error'
  className?: string
}) {
  const [number, unit] = splitUnit(value)
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 bg-(--bg-card) px-3 py-2.5', className)}>
      <dt className="text-[11px] text-(--color-text-muted)">
        {definition ? <Term definition={definition}>{label}</Term> : label}
      </dt>
      <dd className="flex min-w-0 items-baseline gap-1 font-mono tabular-nums text-(--color-text)">
        {valueKey && number !== '-' && <span className="text-[11px] text-(--color-text-subtle)">{valueKey}</span>}
        <span className="text-lg font-semibold">{number}</span>
        {unit && <span className="text-xs text-(--color-text-muted)">{unit}</span>}
      </dd>
      <dd
        className={cn(
          'flex flex-wrap gap-x-2 text-[11px] leading-snug',
          detailTone === 'error' ? 'text-(--color-error)' : 'text-(--color-text-subtle)',
        )}
      >
        {detail}
      </dd>
    </div>
  )
}

const PERCENTILES = (
  <>
    <span className="font-mono">p50</span>: half are faster. <span className="font-mono">p95</span>: 95% are faster, so
    this is the slow tail.
  </>
)

export function OverviewStats({ data, onShowFailed }: { data: Headline; onShowFailed?: () => void }) {
  const failedShare = data.turns > 0 ? (data.failedTurns / data.turns) * 100 : 0
  const totalTokens = data.inputTokens + data.outputTokens
  const failedText = `${formatCompact(data.failedTurns)} failed · ${formatPercent(failedShare)}`
  return (
    <dl
      aria-label="Overview"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) bg-(--color-border) md:grid-cols-4 xl:grid-cols-7"
    >
      <Stat
        label="Spend (est.)"
        definition={TERMS.spendEstimate}
        value={formatSpend(data.spend)}
        detail={data.turns > 0 ? <Pair k="per turn">{formatSpend(data.spendPerTurn)}</Pair> : 'No turns in this range'}
        // Seven cells: the lead stat spans a row on phones so the two-column
        // grid fills evenly (the last one spans two on the four-column grid).
        className="col-span-2 md:col-span-1"
      />
      <Stat
        label="Turns"
        value={formatCompact(data.turns)}
        detail={
          data.failedTurns === 0 ? (
            'None failed'
          ) : onShowFailed ? (
            <button
              type="button"
              onClick={onShowFailed}
              title="Show only failed turns"
              className="touch-hit relative rounded-xs underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
            >
              {failedText}
            </button>
          ) : (
            failedText
          )
        }
        detailTone={data.failedTurns > 0 ? 'error' : 'muted'}
      />
      <Stat
        label="Turn duration"
        definition={<><b className="font-medium">Turn duration.</b> {TERMS.turnDuration} {PERCENTILES}</>}
        valueKey="p50"
        value={formatMs(data.turnP50)}
        detail={<Pair k="p95">{formatMs(data.turnP95)}</Pair>}
      />
      <Stat
        label="First token (TTFT)"
        definition={<><b className="font-medium">First token (TTFT).</b> {TERMS.ttft} {PERCENTILES}</>}
        valueKey="p50"
        value={formatMs(data.ttftP50)}
        detail={data.ttftP50 > 0 ? <Pair k="p95">{formatMs(data.ttftP95)}</Pair> : 'Not measured in this range'}
      />
      <Stat
        label="Output speed"
        definition={<><b className="font-medium">Output speed.</b> {TERMS.tokPerSec} <span className="font-mono">p5</span>: the slowest 5% of calls.</>}
        valueKey="p50"
        value={formatTps(data.tpsP50)}
        detail={data.tpsP50 > 0 ? <Pair k="p5">{formatTps(data.tpsP5)}</Pair> : 'Not measured in this range'}
      />
      <Stat
        label="Tokens"
        value={formatCompact(totalTokens)}
        detail={
          <>
            <Pair k="in">{formatCompact(data.inputTokens)}</Pair>
            <Pair k="out">{formatCompact(data.outputTokens)}</Pair>
          </>
        }
      />
      <Stat
        label="Cache hit"
        definition={TERMS.cacheHit}
        value={formatPercent(data.cachePercent)}
        detail={<span className="font-mono text-(--color-text-muted)">{formatCompact(data.cachedTokens)} / {formatCompact(data.inputTokens)} in</span>}
        // The four-column grid has one slot left in its second row: fill it.
        className="md:col-span-2 xl:col-span-1"
      />
    </dl>
  )
}
