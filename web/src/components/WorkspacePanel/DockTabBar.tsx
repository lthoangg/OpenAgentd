/**
 * DockTabBar — one Review panel pane's editor-tab strip.
 *
 * One row: scrolling tabs on the left, a fixed action cluster on the right:
 * the tab list (when the strip overflows), "+" (every view and tool,
 * including Terminal and Preview), maximize on desktop, and the pane's ⋯
 * menu (Split right / down, and Close pane on an empty pane beside others).
 * One 28px size and one 14px glyph for all of them, as for the tab's own ×.
 * Refresh is not here: it sits in the toolbar of the view it reloads.
 * Views (Git, Plan, Tasks…) come before a hairline and documents after it, as in
 * an editor; the pane's preview tab is set in italics until it is kept.
 * Hiding the dock lives on the header's review-dock toggle (and ⌘D), which
 * is always visible because the dock never covers the header.
 *
 * Tabs are plain buttons with ``aria-current`` rather than an ARIA
 * ``tablist`` (each has a sibling close button and a context menu, which
 * tab semantics do not model). ⌘W, middle-click and the tab menu
 * (right-click or Shift+F10) also close tabs; double-click keeps a preview.
 * Every menu row that has a key shows it (read from ``APP_SHORTCUTS`` and the
 * dock's chords), so a menu and its key cannot drift apart.
 *
 * Tabs move by drag (fine pointers, see ``useTabDrag``): along the strip,
 * onto another pane's strip or middle, or onto a pane's edge to split it.
 * From the keyboard and the tab menu: ⌥⇧←/→, Move Left / Move Right, Split
 * Right / Left / Up / Down, Move to Next Pane. A double-click or
 * right-click on the strip's free end opens the "+" menu there.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarClock, Check, ChevronDown, Columns2, Copy, FileDiff, FileText, GitCommitHorizontal, GitCompare, Globe, ListTodo, Maximize2, MessageCircleQuestion, Minimize2, MoreHorizontal, Plus, Rows2, Target, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import { FileTypeIcon } from '../FileTypeIcon'
import { TerminalTabButton } from '../Terminal/TerminalTabButton'
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, DOCK_TAB_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { formatChord, matchChord } from '@/lib/keyboard/chord'
import { useFlipReorder } from '@/hooks/useFlipReorder'
import { cn } from '@/lib/utils'
import { absoluteWorkspacePath } from '@/utils/workspace'
import type { TerminalSessionMeta } from '@/stores/useTerminalStore'
import {
  DOCK_ACTION_BUTTON_CLASS,
  DOCK_TAB_LIFTED_CLASS,
  DOCK_TAB_STRIP_CLASS,
  dockTabButtonClass,
  dockTabClass,
} from './dock-tab-styles'
import { MOVE_TAB_LEFT_CHORD, MOVE_TAB_RIGHT_CHORD, type DockTab, dockTabLabel, dockTabTooltip, isViewTab } from './dock-tabs'
import type { SplitSide } from './dock-panes'
import type { DockOpenItem } from './DockLauncher'
import { DockTabCloseButton } from './DockTabCloseButton'
import { MenuKeys } from './MenuKeys'
import { DockOpenMenu, OPEN_MENU_WIDTH, menuPointBelow } from './DockOpenMenu'
import { DOCK_TAB_ATTR, useTabDrag } from './useTabDrag'
import type { TabDropTarget } from './useDockTabs'

/** The one glyph size of the strip's action buttons (and, in the tabs, of the ×). */
const STRIP_ICON = 14

/** A new empty pane beside this one: the ⋯ menu's splits, each with its ⌘\ key. */
const PANE_SPLITS = [
  { side: 'right', label: 'Split right', key: 'splitDock', Icon: Columns2 },
  { side: 'down', label: 'Split down', key: 'splitDockDown', Icon: Rows2 },
] as const satisfies readonly { side: PaneSplit; label: string; key: keyof typeof APP_SHORTCUTS; Icon: typeof Columns2 }[]

