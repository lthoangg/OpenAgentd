/**
 * The phone's Sessions screen around the session list (``Sidebar`` with
 * ``page``): a 44px top bar, a large title with a search field that scroll
 * with the list, and a bottom toolbar. The list itself (Pinned, Needs you,
 * the workspaces) is the sidebar's own. It is the middle level of the
 * phone's stack: ‹ Servers goes down to the Servers screen.
 */
import { useEffect, useRef, useState, type Ref } from 'react'
import { Activity, Clock, Search, Settings, SquarePen, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HealthDot } from '@/components/HealthDot'
import { PhoneBackButton } from '@/components/phone/PhoneNavBar'
import { NEXT_THEME, THEME_OPTIONS } from '@/components/theme-options'
import { usePressSlide } from '@/hooks/use-press-slide'
import { useThemePreference } from '@/hooks/useThemePreference'
import { apiBaseUrl } from '@/api/base-url'
import { formatBackendConnectionLabel } from '@/lib/app-backend'
import { mediumHapticFeedback, selectionHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'

/**
 * The top bar: ‹ Servers on the left (the server chip when there is no
 * Servers screen to go back to; ✎ New session is the toolbar's), and a small
 * centred title that fades in once the large one has scrolled away
 * (``data-title-visible``, written by ``useLargeTitleCollapse``). The title
 * has its own column, like ``PhoneNavBar``'s, so a long label truncates
 * instead of running under it.
 */
export function SessionsPageBar({
  barRef,
  onOpenServers,
}: {
  barRef: Ref<HTMLElement>
  onOpenServers?: () => void
}) {
  return (
    <header
      ref={barRef}
      data-sessions-page-bar=""
      className={cn(
        'group/bar mobile-safe-header grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-transparent pr-2 transition-colors duration-(--motion-fast) data-title-visible:border-(--color-border)',
        onOpenServers ? 'pl-2' : 'pl-3',
      )}
    >
      <div className="flex min-w-0 justify-start">
        {onOpenServers ? <PhoneBackButton label="Servers" onBack={onOpenServers} /> : <HealthDot labeled chip />}
      </div>
      {/* The large title is the heading; this one only echoes it. */}
      <span
        aria-hidden="true"
        className="text-base font-semibold text-(--color-text) opacity-0 transition-opacity duration-(--motion-fast) group-data-title-visible/bar:opacity-100"
      >
        Sessions
      </span>
      <div aria-hidden="true" />
    </header>
  )
}

/**
 * The server the list belongs to, under the large title: its dot (green
 * connected, red not reachable, grey connecting) and name. With ‹ Servers
 * in the bar instead of the server chip, this keeps the server in sight; a
 * tap goes down to Servers too.
 */
function SessionsServerLine({ onOpenServers }: { onOpenServers: () => void }) {
  const health = useHealthQuery()
  const backendStatus = useBackendStatusQuery()
  const label = formatBackendConnectionLabel(backendStatus.data ?? null, apiBaseUrl())
  // In a browser there is no app shell to report a status, and the Servers
  // screen calls the page's own server "This server"; say the same here.
  const inBrowser = backendStatus.isSuccess && backendStatus.data === null
  const name = inBrowser && label === 'built-in' ? 'This server' : label === 'built-in' ? 'Built-in server' : label
  const state = health.isSuccess ? 'connected' : health.isError ? 'not reachable' : 'connecting…'
  return (
    <button
      type="button"
      onClick={onOpenServers}
      data-sessions-server=""
      aria-label={`${name}, ${state}. Show servers`}
      className="relative touch-hit -mt-0.5 mb-2 flex max-w-full items-center gap-1.5 rounded-sm text-left text-subhead text-(--color-text-muted) transition-opacity active:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          health.isSuccess ? 'bg-(--accent-green-text)' : health.isError ? 'bg-(--color-error)' : 'bg-(--color-text-muted)',
        )}
      />
      <span className="min-w-0 truncate text-(--color-text-2)">{name}</span>
      <span className="shrink-0">· {state}</span>
    </button>
  )
}

/**
 * The large title, the server it lists, and the search field under them, at
 * the top of the scroller. The field only looks like one: a tap opens
 * ``SessionSearch``, which has the real input. It is a plain button, not
 * ``Button``: a search field is 36px (iOS's), under the phone's button floor.
 */
export function SessionsPageHeader({
  titleRef,
  searchRef,
  onSearch,
  onOpenServers,
}: {
  titleRef: Ref<HTMLHeadingElement>
  searchRef: Ref<HTMLButtonElement>
  onSearch: () => void
  onOpenServers?: () => void
}) {
  return (
    <div data-sessions-page-header="" className="px-3 pb-2">
      <h1 ref={titleRef} className="pb-1 pt-0.5 text-large-title font-bold text-(--color-text)">
        Sessions
      </h1>
      {onOpenServers && <SessionsServerLine onOpenServers={onOpenServers} />}
      <button
        ref={searchRef}
        type="button"
        onClick={onSearch}
        className="flex h-9 w-full items-center gap-1.5 rounded-md bg-(--bg-key) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-fill-key-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        <Search size={16} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">Search</span>
      </button>
    </div>
  )
}

