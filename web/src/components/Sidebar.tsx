import { useState, useEffect, useCallback, useRef, useMemo, memo, type TouchEvent } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { motion, AnimatePresence } from 'framer-motion'
import { useIsMobile } from '@/hooks/use-mobile'
import { useReducedMotion } from '@/hooks/useReducedMotion'

import {
  Home,
  Plus,
  Trash2,
  RefreshCw,
  Search,
  Settings,
  HelpCircle,
  Loader2,
  Pencil,
} from 'lucide-react'
import { isToday, isYesterday } from 'date-fns'
import { useTeamSessionsQuery, useDeleteTeamSessionMutation, useUpdateTeamSessionTitleMutation } from '@/queries'
import { formatRelativeDate } from '@/utils/format'
import { ThemeToggle } from './ThemeToggle'
import { Skeleton } from './ui/skeleton'
import { HealthDot } from './HealthDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { SidebarItem } from '@/components/ui/sidebar-item'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LongPressButton } from '@/components/ui/long-press-button'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import type { SessionResponse } from '@/api/types'
import { useToastStore } from '@/stores/useToastStore'
import { DURATIONS_S, EASINGS } from '@/lib/motion'

interface DateGroup {
  label: string
  sessions: SessionResponse[]
}

function SessionListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-1 px-1 py-2" aria-label="Loading sessions">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-md px-2.5 py-2">
          <Skeleton className="h-3 w-[min(11rem,70%)] bg-(--bg-key)" />
          <Skeleton className="mt-2 h-2.5 w-20 bg-(--bg-key)" />
        </div>
      ))}
    </div>
  )
}

