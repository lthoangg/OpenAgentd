/**
 * ConnectorIcon — a connector's logo on the keycap square, or its monogram.
 *
 * Gallery connectors carry their service's logo as one SVG path (signed with
 * the gallery list). It is drawn inline in the text colour, so it follows
 * light and dark mode and never loads anything from the service. Connectors
 * without one (added by hand, a project's, a plugin's) show two letters.
 */
import type { ConnectorIconData } from '@/api/client'
import { cn } from '@/lib/utils'

export function monogram(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}

interface ConnectorIconProps {
  /** The connector's name, for the monogram. */
  name: string
  icon?: ConnectorIconData | null
  /** `sm` for compact rows (the "+" menu). */
  size?: 'md' | 'sm'
  className?: string
}

export function ConnectorIcon({ name, icon, size = 'md', className }: ConnectorIconProps) {
  return (
    <span
      aria-hidden="true"
      data-connector-icon={icon ? 'logo' : 'monogram'}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm bg-(--bg-key) font-semibold text-(--color-text-muted)',
        size === 'sm' ? 'size-6 text-[0.5625rem]' : 'size-8 text-[0.625rem]',
        className,
      )}
    >
      {icon ? (
        <svg viewBox={icon.view_box} className={cn('fill-(--color-text)', size === 'sm' ? 'size-3.5' : 'size-4')} focusable="false">
          <path d={icon.path} />
        </svg>
      ) : (
        monogram(name)
      )}
    </span>
  )
}
