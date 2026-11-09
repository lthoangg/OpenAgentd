/**
 * RelocateWorkspaceDialog — "Locate folder…" for a sidebar workspace whose
 * folder is gone (the repository was renamed or moved on disk).
 *
 * Two steps: pick the new folder (the OS picker in the desktop app on its
 * own server, the server's folder browser otherwise), then confirm what
 * moves: sessions, worktrees, scheduled tasks and groups, counted by a dry
 * run. When the new folder is already a workspace, the two merge, and the
 * dialog says so. The move itself is ``POST /agent/workspace/relocate``.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'

import { relocateCodingWorkspace } from '@/api/client'
import type { WorkspaceRelocateResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { loadWorkspaceBrowser } from '@/components/Sidebar.browser'
import { pathBasename } from '@/utils/workspace'

export interface RelocateWorkspaceDialogProps {
  /** The missing workspace's path; null closes the dialog. */
  from: string | null
  /** Its sidebar name. */
  name?: string
  /** Picks a folder with the OS dialog; absent, the server's folder browser is used. */
  pickFolder?: (() => Promise<string | null>) | null
  onClose: () => void
  /** After the move, with the server's answer (``workspace`` is the new path). */
  onRelocated: (result: WorkspaceRelocateResponse) => void
}

type Step =
  | { kind: 'pick' }
  | { kind: 'checking'; to: string }
  | { kind: 'confirm'; preview: WorkspaceRelocateResponse }

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut > 0 ? trimmed.slice(0, cut) : null
}

export function RelocateWorkspaceDialog({ from, name, pickFolder, onClose, onRelocated }: RelocateWorkspaceDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [browser, setBrowser] = useState<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }> } | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const label = name || (from ? pathBasename(from) : '')

  const check = useCallback(async (to: string) => {
    if (!from) return
    setError(null)
    setStep({ kind: 'checking', to })
    try {
      setStep({ kind: 'confirm', preview: await relocateCodingWorkspace(from, to, true) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to use that folder')
      setStep({ kind: 'pick' })
    }
  }, [from])

  const browse = useCallback(async (path: string | null) => {
    setBrowsing(true)
    setError(null)
    try {
      setBrowser(await loadWorkspaceBrowser(path))
    } catch {
      // The old folder's parent may be gone too: start from home.
      if (path) {
        try {
          setBrowser(await loadWorkspaceBrowser(null))
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Unable to read directory')
        }
      }
    } finally {
      setBrowsing(false)
    }
  }, [])

  const choose = useCallback(async () => {
    if (!pickFolder) return
    setError(null)
    try {
      const picked = await pickFolder()
      if (picked) await check(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open the folder picker')
    }
  }, [check, pickFolder])

  // Each open starts over: at the picker, the server browser in the old
  // folder's parent (where a renamed folder usually still is).
  useEffect(() => {
    setStep({ kind: 'pick' })
    setError(null)
    setMoving(false)
    setBrowser(null)
    if (from && !pickFolder) void browse(parentOf(from))
  }, [from, pickFolder, browse])

  const move = async () => {
    if (!from || step.kind !== 'confirm') return
    setMoving(true)
    setError(null)
    try {
      onRelocated(await relocateCodingWorkspace(from, step.preview.workspace))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to move the workspace')
      setMoving(false)
    }
  }

  const preview = step.kind === 'confirm' ? step.preview : null
  const moves = preview
    ? [
        plural(preview.sessions, 'session'),
        preview.worktrees.length > 0 ? `${plural(preview.worktrees.length, 'worktree')} (links repaired)` : null,
        preview.scheduled_tasks > 0 ? plural(preview.scheduled_tasks, 'scheduled task') : null,
        preview.groups.length > 0 ? `${preview.groups.length === 1 ? 'Group' : 'Groups'}: ${preview.groups.join(', ')}` : null,
      ].filter((line): line is string => line !== null)
    : []

  return (
    <Dialog open={from !== null} onOpenChange={(open) => { if (!open && !moving) onClose() }}>
      <DialogContent data-relocate-dialog="" initialFocus={preview ? confirmRef : undefined}>
        {preview ? (
          <>
            <DialogHeader>
              <DialogTitle>{`Move “${label}” to this folder?`}</DialogTitle>
              <DialogDescription>Everything that belonged to the old folder moves to the new one.</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-3 text-sm">
              <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
                <p data-relocate-from="" className="text-(--color-text-muted) line-through">{from}</p>
                <p aria-hidden="true" className="text-(--color-text-muted)">↓</p>
                <p data-relocate-to="" className="text-(--color-text)">{preview.workspace}</p>
              </div>
              <ul data-relocate-moves="" className="list-disc space-y-0.5 pl-5 text-(--color-text-2)">
                {moves.map((line) => <li key={line}>{line}</li>)}
              </ul>
              {preview.merge && (
                <p data-relocate-merge="" className="border-l-2 border-(--accent-orange-text) pl-2.5 text-xs text-(--color-text-2)">
                  {`“${pathBasename(preview.workspace)}” is already in the sidebar${preview.target_sessions > 0 ? ` with ${plural(preview.target_sessions, 'session')}` : ''}. They are merged into one workspace.`}
                </p>
              )}
              {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="default" disabled={moving} onClick={() => setStep({ kind: 'pick' })}>Back</Button>
              <Button ref={confirmRef} type="button" variant="primary" disabled={moving} onClick={() => { void move() }}>
                {moving ? 'Moving…' : 'Move workspace'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{`Locate “${label}”`}</DialogTitle>
              <DialogDescription>
                {`The folder ${from ?? ''} is gone. Choose where it is now; its sessions, worktrees, scheduled tasks and groups move with it.`}
              </DialogDescription>
            </DialogHeader>
            {pickFolder ? (
              <div className="min-w-0 space-y-2">
                {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
              </div>
            ) : (
              <div className="min-w-0 space-y-2">
                <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
                  <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]" title={browser?.path}>
                    {browser?.path ?? 'Loading folders…'}
                  </p>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-1">
                  {browser?.parent && (
                    <button
                      type="button"
                      className="w-full rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                      onClick={() => void browse(browser.parent)}
                    >
                      ..
                    </button>
                  )}
                  {browsing && !browser && (
                    <div role="status" aria-label="Loading folders" className="space-y-2 px-2 py-3">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  )}
                  {!browsing && browser && browser.directories.length === 0 && (
                    <EmptyState compact icon={Folder} title="No folders here" className="px-2 py-3" />
                  )}
                  {browser?.directories.map((dir) => (
                    <button
                      type="button"
                      key={dir.path}
                      className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                      onClick={() => void browse(dir.path)}
                    >
                      <Folder size={14} className="shrink-0" />
                      <span className="min-w-0 truncate">{dir.name}</span>
                    </button>
                  ))}
                </div>
                {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
              {pickFolder ? (
                <Button type="button" variant="primary" disabled={step.kind === 'checking'} onClick={() => { void choose() }}>
                  {step.kind === 'checking' ? 'Checking…' : 'Choose folder…'}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  disabled={!browser || browsing || step.kind === 'checking'}
                  onClick={() => { if (browser) void check(browser.path) }}
                >
                  {step.kind === 'checking' ? 'Checking…' : 'Use this folder'}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