function isModifiedPrimaryClick(event: React.MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

function groupByDate(sessions: SessionResponse[]): DateGroup[] {
  const today: SessionResponse[] = []
  const yesterday: SessionResponse[] = []
  const older: SessionResponse[] = []

  for (const s of sessions) {
    const date = s.created_at ? new Date(s.created_at) : null
    if (!date) { older.push(s); continue }
    if (isToday(date)) today.push(s)
    else if (isYesterday(date)) yesterday.push(s)
    else older.push(s)
  }

  const groups: DateGroup[] = []
  if (today.length) groups.push({ label: 'Today', sessions: today })
  if (yesterday.length) groups.push({ label: 'Yesterday', sessions: yesterday })
  if (older.length) groups.push({ label: 'Older', sessions: older })
  return groups
}

const COLLAPSE_KEY = 'oa-sidebar-collapsed'

async function openSessionInNewWindow(sessionId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_new_window', { initialPath: `/cockpit/${sessionId}`, initial_path: `/cockpit/${sessionId}` })
}

interface SidebarProps {
  currentSessionId?: string
  onCommandPalette?: () => void
  onNewChat?: () => void
  /** Mobile only: whether the overlay drawer is open */
  mobileOpen?: boolean
  /**
   * Mobile only: live drag offset (px) applied to the drawer's x while an
   * edge-swipe is in progress. ``null`` hands control back to the spring
   * animation. Lets the drawer track the finger instead of snapping.
   */
  mobileDragOffset?: number | null
  /** Mobile only: called when the drawer should close (backdrop tap, session select) */
  onMobileClose?: () => void
}

export function Sidebar({
  currentSessionId,
  onCommandPalette,
  onNewChat,
  mobileOpen = false,
  mobileDragOffset = null,
  onMobileClose,
}: SidebarProps) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const pushToast = useToastStore((s) => s.push)
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const mobileLongPressActions = isMobile && isTauriMobile && mobileOpen
  const prefersReducedMotion = useReducedMotion()
  const navigate = useNavigate()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const sessions = useTeamSessionsQuery('normal')
  const deleteSession = useDeleteTeamSessionMutation()
  const updateSessionTitle = useUpdateTeamSessionTitleMutation()
  const sessionListRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const editTitleInputRef = useRef<HTMLInputElement>(null)

  // The query is already mode-filtered server-side.
  const normalSessions = useMemo(
    () => sessions.data?.pages.flatMap((p) => p.data) ?? [],
    [sessions.data],
  )
  const dateGroups = useMemo(() => groupByDate(normalSessions), [normalSessions])

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)
  const [editTarget, setEditTarget] = useState<SessionResponse | null>(null)
  const [mobileSessionActions, setMobileSessionActions] = useState<SessionResponse | null>(null)
  const [desktopSessionActions, setDesktopSessionActions] = useState<{ session: SessionResponse; x: number; y: number } | null>(null)
  const editTitleForm = useForm({
    defaultValues: { title: '' },
    onSubmit: ({ value }) => {
      if (!editTarget) return
      const title = value.title.trim()
      if (!title) return
      updateSessionTitle.mutate(
        { id: editTarget.id, title },
        { onSuccess: () => setEditTarget(null) },
      )
    },
  })
  const [pullDistance, setPullDistance] = useState(0)
  const pullStartYRef = useRef<number | null>(null)
  const pullStartXRef = useRef<number | null>(null)
  const pullAxisRef = useRef<'vertical' | 'horizontal' | null>(null)

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_KEY, String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const refetchSessions = sessions.refetch
  const canPullRefresh = isMobile && mobileOpen

  const handleSessionListTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!canPullRefresh || sessionListRef.current?.scrollTop !== 0) return
    pullStartYRef.current = event.touches[0]?.clientY ?? null
    pullStartXRef.current = event.touches[0]?.clientX ?? null
    pullAxisRef.current = null
  }, [canPullRefresh])

  const handleSessionListTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!canPullRefresh || pullStartYRef.current === null || pullStartXRef.current === null) return
    const deltaY = (event.touches[0]?.clientY ?? 0) - pullStartYRef.current
    const deltaX = (event.touches[0]?.clientX ?? 0) - pullStartXRef.current

    // Shared axis-lock convention (mirrors useEdgeSwipe): commit to an
    // axis on the first significant move. A horizontal-dominant gesture
    // belongs to the drawer-close swipe, not pull-to-refresh — bail so the
    // two never fire together on a diagonal drag.
    if (pullAxisRef.current === null && (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6)) {
      pullAxisRef.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
    }
    if (pullAxisRef.current === 'horizontal') {
      setPullDistance(0)
      return
    }
    if (deltaY <= 0) {
      setPullDistance(0)
      return
    }
    setPullDistance(Math.min(72, deltaY * 0.5))
  }, [canPullRefresh])

  const handleSessionListTouchEnd = useCallback(() => {
    if (canPullRefresh && pullAxisRef.current !== 'horizontal' && pullDistance >= 54) {
      void refetchSessions()
    }
    pullStartYRef.current = null
    pullStartXRef.current = null
    pullAxisRef.current = null
    setPullDistance(0)
  }, [canPullRefresh, pullDistance, refetchSessions])

  // ⌘B / Ctrl+B: collapse sidebar. Refresh-sessions no longer has a
  // shortcut (low-frequency; the header button + auto-refetch cover it).
  // Ctrl+S (scheduler) lives in TeamChatView — that panel
  // moved out of the sidebar per the topbar-redesign wireframe and their
  // open-state is owned by useUIStore.
  useHotkey(
    'Mod+B',
    () => toggleCollapse(),
    {
      target: document,
      platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
      preventDefault: true,
      stopPropagation: false,
      ignoreInputs: false,
      meta: { name: 'Sidebar', description: 'Toggle sidebar' },
    },
  )

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions

  useEffect(() => {
    if (editTarget) editTitleInputRef.current?.focus()
  }, [editTarget])

  // Intersection observer — load next page when sentinel scrolls into view.
  // Keep refs so the callback always reads the latest values without
  // disconnecting/reconnecting the observer on every page fetch.
  const hasNextPageRef = useRef(hasNextPage)
  const isFetchingNextPageRef = useRef(isFetchingNextPage)
  const fetchNextPageRef = useRef(fetchNextPage)
  useEffect(() => { hasNextPageRef.current = hasNextPage }, [hasNextPage])
  useEffect(() => { isFetchingNextPageRef.current = isFetchingNextPage }, [isFetchingNextPage])
  useEffect(() => { fetchNextPageRef.current = fetchNextPage }, [fetchNextPage])

  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPageRef.current && !isFetchingNextPageRef.current) {
          fetchNextPageRef.current()
        }
      },
      { root: sessionListRef.current, threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const handleDelete = useCallback((e: React.MouseEvent, session: SessionResponse) => {
    e.stopPropagation()
    setDeleteTarget(session)
  }, [])

  const handleEdit = useCallback((session: SessionResponse) => {
    editTitleForm.reset()
    editTitleForm.setFieldValue('title', session.title || '')
    setEditTarget(session)
  }, [editTitleForm])

  const confirmDelete = () => {
    if (!deleteTarget) return
    const fallbackSession = deleteTarget.id === currentSessionId
      ? normalSessions.find((session) => session.id !== deleteTarget.id)
      : null
    deleteSession.mutate(deleteTarget.id)
    if (deleteTarget.id === currentSessionId) {
      if (fallbackSession) {
        navigate({
          to: '/cockpit/$sessionId',
          params: { sessionId: fallbackSession.id },
          replace: true,
        })
      } else {
        navigate({ to: '/cockpit', replace: true })
      }
    }
    setDeleteTarget(null)
  }

  const handleSelect = (id: string, event?: React.MouseEvent) => {
    if (event && isTauri && (os === 'macos' ? event.metaKey : (event.ctrlKey || event.metaKey))) {
      event.preventDefault()
      event.stopPropagation()
      openSessionInNewWindow(id).catch((err) => {
        console.error('Failed to open session in new window:', err)
        pushToast({
          tone: 'error',
          title: 'Could not open session in new window',
          description: err instanceof Error ? err.message : 'Desktop window creation failed.',
        })
      })
      return
    }

    navigate({ to: '/cockpit/$sessionId', params: { sessionId: id } })
    onMobileClose?.()
  }

  const handleNewChat = () => {
    if (onNewChat) {
      onNewChat()
    } else {
      navigate({ to: '/cockpit' })
    }
    onMobileClose?.()
  }

  const rightPanelWidth = typeof document !== 'undefined'
    ? (document.querySelector('aside.border-l')?.getBoundingClientRect().width ?? 0)
    : 0

  const resizable = useResizableWidth({
    storageKey: 'oa.sidebar.width',
    defaultWidth: 256,
    minWidth: 220,
    maxWidth: Math.min(
      420,
      Math.max(
        220,
        Math.floor((typeof window === 'undefined' ? 420 : window.innerWidth) - rightPanelWidth - 380)
      )
    ),
    edge: 'right',
    disabled: isMobile || collapsed,
  })

  // On mobile the sidebar is a fixed overlay drawer: it slides in/out via
  // x transform and always stays 272px wide. The desktop version animates
  // its inline width between 56px (icon-only) and the user-resized width.
  const desktopWidth = collapsed ? 56 : resizable.width

  return (
    <>
      {/* Mobile backdrop — closes the drawer on tap. During an edge-drag
          it fades in proportionally so the dimming tracks the finger. */}
      <AnimatePresence>
        {isMobile && (mobileOpen || mobileDragOffset !== null) && (
          <motion.div
            key="sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: mobileDragOffset !== null ? Math.max(0, Math.min(1, 1 + mobileDragOffset / 280)) : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: mobileDragOffset !== null ? 0 : (prefersReducedMotion ? 0.01 : 0.2) }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={onMobileClose}
          />
        )}
      </AnimatePresence>

    <motion.aside
      animate={
        isMobile
          ? { x: mobileDragOffset ?? (mobileOpen ? 0 : -280), width: 'min(272px, calc(100vw - 2rem))' }
          : { width: desktopWidth }
      }
      transition={
        // While the finger drives the drawer, snap to the offset with no
        // tween so motion tracks 1:1. Otherwise use the open/close spring.
        mobileDragOffset !== null
          ? { duration: 0 }
          : { duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: EASINGS.inOut }
      }
      className={
        isMobile
          ? 'mobile-safe-top fixed bottom-0 left-0 z-40 flex w-[min(272px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page) shadow-xl'
          : 'relative flex shrink-0 flex-col overflow-hidden border-r border-(--color-border) bg-(--bg-page)'
      }
      style={isMobile ? undefined : { minWidth: desktopWidth }}
    >
      {!isMobile && !collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize · double-click to reset"
          className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
          onPointerDown={resizable.startResize}
          onDoubleClick={resizable.resetWidth}
        />
      )}

      {/* showIconOnly: desktop collapsed icon-only mode.
          On mobile the drawer is always fully expanded.

          No brand block — Home lives in the topbar, sidebar toggle is
          owned by the topbar hamburger + ⌘B/Ctrl+B (see wireframe ``mmhQL``
          which starts directly with the search input). */}
      {(() => {
        const showIconOnly = !isMobile && collapsed
        return (
          <>
            {/* Search trigger — opens the command palette. Styled as an
                input field per the wireframe; clicking anywhere fires the
                palette open. */}
            {!showIconOnly && onCommandPalette && (
              <div className="px-3 pt-3">
                <Tooltip className="w-full">
                  <TooltipTrigger
                    className="w-full"
                    render={
                      <button
                        type="button"
                        onClick={onCommandPalette}
                        className="flex h-8 w-full items-center gap-2 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                        aria-label="Open command palette"
                      >
                        <Search size={13} aria-hidden="true" />
                        <span className="flex-1">Search…</span>
                        <kbd className="font-mono text-[10px] text-(--color-text-subtle)">^P</kbd>
                      </button>
                    }
                  />
                  <TooltipContent>{`Open command palette (${formatShortcut('P', os)})`}</TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Nav action buttons */}
            <nav aria-label="Primary" className={`space-y-0.5 pb-2 ${showIconOnly ? 'flex flex-col items-center px-1 pt-3' : 'px-2 pt-2'}`}>
              {isMobile && (
                <SidebarItem
                  Icon={Home}
                  label="Home"
                  onClick={() => { navigate({ to: '/' }); onMobileClose?.() }}
                />
              )}
              {showIconOnly && onCommandPalette && (
                <SidebarItem
                  Icon={Search}
                  label="Commands"
                  kbd="^P"
                  collapsed
                  onClick={onCommandPalette}
                />
              )}
              <SidebarItem
                Icon={Plus}
                label="New Chat"
                kbd="^N"
                collapsed={showIconOnly}
                onClick={handleNewChat}
              />
            </nav>

            {/* Sessions section — expanded view (desktop expanded or mobile drawer) */}
            <AnimatePresence>
              {!showIconOnly && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.01 : DURATIONS_S.fast }}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-text-muted)">
                      Recent
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            onClick={() => refetchSessions()}
                            className="rounded-xs p-1 text-(--color-text-subtle) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-muted)"
                            aria-label="Refresh sessions"
                          >
                            <RefreshCw size={12} className={sessions.isFetching ? 'animate-spin' : ''} />
                          </button>
                        }
                      />
                      <TooltipContent>Refresh sessions</TooltipContent>
                    </Tooltip>
                  </div>

                  <div
                    ref={sessionListRef}
                    className="relative flex-1 overflow-y-auto px-2 pb-2"
                    onTouchStart={handleSessionListTouchStart}
                    onTouchMove={handleSessionListTouchMove}
                    onTouchEnd={handleSessionListTouchEnd}
                    onTouchCancel={handleSessionListTouchEnd}
                  >
                    {canPullRefresh && (
                      <div
                        className="pointer-events-none sticky top-0 z-10 flex justify-center overflow-hidden transition-[height] duration-150"
                        style={{ height: pullDistance }}
                        aria-hidden
                      >
                        <div className="mt-2 inline-flex h-8 items-center gap-2 rounded-full border border-(--color-border) bg-(--bg-card) px-3 text-[11px] text-(--color-text-muted) shadow-sm">
                          <RefreshCw size={12} className={pullDistance >= 54 || sessions.isFetching ? 'animate-spin' : ''} />
                          {pullDistance >= 54 ? 'Release to refresh' : 'Pull to refresh'}
                        </div>
                      </div>
                    )}
                    {sessions.isLoading && <SessionListSkeleton />}
                    {sessions.isError && (
                      <p className="px-3 py-4 text-center text-xs text-(--color-error)">Failed to load sessions</p>
                    )}
                    {sessions.isSuccess && normalSessions.length === 0 && (
                      <p className="px-3 py-4 text-center text-xs text-(--color-text-subtle)">No sessions yet</p>
                    )}
                    {sessions.isSuccess && normalSessions.length > 0 && (
                      <div className="space-y-0.5">
                        {dateGroups.map(({ label, sessions: group }) => (
                          <div key={label}>
                            <p className="px-2 pb-0.5 pt-2 text-xs text-(--color-text-subtle) first:pt-1">{label}</p>
                            {group.map((session) => (
                              <SessionRow
                                key={session.id}
                                session={session}
                                isActive={session.id === currentSessionId}
                                onSelect={handleSelect}
                                onDelete={(e, s) => handleDelete(e, s)}
                                onEdit={handleEdit}
                                mobileLongPressActions={mobileLongPressActions}
                                onLongPress={setMobileSessionActions}
                                onContextActions={(session, event) => {
                                  setDesktopSessionActions({ session, x: event.clientX, y: event.clientY })
                                }}
                              />
                            ))}
                          </div>
                        ))}
                        <div ref={loadMoreRef} className="h-1" aria-hidden />
                        {isFetchingNextPage && <SessionListSkeleton count={3} />}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Collapsed icon-only session dots — desktop only */}
            {showIconOnly && (
              <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
                {sessions.isSuccess && normalSessions.slice(0, 8).map((session) => {
                  const isActive = session.id === currentSessionId
                  return (
                    <Tooltip key={session.id}>
                      <TooltipTrigger
                        render={
                          <button
                            onMouseDown={(e) => {
                              if (!isModifiedPrimaryClick(e)) return
                              handleSelect(session.id, e)
                            }}
                            onClick={(e) => {
                              if (isModifiedPrimaryClick(e)) return
                              handleSelect(session.id, e)
                            }}
                            aria-label={session.title || 'Untitled'}
                            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                              isActive
                                ? 'bg-(--bg-key) text-(--color-accent)'
                                : 'text-(--color-text-subtle) hover:bg-(--bg-key) hover:text-(--color-text-2)'
                            }`}
                          >
                            <div className="h-1.5 w-1.5 rounded-full bg-current" />
                          </button>
                        }
                      />
                      <TooltipContent>{session.title || 'Untitled'}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            )}

            {/* Mobile drawer footer — on desktop this lives in AppFooter status bar */}
            <div className={`flex md:hidden items-center gap-2 border-t border-(--color-border) px-3 py-2 pb-safe ${showIconOnly ? 'justify-center' : 'justify-between'}`}>
              {showIconOnly ? (
                <ThemeToggle collapsed />
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => { openSettings(); onMobileClose?.() }}
                            className="flex h-11 w-11 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                            aria-label="Settings"
                          >
                            <Settings size={14} aria-hidden="true" />
                          </button>
                        }
                      />
                      <TooltipContent>{`Settings (${formatShortcut(',', os)})`}</TooltipContent>
                    </Tooltip>
                    {onCommandPalette && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={onCommandPalette}
                              className="flex h-11 w-11 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                              aria-label="Help and shortcuts"
                            >
                              <HelpCircle size={14} aria-hidden="true" />
                            </button>
                          }
                        />
                        <TooltipContent>{`Help and shortcuts (${formatShortcut('P', os)})`}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <HealthDot />
                    <ThemeToggle collapsed />
                  </div>
                </>
              )}
            </div>
          </>
        )
      })()}

        {desktopSessionActions && (
          <div
            className="fixed inset-0 z-50"
            onClick={() => setDesktopSessionActions(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setDesktopSessionActions(null)
            }}
          >
            <div
              role="menu"
              aria-label={`Actions for ${desktopSessionActions.session.title || 'Untitled'}`}
              className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
              style={{ left: desktopSessionActions.x, top: desktopSessionActions.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                onClick={() => {
                  const { session } = desktopSessionActions
                  setDesktopSessionActions(null)
                  handleEdit(session)
                }}
              >
                <Pencil size={12} aria-hidden="true" />
                Edit title
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
                onClick={() => {
                  const { session } = desktopSessionActions
                  setDesktopSessionActions(null)
                  setDeleteTarget(session)
                }}
              >
                <Trash2 size={12} aria-hidden="true" />
                Delete session
              </button>
            </div>
          </div>
        )}

        <Dialog open={mobileSessionActions !== null} onOpenChange={(open) => { if (!open) setMobileSessionActions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mobileSessionActions?.title || 'Untitled'}</DialogTitle>
            <DialogDescription>Choose a session action.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                const session = mobileSessionActions
                setMobileSessionActions(null)
                if (session) handleEdit(session)
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Edit title
            </Button>
            <Button
              type="button"
              variant="danger-subtle"
              className="justify-start"
              onClick={() => {
                const session = mobileSessionActions
                setMobileSessionActions(null)
                if (session) setDeleteTarget(session)
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
       <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
         <DialogContent showCloseButton={false}>
           <DialogHeader>
             <DialogTitle>Delete session</DialogTitle>
             <DialogDescription>
               &ldquo;{deleteTarget?.title || 'Untitled'}&rdquo; will be permanently deleted. This cannot be undone.
             </DialogDescription>
           </DialogHeader>
            <DialogFooter className="p-3">
              <Button variant="default" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
             <Button variant="danger" onClick={confirmDelete}>
               Delete
             </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>
       <Dialog open={editTarget !== null} onOpenChange={(open) => { if (!open) setEditTarget(null) }}>
         <DialogContent showCloseButton={false}>
           <form onSubmit={(event) => { event.preventDefault(); void editTitleForm.handleSubmit() }}>
             <DialogHeader>
               <DialogTitle>Edit session title</DialogTitle>
               <DialogDescription>
                 Rename this session in the sidebar.
               </DialogDescription>
             </DialogHeader>
             <div className="px-3 py-2">
               <editTitleForm.Field name="title">
                 {(field) => (
                   <input
                     ref={editTitleInputRef}
                     value={field.state.value}
                     onBlur={field.handleBlur}
                     onChange={(event) => field.handleChange(event.target.value)}
                     className="min-h-11 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-1 text-sm text-(--color-text) outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 md:min-h-9"
                     aria-label="Session title"
                     maxLength={255}
                   />
                 )}
               </editTitleForm.Field>
               {updateSessionTitle.isError && (
                 <p role="alert" className="mt-2 text-xs text-(--color-error)">Failed to update title.</p>
               )}
             </div>
             <DialogFooter className="p-3">
               <Button type="button" variant="default" onClick={() => setEditTarget(null)} disabled={updateSessionTitle.isPending}>
                 Cancel
               </Button>
               <editTitleForm.Subscribe selector={(state) => state.values.title}>
                 {(title) => (
                   <Button type="submit" disabled={!title.trim() || updateSessionTitle.isPending}>
                     {updateSessionTitle.isPending ? 'Saving…' : 'Save'}
                   </Button>
                 )}
               </editTitleForm.Subscribe>
             </DialogFooter>
           </form>
         </DialogContent>
       </Dialog>
       </motion.aside>
    </>
    )
  }

interface SessionRowProps {
  session: SessionResponse
  isActive: boolean
  onSelect: (id: string, event?: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent, session: SessionResponse) => void
  onEdit: (session: SessionResponse) => void
  mobileLongPressActions?: boolean
  onLongPress?: (session: SessionResponse) => void
  onContextActions?: (session: SessionResponse, event: React.MouseEvent) => void
}

/**
 * Single session row. Background stays flat on hover; instead the row
 * brightens its text from ``--color-text-2`` to ``--color-text`` as the
 * hover affordance. Active rows keep the solid ``--bg-key`` background.
 */
const SessionRow = memo(function SessionRow({ session, isActive, onSelect, onDelete, onEdit, mobileLongPressActions = false, onLongPress, onContextActions }: SessionRowProps) {
  // Cheap: framer keeps a single module-level media listener, so calling this
  // per row costs one useState each, not one subscription each.
  const reduceMotion = useReducedMotion()
  const isScheduled = Boolean(session.scheduled_task_name)
  // `needs_input` implies `running`; checked first so a turn suspended on a
  // question reads as "your turn", not as "still working".
  const needsInput = session.needs_input === true
  const isRunning = session.running === true && !needsInput

  return (
    <div className="group relative">
      <LongPressButton
        enabled={mobileLongPressActions}
        onLongPress={() => onLongPress?.(session)}
        onMouseDown={(e) => {
          if (!isModifiedPrimaryClick(e)) return
          onSelect(session.id, e)
        }}
        onClick={(e) => {
          if (isModifiedPrimaryClick(e)) return
          onSelect(session.id, e)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onEdit(session)
        }}
        onContextMenu={(e) => {
          if (mobileLongPressActions) return
          e.preventDefault()
          onContextActions?.(session, e)
        }}
        className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
          isActive
            ? 'bg-(--bg-key) text-(--color-text)'
            : 'text-(--color-text-2) hover:text-(--color-text)'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={session.title ?? 'untitled'}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
                className={`min-w-0 truncate text-xs transition-colors ${
                  isActive
                    ? 'font-medium text-(--color-text)'
                    : 'text-(--color-text-2) group-hover:font-medium group-hover:text-(--color-text)'
                }`}
              >
                {session.title || 'Untitled'}
              </motion.p>
            </AnimatePresence>
            {isScheduled && (
              <span className="shrink-0 rounded-xs px-1 py-px text-[10px] leading-tight bg-(--bg-key) text-(--color-text-subtle)">
                sched
              </span>
            )}
            {isRunning && (
              <span className="shrink-0 text-(--color-accent)" aria-label="Session running">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              </span>
            )}
            {needsInput && (
              <span
                className="shrink-0 rounded-xs px-1 py-px text-[10px] leading-tight bg-(--color-warning)/15 text-(--color-warning)"
                aria-label="Session needs your input"
              >
                asks
              </span>
            )}
          </div>
          {isScheduled && (
            <p className="mt-0.5 truncate text-xs text-(--color-text-subtle) transition-colors group-hover:text-(--color-text-muted)">
              {session.scheduled_task_name}
            </p>
          )}
          <p className="mt-0.5 truncate text-xs text-(--color-text-subtle) transition-colors group-hover:text-(--color-text-muted)">
            {formatRelativeDate(session.created_at)}
          </p>
        </div>
      </LongPressButton>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onEdit(session)
        }}
        className="absolute right-7 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-xs p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--bg-key) hover:text-(--color-text) group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Edit session ${session.title || 'Untitled'}`}
      >
        <Pencil size={12} />
      </button>

      {/* Delete on hover */}
      <button
        onClick={(e) => onDelete(e, session)}
        className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-xs p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Delete session ${session.title || 'Untitled'}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
})