/** Which way a pane's ⋯ menu splits it: a new empty pane right of it or under it. */
export type PaneSplit = 'right' | 'down'

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
  /** Tab menu: close every other tab / the tabs after or before this one / every tab of the pane. */
  onCloseOthers?: (id: string) => void
  onCloseToRight?: (id: string) => void
  onCloseToLeft?: (id: string) => void
  onCloseAll?: (id: string) => void
  /** Moves a tab to an index of ``tabs``; omitted, tabs stay put. */
  onMove?: (id: string, toIndex: number) => void
  /** Keep a preview tab (double-click, Keep Open). */
  onKeep?: (id: string) => void
  /** Tab menu: Split Right / Left / Up / Down, the tab moving into the new pane. Omitted on phones. */
  onSplit?: (id: string, side: SplitSide) => void
  /** False for a pane's only tab (nothing would be left to split). */
  canSplit?: (id: string) => boolean
  /** Tab menu: Move to Next Pane (shown while another pane is on screen). */
  onMoveToNextPane?: (id: string) => void
  canMoveToNextPane?: (id: string) => boolean
  /** Tab menu on files and diffs: the Changes list with the file's diff open. */
  onRevealInGit?: (path: string) => void
  /** An empty pane beside others: its Close button. */
  onClosePane?: () => void
  /** The pane's ⋯ menu: a new empty pane right of it or under it. Omitted on phones. */
  onSplitPane?: (side: PaneSplit) => void
  /** A tab dragged out of the strip and let go over a pane (see ``useTabDrag``). */
  onDropTab?: (id: string, target: TabDropTarget) => void
  /**
   * The "+" menu's rows (see ``dockOpenItems``); empty hides the button. A
   * phone's Review page keeps "+" in its navigation bar instead (``DockOpenMenu``).
   */
  openItems?: DockOpenItem[]
  /**
   * Spell ⌘1–⌘9 beside the tabs in the "All tabs" list: this pane has focus
   * (the keys pick from its strip) and the app is the desktop one (a browser
   * keeps those keys for its own tabs).
   */
  numberKeys?: boolean
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

