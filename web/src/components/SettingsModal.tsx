/**
 * SettingsModal — VS Code–style settings overlay.
 *
 * All navigation is internal: sidebar buttons + editor back/onCreated
 * callbacks update `useSettingsStore` without touching the URL.
 * No /settings/* routes are needed.
 *
 * Section metadata (labels, icons, grouping, mobile nav) lives in
 * `settings/sections.ts`. Only the content switch is here, because each
 * section takes different props.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, X, type LucideIcon } from 'lucide-react'
import { useHotkey } from '@tanstack/react-hotkeys'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import {
  useAgentFilesQuery,
  useDeniedPathsSettingsQuery,
  useMcpServersQuery,
  useSkillFilesQuery,
} from '@/queries'
import {
  SETTINGS_GROUPS,
  isDrillDown,
  mobileBackSection,
  parentSection,
  SETTINGS_SECTIONS,
  type SettingsSectionDef,
  type TopLevelSection,
} from '@/components/settings/sections'
import { ICON_SIZE_INLINE } from '@/components/settings/tokens'

import { SettingsHubPage } from '@/components/settings/pages/settings.index'
import { AgentsListPage } from '@/components/settings/pages/settings.agents'
import { NewAgentPage } from '@/components/settings/pages/settings.agents.new'
import { AgentEditorPage } from '@/components/settings/pages/settings.agents.$name'
import { SkillsListPage } from '@/components/settings/pages/settings.skills'
import { NewSkillPage } from '@/components/settings/pages/settings.skills.new'
import { SkillEditorPage } from '@/components/settings/pages/settings.skills.$name'
import { McpListPage } from '@/components/settings/pages/settings.mcp'
import { NewMcpServerPage } from '@/components/settings/pages/settings.mcp.new'
import { McpServerDetailPage } from '@/components/settings/pages/settings.mcp.$name'
import { ProvidersSettingsPage } from '@/components/settings/pages/settings.providers'
import { DeniedPathsSettingsPage } from '@/components/settings/pages/settings.denied_paths'
import { AutomationSettingsPage } from '@/components/settings/pages/settings.automation'
import { NotificationSettingsPage } from '@/components/settings/pages/settings.notifications'
import { TerminalSettingsPage } from '@/components/settings/pages/settings.terminal'
import { DURATIONS_S, EASINGS } from '@/lib/motion'

// ── Sidebar ───────────────────────────────────────────────────────────────

function SidebarRow({
  item,
  count,
  active,
  onClick,
}: {
  item: SettingsSectionDef
  count?: number | null
  active: boolean
  onClick: () => void
}) {
  const Icon: LucideIcon = item.icon
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
      <Icon
        size={ICON_SIZE_INLINE}
        className={cn('shrink-0', active ? 'text-(--color-text)' : 'text-(--color-text-muted)')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count !== undefined && count !== null && (
        <span
          className={cn(
            'shrink-0 font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-xs border transition-colors',
            active
              ? 'font-semibold text-(--color-text) bg-(--bg-page) border-(--color-border-strong)'
              : 'text-(--color-text-muted) bg-(--bg-key)/50 border-(--color-border)',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-4 pt-3 pb-1 font-mono text-[10px] font-bold tracking-wider text-(--color-text-subtle)/85 uppercase select-none">
      {children}
    </p>
  )
}

function ModalSidebar({
  section,
  onSelect,
}: {
  section: SettingsSection
  onSelect: (s: TopLevelSection) => void
}) {
  const agentsQ = useAgentFilesQuery()
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const deniedPathsQ = useDeniedPathsSettingsQuery()
  const active = parentSection(section)

  const counts: Partial<Record<TopLevelSection, number | null>> = {
    agents: agentsQ.data?.agents.length ?? null,
    skills: skillsQ.data?.skills.length ?? null,
    mcp: mcpQ.data?.servers.length ?? null,
    denied_paths: deniedPathsQ.data?.denied_patterns.length ?? null,
    sandbox: deniedPathsQ.data?.denied_patterns.length ?? null,
  }

  return (
    <nav
      aria-label="Settings categories"
      className="hidden h-full w-52 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) select-none md:flex"
    >
      {SETTINGS_GROUPS.map((group, idx) => {
        const items = SETTINGS_SECTIONS.filter((s) => s.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id}>
            {idx > 0 && (
              <div
                className="mx-4 my-2.5 h-px bg-(--color-border)"
                role="separator"
                aria-hidden="true"
              />
            )}
            <GroupLabel>{group.label}</GroupLabel>
            <div className="flex flex-col">
              {items.map((item) => (
                <SidebarRow
                  key={item.id}
                  item={item}
                  count={counts[item.id]}
                  active={active === item.id}
                  onClick={() => onSelect(item.id)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function MobileTabBar({
  section,
  onSelect,
}: {
  section: SettingsSection
  onSelect: (s: TopLevelSection) => void
}) {
  // Sections without their own tab are reached through About, so highlight it.
  const active = mobileBackSection(section)
  const items = SETTINGS_SECTIONS.filter((s) => s.mobileTab)

  return (
    <nav
      aria-label="Settings sections"
      className="grid h-14 shrink-0 grid-cols-5 border-t border-(--color-border) bg-(--bg-sidebar) md:hidden"
    >
      {items.map((item) => {
        const Icon = item.icon
        const isActive = active === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors',
              'text-(--color-text-muted) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40',
              isActive && 'bg-(--bg-key)/55 text-(--color-text)',
            )}
          >
            <Icon size={ICON_SIZE_INLINE} aria-hidden="true" />
            <span className="truncate">{item.id === 'about' ? 'About' : item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

// ── Section content ───────────────────────────────────────────────────────

/**
 * Kept as an explicit switch rather than folded into the registry: each
 * section takes a different prop shape (list pages need selection callbacks,
 * editors need a name and a back handler), and a union type covering all of
 * them would be harder to read than this.
 */
