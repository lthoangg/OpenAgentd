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
 *
 * Desktop shows the sidebar beside the section. Phones show either the
 * grouped section list or one section full-screen (`mobileView`), with Back
 * in the header.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { OverlayHeader } from '@/components/ui/app-overlay'
import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useModalFocus } from '@/hooks/useModalFocus'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import {
  SETTINGS_GROUPS,
  mobileBackTarget,
  parentSection,
  sectionDef,
  type SettingsSectionDef,
  type TopLevelSection,
} from '@/components/settings/sections'
import { useSettingsSectionCounts, useVisibleSettingsSections } from '@/components/settings/useVisibleSections'
import { ICON_SIZE } from '@/components/settings/tokens'
import { SettingsMobileIndex } from '@/components/settings/SettingsMobileIndex'
import { AboutSettingsPage } from '@/components/settings/pages/settings.index'
import { GeneralSettingsPage } from '@/components/settings/pages/settings.general'
import { ConnectionSettingsPage } from '@/components/settings/pages/settings.connection'
import { AgentsListPage } from '@/components/settings/pages/settings.agents'
import { SkillsListPage } from '@/components/settings/pages/settings.skills'
import { NewSkillPage } from '@/components/settings/pages/settings.skills.new'
import { SkillEditorPage } from '@/components/settings/pages/settings.skills.$name'
import { McpListPage } from '@/components/settings/pages/settings.mcp'
import { NewMcpServerPage } from '@/components/settings/pages/settings.mcp.new'
import { McpServerDetailPage } from '@/components/settings/pages/settings.mcp.$name'
import { MemorySettingsPage } from '@/components/settings/pages/settings.memory'
import { ProvidersSettingsPage } from '@/components/settings/pages/settings.providers'
import { DeniedPathsSettingsPage } from '@/components/settings/pages/settings.denied_paths'
import { WorkspacesSettingsPage } from '@/components/settings/pages/settings.workspaces'
import { GoalsSettingsPage } from '@/components/settings/pages/settings.goals'
import { TitlesSettingsPage } from '@/components/settings/pages/settings.titles'
import { ContextSettingsPage } from '@/components/settings/pages/settings.context'
import { MediaSettingsPage } from '@/components/settings/pages/settings.media'
import { NetworkSettingsPage } from '@/components/settings/pages/settings.network'
import { PluginsSettingsPage } from '@/components/settings/pages/settings.plugins'

import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useAppShortcut } from '@/lib/keyboard/hooks'

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
        'group flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-xs transition-colors duration-(--motion-instant) focus:outline-none',
        'text-(--color-text-2) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
        active && 'bg-(--bg-key) font-medium text-(--color-text) hover:bg-(--bg-key)',
      )}
    >
      <Icon
        size={ICON_SIZE}
        className={cn('shrink-0', active ? 'text-(--color-text)' : 'text-(--color-text-muted)')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count !== undefined && count !== null && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">
          {count}
        </span>
      )}
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-2.5 pt-4 pb-1.5 label-caps text-(--color-text-subtle) select-none">
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
  const sections = useVisibleSettingsSections()
  const counts = useSettingsSectionCounts()
  const active = parentSection(section)

  return (
    <nav
      aria-label="Settings categories"
      className="hidden h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) px-2 pt-1 pb-4 select-none md:flex"
    >
      {SETTINGS_GROUPS.map((group) => {
        const items = sections.filter((s) => s.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id}>
            <GroupLabel>{group.label}</GroupLabel>
            <div className="flex flex-col gap-0.5">
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
    case 'general':
      return <GeneralSettingsPage />
    case 'connection':
      return <ConnectionSettingsPage />
    case 'agents':
      return <AgentsListPage />
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
    case 'memory':       return <MemorySettingsPage />
    case 'plugins':      return <PluginsSettingsPage />
    case 'providers':    return <ProvidersSettingsPage />
    case 'denied_paths': return <DeniedPathsSettingsPage />
    case 'workspaces':   return <WorkspacesSettingsPage />
    case 'goals':        return <GoalsSettingsPage />
    case 'titles':       return <TitlesSettingsPage />
    case 'context':      return <ContextSettingsPage />
    case 'media':        return <MediaSettingsPage />
    case 'network':      return <NetworkSettingsPage />
    case 'about':
    default:             return <AboutSettingsPage />
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
  const showIndex = useSettingsStore((s) => s.showIndex)
  const mobileView = useSettingsStore((s) => s.mobileView)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const pendingNavigation = useSettingsStore((s) => s.pendingNavigation)
  const resolveNavigation = useSettingsStore((s) => s.resolvePendingNavigation)

  const prefersReducedMotion = useReducedMotion()
  const panel = prefersReducedMotion ? PANEL_VARIANTS_REDUCED : PANEL_VARIANTS

  // Switching to the palette would raise the unsaved-changes prompt under it.
  const layer = useModalFocus(open, closeSettings, undefined, {
    kind: 'overlay',
    allowSwitch: () => Object.keys(useSettingsStore.getState().dirtyDrafts).length === 0,
  })
  // ⌘, closes Settings even with unsaved changes (the prompt asks first);
  // opening something else over it is what `allowSwitch` blocks.
  useAppShortcut('settings', () => { closeSettings() }, { layer })

  const atIndex = mobileView === 'index'
  const sectionLabel = sectionDef(section)?.label ?? 'Settings'
  const goBack = () => {
    const target = mobileBackTarget(section)
    if (target === 'index') showIndex()
    else setSection(target)
  }

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
            className="fixed inset-0 z-50 bg-(--color-overlay)"
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
            data-modal-focus="true"
            data-settings-modal=""
            initial={panel.hidden}
            animate={panel.visible}
            exit={panel.hidden}
            transition={{ duration: prefersReducedMotion ? 0 : DURATIONS_S.fast, ease: EASINGS.out }}
            data-swipe-ignore
            className={cn(
              'settings-modal-shell z-50 flex flex-col overflow-hidden rounded-lg',
              'border border-(--color-border) bg-(--bg-page) shadow-(--shadow-depth)',
            )}
          >
            {/* Header / Title Bar */}
            <OverlayHeader
              title={
                atIndex ? 'Settings' : (
                  <>
                    <span className="md:hidden">{sectionLabel}</span>
                    <span className="max-md:hidden">Settings</span>
                  </>
                )
              }
              onClose={closeSettings}
              closeLabel="Close settings"
              leading={
                !atIndex && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="md:hidden"
                    onClick={goBack}
                    aria-label={mobileBackTarget(section) === 'index' ? 'Back to settings' : 'Back to list'}
                  >
                    <ArrowLeft size={ICON_SIZE} aria-hidden="true" />
                  </Button>
                )
              }
            />

            {/* Body */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ModalSidebar section={section} onSelect={(s) => setSection(s)} />

              {atIndex && (
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:hidden">
                  <SettingsMobileIndex onSelect={(s) => setSection(s)} />
                </div>
              )}

              <main
                className={cn(
                  'flex min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-page)',
                  atIndex && 'max-md:hidden',
                )}
              >
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
          <Dialog open={pendingNavigation !== null} onOpenChange={(next) => { if (!next) resolveNavigation(false) }}>
            <DialogContent>
              <DialogTitle>Discard unsaved settings?</DialogTitle>
              <DialogDescription>Keep editing to save your changes, or discard them to continue.</DialogDescription>
              <DialogFooter>
                <Button onClick={() => resolveNavigation(false)}>Keep editing</Button>
                <Button variant="danger" onClick={() => resolveNavigation(true)}>Discard changes</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </AnimatePresence>
  )
}
