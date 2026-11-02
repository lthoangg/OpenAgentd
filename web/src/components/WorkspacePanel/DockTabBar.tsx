/**
 * DockTabBar — one Review panel pane's editor-tab strip.
 *
 * One row: scrolling tabs on the left, a fixed action cluster on the right:
 * the tab list (when the strip overflows), "Open…" (every view and tool,
 * including Terminal and Preview, and Split Right / Split Down), refresh
 * while a Git or file tab shows, maximize on desktop, Hide on a pane of
 * terminals (⌃`), and Close on an empty pane beside others. Views
 * (Git, Plan, Tasks…) come before a hairline and documents after it, as in
 * an editor; the pane's preview tab is set in italics until it is kept.
 * Hiding the dock lives on the header's review-dock toggle (and ⌘D), which
 * is always visible because the dock never covers the header.
 *
 * Tabs are plain buttons with ``aria-current`` rather than an ARIA
 * ``tablist`` (each has a sibling close button and a context menu, which
 * tab semantics do not model). ⌘W, middle-click and the tab menu
 * (right-click or Shift+F10) also close tabs; double-click keeps a preview.
 *
 * Tabs move by drag (fine pointers, see ``useTabDrag``): along the strip,
 * onto another pane's strip or middle, or onto a pane's edge to split it.
 * From the keyboard and the tab menu: ⌥⇧←/→, Move Left / Move Right, Split
 * Right / Split Down, Move to Next Pane.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarClock, Check, ChevronDown, Copy, FileDiff, FileText, GitCommitHorizontal, GitCompare, Globe, ListTodo, Maximize2, MessageCircleQuestion, Minimize2, Plus, RefreshCw, Target, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import { FileTypeIcon } from '../FileTypeIcon'
import { TerminalTabButton } from '../Terminal/TerminalTabButton'
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import type { TerminalSessionMeta } from '@/stores/useTerminalStore'
import {
  DOCK_ACTION_BUTTON_CLASS,
  DOCK_STRIP_PART_CLASS,
  DOCK_TAB_LIFTED_CLASS,
  DOCK_TAB_STRIP_CLASS,
  dockTabButtonClass,
  dockTabClass,
  dockTabCloseClass,
} from './dock-tab-styles'
import { type DockTab, dockTabLabel, dockTabTooltip, isViewTab } from './dock-tabs'
import type { DockOpenItem } from './DockLauncher'
import { DOCK_TAB_ATTR, useTabDrag } from './useTabDrag'
import type { TabDropTarget } from './useDockTabs'

/** Width the "+" menu is laid out for, so it opens right-aligned under the button. */
const OPEN_MENU_WIDTH = 192

export interface DockTabBarProps {
  tabs: DockTab[]
  activeTabId: string
  /** This pane's preview tab (italic, replaced by the next preview). */
  previewTabId?: string | null
  workspace: string
  terminalMetas: TerminalSessionMeta[]
  mobile: boolean
  os: OS
  registerTabRef: (id: string, node: HTMLButtonElement | null) => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** Tab menu: close every other tab / the tabs after this one. */
  onCloseOthers?: (id: string) => void
  onCloseToRight?: (id: string) => void
  /** Moves a tab to an index of ``tabs``; omitted, tabs stay put. */
  onMove?: (id: string, toIndex: number) => void
  /** Keep a preview tab (double-click, Keep Open). */
  onKeep?: (id: string) => void
  /** Tab menu: Split Right / Split Down, the tab moving into the new pane. Omitted on phones. */
  onSplit?: (id: string, side: 'right' | 'down') => void
  /** False for a pane's only tab (nothing would be left to split). */
  canSplit?: (id: string) => boolean
  /** Tab menu: Move to Next Pane (shown while another pane is on screen). */
  onMoveToNextPane?: (id: string) => void
  canMoveToNextPane?: (id: string) => boolean
  /** Tab menu on files and diffs: the Changes list with the file's diff open. */
  onRevealInGit?: (path: string) => void
  /** A pane of terminals: its Hide button (⌃`). */
  onHideTerminals?: () => void
  /** An empty pane beside others: its Close button. */
  onClosePane?: () => void
  /** A tab dragged out of the strip and let go over a pane (see ``useTabDrag``). */
  onDropTab?: (id: string, target: TabDropTarget) => void
  onRefresh: () => void
  /** What refresh reloads for the active tab ("Refresh Git status"); null hides it. */
  refreshLabel?: string | null
  /** The "+" menu's rows (see ``dockOpenItems``); empty hides the button. */
  openItems?: DockOpenItem[]
  /** ``null`` hides the toggle (mobile, or a forced narrow-window overlay). */
  maximized: boolean | null
  onToggleMaximized: () => void
}

