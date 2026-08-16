/**
 * SectionCard — the "Connection options" card pattern from AppBackendDialog.
 *
 * Structure:
 *   <SectionCard>
 *     <SectionCardHeader>Label</SectionCardHeader>
 *     <SectionCardRows>
 *       <SectionCardRow>…</SectionCardRow>
 *     </SectionCardRows>
 *   </SectionCard>
 *
 * Design language:
 *   warm paper surface · crisp 1px border · uppercase tracking header ·
 *   divide-y rows that lift to --bg-page on hover
 */
import { type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

// ─── Root card ───────────────────────────────────────────────────────────────

function SectionCard({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)',
        className,
      )}
      {...props}
    />
  )
}

// ─── Header strip ─────────────────────────────────────────────────────────────

function SectionCardHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn(
        'border-b border-(--color-border)/60 bg-(--bg-key)/30',
        'px-3 py-1.5',
        'text-[11px] font-semibold uppercase tracking-wider text-(--color-text-muted)',
        'select-none',
        className,
      )}
      {...props}
    />
  )
}

// ─── Row list wrapper ─────────────────────────────────────────────────────────

function SectionCardRows({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn('divide-y divide-(--color-border)', className)}
      {...props}
    />
  )
}

// ─── Individual row ───────────────────────────────────────────────────────────

function SectionCardRow({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-3 py-2',
        'text-xs transition-colors hover:bg-(--bg-page)',
        className,
      )}
      {...props}
    />
  )
}

// ─── Inline badge ("active", "saved server", …) ──────────────────────────────

function SectionCardBadge({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      className={cn(
        'shrink-0 select-none rounded-xs border border-(--color-border)',
        'bg-(--bg-key) px-1.5 py-0.5',
        'text-[11px] font-semibold text-(--color-text-muted)',
        className,
      )}
      {...props}
    />
  )
}

export { SectionCard, SectionCardHeader, SectionCardRows, SectionCardRow, SectionCardBadge }
