import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { motion, AnimatePresence } from 'framer-motion'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'
import { useProximityTracker, useProximityIntensity } from '@/hooks/useProximity'
import { useIsMobile } from '@/hooks/use-mobile'

import {
  Plus,
  Trash2,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Brain,
  Settings,
  CalendarClock,
} from 'lucide-react'
import { isToday, isYesterday } from 'date-fns'
import { useTeamSessionsQuery, useDeleteTeamSessionMutation } from '@/queries'
import { formatRelativeDate } from '@/utils/format'
import { WikiPanel } from './WikiPanel'
import { SchedulerPanel } from './SchedulerPanel'
import { ThemeToggle } from './ThemeToggle'
import { HealthDot } from './HealthDot'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { SessionResponse } from '@/api/types'

interface DateGroup {
  label: string
  sessions: SessionResponse[]
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
  const navigate = useNavigate()
  const sessions = useTeamSessionsQuery()
  const deleteSession = useDeleteTeamSessionMutation()
  const sessionListRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const mouseY = useProximityTracker(sessionListRef)

  // Flatten pages into a single list of sessions
  const allSessions = sessions.data?.pages.flatMap((p) => p.data) ?? []

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const [wikiOpen, setWikiOpen] = useState(false)
  const [schedulerOpen, setSchedulerOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)

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