interface ToolbarItem {
  label: string
  icon: LucideIcon
  onClick: () => void
  /** The accessible name when it says more than the label. */
  ariaLabel?: string
}

/** A row of ✎'s hold menu: a workspace to start a new session in. */
export interface NewSessionChoice {
  path: string
  label: string
  /** The workspace a tap on ✎ starts in. */
  current?: boolean
}

const WORKSPACE_PREFIX = 'ws:'

/**
 * The bottom toolbar, floating over the end of the list as iOS 26's does:
 * a pill of icon buttons on the left (Settings, Scheduled, Usage, and the
 * theme, which shows the current choice and moves to the next on a tap:
 * System → Light → Dark) and the round ✎ New session on the right, under the
 * thumb. They are actions, not tabs, so there are no captions; each button
 * is named for assistive tech. The command palette has no button: it is a
 * keyboard surface, and ⌘K still opens it from a hardware keyboard.
 *
 * Both take iOS's press-and-slide (``usePressSlide``): a finger on the pill
 * can slide across it, the highlight and a bubble naming the button follow,
 * and lifting runs the one under it. Holding ✎ opens the workspaces above
 * it and turns ✎ into ✕: slide to one and lift to start there; lift on ✕ or
 * outside to cancel. A hold lifted where it began keeps the menu open for a
 * tap, as iOS's long-press menus do. Taps, a mouse and a keyboard work as
 * plain buttons.
 */
