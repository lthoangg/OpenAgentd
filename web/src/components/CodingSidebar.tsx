import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { FolderCode, Home, Loader2, PanelLeftClose, Plus, RefreshCw } from 'lucide-react'
import { useDeleteTeamSessionMutation, useTeamSessionsQuery } from '@/queries/useSessionsQuery'
import { browseWorkspaces, validateWorkspace } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { formatRelativeDate } from '@/utils/format'
import { codingSessionSearch, loadCodingWorkspaceEntries, loadCodingWorkspaces, saveLastCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface CodingSidebarProps {
  currentSessionId?: string
  workspace?: string | null
  onCollapse?: () => void
  openWorkspaceDialogKey?: number
}

export function CodingSidebar({ currentSessionId, workspace, onCollapse, openWorkspaceDialogKey = 0 }: CodingSidebarProps) {
  const navigate = useNavigate()
  const sessions = useTeamSessionsQuery()
  const deleteSession = useDeleteTeamSessionMutation()
  const isTeamWorking = useTeamStore((state) => state.isTeamWorking)
  const allSessions = sessions.data?.pages.flatMap((page) => page.data) ?? []
  const codingSessions = allSessions.filter((session) => session.mode === 'coding' && session.workspace)
  const [workspaces, setWorkspaces] = useState<string[]>(() => loadCodingWorkspaces())
  const savedWorkspaceCreatedAt = new Map(loadCodingWorkspaceEntries().map((entry) => [entry.path, Date.parse(entry.createdAt)]))
  const savedWorkspaceTime = (path: string) => {
    const value = savedWorkspaceCreatedAt.get(path) ?? Number.MAX_SAFE_INTEGER
    return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value
  }
  const savedWorkspaces = [...workspaces].sort((a, b) => {
    return savedWorkspaceTime(a) - savedWorkspaceTime(b)
  })
  const sessionWorkspaces = Array.from(
    codingSessions.reduce((items, session) => {
      const path = session.workspace
      if (!path || savedWorkspaces.includes(path)) return items
      const createdAt = session.created_at ? Date.parse(session.created_at) : Number.MAX_SAFE_INTEGER
      const current = items.get(path)
      items.set(path, Math.min(current ?? Number.MAX_SAFE_INTEGER, Number.isNaN(createdAt) ? Number.MAX_SAFE_INTEGER : createdAt))
      return items
    }, new Map<string, number>()),
  )
    .sort(([, a], [, b]) => a - b)
    .map(([path]) => path)
  const visibleWorkspaces = [
    ...savedWorkspaces,
    ...sessionWorkspaces,
  ]
  const activeWorkspace = workspace ?? null
  const activeSessions = activeWorkspace
    ? codingSessions.filter((session) => session.workspace === activeWorkspace)
    : []

  const [dialogOpen, setDialogOpen] = useState(false)
  const [browserPath, setBrowserPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [trustWorkspace, setTrustWorkspace] = useState<string | null>(null)

  const loadBrowser = useCallback(async (path?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await browseWorkspaces(path)
      setBrowserPath(result.path)
      setParentPath(result.parent)
      setDirs(result.directories)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (dialogOpen && !browserPath) void loadBrowser(null)
  }, [dialogOpen, browserPath, loadBrowser])

  useEffect(() => {
    const handler = () => setWorkspaces(loadCodingWorkspaces())
    window.addEventListener('coding-workspaces-changed', handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener('coding-workspaces-changed', handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  useEffect(() => {
    if (openWorkspaceDialogKey > 0) setDialogOpen(true)
  }, [openWorkspaceDialogKey])

  useEffect(() => {
    if (pendingWorkspace && workspace === pendingWorkspace) setPendingWorkspace(null)
  }, [pendingWorkspace, workspace])

  const selectWorkspace = (path: string) => {
    const entry = saveLastCodingWorkspace(path)
    setPendingWorkspace(path)
    setWorkspaces(loadCodingWorkspaces())
    useTeamStore.getState().newSession()
    navigate({ to: '/coding', search: { w: entry.id } })
  }

  const openSelectedFolder = async () => {
    if (!browserPath) return
    try {
      const result = await validateWorkspace(browserPath)
      setTrustWorkspace(result.workspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Workspace is invalid')
    }
  }

  const confirmTrustedWorkspace = () => {
    if (!trustWorkspace) return
    const workspaceToOpen = trustWorkspace
    setTrustWorkspace(null)
    setDialogOpen(false)
    selectWorkspace(workspaceToOpen)
  }

  return (
    <aside className="flex shrink-0 border-r border-(--color-border) bg-(--bg-sidebar)">
      <div className="flex w-16 flex-col items-center gap-2 border-r border-(--color-border) px-2 py-3">
        <button
          type="button"
          onClick={() => navigate({ to: '/' })}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
          title="Home"
          aria-label="Home"
        >
          <Home size={16} />
        </button>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-(--bg-key) text-(--color-accent) hover:opacity-90"
          title="Add workspace"
          aria-label="Add workspace"
        >
          <Plus size={16} />
        </button>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {visibleWorkspaces.map((path) => (
            <button
              type="button"
              key={path}
              onClick={() => selectWorkspace(path)}
              className={`flex h-10 w-10 items-center justify-center rounded-xl text-xs transition-colors ${path === activeWorkspace ? 'bg-(--color-accent) text-(--color-text-on-accent)' : 'bg-(--bg-key) text-(--color-text-muted) hover:text-(--color-text)'}`}
              title={path}
            >
              {pendingWorkspace === path ? <Loader2 size={14} className="animate-spin" /> : workspaceLabel(path).slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex w-64 flex-col">
        <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-3">
          <p className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-(--color-text)" title={activeWorkspace ?? undefined}>
            {pendingWorkspace ? `Opening ${workspaceLabel(pendingWorkspace)}…` : activeWorkspace ? workspaceLabel(activeWorkspace) : 'No workspace'}
          </p>
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
            title="Collapse session list (Ctrl+B)"
            aria-label="Collapse session list"
            aria-expanded="true"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-(--color-text-muted)">Sessions</span>
          <div className="flex gap-1">
            <button type="button" onClick={() => sessions.refetch()} className="rounded p-1 text-(--color-text-subtle) hover:bg-(--bg-key)" aria-label="Refresh sessions">
              <RefreshCw size={12} className={sessions.isFetching ? 'animate-spin' : ''} />
            </button>
            <button type="button" disabled={!activeWorkspace} onClick={() => activeWorkspace && selectWorkspace(activeWorkspace)} className="rounded p-1 text-(--color-text-subtle) hover:bg-(--bg-key) disabled:opacity-40" aria-label="New coding session">
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!activeWorkspace && <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Add a workspace to start.</p>}
          {activeWorkspace && activeSessions.length === 0 && <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No sessions yet</p>}
          {activeSessions.map((session) => (
            <div key={session.id} className="group relative">
              <button
                type="button"
                onClick={() => {
                  const search = codingSessionSearch(session.workspace, activeWorkspace)
                  if (!search) return
                  navigate({
                    to: '/coding/$sessionId',
                    params: { sessionId: session.id },
                    search,
                  })
                }}
                className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${session.id === currentSessionId ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-2) hover:bg-(--bg-key)'}`}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={session.title ?? 'untitled'}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="truncate text-xs font-medium"
                  >
                    {session.title || 'Untitled'}
                  </motion.p>
                </AnimatePresence>
                {session.id === currentSessionId && isTeamWorking && (
                  <span className="absolute right-7 top-1/2 -translate-y-1/2 text-(--color-accent)" aria-label="Session running">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  </span>
                )}
                <p className="mt-0.5 text-xs text-(--color-text-subtle)">{formatRelativeDate(session.created_at)}</p>
              </button>
              <button
                type="button"
                onClick={() => { deleteSession.mutate(session.id); if (session.id === currentSessionId) navigate({ to: '/coding' }) }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-(--color-text-subtle) opacity-0 hover:bg-(--color-error-subtle) hover:text-(--color-error) group-hover:opacity-100"
                aria-label={`Delete session ${session.title || 'Untitled'}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setTrustWorkspace(null) }}>
        <DialogContent showCloseButton={false}>
          {trustWorkspace ? (
            <>
              <DialogHeader>
                <DialogTitle>Trust this workspace?</DialogTitle>
                <DialogDescription>
                  Coding mode grants agents filesystem and shell access inside this exact directory.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-(--color-border) bg-(--bg-page) px-3 py-2">
                <p className="break-all font-mono text-xs text-(--color-text-muted)">{trustWorkspace}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTrustWorkspace(null)}>Back</Button>
                <Button type="button" onClick={confirmTrustedWorkspace}>Trust and open</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Open workspace</DialogTitle>
                <DialogDescription>Choose a server-local project folder.</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <div className="rounded-lg border border-(--color-border) bg-(--bg-page) px-3 py-2">
                  <p className="truncate font-mono text-xs text-(--color-text-muted)" title={browserPath ?? undefined}>{browserPath ?? 'Loading folders…'}</p>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-(--color-border) p-1">
                  {parentPath && <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)" onClick={() => void loadBrowser(parentPath)}>..</button>}
                  {loading && dirs.length === 0 && <p className="px-2 py-4 text-center text-xs text-(--color-text-subtle)">Loading folders…</p>}
                  {!loading && dirs.length === 0 && <p className="px-2 py-4 text-center text-xs text-(--color-text-subtle)">No folders here</p>}
                  {dirs.map((dir) => <button type="button" key={dir.path} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)" onClick={() => void loadBrowser(dir.path)}><FolderCode size={14} /><span className="truncate">{dir.name}</span></button>)}
                </div>
                {error && <p className="text-xs text-(--color-error)">{error}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="button" disabled={!browserPath || loading} onClick={openSelectedFolder}>Open this folder</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  )
}