  // Ctrl+B: collapse sidebar; Ctrl+R: refresh sessions; Ctrl+M: toggle wiki; Ctrl+S: toggle scheduler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey) return
      if (e.key === 'b') { e.preventDefault(); toggleCollapse() }
      if (e.key === 'r') { e.preventDefault(); refetchSessions() }
      if (e.key === 'm') { e.preventDefault(); setWikiOpen((prev) => !prev) }
      if (e.key === 's') { e.preventDefault(); setSchedulerOpen((prev) => !prev) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleCollapse, refetchSessions])

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions

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

  const confirmDelete = () => {
    if (!deleteTarget) return
    deleteSession.mutate(deleteTarget.id)
    if (deleteTarget.id === currentSessionId) {
      navigate({ to: '/cockpit' })
    }
    setDeleteTarget(null)
  }

  const handleSelect = (id: string) => {
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

  // On mobile the sidebar is a fixed overlay drawer: it slides in/out via
  // x transform and always stays 272px wide. The desktop version animates
  // its inline width between 56px (icon-only) and 256px (expanded).
  const desktopWidth = collapsed ? 56 : 256

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
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={onMobileClose}
          />
        )}
      </AnimatePresence>

    <motion.aside
      animate={
        isMobile
          ? { x: mobileOpen ? 0 : -280 }
          : { width: desktopWidth }
      }
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={
        isMobile
          ? 'fixed inset-y-0 left-0 z-40 flex w-[272px] shrink-0 flex-col overflow-hidden bg-(--color-surface) shadow-xl'
          : 'relative flex shrink-0 flex-col overflow-hidden bg-(--color-surface)'
      }
      style={isMobile ? undefined : { minWidth: desktopWidth }}
    >
      {/* showIconOnly: desktop collapsed icon-only mode.
          On mobile the drawer is always fully expanded. */}
      {(() => {
        const showIconOnly = !isMobile && collapsed
        return (
          <>
            {/* Brand header */}
            <div className="flex h-14 items-center justify-between px-3">
              <button
                onClick={() => navigate({ to: '/' })}
                className="flex items-center gap-2.5 overflow-hidden rounded-md p-1 -ml-1 transition-colors hover:bg-(--color-accent-subtle)"
                title="Home"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-(--color-accent-subtle) ring-1 ring-(--color-border-strong)">
                  <img src={OpenAgentdAppIcon} width={28} height={28} alt="OpenAgentd logo" className="rounded-md" />
                </div>
                <AnimatePresence>
                  {!showIconOnly && (
                    <motion.div
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -8 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-center gap-1.5 overflow-hidden"
                    >
                      <span className="whitespace-nowrap text-sm font-semibold text-(--color-text)">
                        OpenAgentd
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>

              {/* On mobile: close button (×). On desktop: collapse toggle. */}
              {isMobile ? (
                <button
                  onClick={onMobileClose}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text-2)"
                  aria-label="Close sidebar"
                >
                  <PanelLeftClose size={15} />
                </button>
              ) : (
                <button
                  onClick={toggleCollapse}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text-2)"
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
                >
                  {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
                </button>
              )}
            </div>

            {/* Nav action buttons */}
            <div className="px-2 pb-2 space-y-0.5">
              <button
                onClick={handleNewChat}
                title="New Chat (Ctrl+N)"
                className={`interactive-weight flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all text-(--color-text-2) hover:bg-(--color-accent-subtle) hover:text-(--color-text) ${showIconOnly ? 'justify-center' : ''}`}
              >
                <Plus size={16} className="shrink-0" />
                <AnimatePresence>
                  {!showIconOnly && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="whitespace-nowrap flex-1 text-left">
                      New Chat
                    </motion.span>
                  )}
                </AnimatePresence>
                {!showIconOnly && (
                  <kbd className="shrink-0 rounded border border-(--color-border) bg-(--color-bg) px-1 py-0.5 font-mono text-xs text-(--color-text-subtle)">^N</kbd>
                )}
              </button>

              {onCommandPalette && (
                <button
                  onClick={onCommandPalette}
                  title="Commands (Ctrl+P)"
                  className={`interactive-weight flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all text-(--color-text-subtle) hover:bg-(--color-accent-subtle) hover:text-(--color-text-muted) ${showIconOnly ? 'justify-center' : ''}`}
                >
                  <Search size={15} className="shrink-0" />
                  <AnimatePresence>
                    {!showIconOnly && (
                      <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="whitespace-nowrap flex-1 text-left">
                        Commands
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {!showIconOnly && (
                    <kbd className="shrink-0 rounded border border-(--color-border) bg-(--color-bg) px-1 py-0.5 font-mono text-xs text-(--color-text-subtle)">^P</kbd>
                  )}
                </button>
              )}

              <button
                onClick={() => setWikiOpen(true)}
                title="Wiki (Ctrl+M)"
                className={`interactive-weight flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all text-(--color-text-subtle) hover:bg-(--color-accent-subtle) hover:text-(--color-text-muted) ${showIconOnly ? 'justify-center' : ''}`}
              >
                <Brain size={15} className="shrink-0" />
                <AnimatePresence>
                  {!showIconOnly && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="whitespace-nowrap flex-1 text-left">
                      Wiki
                    </motion.span>
                  )}
                </AnimatePresence>
                {!showIconOnly && (
                  <kbd className="shrink-0 rounded border border-(--color-border) bg-(--color-bg) px-1 py-0.5 font-mono text-xs text-(--color-text-subtle)">^M</kbd>
                )}
              </button>

              <button
                onClick={() => setSchedulerOpen(true)}
                title="Scheduled Tasks (Ctrl+S)"
                className={`interactive-weight flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all text-(--color-text-subtle) hover:bg-(--color-accent-subtle) hover:text-(--color-text-muted) ${showIconOnly ? 'justify-center' : ''}`}
              >
                <CalendarClock size={15} className="shrink-0" />
                <AnimatePresence>
                  {!showIconOnly && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="whitespace-nowrap flex-1 text-left">
                      Scheduled Tasks
                    </motion.span>
                  )}
                </AnimatePresence>
                {!showIconOnly && (
                  <kbd className="shrink-0 rounded border border-(--color-border) bg-(--color-bg) px-1 py-0.5 font-mono text-xs text-(--color-text-subtle)">^S</kbd>
                )}
              </button>

              <button
                onClick={() => { navigate({ to: '/settings' }); onMobileClose?.() }}
                title="Settings"
                className={`interactive-weight flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all text-(--color-text-subtle) hover:bg-(--color-accent-subtle) hover:text-(--color-text-muted) ${showIconOnly ? 'justify-center' : ''}`}
              >
                <Settings size={15} className="shrink-0" />
                <AnimatePresence>
                  {!showIconOnly && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="whitespace-nowrap flex-1 text-left">
                      Settings
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            </div>

            {/* Sessions section — expanded view (desktop expanded or mobile drawer) */}
            <AnimatePresence>
              {!showIconOnly && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 pb-1 pt-1">
                    <span className="text-xs font-medium uppercase tracking-wider text-(--color-text-subtle)">Recent</span>
                    <button
                      onClick={() => refetchSessions()}
                      className="rounded p-1 text-(--color-text-subtle) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text-muted)"
                      aria-label="Refresh sessions"
                      title="Refresh sessions (Ctrl+R)"
                    >
                      <RefreshCw size={12} className={sessions.isFetching ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  <div ref={sessionListRef} className="flex-1 overflow-y-auto px-2 pb-2">
                    {sessions.isLoading && (
                      <div className="space-y-1 px-1 py-2">
                        {[...Array(6)].map((_, i) => (
                          <div key={i} className="h-8 animate-pulse rounded-md bg-(--color-accent-dim)" />
                        ))}
                      </div>
                    )}
                    {sessions.isError && (
                      <p className="px-3 py-4 text-center text-xs text-(--color-error)">Failed to load sessions</p>
                    )}
                    {sessions.isSuccess && allSessions.length === 0 && (
                      <p className="px-3 py-4 text-center text-xs text-(--color-text-subtle)">No sessions yet</p>
                    )}
                    {sessions.isSuccess && allSessions.length > 0 && (
                      <div className="space-y-0.5">
                        {groupByDate(allSessions).map(({ label, sessions: group }) => (
                          <div key={label}>
                            <p className="px-2 pb-0.5 pt-2 text-xs text-(--color-text-subtle) first:pt-1">{label}</p>
                            {group.map((session) => (
                              <SessionRow
                                key={session.id}
                                session={session}
                                isActive={session.id === currentSessionId}
                                mouseY={mouseY}
                                onSelect={handleSelect}
                                onDelete={(e, s) => handleDelete(e, s)}
                              />
                            ))}
                          </div>
                        ))}
                        <div ref={loadMoreRef} className="h-1" aria-hidden />
                        {isFetchingNextPage && (
                          <div className="space-y-1 px-1 pt-1">
                            {[...Array(3)].map((_, i) => (
                              <div key={i} className="h-8 animate-pulse rounded-md bg-(--color-accent-dim)" />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Collapsed icon-only session dots — desktop only */}
            {showIconOnly && (
              <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
                {sessions.isSuccess && allSessions.slice(0, 8).map((session) => {
                  const isActive = session.id === currentSessionId
                  return (
                    <button
                      key={session.id}
                      onClick={() => handleSelect(session.id)}
                      title={session.title || 'Untitled'}
                      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                        isActive
                          ? 'bg-(--color-accent-dim) text-(--color-accent)'
                          : 'text-(--color-text-subtle) hover:bg-(--color-accent-subtle) hover:text-(--color-text-2)'
                      }`}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-current" />
                    </button>
                  )
                })}
              </div>
            )}

            {/* Footer */}
            <div className={`flex items-center border-t border-(--color-border) px-3 py-2 pb-safe ${showIconOnly ? 'justify-center' : 'justify-between'}`}>
              <ThemeToggle collapsed={showIconOnly} />
              {!showIconOnly && <HealthDot />}
            </div>
          </>
        )
      })()}

       {/* Wiki Panel */}
       <WikiPanel open={wikiOpen} onClose={() => setWikiOpen(false)} />

       {/* Scheduler Panel */}
       <SchedulerPanel open={schedulerOpen} onClose={() => setSchedulerOpen(false)} />

       {/* Delete confirmation dialog */}
       <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
         <DialogContent showCloseButton={false}>
           <DialogHeader>
             <DialogTitle>Delete session</DialogTitle>
             <DialogDescription>
               &ldquo;{deleteTarget?.title || 'Untitled'}&rdquo; will be permanently deleted. This cannot be undone.
             </DialogDescription>
           </DialogHeader>
           <DialogFooter>
             <Button variant="outline" onClick={() => setDeleteTarget(null)}>
               Cancel
             </Button>
             <Button variant="destructive" onClick={confirmDelete}>
               Delete
             </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>
       </motion.aside>
    </>
    )
  }

interface SessionRowProps {
  session: SessionResponse
  isActive: boolean
  mouseY: number | null
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, session: SessionResponse) => void
}

/**
 * Single session row with proximity fade. Layers, back to front:
 *   1. Proximity layer — absolute ::before-style div, background set inline
 *      from cursor distance. Skipped for active rows (already at peak).
 *   2. Button — transparent default; `:hover` and `[data-active]` paint a
 *      solid accent-dim background on top of the proximity layer.
 *
 * Because the proximity layer is a sibling positioned behind the button's
 * visible chrome (via `isolation: isolate` + stacking), the `:hover` class
 * background sits on top and wins without inline-style interference.
 */
function SessionRow({ session, isActive, mouseY, onSelect, onDelete }: SessionRowProps) {
  const { ref, intensity } = useProximityIntensity(mouseY)
  const showProximity = !isActive && intensity > 0
  const isScheduled = Boolean(session.scheduled_task_name)

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className="group relative isolate">
      {/* Proximity layer — behind the button, same rounded corners */}
      {showProximity && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-md"
          style={{
            backgroundColor: `color-mix(in srgb, var(--color-accent-dim) ${intensity * 100}%, transparent)`,
          }}
        />
      )}
      <button
        onClick={() => onSelect(session.id)}
        className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
          isActive
            ? 'bg-(--color-accent-dim) text-(--color-text)'
            : 'hover:bg-(--color-accent-dim) text-(--color-text-2)'
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
                className={`min-w-0 truncate text-xs ${
                  isActive
                    ? 'font-medium text-(--color-text)'
                    : 'text-(--color-text-2)'
                }`}
              >
                {session.title || 'Untitled'}
              </motion.p>
            </AnimatePresence>
            {isScheduled && (
              <span className="shrink-0 rounded px-1 py-px text-[10px] leading-tight bg-(--color-accent-subtle) text-(--color-text-subtle)">
                sched
              </span>
            )}
          </div>
          {isScheduled && (
            <p className="mt-0.5 truncate text-xs text-(--color-text-subtle)">
              {session.scheduled_task_name}
            </p>
          )}
          <p className="mt-0.5 truncate text-xs text-(--color-text-subtle)">
            {formatRelativeDate(session.created_at)}
          </p>
        </div>
      </button>

      {/* Delete on hover */}
      <button
        onClick={(e) => onDelete(e, session)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-(--color-text-subtle) transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) opacity-100 md:opacity-0 md:group-hover:opacity-100"
        aria-label={`Delete session ${session.title || 'Untitled'}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
