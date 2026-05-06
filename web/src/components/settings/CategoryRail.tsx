/**
 * CategoryRail — narrow icon-only rail (left column) for the settings
 * three-column layout. Tooltips reveal the category label on hover.
 *
 *   ┌──┐
 *   │←│  Exit settings (→ /)
 *   │──│  ── separator ──
 *   │🔧│  Agents
 *   │✨│  Skills
 *   │🔌│  MCP servers
 *   │🛡│  Sandbox
 *   └──┘
 *
 * The settings hub itself is reachable by clicking any category and then
 * navigating, or by visiting /settings directly — it doesn't need a rail
 * pill of its own.
 */
import { Link, useLocation } from '@tanstack/react-router'
import {
  ArrowLeft,
  Mic,
  Moon,
  Plug,
  Shield,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type CategoryPath =
  | '/settings/agents'
  | '/settings/skills'
  | '/settings/mcp'
  | '/settings/sandbox'
  | '/settings/dream'
  | '/settings/voice'

interface RailItem {
  to: CategoryPath
  label: string
  icon: LucideIcon
  /** Match any pathname that starts with this prefix (so editor routes
   *  inside /settings/agents stay highlighted). */
  matchPrefix: string
}

const ITEMS: readonly RailItem[] = [
  { to: '/settings/agents', label: 'Agents', icon: Wrench, matchPrefix: '/settings/agents' },
  { to: '/settings/skills', label: 'Skills', icon: Sparkles, matchPrefix: '/settings/skills' },
  { to: '/settings/mcp', label: 'MCP servers', icon: Plug, matchPrefix: '/settings/mcp' },
  { to: '/settings/sandbox', label: 'Sandbox', icon: Shield, matchPrefix: '/settings/sandbox' },
  { to: '/settings/dream', label: 'Dream', icon: Moon, matchPrefix: '/settings/dream' },
  { to: '/settings/voice', label: 'Voice', icon: Mic, matchPrefix: '/settings/voice' },
]

export function CategoryRail() {
  const { pathname } = useLocation()

  // Find the active category once per pathname (avoids walking ITEMS for
  // every render of every pill).
  const activePath = useMemo<string | null>(() => {
    const match = ITEMS.find(
      (item) =>
        pathname === item.matchPrefix ||
        pathname.startsWith(`${item.matchPrefix}/`),
    )
    return match?.matchPrefix ?? null
  }, [pathname])

  return (
    <nav
      aria-label="Settings categories"
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-3"
    >
      {/* Exit settings → app home */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/"
              aria-label="Exit settings"
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
              )}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Link>
          }
        />
        <TooltipContent side="right">Exit settings</TooltipContent>
      </Tooltip>

      <div
        className="my-1.5 h-px w-6 shrink-0 bg-border"
        role="separator"
        aria-hidden="true"
      />

      {ITEMS.map((item) => {
        const active = activePath === item.matchPrefix
        const Icon = item.icon
        return (
          <Tooltip key={item.to}>
            <TooltipTrigger
              render={
                <Link
                  to={item.to}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                    'text-muted-foreground hover:bg-muted hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
                    active &&
                      'bg-foreground/10 text-foreground ring-1 ring-border hover:bg-foreground/10',
                  )}
                >
                  <Icon size={16} aria-hidden="true" />
                </Link>
              }
            />
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
