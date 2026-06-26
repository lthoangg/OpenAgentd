/**
 * SettingsModal — VS Code–style clean settings overlay.
 *
 * All navigation is internal: sidebar buttons + editor back/onCreated
 * callbacks update `useSettingsStore` without touching the URL.
 * No /settings/* routes are needed.
 */
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bell,
  Image,
  Info,
  KeyRound,
  Plug,
  Shield,
  Sparkles,
  Type,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import {
  useAgentFilesQuery,
  useMcpServersQuery,
  useSandboxSettingsQuery,
  useSkillFilesQuery,
} from '@/queries'

import { SettingsHubPage } from '@/routes/settings.index'
import { AgentsListPage } from '@/routes/settings.agents'
import { NewAgentPage } from '@/routes/settings.agents.new'
import { AgentEditorPage } from '@/routes/settings.agents.$name'
import { SkillsListPage } from '@/routes/settings.skills'
import { NewSkillPage } from '@/routes/settings.skills.new'
import { SkillEditorPage } from '@/routes/settings.skills.$name'
import { McpListPage } from '@/routes/settings.mcp'
import { NewMcpServerPage } from '@/routes/settings.mcp.new'
import { McpServerDetailPage } from '@/routes/settings.mcp.$name'
import { ProvidersSettingsPage } from '@/routes/settings.providers'
import { SandboxSettingsPage } from '@/routes/settings.sandbox'
import { MultimodalSettingsPage } from '@/routes/settings.multimodal'
import { TitleGenerationSettingsPage } from '@/routes/settings.title-generation'
import { NotificationSettingsPage } from '@/routes/settings.notifications'

// ── Sidebar ───────────────────────────────────────────────────────────────

/** Sections that map directly to a top-level sidebar entry. */
type TopLevelSection = Extract<
  SettingsSection,
  'agents' | 'skills' | 'mcp' | 'providers' | 'sandbox' | 'multimodal' | 'title-generation' | 'notifications' | 'about'
>

interface SidebarItem {
  section: TopLevelSection
  label: string
  icon: LucideIcon
  count?: number | null
}

/** Which top-level section a given section belongs to (for sidebar highlight). */
function parentSection(section: SettingsSection): TopLevelSection {
  if (section.startsWith('agents')) return 'agents'
  if (section.startsWith('skills')) return 'skills'
  if (section.startsWith('mcp')) return 'mcp'
  return section as TopLevelSection
}

function SidebarRow({
  item,
  active,
  onClick,
}: {
  item: SidebarItem
  active: boolean
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-8.5 w-full items-center gap-2.5 px-4 text-xs transition-colors text-left focus:outline-none',
        'text-(--color-text-2) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
        active && 'bg-(--bg-key)/70 font-semibold text-(--color-text)',
      )}
    >
      {/* VS Code active left vertical line indicator */}
      {active && (
        <span
          className="absolute top-[4px] bottom-[4px] left-0 w-[3px] rounded-r bg-(--color-accent)"
          aria-hidden="true"
        />
      )}
      <Icon size={13} className={cn('shrink-0', active ? 'text-(--color-text)' : 'text-(--color-text-muted)')} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count !== null && (
        <span className={cn(
          'shrink-0 font-mono text-[9px] tabular-nums px-1.5 py-0.5 rounded border transition-colors',
          active
            ? 'font-semibold text-(--color-text) bg-(--bg-page) border-(--color-border-strong)'
            : 'text-(--color-text-muted) bg-(--bg-key)/50 border-(--color-border)',
        )}>
          {item.count}
        </span>
      )}
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-4 pt-3 pb-1 font-mono text-[9px] font-bold tracking-wider text-(--color-text-subtle)/85 uppercase select-none">
      {children}
    </p>
  )
}

function ModalSidebar({ section, onSelect }: { section: SettingsSection; onSelect: (s: TopLevelSection) => void }) {
  const agentsQ = useAgentFilesQuery()
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const sandboxQ = useSandboxSettingsQuery()
  const active = parentSection(section)

  const configItems: SidebarItem[] = [
    { section: 'agents',           label: 'Agents',          icon: Wrench,   count: agentsQ.data?.agents.length ?? null },
    { section: 'skills',           label: 'Skills',           icon: Sparkles, count: skillsQ.data?.skills.length ?? null },
    { section: 'mcp',              label: 'MCP servers',      icon: Plug,     count: mcpQ.data?.servers.length ?? null },
    { section: 'providers',        label: 'Providers',        icon: KeyRound },
    { section: 'sandbox',          label: 'Sandbox',          icon: Shield,   count: sandboxQ.data?.denied_patterns.length ?? null },
    { section: 'multimodal',       label: 'Multimodal',       icon: Image },
    { section: 'title-generation', label: 'Title generation', icon: Type },
    { section: 'notifications',    label: 'Notifications',    icon: Bell },
  ]

  const aboutItems: SidebarItem[] = [
    { section: 'about', label: 'About openagentd', icon: Info },
  ]

  return (
    <nav aria-label="Settings categories" className="flex h-full w-52 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) select-none">
      <GroupLabel>Configuration</GroupLabel>
      <div className="flex flex-col">
        {configItems.map((item) => (
          <SidebarRow key={item.section} item={item} active={active === item.section} onClick={() => onSelect(item.section)} />
        ))}
      </div>
      <div className="mx-4 my-2.5 h-px bg-(--color-border)" role="separator" aria-hidden="true" />
      <GroupLabel>About</GroupLabel>
      <div className="flex flex-col">
        {aboutItems.map((item) => (
          <SidebarRow key={item.section} item={item} active={active === item.section} onClick={() => onSelect(item.section)} />
        ))}
      </div>
    </nav>
  )
}