function TabIcon({ tab }: { tab: DockTab }) {
  switch (tab.type) {
    case 'review':
      return <GitCompare size={12} className="shrink-0" aria-hidden="true" />
    case 'tasks':
      return <ListTodo size={12} className="shrink-0" aria-hidden="true" />
    case 'schedule':
      return <CalendarClock size={12} className="shrink-0" aria-hidden="true" />
    case 'plan':
      return <FileText size={12} className="shrink-0" aria-hidden="true" />
    case 'btw':
      return <MessageCircleQuestion size={12} className="shrink-0" aria-hidden="true" />
    case 'goal':
      return <Target size={12} className="shrink-0" aria-hidden="true" />
    case 'file':
      return <FileTypeIcon name={tab.file.name || tab.file.path} size={13} />
    case 'attachment':
      return <FileTypeIcon name={tab.item.name} size={13} />
    case 'diff':
      return <FileDiff size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
    case 'commit':
      return <GitCommitHorizontal size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
    case 'preview':
      return <Globe size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
    default:
      return null
  }
}

function ActionButton({ label, onClick, children, expanded }: {
  label: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  /** Set on a button that opens a menu: whether it is showing. */
  expanded?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={cn(DOCK_ACTION_BUTTON_CLASS, 'pointer-coarse:size-9', expanded && 'bg-(--bg-key) text-(--color-text)')}
            aria-label={label}
            aria-haspopup={expanded === undefined ? undefined : 'menu'}
            aria-expanded={expanded}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The path a file or diff tab shows, absolute, for "Copy Path". */
function tabPath(tab: DockTab, workspace: string): string | null {
  const path = tab.type === 'file' ? tab.file.path : tab.type === 'diff' ? tab.path : null
  if (!path) return null
  return path.startsWith('/') ? path : `${workspace.replace(/\/+$/, '')}/${path}`
}

/**
 * The tab-strip items every tab's menu shares (terminal tabs add theirs
 * first). ``dismiss`` closes the menu before the action runs.
 */
export function DockTabMenuItems({ tab, tabs, workspace, dismiss, onClose, onCloseOthers, onCloseToRight, onMove, preview = false, onKeep, onSplit, canSplit, onMoveToNextPane, canMoveToNextPane, onRevealInGit, os }: {
  tab: DockTab
  tabs: DockTab[]
  workspace: string
  dismiss: () => void
  onClose?: (id: string) => void
  onCloseOthers?: (id: string) => void
  onCloseToRight?: (id: string) => void
  onMove?: (id: string, toIndex: number) => void
  preview?: boolean
  onKeep?: (id: string) => void
  onSplit?: (id: string, side: 'right' | 'down') => void
  canSplit?: (id: string) => boolean
  onMoveToNextPane?: (id: string) => void
  canMoveToNextPane?: (id: string) => boolean
  onRevealInGit?: (path: string) => void
  /** Spells the keys beside Split Right and Split Down (⌃⌥→, ⌃⌥↓). */
  os?: OS
}): ReactNode {
  const index = tabs.findIndex((item) => item.id === tab.id)
  const hasOthers = tabs.length > 1
  const hasRight = index >= 0 && index < tabs.length - 1
  const path = tabPath(tab, workspace)
  const changedPath = tab.type === 'diff' ? tab.path : tab.type === 'file' ? tab.file.path : null
  const item = (label: string, run: () => void, icon?: ReactNode, disabled = false, shortcut?: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(CONTEXT_MENU_ITEM_CLASS, 'disabled:opacity-50')}
      onClick={() => { dismiss(); run() }}
    >
      {icon ?? <span className="w-3" aria-hidden="true" />}
      <span className="flex-1">{label}</span>
      {shortcut && (
        <kbd aria-hidden="true" className="hidden font-mono text-meta text-(--color-text-subtle) md:inline">{shortcut}</kbd>
      )}
    </button>
  )
  const splitKey = (name: 'splitTabRight' | 'splitTabDown') => (os ? shortcutLabel(APP_SHORTCUTS[name], os) : undefined)
  return (
    <>
      {onClose && item('Close', () => onClose(tab.id), <X size={12} aria-hidden="true" />)}
      {onCloseOthers && item('Close Others', () => onCloseOthers(tab.id), undefined, !hasOthers)}
      {onCloseToRight && item('Close to the Right', () => onCloseToRight(tab.id), undefined, !hasRight)}
      {preview && onKeep && item('Keep Open', () => onKeep(tab.id))}
      {onSplit && item('Split Right', () => onSplit(tab.id, 'right'), undefined, !(canSplit?.(tab.id) ?? true), splitKey('splitTabRight'))}
      {onSplit && item('Split Down', () => onSplit(tab.id, 'down'), undefined, !(canSplit?.(tab.id) ?? true), splitKey('splitTabDown'))}
      {onMoveToNextPane && (canMoveToNextPane?.(tab.id) ?? true) && item('Move to Next Pane', () => onMoveToNextPane(tab.id))}
      {onMove && item('Move Left', () => onMove(tab.id, index - 1), undefined, index <= 0)}
      {onMove && item('Move Right', () => onMove(tab.id, index + 1), undefined, !hasRight)}
      {path && item('Copy Path', () => { void navigator.clipboard?.writeText(path) }, <Copy size={12} aria-hidden="true" />)}
      {changedPath && onRevealInGit && item('Reveal in Git', () => onRevealInGit(changedPath))}
    </>
  )
}

/** Focus a tab's activate button (the first button in its wrapper). */
function focusTabButton(strip: HTMLElement | null, id: string) {
  const node = Array.from(strip?.querySelectorAll(`[${DOCK_TAB_ATTR}]`) ?? []).find((el) => el.getAttribute(DOCK_TAB_ATTR) === id)
  node?.querySelector<HTMLElement>('button')?.focus()
}

export function DockTabBar({
  tabs,
  activeTabId,
  previewTabId = null,
  workspace,
  terminalMetas,
  mobile,
  os,
  registerTabRef,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onMove,
  onKeep,
  onSplit,
  canSplit,
  onMoveToNextPane,
  canMoveToNextPane,
  onRevealInGit,
  onHideTerminals,
  onClosePane,
  onDropTab,
  onRefresh,
  refreshLabel = null,
  openItems = [],
  maximized,
  onToggleMaximized,
}: DockTabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const drag = useTabDrag({ enabled: !mobile && onMove !== undefined, onMove: onMove ?? (() => {}), onDrop: onDropTab })
  // A moved tab's node is re-inserted, which drops its focus: put it back
  // when the move came from the keyboard or the tab menu.
  const moveAndFocus = onMove && ((id: string, toIndex: number) => {
    onMove(id, toIndex)
    requestAnimationFrame(() => focusTabButton(stripRef.current, id))
  })
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [openMenuAt, setOpenMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [listMenuAt, setListMenuAt] = useState<{ x: number; y: number } | null>(null)
  const menuTab = menu ? tabs.find((tab) => tab.id === menu.id) : undefined
  const paneMenuProps = {
    onKeep,
    onSplit,
    canSplit,
    onMoveToNextPane,
    canMoveToNextPane,
    onRevealInGit,
    os,
  }
  const sharedMenu = (tab: DockTab, dismiss: () => void) => (
    <DockTabMenuItems
      tab={tab}
      tabs={tabs}
      workspace={workspace}
      dismiss={dismiss}
      onCloseOthers={onCloseOthers}
      onCloseToRight={onCloseToRight}
      onMove={moveAndFocus}
      preview={tab.id === previewTabId}
      {...paneMenuProps}
    />
  )
  // The tab list shows only when the strip cannot show every tab.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const node = scrollerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const measure = () => setOverflowing(node.scrollWidth > node.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [tabs.length])
  const viewCount = tabs.filter(isViewTab).length
  // ⌥⇧←/→ moves the focused tab one place; focus stays on it.
  const handleStripKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!moveAndFocus || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const id = (event.target as Element).closest(`[${DOCK_TAB_ATTR}]`)?.getAttribute(DOCK_TAB_ATTR)
    const index = id ? tabs.findIndex((tab) => tab.id === id) : -1
    if (!id || index < 0) return
    event.preventDefault()
    const to = index + (event.key === 'ArrowLeft' ? -1 : 1)
    if (to < 0 || to >= tabs.length) return
    moveAndFocus(id, to)
  }
  return (
    <div ref={stripRef} data-dock-strip="" className={DOCK_TAB_STRIP_CLASS}>
      <div
        ref={scrollerRef}
        className={cn('scrollbar-none flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden py-1 pl-1', DOCK_STRIP_PART_CLASS)}
        onKeyDown={handleStripKeyDown}
        {...drag.handlers}
      >
        {tabs.map((tab, index) => {
          const active = activeTabId === tab.id
          const dragging = drag.draggingId === tab.id
          // Views first, then a hairline, then documents.
          const divider = index === viewCount && viewCount > 0 && index < tabs.length
            ? <span key={`${tab.id}:divider`} aria-hidden="true" data-dock-tab-divider="" className="mx-1 my-1.5 w-px shrink-0 self-stretch bg-(--color-border-subtle)" />
            : null
          if (tab.type === 'terminal') {
            return [divider, (
              <TerminalTabButton
                key={tab.id}
                dockTabId={tab.id}
                className={dragging ? DOCK_TAB_LIFTED_CLASS : undefined}
                buttonRef={(node) => registerTabRef(tab.id, node)}
                meta={terminalMetas.find((m) => m.id === tab.termId) ?? {
                  id: tab.termId, contextKey: workspace, title: tab.title, status: 'connecting', order: 0,
                }}
                active={active}
                mobile={mobile}
                onActivate={() => onActivate(tab.id)}
                onClose={() => onClose(tab.id)}
                extraMenuItems={(dismiss) => sharedMenu(tab, dismiss)}
              />
            )]
          }
          const label = dockTabLabel(tab)
          const preview = tab.id === previewTabId
          // A preview tab says so in its tooltip and, for screen readers, in
          // its description (the tooltip's exists only while it shows); its
          // name stays the file's.
          const previewNote = 'Preview: the next file replaces it; double-click to keep it'
          const pathTooltip = dockTabTooltip(tab)
          const tooltip = preview ? (pathTooltip ? `${pathTooltip} · ${previewNote}` : previewNote) : pathTooltip
          const tabButton = (
            <button
              ref={(node) => registerTabRef(tab.id, node)}
              type="button"
              aria-current={active ? 'true' : undefined}
              aria-label={label === tab.title ? undefined : label}
              aria-description={preview ? previewNote : undefined}
              onClick={() => onActivate(tab.id)}
              // Double-click keeps a preview tab, as in editors.
              onDoubleClick={preview && onKeep ? () => onKeep(tab.id) : undefined}
              onContextMenu={(event) => {
                if (mobile) return
                event.preventDefault()
                setMenu({ id: tab.id, x: event.clientX, y: event.clientY })
              }}
              onKeyDown={(event) => {
                if (mobile || !isMenuKey(event)) return
                event.preventDefault()
                const at = menuPointFor(event.currentTarget)
                setMenu({ id: tab.id, x: at.clientX, y: at.clientY })
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                onClose(tab.id)
              }}
              className={cn(dockTabButtonClass(true), 'flex-1')}
            >
              <TabIcon tab={tab} />
              <span className={cn('truncate', !isViewTab(tab) && 'font-mono', tab.type === 'goal' && 'tabular-nums', preview && 'italic')}>{tab.title}</span>
            </button>
          )
          return [divider, (
            <div key={tab.id} data-dock-tab={tab.id} data-dock-tab-preview={preview || undefined} className={cn(dockTabClass(active), dragging && DOCK_TAB_LIFTED_CLASS)}>
              {tooltip ? (
                <Tooltip className="h-full min-w-0 flex-1">
                  <TooltipTrigger className="h-full min-w-0 flex-1" render={tabButton} />
                  <TooltipContent side="bottom">{tooltip}</TooltipContent>
                </Tooltip>
              ) : tabButton}
              <button
                type="button"
                data-dock-tab-close
                onClick={() => onClose(tab.id)}
                className={dockTabCloseClass(active)}
                aria-label={`Close ${label}`}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          )]
        })}
        <div aria-hidden="true" className="min-w-2 flex-1" />
      </div>
      <div className={cn('flex shrink-0 items-center gap-0.5 px-1', DOCK_STRIP_PART_CLASS)}>
        {overflowing && tabs.length > 1 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setListMenuAt({ x: rect.right - OPEN_MENU_WIDTH, y: rect.bottom + 2 })
                  }}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-0.5 rounded-sm px-1.5 font-mono text-meta tabular-nums text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 pointer-coarse:h-9',
                    listMenuAt !== null && 'bg-(--bg-key) text-(--color-text)',
                  )}
                  aria-label={`All tabs (${tabs.length})`}
                  aria-haspopup="menu"
                  aria-expanded={listMenuAt !== null}
                >
                  {tabs.length}
                  <ChevronDown size={11} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">All tabs</TooltipContent>
          </Tooltip>
        )}
        {openItems.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setOpenMenuAt({ x: rect.right - OPEN_MENU_WIDTH, y: rect.bottom + 2 })
                  }}
                  className={cn(
                    // The + alone, the same square as Refresh.
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7 pointer-coarse:h-9 pointer-coarse:w-9',
                    openMenuAt !== null && 'bg-(--bg-key) text-(--color-text)',
                  )}
                  aria-label="Open in Review panel"
                  aria-haspopup="menu"
                  aria-expanded={openMenuAt !== null}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">Open a view, terminal, preview or file</TooltipContent>
          </Tooltip>
        )}
        {refreshLabel && (
          <ActionButton label={refreshLabel} onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
          </ActionButton>
        )}
        {!mobile && maximized !== null && (
          <ActionButton
            label={`${maximized ? 'Restore' : 'Maximize'} Review panel (${shortcutLabel(APP_SHORTCUTS.maximizeDock, os)})`}
            onClick={onToggleMaximized}
          >
            {maximized
              ? <Minimize2 size={13} aria-hidden="true" />
              : <Maximize2 size={13} aria-hidden="true" />}
          </ActionButton>
        )}
        {onHideTerminals && (
          <ActionButton label={`Hide terminals (${shortcutLabel(APP_SHORTCUTS.toggleTerminal, os)})`} onClick={onHideTerminals}>
            <ChevronDown size={14} aria-hidden="true" />
          </ActionButton>
        )}
        {onClosePane && (
          <ActionButton label={`Close pane (${shortcutLabel(APP_SHORTCUTS.closeTab, os)})`} onClick={onClosePane}>
            <X size={14} aria-hidden="true" />
          </ActionButton>
        )}
      </div>
      {listMenuAt && (
        <ContextMenu at={listMenuAt} label="All tabs" onDismiss={() => setListMenuAt(null)} className="w-56">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitemradio"
              aria-checked={tab.id === activeTabId}
              className={cn(CONTEXT_MENU_ITEM_CLASS, 'pointer-coarse:h-9 pointer-coarse:text-sm')}
              onClick={() => { setListMenuAt(null); onActivate(tab.id) }}
            >
              <TabIcon tab={tab} />
              <span className={cn('min-w-0 flex-1 truncate', !isViewTab(tab) && 'font-mono', tab.id === previewTabId && 'italic')}>{tab.title}</span>
              {tab.id === activeTabId && <Check size={12} className="shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </ContextMenu>
      )}
      {openMenuAt && (
        <ContextMenu at={openMenuAt} label="Open in Review panel" onDismiss={() => setOpenMenuAt(null)} className="w-48">
          {openItems.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 && openItems[index - 1].group !== item.group && <ContextMenuSeparator />}
              <button
                type="button"
                role="menuitem"
                aria-label={item.open ? `${item.label} (open)` : item.label}
                className={cn(CONTEXT_MENU_ITEM_CLASS, 'pointer-coarse:h-9 pointer-coarse:text-sm')}
                onClick={() => { setOpenMenuAt(null); item.run() }}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <kbd aria-hidden="true" className="hidden font-mono text-meta text-(--color-text-subtle) md:inline">{item.shortcut}</kbd>
                )}
                {item.open && <Check size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />}
              </button>
            </Fragment>
          ))}
        </ContextMenu>
      )}
      {menu && menuTab && (
        <ContextMenu at={menu} label={`Actions for ${dockTabLabel(menuTab)}`} onDismiss={() => setMenu(null)} className="min-w-44">
          <DockTabMenuItems
            tab={menuTab}
            tabs={tabs}
            workspace={workspace}
            dismiss={() => setMenu(null)}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
            onCloseToRight={onCloseToRight}
            onMove={moveAndFocus}
            preview={menuTab.id === previewTabId}
            {...paneMenuProps}
          />
        </ContextMenu>
      )}
    </div>
  )
}
