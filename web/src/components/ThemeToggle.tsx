/**
 * ThemeToggle — three-way preference control (System / Light / Dark).
 *
 * Expanded: segmented control of three icon-only buttons. Labels live on
 * `aria-label` and `title` only — same density rule as `ViewToggle`.
 * Collapsed: single icon button showing the current preference; click cycles
 * `system -> light -> dark -> system`.
 */
import { cn } from '@/lib/utils'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useThemePreference } from '@/hooks/useThemePreference'
import type { ThemePreference } from '@/lib/theme'

const OPTIONS: ReadonlyArray<{
  value: ThemePreference
  label: string
  Icon: typeof Monitor
}> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export function ThemeToggle({
  collapsed = false,
  compact = false,
  className,
}: {
  collapsed?: boolean
  compact?: boolean
  className?: string
}) {
  const { preference, setPreference } = useThemePreference()

  if (collapsed) {
    const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0]
    const Icon = current.Icon
    return (
      <button
        type="button"
        onClick={() => setPreference(NEXT[preference])}
        title={`Theme: ${current.label} (click to cycle)`}
        aria-label={`Theme: ${current.label}. Click to cycle.`}
        className={cn(
          'interactive-weight flex text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
          compact
            ? 'h-5 w-5 items-center justify-center rounded-xs'
            : 'h-8 w-8 items-center justify-center rounded-md',
          className,
        )}
      >
        <Icon size={compact ? 12 : 14} />
      </button>
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme preference"
      className="inline-flex items-center overflow-hidden rounded-md border border-(--color-border-subtle) p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = preference === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setPreference(value)}
            className={`interactive-weight inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${
              active
                ? 'bg-(--color-surface-2) text-(--color-text)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
