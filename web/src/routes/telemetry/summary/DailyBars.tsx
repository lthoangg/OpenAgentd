/**
 * Bar chart of turns-per-day with stacked error overlay.  Pure CSS — no
 * Chart.js dependency — since each bar is a single ratio of two numbers.
 */

import { EmptyTable } from '../primitives'

export function DailyBars({
  rows,
}: {
  rows: Array<{ day: string; turns: number; errors: number }>
}) {
  if (rows.length === 0) {
    return <EmptyTable label="No turns recorded in this window." />
  }
  const max = Math.max(...rows.map((r) => r.turns), 1)
  return (
    <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-4">
      <div className="flex h-28 items-end gap-2">
        {rows.map((r) => {
          const pct = (r.turns / max) * 100
          return (
            <div key={r.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="flex w-full flex-col-reverse rounded-t-sm bg-(--color-accent) transition-all"
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`${r.day}: ${r.turns} turns${r.errors > 0 ? `, ${r.errors} errors` : ''}`}
              >
                {r.errors > 0 && (
                  <div
                    className="w-full rounded-t-sm bg-(--color-error)"
                    style={{
                      height: `${(r.errors / Math.max(r.turns, 1)) * 100}%`,
                    }}
                  />
                )}
              </div>
              <span className="w-full truncate text-[9px] text-(--color-text-muted)">
                {r.day.slice(5)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
