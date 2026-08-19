import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function MobileHeaderAction({
  Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  badge = 0,
}: {
  Icon: LucideIcon
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  badge?: number
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled || !onClick}
            className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 disabled:opacity-45 ${
              active
                ? 'bg-(--bg-key) text-(--color-text)'
                : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)'
            }`}
            aria-label={label}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            {badge > 0 && (
              <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-(--color-accent) px-1 text-center font-mono text-[9px] leading-3.5 text-(--bg-page)">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