function SectionContent({
  section,
  selectedName,
  setSection,
}: {
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
          onNew={() => setSection('agents-new')}
        />
      )
    case 'agents-new':
      return (
        <NewAgentPage
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
    case 'providers':    return <ProvidersSettingsPage />
    case 'denied_paths':
    case 'sandbox':      return <DeniedPathsSettingsPage />
    case 'automation':   return <AutomationSettingsPage />
    case 'notifications': return <NotificationSettingsPage />
    case 'terminal':     return <TerminalSettingsPage />
    case 'about':
    default:             return <SettingsHubPage />
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────

/** Panel enter/exit. Module scope so framer sees a stable target reference.
 *  Mirrors MODAL_VARIANTS / MODAL_VARIANTS_REDUCED in ui/app-overlay.tsx —
 *  reduced motion keeps the fade and drops the scale/translate. */
const PANEL_VARIANTS = {
  hidden: { opacity: 0, scale: 0.98, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0 },
} as const
const PANEL_VARIANTS_REDUCED = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
} as const

export function SettingsModal() {
  const open = useSettingsStore((s) => s.open)
  const section = useSettingsStore((s) => s.section)
  const selectedName = useSettingsStore((s) => s.selectedName)
  const setSection = useSettingsStore((s) => s.setSection)
  const closeSettings = useSettingsStore((s) => s.closeSettings)

  const prefersReducedMotion = useReducedMotion()
  const panel = prefersReducedMotion ? PANEL_VARIANTS_REDUCED : PANEL_VARIANTS

  // Escape to close.
  useHotkey('Escape', closeSettings, { enabled: open })

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATIONS_S.fast }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]"
            onClick={closeSettings}
            aria-hidden="true"
            // Full-screen on mobile — must not be readable by the outer
            // edge-swipe drawer controller (same rationale as AppOverlay).
            data-swipe-ignore
          />

          <motion.div
            key="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={panel.hidden}
            animate={panel.visible}
            exit={panel.hidden}
            transition={{ duration: prefersReducedMotion ? 0 : DURATIONS_S.fast, ease: EASINGS.out }}
            data-swipe-ignore
            className={cn(
              'settings-modal-shell z-50 flex flex-col overflow-hidden rounded-lg',
              'border border-(--color-border) bg-(--bg-page) shadow-2xl',
            )}
          >
            {/* Header / Title Bar */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-sidebar) px-2 select-none sm:px-4">
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                {isDrillDown(section) && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="md:hidden"
                    onClick={() => setSection(mobileBackSection(section))}
                    aria-label="Back to list"
                  >
                    <ArrowLeft size={ICON_SIZE_INLINE} aria-hidden="true" />
                  </Button>
                )}
                <span className="text-base font-semibold text-(--color-text)">Settings</span>
              </div>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={closeSettings}
                      className="flex h-11 w-11 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:h-7 md:w-7"
                      aria-label="Close settings"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  }
                />
                <TooltipContent>Close (Esc)</TooltipContent>
              </Tooltip>
            </div>

            {/* Body */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ModalSidebar section={section} onSelect={(s) => setSection(s)} />

              <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-page)">
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
            <MobileTabBar section={section} onSelect={(s) => setSection(s)} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
