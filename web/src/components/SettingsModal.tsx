/**
 * SettingsModal — VS Code–style full-screen settings overlay.
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
        'group relative mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md px-3 text-sm transition-colors',
        'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-(--focus-ring)/40',
        active && 'bg-(--bg-key) font-semibold text-(--color-text)',
      )}
    >
      <Icon size={15} className={cn('shrink-0', active ? 'text-(--color-text)' : 'text-(--color-text-muted)')} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {item.count !== undefined && item.count !== null && (
        <span className={cn('shrink-0 font-mono text-[10px] tabular-nums', active ? 'font-semibold text-(--color-text-muted)' : 'text-(--color-text-muted)')}>
          {item.count}
        </span>
      )}
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pt-4 pb-1.5 font-mono text-[10px] font-semibold tracking-wider text-(--color-text-muted) uppercase select-none">
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
    <nav aria-label="Settings categories" className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar)">
      <GroupLabel>Configuration</GroupLabel>
      <div className="flex flex-col">
        {configItems.map((item) => (
          <SidebarRow key={item.section} item={item} active={active === item.section} onClick={() => onSelect(item.section)} />
        ))}
      </div>
      <div className="mx-3 my-3 h-px bg-(--color-border)" role="separator" aria-hidden="true" />
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
            className="fixed inset-0 z-50 bg-black/50"
            onClick={closeSettings}
            aria-hidden="true"
          />

          <motion.div
            key="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl',
              'border border-(--color-border) bg-(--bg-page) shadow-2xl',
              'md:inset-[5vh_auto] md:left-1/2 md:-translate-x-1/2',
              'md:w-[min(90vw,72rem)] md:max-h-[90vh]',
            )}
          >
            {/* Header */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-page) px-4">
              <span className="text-sm font-semibold text-(--color-text)">Settings</span>
              <button
                type="button"
                onClick={closeSettings}
                className="flex h-7 w-7 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                aria-label="Close settings"
                title="Close (Esc)"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            {/* Body */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ModalSidebar section={section} onSelect={(s) => setSection(s)} />
              <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <SectionContent
                  key={`${section}:${selectedName ?? ''}`}
                  section={section}
                  selectedName={selectedName}
                  setSection={setSection}
                />
              </main>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
