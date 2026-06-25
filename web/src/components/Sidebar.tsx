import { useState, useEffect, useCallback, useRef, type TouchEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
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
import { useResizableWidth } from '@/hooks/use-resizable-width'
import type { SessionResponse } from '@/api/types'
import { useToastStore } from '@/stores/useToastStore'

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

interface SidebarProps {
  currentSessionId?: string
  onCommandPalette?: () => void
  onNewChat?: () => void
  /** Mobile only: whether the overlay drawer is open */
  mobileOpen?: boolean
  /** Mobile only: called when the drawer should close (backdrop tap, session select) */
  onMobileClose?: () => void
}

export function Sidebar({
  currentSessionId,
  onCommandPalette,
  onNewChat,
  mobileOpen = false,
  onMobileClose,
}: SidebarProps) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const pushToast = useToastStore((s) => s.push)
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const mobileLongPressActions = isMobile && isTauriMobile && mobileOpen
  const prefersReducedMotion = useReducedMotion()
  const navigate = useNavigate()
  const sessions = useTeamSessionsQuery('normal')
  const deleteSession = useDeleteTeamSessionMutation()
  const updateSessionTitle = useUpdateTeamSessionTitleMutation()
  const sessionListRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const editTitleInputRef = useRef<HTMLInputElement>(null)

  // The query is already mode-filtered server-side.
  const normalSessions = sessions.data?.pages.flatMap((p) => p.data) ?? []

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
  const [editTitle, setEditTitle] = useState('')
  const [pullDistance, setPullDistance] = useState(0)
  const pullStartYRef = useRef<number | null>(null)

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
  }, [canPullRefresh])

  const handleSessionListTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!canPullRefresh || pullStartYRef.current === null) return
    const delta = (event.touches[0]?.clientY ?? 0) - pullStartYRef.current
    if (delta <= 0) {
      setPullDistance(0)
      return
    }
    setPullDistance(Math.min(72, delta * 0.5))
  }, [canPullRefresh])

  const handleSessionListTouchEnd = useCallback(() => {
    if (canPullRefresh && pullDistance >= 54) {
      void refetchSessions()
    }
    pullStartYRef.current = null
    setPullDistance(0)
  }, [canPullRefresh, pullDistance, refetchSessions])

  // Ctrl+B: collapse sidebar; Ctrl+R: refresh sessions.
  // Ctrl+M (wiki) / Ctrl+S (scheduler) live in TeamChatView — those panels
  // moved out of the sidebar per the topbar-redesign wireframe and their
  // open-state is owned by useUIStore.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey) return
      if (e.key === 'b') { e.preventDefault(); toggleCollapse() }
      if (e.key === 'r') { e.preventDefault(); refetchSessions() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleCollapse, refetchSessions])

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions

  useEffect(() => {
    if (editTarget) editTitleInputRef.current?.focus()
  }, [editTarget])

  // Intersection observer — load next page when sentinel scrolls into view.
  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { root: sessionListRef.current, threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const handleDelete = (e: React.MouseEvent, session: SessionResponse) => {
    e.stopPropagation()
    setDeleteTarget(session)
  }

  const handleEdit = (session: SessionResponse) => {
    setEditTarget(session)
    setEditTitle(session.title || '')
  }

  const submitSessionTitle = (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTarget) return
    const title = editTitle.trim()
    if (!title) return
    updateSessionTitle.mutate(
      { id: editTarget.id, title },
      { onSuccess: () => setEditTarget(null) },
    )
  }

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
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('app_new_window', { initialPath: `/cockpit/${id}`, initial_path: `/cockpit/${id}` }).catch((err) => {
          console.error('Failed to open session in new window:', err)
          pushToast({
            tone: 'error',
            title: 'Could not open session in new window',
            description: err instanceof Error ? err.message : 'Desktop window creation failed.',
          })
        })
      }).catch((err) => {
        pushToast({
          tone: 'error',
          title: 'Could not open session in new window',
          description: err instanceof Error ? err.message : 'Desktop API is unavailable.',
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

  const resizable = useResizableWidth({
    storageKey: 'oa.sidebar.width',
    defaultWidth: 256,
    minWidth: 220,
    maxWidth: 420,
    edge: 'right',
    disabled: isMobile || collapsed,
  })

  // On mobile the sidebar is a fixed overlay drawer: it slides in/out via
  // x transform and always stays 272px wide. The desktop version animates
  // its inline width between 56px (icon-only) and the user-resized width.
  const desktopWidth = collapsed ? 56 : resizable.width

  return (
    <>
      {/* Mobile backdrop — closes the drawer on tap */}
      <AnimatePresence>
        {isMobile && mobileOpen && (
          <motion.div
            key="sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-30 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={onMobileClose}
          />
        )}
      </AnimatePresence>

    <motion.aside
      animate={
        isMobile
          ? { x: mobileOpen ? 0 : -280, width: 'min(272px, calc(100vw - 2rem))' }
          : { width: desktopWidth }
      }
      transition={{ duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
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
          owned by the topbar hamburger + Ctrl+B (see wireframe ``mmhQL``
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
                <button
                  type="button"
                  onClick={onCommandPalette}
                  className="flex h-8 w-full items-center gap-2 rounded-md border border-(--color-border) bg-(--bg-page) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
                  aria-label="Open command palette"
                  title="Open command palette (Ctrl+P)"
                >
                  <Search size={13} aria-hidden="true" />
                  <span className="flex-1">Search…</span>
                  <kbd className="font-mono text-[10px] text-(--color-text-subtle)">^P</kbd>
                </button>
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
                  transition={{ duration: prefersReducedMotion ? 0.01 : 0.15 }}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-(--color-text-muted)">
                      Recent
                    </span>
                    <button
                      onClick={() => refetchSessions()}
                      className="rounded p-1 text-(--color-text-subtle) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-muted)"
                      aria-label="Refresh sessions"
                      title="Refresh sessions (Ctrl+R)"
                    >
                      <RefreshCw size={12} className={sessions.isFetching ? 'animate-spin' : ''} />
                    </button>
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
                        {groupByDate(normalSessions).map(({ label, sessions: group }) => (
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
                    <button
                      key={session.id}
                      onMouseDown={(e) => {
                        if (!isModifiedPrimaryClick(e)) return
                        handleSelect(session.id, e)
                      }}
                      onClick={(e) => {
                        if (isModifiedPrimaryClick(e)) return
                        handleSelect(session.id, e)
                      }}
                      title={session.title || 'Untitled'}
                      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                        isActive
                          ? 'bg-(--bg-key) text-(--color-accent)'
                          : 'text-(--color-text-subtle) hover:bg-(--bg-key) hover:text-(--color-text-2)'
                      }`}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-current" />
                    </button>
                  )
                })}
              </div>
            )}

            {/* Footer — wireframe trio: Settings · Help (palette) · ThemeToggle.
                HealthDot is the small status dot tucked between the icon group
                and the theme toggle. Collapsed mode keeps only the theme
                cycler so the rail stays at 56px wide. */}
            <div className={`flex items-center gap-2 border-t border-(--color-border) px-3 py-2 pb-safe ${showIconOnly ? 'justify-center' : 'justify-between'}`}>
              {showIconOnly ? (
                <ThemeToggle collapsed />
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => { navigate({ to: '/settings' }); onMobileClose?.() }}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                      aria-label="Settings"
                      title="Settings"
                    >
                      <Settings size={14} aria-hidden="true" />
                    </button>
                    {onCommandPalette && (
                      <button
                        type="button"
                        onClick={onCommandPalette}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                        aria-label="Help and shortcuts"
                        title="Help and shortcuts (Ctrl+P)"
                      >
                        <HelpCircle size={14} aria-hidden="true" />
                      </button>
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
              className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
              style={{ left: desktopSessionActions.x, top: desktopSessionActions.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                onClick={() => {
                  const { session } = desktopSessionActions
                  setDesktopSessionActions(null)
                  handleEdit(session)
                }}
              >
                <Pencil size={14} aria-hidden="true" />
                Edit title
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
                onClick={() => {
                  const { session } = desktopSessionActions
                  setDesktopSessionActions(null)
                  setDeleteTarget(session)
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
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
              variant="outline"
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
              variant="outline"
              className="justify-start text-(--color-error)"
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
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
             <Button variant="destructive" onClick={confirmDelete}>
               Delete
             </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>
       <Dialog open={editTarget !== null} onOpenChange={(open) => { if (!open) setEditTarget(null) }}>
         <DialogContent showCloseButton={false}>
           <form onSubmit={submitSessionTitle}>
             <DialogHeader>
               <DialogTitle>Edit session title</DialogTitle>
               <DialogDescription>
                 Rename this session in the sidebar.
               </DialogDescription>
             </DialogHeader>
             <div className="px-3 py-2">
               <input
                 ref={editTitleInputRef}
                 value={editTitle}
                 onChange={(e) => setEditTitle(e.target.value)}
                 className="h-9 w-full min-w-0 rounded-[10px] border border-(--color-border) bg-(--bg-page) px-3 py-1 text-sm text-(--color-text) outline-none focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25"
                 aria-label="Session title"
                 maxLength={255}
               />
               {updateSessionTitle.isError && (
                 <p className="mt-2 text-xs text-(--color-error)">Failed to update title.</p>
               )}
             </div>
             <DialogFooter className="p-3">
               <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                 Cancel
               </Button>
               <Button type="submit" disabled={!editTitle.trim() || updateSessionTitle.isPending}>
                 {updateSessionTitle.isPending ? 'Saving…' : 'Save'}
               </Button>
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
function SessionRow({ session, isActive, onSelect, onDelete, onEdit, mobileLongPressActions = false, onLongPress, onContextActions }: SessionRowProps) {
  const isScheduled = Boolean(session.scheduled_task_name)
  const isRunning = session.running === true

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
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
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
              <span className="shrink-0 rounded px-1 py-px text-[10px] leading-tight bg-(--bg-key) text-(--color-text-subtle)">
                sched
              </span>
            )}
            {isRunning && (
              <span className="shrink-0 text-(--color-accent)" aria-label="Session running">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
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
        className="absolute right-7 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--bg-key) hover:text-(--color-text) group-hover:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Edit session ${session.title || 'Untitled'}`}
      >
        <Pencil size={12} />
      </button>

      {/* Delete on hover */}
      <button
        onClick={(e) => onDelete(e, session)}
        className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) group-hover:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Delete session ${session.title || 'Untitled'}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
