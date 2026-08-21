/**
 * AppHeader — shared 36 px application header.
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │ [traffic-lights]  [🏠] [☰]  Title       ● local  │
 *   └────────────────────────────────────────────────────┘
 *
 * On macOS Tauri the OS overlays the traffic-light buttons over our
 * WebView; we reserve a 70 px left inset for them and use
 * `useTauriDrag` to make the header act as the window-drag region.
 */
import { Link } from '@tanstack/react-router'
import { Home, PanelLeft } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { useTauriDrag } from '@/hooks/use-tauri-drag'

export interface AppHeaderProps {
  title?: string
  /** Content between the title and the right cluster. */
  center?: ReactNode
  /** Right cluster (defaults to a small "● local" status pill). */
  right?: ReactNode
  /** When omitted, the hamburger button is hidden. */
  onToggleSidebar?: () => void
   /** Tooltip hint, e.g. `'Ctrl+B'` / `'⌘B'`. */
  toggleShortcut?: string
  homeTo?: string
  className?: string
}

// Keep the controls inside the compact header while retaining a slightly
// larger touch target on phones. All header icon buttons share this geometry.
const ICON_BUTTON =
  'flex h-11 w-11 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:h-7 md:w-7'

function DefaultStatus() {
  return (
    <div className="flex items-center gap-1.5 pr-3 text-(--color-text-muted)">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-(--color-success)" />
      <span className="font-mono text-[11px]">local</span>
    </div>
  )
}

export function AppHeader({
  title,
  center,
  right,
  onToggleSidebar,
  toggleShortcut,
  homeTo = '/',
  className,
}: AppHeaderProps) {
  const { isMacOverlay } = usePlatform()
  const dragHandlers = useTauriDrag()

  // Mirror the platform on <html> so CSS / non-AppHeader code can react.
  useEffect(() => {
    if (!isMacOverlay) return
    document.documentElement.setAttribute('data-platform', 'mac-overlay')
    return () => document.documentElement.removeAttribute('data-platform')
  }, [isMacOverlay])

  return (
    <header
      {...dragHandlers}
      className={cn(
        'mobile-safe-header relative z-30 flex h-(--spacing-app-header) shrink-0 items-center border-b border-(--color-border) bg-(--bg-page)',
        isMacOverlay && 'pl-(--spacing-mac-traffic-inset) select-none',
        className,
      )}
    >
      <div className="flex min-w-0 shrink items-center gap-1 pl-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Link to={homeTo} aria-label="Home" className={ICON_BUTTON}>
                <Home size={14} strokeWidth={1.8} aria-hidden="true" />
              </Link>
            }
          />
          <TooltipContent>Home</TooltipContent>
        </Tooltip>

        {onToggleSidebar && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onToggleSidebar}
                  aria-label="Toggle sidebar"
                  className={ICON_BUTTON}
                >
                  <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{toggleShortcut ? `Toggle sidebar (${toggleShortcut})` : 'Toggle sidebar'}</TooltipContent>
          </Tooltip>
        )}

        {title && (
          <span className="ml-1 min-w-0 truncate text-sm font-semibold text-(--color-text) md:ml-2">
            {title}
          </span>
        )}
      </div>

      <div className="hidden min-w-0 flex-1 items-center sm:flex">
        {center && <div className="min-w-0 flex-1">{center}</div>}
      </div>

      <div className="ml-auto flex shrink-0 items-center">{right ?? <DefaultStatus />}</div>
    </header>
  )
}
