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
 * in the header. On a phone the two are a navigation stack (PhoneStack): a
 * section slides in over the list, ‹ Settings, an edge swipe or Android Back
 * slide it away again.
 *
 * The sidebar is a labelled list from 900px up and an icon rail below it
 * (names in tooltips), so the form keeps its width on a narrow window.
 * Search finds single settings as well as sections (`settings-index.ts`),
 * on the sidebar, in a dialog from the rail, and on the phone section list.
 *
 * The frame is the shared `AppOverlay` (wide, app-level): the same card, gap
 * above the status bar, border and motion as every other overlay.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { AppOverlay, OVERLAY_MAX_WIDTH, OverlayHeader } from '@/components/ui/app-overlay'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
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
import { PhoneStack } from '@/components/phone/PhoneStack'
import { useIsPhone } from '@/hooks/use-is-phone'
import { ICON_SIZE } from '@/components/settings/tokens'
import { SettingsMobileIndex } from '@/components/settings/SettingsMobileIndex'
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from '@/components/settings/SettingsSearch'
import { revealSetting, type SettingsHit } from '@/components/settings/settings-index'
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

// ── Sidebar ───────────────────────────────────────────────────────────────

// Below 900px the sidebar is an icon rail: `max-[899px]:` / `min-[900px]:`.
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
  const Icon = item.icon
  return (
    <Tooltip className="w-full">
      <TooltipTrigger
        className="w-full"
        render={
          <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-xs transition-colors duration-(--motion-instant) pointer-coarse:h-9',
              'max-[899px]:justify-center max-[899px]:px-0',
              'text-(--color-text-2) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
              active && 'bg-(--bg-key) font-medium text-(--color-text) hover:bg-(--bg-key)',
            )}
          >
            <Icon size={ICON_SIZE} aria-hidden="true" className="shrink-0 min-[900px]:hidden" />
            {/* The name stays for screen readers when the rail shows only the icon. */}
            <span className="min-w-0 flex-1 truncate max-[899px]:sr-only">{item.label}</span>
            {count && (
              <span className="shrink-0 text-meta tabular-nums text-(--color-text-muted) max-[899px]:hidden">
                {count}
              </span>
            )}
          </button>
        }
      />
      <TooltipContent side="right">
        <span className="block font-medium">{item.label}</span>
        <span className="block">{item.description}</span>
      </TooltipContent>
    </Tooltip>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-2.5 pt-4 pb-1 text-xs font-medium text-(--color-text-muted) select-none max-[899px]:hidden">
      {children}
    </p>
  )
}

