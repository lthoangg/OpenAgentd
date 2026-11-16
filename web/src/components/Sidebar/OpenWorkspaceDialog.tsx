/**
 * Open workspace…: where a new workspace folder comes from. The desktop app
 * on its own server asks the OS folder picker; everywhere else the user
 * browses the server's folders. Either way a folder opens only after the
 * user has trusted it ("Let agents work in …?").
 */
import { useCallback, useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import { workspaceLabel } from '@/utils/workspace'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  loadWorkspaceBrowser,
  pickWorkspaceDirectory,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from './browser'
import { consumeTrustedWorkspace, selectTrustedWorkspace } from './trust'

export type OpenWorkspaceDialogState = ReturnType<typeof useOpenWorkspaceDialog>

/**
 * The dialog's state and the ``open`` that starts it. ``error`` is the
 * sidebar's one error line, shared with the worktree dialogs; ``onOpen``
 * opens the folder the user trusted.
 */
export function useOpenWorkspaceDialog({
  isTauri,
  isTauriMobile,
  openKey,
  setError,
  onOpen,
}: {
  isTauri: boolean
  isTauriMobile: boolean
  /** Bump to open the dialog (e.g. from a "no workspace attached" CTA). */
  openKey: number
  setError: (error: string | null) => void
  onOpen: (path: string) => void
}) {
  const [nativeFolderPickerEnabled, setNativeFolderPickerEnabled] = useState(isTauri)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  const [browserPath, setBrowserPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const [trustWorkspace, setTrustWorkspace] = useState<string | null>(null)

  const loadBrowser = useCallback(async (path?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadWorkspaceBrowser(path)
      setBrowserPath(result.path)
      setParentPath(result.parent)
      setDirs(result.directories)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read directory")
    } finally {
      setLoading(false)
    }
  }, [setError])

  const openWebWorkspaceDialog = useCallback(() => {
    setSelectedWorkspace(null)
    setTrustWorkspace(null)
    setDialogOpen(true)
    if (!browserPath) void loadBrowser(null)
    // `useState` setters are stable, so listing them is runtime-neutral — but
    // the React Compiler infers them as dependencies and skips optimizing the
    // whole component when the source list omits them.
  }, [browserPath, loadBrowser, setSelectedWorkspace, setTrustWorkspace, setDialogOpen])

  const open = useCallback(async () => {
    setError(null)
    setSelectedWorkspace(null)
    setTrustWorkspace(null)

    if (await shouldUseServerWorkspaceBrowser(isTauri, isTauriMobile)) {
      setNativeFolderPickerEnabled(false)
      openWebWorkspaceDialog()
      return
    }
    setNativeFolderPickerEnabled(true)

    setDialogOpen(true)
    setLoading(true)
    try {
      const selected = await pickWorkspaceDirectory()
      if (!selected) return
      setSelectedWorkspace(selected)
      setTrustWorkspace(await validateTrustedWorkspace(selected))
      setDialogOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open workspace")
    } finally {
      setLoading(false)
    }
    // Stable `useState` setters — see openWebWorkspaceDialog above.
  }, [
    isTauri,
    isTauriMobile,
    openWebWorkspaceDialog,
    setError,
    setSelectedWorkspace,
    setTrustWorkspace,
    setNativeFolderPickerEnabled,
    setDialogOpen,
    setLoading,
  ])

  useEffect(() => {
    if (openKey > 0) void open()
  }, [openKey, open])

  const openSelectedFolder = async () => {
    try {
      const trustedWorkspace = await selectTrustedWorkspace(browserPath, validateTrustedWorkspace)
      if (!trustedWorkspace) return
      setTrustWorkspace(trustedWorkspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Workspace is invalid')
    }
  }

  const confirmTrustedWorkspace = () => {
    const nextState = consumeTrustedWorkspace(trustWorkspace)
    if (!nextState.workspaceToOpen) return
    setTrustWorkspace(nextState.nextTrustWorkspace)
    setDialogOpen(nextState.nextDialogOpen)
    onOpen(nextState.workspaceToOpen)
  }

  return {
    open,
    nativeFolderPickerEnabled,
    dialogOpen,
    setDialogOpen,
    selectedWorkspace,
    browserPath,
    parentPath,
    dirs,
    loading,
    trustWorkspace,
    setTrustWorkspace,
    loadBrowser,
    openSelectedFolder,
    confirmTrustedWorkspace,
  }
}

export function OpenWorkspaceDialog({
  state,
  error,
  isTauriMobile,
}: {
  state: OpenWorkspaceDialogState
  error: string | null
  isTauriMobile: boolean
}) {
  const {
    open,
    nativeFolderPickerEnabled,
    dialogOpen,
    setDialogOpen,
    selectedWorkspace,
    browserPath,
    parentPath,
    dirs,
    loading,
    trustWorkspace,
    setTrustWorkspace,
    loadBrowser,
    openSelectedFolder,
    confirmTrustedWorkspace,
  } = state
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open)
        if (!open) setTrustWorkspace(null)
      }}
    >
      <DialogContent showCloseButton={false} className="min-w-0">
        {trustWorkspace ? (
          <>
            <DialogHeader>
              <DialogTitle>Let agents work in {workspaceLabel(trustWorkspace)}?</DialogTitle>
              {/* The Undo limit is the snapshot's: edited files up to 2 MB, not what a command moved or deleted. */}
              <DialogDescription>
                They can read, change and delete files in this folder, and run commands there. Undo in the chat
                brings back files they edited, up to 2 MB each.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
              <p className="break-all font-mono text-xs text-(--color-text-muted)">{trustWorkspace}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={() => setTrustWorkspace(null)}>Back</Button>
              <Button variant="primary" type="button" onClick={confirmTrustedWorkspace}>Allow and open</Button>
            </DialogFooter>
          </>
        ) : nativeFolderPickerEnabled && !isTauriMobile ? (
          <>
            <DialogHeader>
              <DialogTitle>Open workspace</DialogTitle>
              <DialogDescription>
                Use the desktop folder picker to choose a workspace.
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-2">
              {selectedWorkspace && (
                <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                  <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={selectedWorkspace}>
                    {selectedWorkspace}
                  </p>
                </div>
              )}
              {error && <p className="text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button variant="primary" type="button" disabled={loading} onClick={() => { void open() }}>
                {loading ? 'Opening…' : 'Choose folder…'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Open workspace</DialogTitle>
              <DialogDescription>Choose a workspace folder on the server.</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-2">
              <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={browserPath ?? undefined}>
                  {browserPath ?? 'Loading folders…'}
                </p>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-1">
                {parentPath && (
                  <button
                    type="button"
                    className="w-full rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                    onClick={() => void loadBrowser(parentPath)}
                  >
                    ..
                  </button>
                )}
                {loading && dirs.length === 0 && (
                  <div role="status" aria-label="Loading folders" className="space-y-2 px-2 py-3">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                )}
                {!loading && dirs.length === 0 && (
                  <EmptyState compact icon={Folder} title="No folders here" className="px-2 py-3" />
                )}
                {dirs.map((dir) => (
                  <button
                    type="button"
                    key={dir.path}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                    onClick={() => void loadBrowser(dir.path)}
                  >
                    <Folder size={14} className="shrink-0" />
                    <span className="min-w-0 truncate">{dir.name}</span>
                  </button>
                ))}
              </div>
              {error && <p className="text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button variant="primary" type="button" disabled={!browserPath || loading} onClick={openSelectedFolder}>Open this folder</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