export function SessionsPageToolbar({
  onNewSession,
  onNewSessionIn,
  newSessionChoices = [],
  onOpenSettings,
  onOpenScheduler,
  onOpenUsage,
}: {
  onNewSession: () => void
  /** Start a new session in a workspace picked from ✎'s hold menu. */
  onNewSessionIn?: (path: string) => void
  newSessionChoices?: readonly NewSessionChoice[]
  onOpenSettings: () => void
  onOpenScheduler: () => void
  onOpenUsage: () => void
}) {
  const { preference, setPreference } = useThemePreference()
  const theme = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0]
  const nextTheme = THEME_OPTIONS.find((option) => option.value === NEXT_THEME[preference])?.label
  const items: ToolbarItem[] = [
    { label: 'Settings', icon: Settings, onClick: onOpenSettings },
    { label: 'Scheduled', icon: Clock, onClick: onOpenScheduler },
    { label: 'Usage', icon: Activity, onClick: onOpenUsage },
    {
      label: `Theme: ${theme.label}`,
      icon: theme.Icon,
      onClick: () => setPreference(NEXT_THEME[preference]),
      ariaLabel: `Theme: ${theme.label}. Tap for ${nextTheme}.`,
    },
  ]

  // The pill: the first target under the finger gets no tick, each move does.
  const pillTicking = useRef(false)
  const pill = usePressSlide({
    onChange: (id) => {
      if (id && pillTicking.current) selectionHapticFeedback()
      pillTicking.current = true
    },
    onRelease: (id) => {
      pillTicking.current = false
      items.find((item) => item.label === id)?.onClick()
    },
    onCancel: () => { pillTicking.current = false },
  })

  // ✎ and its hold menu. A ref mirrors the state for the gesture's callbacks,
  // which run before React has re-rendered with the menu open.
  const [menuOpen, setMenuOpenState] = useState(false)
  const menuOpenRef = useRef(false)
  const setMenuOpen = (open: boolean) => {
    menuOpenRef.current = open
    setMenuOpenState(open)
  }
  const canPickWorkspace = Boolean(onNewSessionIn) && newSessionChoices.length > 0
  const pickWorkspace = (path: string) => {
    setMenuOpen(false)
    onNewSessionIn?.(path)
  }
  const newSlide = usePressSlide({
    canHold: (id) => id === 'new' && canPickWorkspace && !menuOpenRef.current,
    onHold: () => {
      mediumHapticFeedback()
      setMenuOpen(true)
    },
    onChange: (id) => {
      if (menuOpenRef.current && id?.startsWith(WORKSPACE_PREFIX)) selectionHapticFeedback()
    },
    onRelease: (id, { moved, held }) => {
      if (!menuOpenRef.current) {
        if (id === 'new') onNewSession()
        return
      }
      if (id?.startsWith(WORKSPACE_PREFIX)) pickWorkspace(id.slice(WORKSPACE_PREFIX.length))
      // A hold lifted where it began leaves the menu up for a tap.
      else if (!(held && !moved)) setMenuOpen(false)
    },
    onCancel: () => setMenuOpen(false),
  })
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div
      data-sessions-page-toolbar=""
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 bg-gradient-to-t from-(--bg-page) from-40% to-transparent px-4 pt-8 pb-safe"
    >
      {menuOpen && (
        // Behind the menu: a tap outside it cancels.
        <div
          aria-hidden="true"
          data-sessions-new-scrim=""
          onClick={() => setMenuOpen(false)}
          className="pointer-events-auto fixed inset-0 bg-(--color-overlay) opacity-30"
        />
      )}
      <div
        role="toolbar"
        aria-label="Sessions"
        {...pill.handlers}
        className={cn(
          'relative flex touch-none select-none items-center gap-0.5 rounded-full border border-(--color-border) bg-(--bg-card)/90 p-1 shadow-(--shadow-depth) backdrop-blur-md transition-opacity duration-(--motion-fast) [-webkit-touch-callout:none]',
          menuOpen ? 'pointer-events-none opacity-50' : 'pointer-events-auto',
        )}
      >
        {items.map(({ label, icon: Icon, onClick, ariaLabel }) => {
          const active = pill.active === label
          return (
            <span key={label} className="relative flex">
              {active && (
                // The icons have no captions: name the one under the finger.
                <span
                  aria-hidden="true"
                  data-sessions-toolbar-bubble=""
                  className="pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-(--color-accent) px-2.5 py-1 text-xs font-semibold text-(--color-text-on-accent) shadow-(--shadow-depth)"
                >
                  {label}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClick}
                aria-label={ariaLabel ?? label}
                title={label}
                data-sessions-toolbar-item=""
                data-slide-id={label}
                data-active={active ? '' : undefined}
                className="rounded-full! text-(--color-text-2) transition-transform duration-(--motion-fast) data-active:scale-105 data-active:bg-(--color-fill-key-hover) data-active:text-(--color-text)"
              >
                <Icon className="size-5" aria-hidden="true" />
              </Button>
            </span>
          )
        })}
      </div>
      <div
        {...newSlide.handlers}
        data-sessions-new-area=""
        className="pointer-events-auto relative touch-none select-none [-webkit-touch-callout:none]"
      >
        {menuOpen && (
          <div
            role="menu"
            aria-label="New session in"
            data-sessions-new-menu=""
            className="oa-menu-bloom absolute bottom-full right-0 mb-3 w-60 origin-bottom-right rounded-2xl border border-(--color-border) bg-(--bg-card) p-1.5 shadow-(--shadow-depth)"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-xs text-(--color-text-muted)">New session in…</p>
            {newSessionChoices.map((choice) => {
              const id = `${WORKSPACE_PREFIX}${choice.path}`
              return (
                <button
                  key={choice.path}
                  type="button"
                  role="menuitem"
                  data-slide-id={id}
                  data-active={newSlide.active === id ? '' : undefined}
                  onClick={() => pickWorkspace(choice.path)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-(--color-text) data-active:bg-(--color-fill-key-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
                >
                  <span className="min-w-0 truncate">{choice.label}</span>
                  {choice.current && <span className="ml-auto shrink-0 text-xs text-(--color-text-muted)">current</span>}
                </button>
              )
            })}
          </div>
        )}
        <Button
          type="button"
          variant={menuOpen ? 'default' : 'primary'}
          size="icon"
          onClick={menuOpen ? () => setMenuOpen(false) : onNewSession}
          aria-label={menuOpen ? 'Cancel' : 'New session'}
          aria-haspopup={canPickWorkspace ? 'menu' : undefined}
          aria-expanded={canPickWorkspace ? menuOpen : undefined}
          data-sessions-new=""
          data-slide-id="new"
          data-active={menuOpen && newSlide.active === 'new' ? '' : undefined}
          // A finger on ✎ presses it in, as an iOS button gives; the hold
          // that opens the menu lets it spring back (the snappy spring
          // overshoots a little) while ✕ springs into its place.
          data-pressed={!menuOpen && newSlide.active === 'new' ? '' : undefined}
          // Round and 52px, as the mockup: ``!`` beats the icon size's square 36px.
          className="size-13! min-h-13! min-w-13! rounded-full! shadow-(--shadow-depth) transition-[scale,background-color,color] duration-(--motion-base) ease-(--ease-spring-snappy) data-active:scale-105 data-pressed:scale-[0.88] data-pressed:duration-(--motion-fast) data-pressed:ease-(--ease-out)"
        >
          {menuOpen ? <X key="x" className="oa-icon-in size-5" aria-hidden="true" /> : <SquarePen key="new" className="size-5" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  )
}