/** The rail's search: an icon that opens the same search in a dialog. */
function RailSearch({ onOpen }: { onOpen: (hit: SettingsHit) => void }) {
  const sections = useVisibleSettingsSections()
  const search = useSettingsSearch(sections)
  const [open, setOpen] = useState(false)
  const choose = (hit: SettingsHit) => {
    setOpen(false)
    search.setQuery('')
    onOpen(hit)
  }
  return (
    <div className="flex justify-center min-[900px]:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Search settings" onClick={() => setOpen(true)}>
              <Search size={ICON_SIZE} aria-hidden="true" />
            </Button>
          }
        />
        <TooltipContent side="right">Search settings</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogTitle>Search settings</DialogTitle>
          <DialogDescription className="sr-only">Find a section or a single setting.</DialogDescription>
          <div className="mt-3 max-h-[60vh] overflow-y-auto">
            <SettingsSearchField search={search} onOpen={choose} autoFocus />
            <SettingsSearchResults search={search} onOpen={choose} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ModalSidebar({
  section,
  onSelect,
  onOpenHit,
}: {
  section: SettingsSection
  onSelect: (s: TopLevelSection) => void
  onOpenHit: (hit: SettingsHit) => void
}) {
  const sections = useVisibleSettingsSections()
  const counts = useSettingsSectionCounts()
  const active = parentSection(section)
  const search = useSettingsSearch(sections)

  return (
    <nav
      aria-label="Settings categories"
      className={cn(
        'hidden h-full w-12 shrink-0 flex-col overflow-y-auto border-r border-(--color-border) bg-(--bg-sidebar) px-1.5 pt-2 pb-4 select-none md:flex',
        'min-[900px]:w-60 min-[900px]:px-2',
      )}
    >
      <SettingsSearchField search={search} onOpen={onOpenHit} wrapperClassName="max-[899px]:hidden" />
      <RailSearch onOpen={onOpenHit} />
      {search.searching && <SettingsSearchResults search={search} onOpen={onOpenHit} className="max-[899px]:hidden" />}
      <div className={cn('flex flex-col', search.searching && 'min-[900px]:hidden')}>
        {SETTINGS_GROUPS.map((group) => {
          const items = sections.filter((s) => s.group === group.id)
          if (items.length === 0) return null
          return (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="max-[899px]:mt-1.5 max-[899px]:border-t max-[899px]:border-(--color-border-subtle) max-[899px]:pt-1.5 max-[899px]:first:mt-0 max-[899px]:first:border-t-0 max-[899px]:first:pt-0"
            >
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
      </div>
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

  // A search result for one setting opens its section, then scrolls to the
  // setting and focuses its control once the page has rendered it.
  const mainRef = useRef<HTMLElement>(null)
  const [reveal, setReveal] = useState<{ anchor: string; nonce: number } | null>(null)
  const openHit = (hit: SettingsHit) => {
    setSection(hit.section)
    setReveal(hit.kind === 'setting' ? { anchor: hit.anchor, nonce: Date.now() } : null)
  }
  useEffect(() => {
    if (!open || !reveal) return undefined
    let tries = 0
    let timer: number | undefined
    const attempt = () => {
      if (revealSetting(mainRef.current, reveal.anchor) || (tries += 1) > 12) return
      timer = window.setTimeout(attempt, 100)
    }
    attempt()
    return () => window.clearTimeout(timer)
  }, [open, reveal])

  // Focus starts where a Settings window's does: in the search field, or,
  // where the icon rail hides the field behind an icon, in the page itself.
  // On Close (or a rail icon) it drew a ring and opened a tooltip the moment
  // ⌘, opened Settings.
  const initialFocus = useMemo(() => ({
    get current(): HTMLElement | null {
      const modal = document.querySelector<HTMLElement>('[data-settings-modal]')
      const shown = (el: HTMLElement | null | undefined) => (el && el.getClientRects().length > 0 ? el : null)
      return shown(modal?.querySelector<HTMLElement>('nav[aria-label="Settings categories"] input[type="search"]')) ?? shown(modal?.querySelector<HTMLElement>('main'))
    },
  }), [])
  const atIndex = mobileView === 'index'
  const sectionLabel = sectionDef(section)?.label ?? 'Settings'
  const backTarget = mobileBackTarget(section)
  const goBack = () => {
    if (backTarget === 'index') showIndex()
    else setSection(backTarget)
  }
  // A phone's Settings is a stack: the list, a section pushed over it. Back
  // (Android's included, which reaches the overlay as Escape) climbs a level
  // before it closes the sheet.
  const phone = useIsPhone()

  const page = (
    <main
      ref={mainRef}
      // Focusable, so Settings can open with focus in the page.
      tabIndex={-1}
      className={cn(
        'flex min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-page) outline-none',
        atIndex && !phone && 'max-md:hidden',
        phone && 'h-full',
      )}
    >
      {/* Keyed by the page, so a new section fades in (``fast``). */}
      <div key={`${section}:${selectedName ?? ''}`} className="oa-fade-in-fast min-h-0 flex-1 overflow-hidden flex flex-col">
        <SectionContent
          section={section}
          selectedName={selectedName}
          setSection={setSection}
        />
      </div>
    </main>
  )

  return (
    <AppOverlay
      open={open}
      onClose={closeSettings}
      onEscape={phone && !atIndex ? goBack : undefined}
      label="Settings"
      maxWidth={OVERLAY_MAX_WIDTH.wide}
      appLevel
      initialFocus={initialFocus}
      // ⌘, closes Settings even with unsaved changes (the prompt asks first);
      // opening something else over it is what `allowSwitch` blocks, so the
      // prompt never opens under the palette.
      toggleShortcut="settings"
      allowSwitch={() => Object.keys(useSettingsStore.getState().dirtyDrafts).length === 0}
    >
      {/* `group/settings`: an open editor brings its own Back, so the
          overlay's mobile Back hides while one is shown (one Back only).
          Settings pages scope their own shortcuts (⌘S) to this root. */}
      <div data-settings-modal="" className="group/settings flex min-h-0 flex-1 flex-col">
        <OverlayHeader
          title={
            atIndex ? 'Settings' : phone ? sectionLabel : (
              <>
                <span className="md:hidden">{sectionLabel}</span>
                <span className="max-md:hidden">Settings</span>
              </>
            )
          }
          onClose={closeSettings}
          closeLabel="Close settings"
          back={atIndex ? undefined : {
            label: backTarget === 'index' ? 'Settings' : (sectionDef(backTarget)?.label ?? 'Back'),
            onBack: goBack,
            ariaLabel: backTarget === 'index' ? 'Back to settings' : 'Back to list',
            className: 'md:hidden group-has-[[data-editor-kind]]/settings:hidden',
          }}
        />

        {/* Body */}
        {phone ? (
          <div className="relative min-h-0 flex-1">
            <PhoneStack
              root={(
                <div className="flex h-full min-w-0 flex-col overflow-hidden">
                  <SettingsMobileIndex onSelect={(s) => setSection(s)} onOpenHit={openHit} />
                </div>
              )}
              page={page}
              pushed={!atIndex}
              onBack={goBack}
              // An editor two levels down brings its own Back to its list.
              backEnabled={backTarget === 'index'}
            />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ModalSidebar section={section} onSelect={(s) => setSection(s)} onOpenHit={openHit} />

          {atIndex && (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:hidden">
              <SettingsMobileIndex onSelect={(s) => setSection(s)} onOpenHit={openHit} />
            </div>
          )}

          {page}
        </div>
        )}
      </div>
      <ConfirmDialog
        open={pendingNavigation !== null}
        onOpenChange={(next) => { if (!next) resolveNavigation(false) }}
        title="Discard changes?"
        description="Your unsaved settings will be lost."
        confirmLabel="Discard changes"
        onConfirm={() => resolveNavigation(true)}
      />
    </AppOverlay>
  )
}