// ── Section content ───────────────────────────────────────────────────────

function SectionContent({ section, selectedName, setSection }: {
  section: SettingsSection
  selectedName: string | null
  setSection: (s: SettingsSection, name?: string) => void
}) {
  switch (section) {
    case 'agents':
      return (
        <AgentsListPage
          selectedName={selectedName}
          onSelect={(name) => setSection('agents-edit', name)}
          onNew={(mode) => setSection('agents-new', mode ?? 'normal')}
        />
      )
    case 'agents-new':
      return (
        <NewAgentPage
          initialMode={selectedName === 'coding' ? 'coding' : 'normal'}
          onBack={() => setSection('agents')}
          onCreated={(name) => setSection('agents-edit', name)}
        />
      )
    case 'agents-edit':
      return selectedName ? (
        <AgentEditorPage name={selectedName} onBack={() => setSection('agents')} />
      ) : null
    case 'skills':
      return (
        <SkillsListPage
          selectedName={selectedName}
          onSelect={(name) => setSection('skills-edit', name)}
          onNew={() => setSection('skills-new')}
        />
      )
    case 'skills-new':
      return (
        <NewSkillPage
          onBack={() => setSection('skills')}
          onCreated={(name) => setSection('skills-edit', name)}
        />
      )
    case 'skills-edit':
      return selectedName ? (
        <SkillEditorPage name={selectedName} onBack={() => setSection('skills')} />
      ) : null
    case 'mcp':
      return (
        <McpListPage
          selectedName={selectedName}
          onSelect={(name) => setSection('mcp-edit', name)}
          onNew={() => setSection('mcp-new')}
        />
      )
    case 'mcp-new':
      return (
        <NewMcpServerPage
          onBack={() => setSection('mcp')}
          onCreated={(name) => setSection('mcp-edit', name)}
        />
      )
    case 'mcp-edit':
      return selectedName ? (
        <McpServerDetailPage name={selectedName} onBack={() => setSection('mcp')} />
      ) : null
    case 'providers':        return <ProvidersSettingsPage />
    case 'sandbox':          return <SandboxSettingsPage />
    case 'multimodal':       return <MultimodalSettingsPage />
    case 'title-generation': return <TitleGenerationSettingsPage />
    case 'notifications':    return <NotificationSettingsPage />
    case 'about':
    default:                 return <SettingsHubPage />
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getBreadcrumbs(section: SettingsSection, selectedName: string | null): string[] {
  const parts = ['Preferences', 'Settings']
  if (section.startsWith('agents')) {
    parts.push('Agents')
    if (section === 'agents-new') parts.push('New')
    if (section === 'agents-edit' && selectedName) parts.push(selectedName.replace(/^coding\//, ''))
  } else if (section.startsWith('skills')) {
    parts.push('Skills')
    if (section === 'skills-new') parts.push('New')
    if (section === 'skills-edit' && selectedName) parts.push(selectedName)
  } else if (section.startsWith('mcp')) {
    parts.push('MCP Servers')
    if (section === 'mcp-new') parts.push('New')
    if (section === 'mcp-edit' && selectedName) parts.push(selectedName)
  } else {
    const mapping: Record<string, string> = {
      providers: 'Providers',
      sandbox: 'Sandbox',
      multimodal: 'Multimodal',
      'title-generation': 'Title Generation',
      notifications: 'Notifications',
      about: 'About',
    }
    parts.push(mapping[section] || section)
  }
  return parts
}

// ── Modal ─────────────────────────────────────────────────────────────────

export function SettingsModal() {
  const open = useSettingsStore((s) => s.open)
  const section = useSettingsStore((s) => s.section)
  const selectedName = useSettingsStore((s) => s.selectedName)
  const setSection = useSettingsStore((s) => s.setSection)
  const closeSettings = useSettingsStore((s) => s.closeSettings)

  // Escape to close.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closeSettings])

  const breadcrumbs = getBreadcrumbs(section, selectedName)

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]"
            onClick={closeSettings}
            aria-hidden="true"
          />

          <motion.div
            key="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, scale: 0.98, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'fixed inset-2 z-50 flex flex-col overflow-hidden rounded-lg',
              'border border-(--color-border) bg-(--bg-page) shadow-2xl',
              'md:inset-[4vh_auto] md:left-1/2 md:-translate-x-1/2',
              'md:w-[min(95vw,76rem)] md:max-h-[92vh]',
            )}
          >
            {/* Header / Title Bar */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-sidebar) px-4 select-none">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-(--color-text)">Settings</span>
              </div>

              {/* Simple Close Button */}
              <button
                type="button"
                onClick={closeSettings}
                className="flex h-7 w-7 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                aria-label="Close settings"
                title="Close (Esc)"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>

            {/* Body */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {/* Left Sidebar categories panel */}
              <ModalSidebar section={section} onSelect={(s) => setSection(s)} />

              {/* Right content panel */}
              <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-page)">
                {/* Breadcrumbs Bar */}
                <div className="flex h-8.5 shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--bg-page) px-6 font-mono text-[10px] text-(--color-text-muted) select-none">
                  {breadcrumbs.map((crumb, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      {idx > 0 && <span className="text-(--color-text-subtle)/50">/</span>}
                      <span className={cn(idx === breadcrumbs.length - 1 ? 'text-(--color-text) font-semibold' : 'text-(--color-text-subtle)')}>
                        {crumb}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                  <SectionContent
                    key={`${section}:${selectedName ?? ''}`}
                    section={section}
                    selectedName={selectedName}
                    setSection={setSection}
                  />
                </div>
              </main>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
