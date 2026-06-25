/**
 * SettingsSidebar — wide labeled sidebar (240px) for the settings shell.
 *
 *   ┌──────────────────────────┐
 *   │ CONFIGURATION             │
 *   │ ▌ 🔧 Agents          6    │  ← active row has accent left border
 *   │   ✨ Skills          12   │
 *   │   🔌 MCP servers     4    │
 *   │   🛡 Sandbox              │
 *   │   🎙 Voice                │
 *   │ ────────────────────────  │
 *   │ ABOUT                     │
 *   │   📊 Telemetry            │
 *   │   ℹ About openagentd      │
 *   └──────────────────────────┘
 *
 * Counts come from the same TanStack queries the hub page uses; rows
 * without a queryable count omit the trailing badge.
 */
import { Link, useLocation } from '@tanstack/react-router'
import {
  BarChart3,
  Bell,
  Info,
  Image,
  KeyRound,
  Plug,
  Shield,
  Sparkles,
  Type,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import {
  useAgentFilesQuery,
  useMcpServersQuery,
  useSandboxSettingsQuery,
  useSkillFilesQuery,
} from '@/queries'

type SidebarPath =
  | '/settings/agents'
  | '/settings/skills'
  | '/settings/mcp'
  | '/settings/providers'
  | '/settings/multimodal'
  | '/settings/sandbox'
  | '/settings/title-generation'
  | '/settings/notifications'
  | '/telemetry'
  | '/settings'

interface SidebarItem {
  to: SidebarPath
  label: string
  icon: LucideIcon
  /** Match any pathname that starts with this prefix so editor routes
   *  (e.g. /settings/agents/lead) keep the parent row active. */
  matchPrefix: string
  /** Optional badge with a live count. */
  count?: number | null
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pt-4 pb-1.5 font-mono text-[10px] font-semibold tracking-wider text-(--color-text-muted) uppercase">
      {children}
    </p>
  )
}

function SidebarRow({ item, active }: { item: SidebarItem; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative mx-2 flex h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors',
        'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-(--focus-ring)/40',
        active && 'bg-(--bg-key) font-semibold text-(--color-text)',
      )}
    >
      <Icon
        size={15}
        className={cn(
          'shrink-0',
          active ? 'text-(--color-text)' : 'text-(--color-text-muted)',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count !== null && (
        <span
          className={cn(
            'shrink-0 font-mono text-[10px] tabular-nums',
            active ? 'font-semibold text-(--color-text-muted)' : 'text-(--color-text-muted)',
          )}
        >
          {item.count}
        </span>
      )}
    </Link>
  )
}

export function SettingsSidebar() {
  const { pathname } = useLocation()
  const agentsQ = useAgentFilesQuery()
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const sandboxQ = useSandboxSettingsQuery()

  const configurationItems = useMemo<SidebarItem[]>(
    () => [
      {
        to: '/settings/agents',
        label: 'Agents',
        icon: Wrench,
        matchPrefix: '/settings/agents',
        count: agentsQ.data?.agents.length ?? null,
      },
      {
        to: '/settings/skills',
        label: 'Skills',
        icon: Sparkles,
        matchPrefix: '/settings/skills',
        count: skillsQ.data?.skills.length ?? null,
      },
      {
        to: '/settings/mcp',
        label: 'MCP servers',
        icon: Plug,
        matchPrefix: '/settings/mcp',
        count: mcpQ.data?.servers.length ?? null,
      },
      {
        to: '/settings/providers',
        label: 'Providers',
        icon: KeyRound,
        matchPrefix: '/settings/providers',
      },
      {
        to: '/settings/sandbox',
        label: 'Sandbox',
        icon: Shield,
        matchPrefix: '/settings/sandbox',
        count: sandboxQ.data?.denied_patterns.length ?? null,
      },
      {
        to: '/settings/multimodal',
        label: 'Multimodal',
        icon: Image,
        matchPrefix: '/settings/multimodal',
      },
      {
        to: '/settings/title-generation',
        label: 'Title generation',
        icon: Type,
        matchPrefix: '/settings/title-generation',
      },
      {
        to: '/settings/notifications',
        label: 'Notifications',
        icon: Bell,
        matchPrefix: '/settings/notifications',
      },
    ],
    [
      agentsQ.data?.agents.length,
      skillsQ.data?.skills.length,
      mcpQ.data?.servers.length,
      sandboxQ.data?.denied_patterns.length,
    ],
  )

  const aboutItems = useMemo<SidebarItem[]>(
    () => [
      {
        to: '/telemetry',
        label: 'Telemetry',
        icon: BarChart3,
        matchPrefix: '/telemetry',
      },
      {
        to: '/settings',
        label: 'About openagentd',
        icon: Info,
        matchPrefix: '/settings',
      },
    ],
    [],
  )

  const isActive = (matchPrefix: string): boolean => {
    if (matchPrefix === '/settings') {
      // Only highlight About on exact /settings, not on any /settings/*.
      return pathname === '/settings'
    }
    return (
      pathname === matchPrefix || pathname.startsWith(`${matchPrefix}/`)
    )
  }

  return (
    <nav
      aria-label="Settings categories"
      className="flex h-full w-[min(18rem,calc(100vw-2rem))] shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) md:w-60"
    >
      <GroupLabel>Configuration</GroupLabel>
      <div className="flex flex-col">
        {configurationItems.map((item) => (
          <SidebarRow key={item.to} item={item} active={isActive(item.matchPrefix)} />
        ))}
      </div>

      <div className="mx-3 my-3 h-px bg-(--color-border)" role="separator" aria-hidden="true" />

      <GroupLabel>About</GroupLabel>
      <div className="flex flex-col">
        {aboutItems.map((item) => (
          <SidebarRow key={item.to} item={item} active={isActive(item.matchPrefix)} />
        ))}
      </div>
    </nav>
  )
}