function ActionButton({ label, tooltip = label, onClick, children, expanded }: {
  label: string
  /** Hint text when it says more than the accessible name. */
  tooltip?: string
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
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** The tab menu's splits, in order, with the ⌃⌥+arrow key for each. */
const SPLITS = [
  { side: 'right', label: 'Split right', key: 'splitTabRight' },
  { side: 'left', label: 'Split left', key: 'splitTabLeft' },
  { side: 'up', label: 'Split up', key: 'splitTabUp' },
  { side: 'down', label: 'Split down', key: 'splitTabDown' },
] as const satisfies readonly { side: SplitSide; label: string; key: keyof typeof APP_SHORTCUTS }[]

/** The path a file or diff tab shows, absolute, for "Copy Path". */
function tabPath(tab: DockTab, workspace: string): string | null {
  const path = tab.type === 'file' ? tab.file.path : tab.type === 'diff' ? tab.path : null
  if (!path) return null
  return absoluteWorkspacePath(workspace, path)
}

/**
 * The tab-strip items every tab's menu shares (terminal tabs add theirs
 * first), in order and groups: closing, then keeping, splitting and
 * moving, then the path. Close all stands apart from the other closings
 * (it is the one that empties the pane). ``dismiss`` closes the menu before
 * the action runs.
 */
export function DockTabMenuItems({ tab, tabs, workspace, dismiss, onClose, onCloseOthers, onCloseToRight, onCloseToLeft, onCloseAll, onMove, preview = false, onKeep, onSplit, canSplit, onMoveToNextPane, canMoveToNextPane, onRevealInGit, os }: {
  tab: DockTab
  tabs: DockTab[]
  workspace: string
  dismiss: () => void
  onClose?: (id: string) => void
  onCloseOthers?: (id: string) => void
  onCloseToRight?: (id: string) => void
  onCloseToLeft?: (id: string) => void
  onCloseAll?: (id: string) => void
  onMove?: (id: string, toIndex: number) => void
  preview?: boolean
  onKeep?: (id: string) => void
  onSplit?: (id: string, side: SplitSide) => void
  canSplit?: (id: string) => boolean
  onMoveToNextPane?: (id: string) => void
  canMoveToNextPane?: (id: string) => boolean
  onRevealInGit?: (path: string) => void
  /** Spells the keys beside Close (⌘W), the splits (⌃⌥→…) and the moves (⌥⇧←, ⌥⇧→). */
  os: OS
}): ReactNode {
  const index = tabs.findIndex((item) => item.id === tab.id)
  const hasOthers = tabs.length > 1
  const hasRight = index >= 0 && index < tabs.length - 1
  const hasLeft = index > 0
  const path = tabPath(tab, workspace)
  const changedPath = tab.type === 'diff' ? tab.path : tab.type === 'file' ? tab.file.path : null
  const item = (label: string, run: () => void, icon?: ReactNode, disabled = false, shortcut?: string) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(CONTEXT_MENU_ITEM_CLASS, 'disabled:opacity-50')}
      onClick={() => { dismiss(); run() }}
    >
      {icon ?? <span className="w-3" aria-hidden="true" />}
      <span className="flex-1">{label}</span>
      {shortcut && <MenuKeys>{shortcut}</MenuKeys>}
    </button>
  )
  const splitDisabled = !(canSplit?.(tab.id) ?? true)
  const groups: ReactNode[][] = [
    [
      onClose && item('Close', () => onClose(tab.id), <X size={12} aria-hidden="true" />, false, shortcutLabel(APP_SHORTCUTS.closeTab, os)),
      onCloseOthers && item('Close others', () => onCloseOthers(tab.id), undefined, !hasOthers),
      onCloseToLeft && item('Close to the left', () => onCloseToLeft(tab.id), undefined, !hasLeft),
      onCloseToRight && item('Close to the right', () => onCloseToRight(tab.id), undefined, !hasRight),
    ],
    [
      onCloseAll && item('Close all', () => onCloseAll(tab.id)),
    ],
    [
      preview && onKeep && item('Keep open', () => onKeep(tab.id)),
      ...(onSplit
        ? SPLITS.map(({ side, label, key }) =>
            item(label, () => onSplit(tab.id, side), undefined, splitDisabled, shortcutLabel(APP_SHORTCUTS[key], os)))
        : []),
      onMoveToNextPane && (canMoveToNextPane?.(tab.id) ?? true) && item('Move to next pane', () => onMoveToNextPane(tab.id)),
      onMove && item('Move left', () => onMove(tab.id, index - 1), undefined, index <= 0, formatChord(MOVE_TAB_LEFT_CHORD, os)),
      onMove && item('Move right', () => onMove(tab.id, index + 1), undefined, !hasRight, formatChord(MOVE_TAB_RIGHT_CHORD, os)),
    ],
    [
      path && item('Copy path', () => { void navigator.clipboard?.writeText(path) }, <Copy size={12} aria-hidden="true" />),
      changedPath && onRevealInGit && item('Reveal in Git', () => onRevealInGit(changedPath)),
    ],
  ].map((group) => group.filter(Boolean)).filter((group) => group.length > 0)
  return (
    <>
      {groups.map((group, at) => (
        <Fragment key={at}>
          {at > 0 && <ContextMenuSeparator />}
          {group}
        </Fragment>
      ))}
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
  onCloseToLeft,
  onCloseAll,
  onMove,
  onKeep,
  onSplit,
  canSplit,
  onMoveToNextPane,
  canMoveToNextPane,
  onRevealInGit,
  onClosePane,
  onSplitPane,
  onDropTab,
  openItems = [],
  numberKeys = false,
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
  const [paneMenuAt, setPaneMenuAt] = useState<{ x: number; y: number } | null>(null)
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
      onCloseToLeft={onCloseToLeft}
      onCloseAll={onCloseAll}
      onMove={moveAndFocus}
      preview={tab.id === previewTabId}
      {...paneMenuProps}
    />
  )
  // The tab list shows only when the strip cannot show every tab.
  const scrollerRef = useRef<HTMLDivElement>(null)
  // A closed tab's right-hand neighbours slide left into the gap and a new
  // tab rises in. A tab being dragged (or just dropped inside the strip) has
  // already moved the others, see ``useTabDrag``.
  useFlipReorder(scrollerRef, {
    axis: 'x',
    attr: DOCK_TAB_ATTR,
    enter: 'rise',
    skip: () => drag.draggingId !== null || drag.reorderedByDrag(),
  })
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
    if (!moveAndFocus) return
    const direction = matchChord(event.nativeEvent, MOVE_TAB_LEFT_CHORD, os) ? -1 : matchChord(event.nativeEvent, MOVE_TAB_RIGHT_CHORD, os) ? 1 : 0
    if (direction === 0) return
    const id = (event.target as Element).closest(`[${DOCK_TAB_ATTR}]`)?.getAttribute(DOCK_TAB_ATTR)
    const index = id ? tabs.findIndex((tab) => tab.id === id) : -1
    if (!id || index < 0) return
    event.preventDefault()
    const to = index + direction
    if (to < 0 || to >= tabs.length) return
    moveAndFocus(id, to)
  }
  // ⌘1–⌘8 pick the tab at that position, ⌘9 the last one (see ``useDockTabs``).
  const tabNumberKey = (index: number): string | undefined => {
    if (!numberKeys) return undefined
    const slot = index < DOCK_TAB_SHORTCUTS.length - 1 ? index : index === tabs.length - 1 ? DOCK_TAB_SHORTCUTS.length - 1 : -1
    return slot < 0 ? undefined : shortcutLabel(APP_SHORTCUTS[DOCK_TAB_SHORTCUTS[slot]], os)
  }
  const hasPaneMenu = !mobile && (onSplitPane !== undefined || onClosePane !== undefined)
  return (
    <div ref={stripRef} data-dock-strip="" className={DOCK_TAB_STRIP_CLASS}>
      <div
        ref={scrollerRef}
        className="scrollbar-none flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden py-1 pl-1"
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
                os={os}
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
              <DockTabCloseButton title={label} active={active} os={os} onClick={() => onClose(tab.id)} />
            </div>
          )]
        })}
        {/* The strip's free end: a double-click or right-click opens the
            "+" menu where the pointer is. */}
        <div
          aria-hidden="true"
          data-dock-strip-gap=""
          className="min-w-2 flex-1"
          onDoubleClick={mobile || openItems.length === 0 ? undefined : (event) => setOpenMenuAt({ x: event.clientX, y: event.clientY })}
          onContextMenu={mobile || openItems.length === 0 ? undefined : (event) => {
            event.preventDefault()
            setOpenMenuAt({ x: event.clientX, y: event.clientY })
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
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
                  <ChevronDown size={STRIP_ICON} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">All tabs</TooltipContent>
          </Tooltip>
        )}
        {openItems.length > 0 && (
          <ActionButton
            label="Open in Review panel"
            tooltip="Open a view, terminal, preview or file"
            expanded={openMenuAt !== null}
            onClick={(event) => setOpenMenuAt(menuPointBelow(event.currentTarget))}
          >
            <Plus size={STRIP_ICON} aria-hidden="true" />
          </ActionButton>
        )}
        {!mobile && maximized !== null && (
          <ActionButton
            label={`${maximized ? 'Restore' : 'Maximize'} Review panel (${shortcutLabel(APP_SHORTCUTS.maximizeDock, os)})`}
            onClick={onToggleMaximized}
          >
            {maximized
              ? <Minimize2 size={STRIP_ICON} aria-hidden="true" />
              : <Maximize2 size={STRIP_ICON} aria-hidden="true" />}
          </ActionButton>
        )}
        {/* Last, as in every toolbar: the pane's own actions. */}
        {hasPaneMenu && (
          <ActionButton
            label="Pane actions"
            expanded={paneMenuAt !== null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setPaneMenuAt({ x: rect.right - OPEN_MENU_WIDTH, y: rect.bottom + 2 })
            }}
          >
            <MoreHorizontal size={STRIP_ICON} aria-hidden="true" />
          </ActionButton>
        )}
      </div>
      {listMenuAt && (
        <ContextMenu at={listMenuAt} label="All tabs" onDismiss={() => setListMenuAt(null)} className="w-56">
          {tabs.map((tab, index) => {
            const keys = tabNumberKey(index)
            return (
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
                {keys && <MenuKeys>{keys}</MenuKeys>}
                {tab.id === activeTabId && <Check size={12} className="shrink-0" aria-hidden="true" />}
              </button>
            )
          })}
        </ContextMenu>
      )}
      {openMenuAt && (
        <DockOpenMenu at={openMenuAt} items={openItems} onDismiss={() => setOpenMenuAt(null)} />
      )}
      {paneMenuAt && (
        <ContextMenu at={paneMenuAt} label="Pane actions" onDismiss={() => setPaneMenuAt(null)} className="w-48">
          {onSplitPane && PANE_SPLITS.map(({ side, label, key, Icon }) => (
            <button
              key={side}
              type="button"
              role="menuitem"
              className={cn(CONTEXT_MENU_ITEM_CLASS, 'pointer-coarse:h-9 pointer-coarse:text-sm')}
              onClick={() => { setPaneMenuAt(null); onSplitPane(side) }}
            >
              <Icon size={STRIP_ICON} aria-hidden="true" />
              <span className="flex-1">{label}</span>
              <MenuKeys>{shortcutLabel(APP_SHORTCUTS[key], os)}</MenuKeys>
            </button>
          ))}
          {onSplitPane && onClosePane && <ContextMenuSeparator />}
          {onClosePane && (
            <button
              type="button"
              role="menuitem"
              className={cn(CONTEXT_MENU_ITEM_CLASS, 'pointer-coarse:h-9 pointer-coarse:text-sm')}
              onClick={() => { setPaneMenuAt(null); onClosePane() }}
            >
              <X size={STRIP_ICON} aria-hidden="true" />
              <span className="flex-1">Close pane</span>
              <MenuKeys>{shortcutLabel(APP_SHORTCUTS.closeTab, os)}</MenuKeys>
            </button>
          )}
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
            onCloseToLeft={onCloseToLeft}
            onCloseAll={onCloseAll}
            onMove={moveAndFocus}
            preview={menuTab.id === previewTabId}
            {...paneMenuProps}
          />
        </ContextMenu>
      )}
    </div>
  )
}
