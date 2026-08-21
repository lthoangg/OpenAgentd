/**
 * Low-level presentational primitives shared across the telemetry page.
 * Stateless, no data fetching, no router awareness.
 */

import type React from 'react'

export { SectionCard, SectionCardHeader } from '@/components/ui/section-card'

export function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'danger'
}) {
  return (
    <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-3">
      <p className="text-[10px] uppercase tracking-wide text-(--color-text-muted)">
        {label}
      </p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          tone === 'danger' ? 'text-(--color-error)' : 'text-(--color-text)'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

type Cell = React.ReactNode

export function Table({
  headers,
  rows,
  align,
}: {
  headers: string[]
  rows: Cell[][]
  align: ('left' | 'right')[]
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] text-xs sm:min-w-[360px]">
        <thead>
          <tr className="border-b border-(--color-border)/60 bg-(--bg-key)/25">
            {headers.map((h, i) => (
              <th
                key={h}
                className={`px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wider text-(--color-text-muted) ${
                  align[i] === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-(--color-border)/40 last:border-b-0 hover:bg-(--bg-key)/20 transition-colors"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-2 tabular-nums ${
                    align[ci] === 'right' ? 'text-right' : 'text-left'
                  } ${ci === 0 ? 'font-medium text-(--color-text)' : 'text-(--color-text-muted)'} ${
                    ci === 0 ? '' : 'text-[11px]'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EmptyTable({ label }: { label: string }) {
  return (
    <div className="p-6 text-center">
      <p className="text-xs text-(--color-text-muted)">{label}</p>
    </div>
  )
}

export function Th({
  children,
  align,
}: {
  children?: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={`px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wider text-(--color-text-muted) ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align,
  muted,
  mono,
}: {
  children?: React.ReactNode
  align?: 'left' | 'right'
  muted?: boolean
  mono?: boolean
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${muted ? 'text-(--color-text-muted)' : 'text-(--color-text-2)'} ${
        mono ? 'font-mono text-[10.5px]' : ''
      }`}
    >
      {children}
    </td>
  )
}

export function Kv({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-(--color-text-muted)">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-(--color-text) ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
