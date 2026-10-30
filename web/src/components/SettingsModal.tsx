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
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'

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
import { TelemetrySettingsPage } from '@/components/settings/pages/settings.telemetry'
import { TitlesSettingsPage } from '@/components/settings/pages/settings.titles'
import { ContextSettingsPage } from '@/components/settings/pages/settings.context'
import { MediaSettingsPage } from '@/components/settings/pages/settings.media'
import { DesktopSettingsPage } from '@/components/settings/pages/settings.desktop'
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
  /** What the section holds, in words ("4 skills"). */
  count?: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={item.description}
      className={cn(
        'group flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-xs transition-colors duration-(--motion-instant)',
        'text-(--color-text-2) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
        active && 'bg-(--bg-key) font-medium text-(--color-text) hover:bg-(--bg-key)',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count && (
        <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-subtle)">
          {count}
        </span>
      )}
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-2.5 pt-4 pb-1 text-xs font-medium text-(--color-text-muted) select-none">
      {children}
    </p>
  )
}

/** Whether a section matches the nav search, by its label or description. */
function matchesSearch(item: SettingsSectionDef, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
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
  const [query, setQuery] = useState('')
  const matches = sections.filter((s) => matchesSearch(s, query))

  return (
    <nav
      aria-label="Settings categories"
      className="hidden h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) px-2 pt-2 pb-4 select-none md:flex"
    >
      <SearchBar
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search settings"
        onKeyDown={(event) => {
          // Enter opens the first match, so typing a word then Enter jumps there.
          if (event.key === 'Enter' && matches[0]) {
            event.preventDefault()
            onSelect(matches[0].id)
          }
        }}
      />
      {matches.length === 0 && (
        <p className="px-2.5 pt-4 text-xs text-(--color-text-muted)">No settings match “{query.trim()}”.</p>
      )}
      {SETTINGS_GROUPS.map((group) => {
        const items = matches.filter((s) => s.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id} role="group" aria-label={group.label}>
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
    case 'desktop':
      return <DesktopSettingsPage />
    case 'connection':
    case 'network':
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
    case 'telemetry':    return <TelemetrySettingsPage />
    case 'titles':       return <TitlesSettingsPage />
    case 'context':      return <ContextSettingsPage />
    case 'media':        return <MediaSettingsPage />
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
              // `group/settings`: an open editor brings its own Back, so the
              // overlay's mobile Back hides while one is shown (one Back only).
              'group/settings settings-modal-shell z-50 flex flex-col overflow-hidden rounded-lg',
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
                    className="md:hidden group-has-[[data-editor-kind]]/settings:hidden"
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
