/**
 * DockTabBar — the review dock's editor-tab strip.
 *
 * One row: scrolling tabs on the left, a fixed action cluster on the right:
 * "Open…" (every view and tool, including Terminal and Preview), refresh
 * while a Git or file tab shows, and maximize on desktop.  File search is
 * Find file, ⌘P. Hiding the
 * dock lives on the header's review-dock toggle (and ⌘D), which is always
 * visible because the dock never covers the header.
 *
 * Tabs are plain buttons with ``aria-current`` rather than an ARIA
 * ``tablist`` (each has a sibling close button and a context menu, which
 * tab semantics do not model). ⌘W, middle-click and the tab menu
 * (right-click or Shift+F10) also close tabs.
 *
 * Tabs move by drag (fine pointers, see ``useTabDrag``), ⌥⇧←/→ on a
 * focused tab, or Move Left / Move Right in the tab menu.
 */
import { Fragment, useRef, useState, type ReactNode } from 'react'
import { CalendarClock, Check, Copy, FileDiff, FileText, GitCommitHorizontal, GitCompare, Globe, ListTodo, Maximize2, MessageCircleQuestion, Minimize2, Plus, RefreshCw, Target, X } from 'lucide-react'
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
  DOCK_TAB_LIFTED_CLASS,
  dockTabButtonClass,
  dockTabClass,
  dockTabCloseClass,
} from './dock-tab-styles'
import { type DockTab, dockTabLabel, dockTabTooltip, isViewTab } from './dock-tabs'
import type { DockOpenItem } from './DockLauncher'
import { DOCK_TAB_ATTR, useTabDrag } from './useTabDrag'

/** Width the "+" menu is laid out for, so it opens right-aligned under the button. */
const OPEN_MENU_WIDTH = 192

export interface DockTabBarProps {
  tabs: DockTab[]
  activeTabId: string
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
            className={cn(DOCK_ACTION_BUTTON_CLASS, expanded && 'bg-(--bg-key) text-(--color-text)')}
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
export function DockTabMenuItems({ tab, tabs, workspace, dismiss, onClose, onCloseOthers, onCloseToRight, onMove }: {
  tab: DockTab
  tabs: DockTab[]
  workspace: string
  dismiss: () => void
  onClose?: (id: string) => void
  onCloseOthers?: (id: string) => void
  onCloseToRight?: (id: string) => void
  onMove?: (id: string, toIndex: number) => void
}): ReactNode {
  const index = tabs.findIndex((item) => item.id === tab.id)
  const hasOthers = tabs.length > 1
  const hasRight = index >= 0 && index < tabs.length - 1
  const path = tabPath(tab, workspace)
  const item = (label: string, run: () => void, icon?: ReactNode, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(CONTEXT_MENU_ITEM_CLASS, 'disabled:opacity-50')}
      onClick={() => { dismiss(); run() }}
    >
      {icon ?? <span className="w-3" aria-hidden="true" />}
      {label}
    </button>
  )
  return (
    <>
      {onClose && item('Close', () => onClose(tab.id), <X size={12} aria-hidden="true" />)}
      {onCloseOthers && item('Close other tabs', () => onCloseOthers(tab.id), undefined, !hasOthers)}
      {onCloseToRight && item('Close tabs to the right', () => onCloseToRight(tab.id), undefined, !hasRight)}
      {onMove && item('Move left', () => onMove(tab.id, index - 1), undefined, index <= 0)}
      {onMove && item('Move right', () => onMove(tab.id, index + 1), undefined, !hasRight)}
      {path && item('Copy path', () => { void navigator.clipboard?.writeText(path) }, <Copy size={12} aria-hidden="true" />)}
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
  onRefresh,
  refreshLabel = null,
  openItems = [],
  maximized,
  onToggleMaximized,
}: DockTabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const drag = useTabDrag({ enabled: !mobile && onMove !== undefined, onMove: onMove ?? (() => {}) })
  // A moved tab's node is re-inserted, which drops its focus: put it back
  // when the move came from the keyboard or the tab menu.
  const moveAndFocus = onMove && ((id: string, toIndex: number) => {
    onMove(id, toIndex)
    requestAnimationFrame(() => focusTabButton(stripRef.current, id))
  })
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [openMenuAt, setOpenMenuAt] = useState<{ x: number; y: number } | null>(null)
  const menuTab = menu ? tabs.find((tab) => tab.id === menu.id) : undefined
  const sharedMenu = (tab: DockTab, dismiss: () => void) => (
    <DockTabMenuItems
      tab={tab}
      tabs={tabs}
      workspace={workspace}
      dismiss={dismiss}
      onCloseOthers={onCloseOthers}
      onCloseToRight={onCloseToRight}
      onMove={moveAndFocus}
    />
  )
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
    <div ref={stripRef} className="flex h-(--spacing-tab-bar) min-w-0 shrink-0 bg-(--bg-sidebar)">
      <div
        className="scrollbar-none flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        onKeyDown={handleStripKeyDown}
        {...drag.handlers}
      >
        {tabs.map((tab) => {
          const active = activeTabId === tab.id
          const dragging = drag.draggingId === tab.id
          if (tab.type === 'terminal') {
            return (
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
            )
          }
          const label = dockTabLabel(tab)
          const tooltip = dockTabTooltip(tab)
          const tabButton = (
            <button
              ref={(node) => registerTabRef(tab.id, node)}
              type="button"
              aria-current={active ? 'true' : undefined}
              aria-label={label === tab.title ? undefined : label}
              onClick={() => onActivate(tab.id)}
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
              <span className={cn('truncate', !isViewTab(tab) && 'font-mono', tab.type === 'goal' && 'tabular-nums')}>{tab.title}</span>
            </button>
          )
          return (
            <div key={tab.id} data-dock-tab={tab.id} className={cn(dockTabClass(active), dragging && DOCK_TAB_LIFTED_CLASS)}>
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
          )
        })}
        <div aria-hidden="true" className="min-w-2 flex-1 border-b border-(--color-border)" />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-(--color-border) px-1">
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
                    'flex h-8 shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:px-1.5 pointer-coarse:h-9 pointer-coarse:px-3',
                    openMenuAt !== null && 'bg-(--bg-key) text-(--color-text)',
                  )}
                  aria-label="Open in the review panel"
                  aria-haspopup="menu"
                  aria-expanded={openMenuAt !== null}
                >
                  <Plus size={13} aria-hidden="true" />
                  Open…
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
            label={`${maximized ? 'Restore' : 'Maximize'} review panel (${shortcutLabel(APP_SHORTCUTS.maximizeDock, os)})`}
            onClick={onToggleMaximized}
          >
            {maximized
              ? <Minimize2 size={13} aria-hidden="true" />
              : <Maximize2 size={13} aria-hidden="true" />}
          </ActionButton>
        )}
      </div>
      {openMenuAt && (
        <ContextMenu at={openMenuAt} label="Open in the review panel" onDismiss={() => setOpenMenuAt(null)} className="w-48">
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
                  <kbd aria-hidden="true" className="hidden font-mono text-[11px] text-(--color-text-subtle) md:inline">{item.shortcut}</kbd>
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
          />
        </ContextMenu>
      )}
    </div>
  )
}
