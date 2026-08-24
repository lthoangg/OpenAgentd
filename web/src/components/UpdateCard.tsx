import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useDragControls, type PanInfo } from 'framer-motion'
import { AlertCircle, Download, GripVertical, Loader2, Maximize2, Minus } from 'lucide-react'
import { checkForUpdates as invokeCheckForUpdates, downloadUpdate as invokeDownloadUpdate, fetchReleaseNotes, installUpdate as invokeInstallUpdate, type ReleaseNotes, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { getPlatform } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

async function listenUpdaterEvents(callbacks: {
  onStatus: (status: UpdateStatus) => void
  onCheckRequested: () => void
}): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  const unlistenStatus = await listen<UpdateStatus>('updater-status', (event) => {
    callbacks.onStatus(event.payload)
  })
  const unlistenCheck = await listen('updater-check-requested', () => {
    callbacks.onCheckRequested()
  })
  return () => {
    void unlistenStatus()
    void unlistenCheck()
  }
}

export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus>({ status: 'idle' })
  const [tauriReady, setTauriReady] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragControls = useDragControls()
  const [initialAutomaticCheckAt] = useState(() => Date.now())
  const dismissedUntilNextCheckRef = useRef(false)
  const nextAutomaticCheckAtRef = useRef(initialAutomaticCheckAt)
  const [nextAutomaticCheckAt, setNextAutomaticCheckAt] = useState(initialAutomaticCheckAt)
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const scheduleNextAutomaticCheck = useCallback((timestamp: number) => {
    nextAutomaticCheckAtRef.current = timestamp
    setNextAutomaticCheckAt(timestamp)
  }, [])

  const checkForUpdates = useCallback(async (silent = false) => {
    setTauriReady(true)
    if (!silent) {
      dismissedUntilNextCheckRef.current = false
      scheduleNextAutomaticCheck(Date.now() + CHECK_INTERVAL_MS)
      setStatus({ status: 'checking' })
    }
    try {
      const next = await invokeCheckForUpdates(silent)
      if (!silent || next.status !== 'up_to_date') setStatus(next)
    } catch (error) {
      if (!silent) setStatus({ status: 'error', message: String(error) })
    }
  }, [scheduleNextAutomaticCheck])

  const runAutomaticUpdateCheck = useCallback(() => {
    const now = Date.now()
    if (now < nextAutomaticCheckAtRef.current) return
    dismissedUntilNextCheckRef.current = false
    scheduleNextAutomaticCheck(now + CHECK_INTERVAL_MS)
    void checkForUpdates(true)
  }, [checkForUpdates, scheduleNextAutomaticCheck])

  const downloadUpdate = useCallback(async () => {
    try {
      const next = await invokeDownloadUpdate()
      setStatus(next)
    } catch (error) {
      setStatus({ status: 'error', message: String(error) })
    }
  }, [])

  const installUpdate = useCallback(async () => {
    setStatus((current) => ({ ...current, status: 'installing' }))
    try {
      // The Tauri command shuts down the sidecar and then calls
      // `app.restart()`, so this promise intentionally never
      // resolves — the process is replaced before a response can come back.
      // We race it against a 60-second timeout so that if the restart fails
      // for any unexpected reason the card transitions to an error state
      // instead of staying frozen on "Installing update…" indefinitely.
      const RESTART_TIMEOUT_MS = 60_000
      const restartTimeout = new Promise<never>((_, reject) => {
        restartTimeoutRef.current = setTimeout(
          () => reject(new Error('Restart timed out — please quit and reopen OpenAgentd.')),
          RESTART_TIMEOUT_MS,
        )
      })
      await Promise.race([
        invokeInstallUpdate(),
        restartTimeout,
      ])
    } catch (error) {
      setStatus({ status: 'error', message: String(error) })
    } finally {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current)
      restartTimeoutRef.current = undefined
    }
  }, [])

  const handleLater = useCallback(() => {
    const dismissedUntil = Date.now() + CHECK_INTERVAL_MS
    dismissedUntilNextCheckRef.current = true
    scheduleNextAutomaticCheck(dismissedUntil)
    setStatus({ status: 'idle' })
  }, [scheduleNextAutomaticCheck])

  const handleDragEnd = useCallback((_: unknown, info: PanInfo) => {
    setOffset((prev) => ({
      x: prev.x + info.offset.x,
      y: prev.y + info.offset.y,
    }))
  }, [])

  const resetPosition = useCallback(() => {
    setOffset({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const platform = getPlatform()
    // Mobile releases are delivered by the platform distribution channel;
    // only the desktop shell registers the custom updater commands below.
    if (!platform.isTauri || platform.os === 'ios' || platform.os === 'android') {
      setTauriReady(false)
      return
    }

    let cleanup: (() => void) | undefined
    let cancelled = false

    async function start() {
      try {
        const unlistenAll = await listenUpdaterEvents({
          onStatus: (incomingStatus) => {
            if (dismissedUntilNextCheckRef.current && (incomingStatus.status === 'available' || incomingStatus.status === 'downloaded')) return
            setStatus(incomingStatus)
          },
          onCheckRequested: () => {
            void checkForUpdates(false)
          },
        })
        if (cancelled) {
          unlistenAll()
          return
        }
        setTauriReady(true)
        cleanup = unlistenAll
        const handleForeground = () => {
          if (
            document.visibilityState === 'visible'
            && Date.now() >= nextAutomaticCheckAtRef.current
          ) runAutomaticUpdateCheck()
        }
        document.addEventListener('visibilitychange', handleForeground)
        window.addEventListener('pageshow', handleForeground)
        const previousCleanup = cleanup
        cleanup = () => {
          previousCleanup?.()
          document.removeEventListener('visibilitychange', handleForeground)
          window.removeEventListener('pageshow', handleForeground)
        }
      } catch {
        setTauriReady(false)
      }
    }

    void start()
    return () => {
      cancelled = true
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current)
      restartTimeoutRef.current = undefined
      cleanup?.()
    }
  }, [checkForUpdates, runAutomaticUpdateCheck])

  useEffect(() => {
    if (!tauriReady) return
    const delay = Math.max(0, nextAutomaticCheckAt - Date.now())
    const timeout = window.setTimeout(runAutomaticUpdateCheck, delay)
    return () => window.clearTimeout(timeout)
  }, [nextAutomaticCheckAt, runAutomaticUpdateCheck, tauriReady])

  const progress = useMemo(() => {
    if (status.status !== 'downloading' || !status.downloaded_bytes || !status.total_bytes) return null
    return Math.min(100, Math.round((status.downloaded_bytes / status.total_bytes) * 100))
  }, [status])

  if (!tauriReady || status.status === 'idle') return null
  if (status.status === 'up_to_date' && !status.message) return null

  return (
    <aside
      className="mobile-safe-floating fixed z-50 pointer-events-none flex justify-end"
      aria-live="polite"
    >
      <motion.div
        drag
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        dragElastic={0}
        onDragEnd={handleDragEnd}
        animate={{ x: offset.x, y: offset.y }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        style={{ touchAction: 'none' }}
        className={cn(
          'pointer-events-auto border border-(--color-border) bg-(--bg-card) text-sm text-(--color-text) shadow-lg backdrop-blur-xs transition-[width,padding,border-radius] duration-200',
          minimized
            ? 'w-auto rounded-full px-3 py-1.5'
            : 'w-auto max-w-sm rounded-md p-4 sm:w-full sm:max-w-sm'
        )}
      >
        {minimized ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Drag update notification (double-click to reset position)"
              title="Drag to move · Double-click to reset"
              onPointerDown={(e) => dragControls.start(e)}
              onDoubleClick={resetPosition}
              className="cursor-grab active:cursor-grabbing p-0.5 rounded-xs text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--bg-key)/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring)"
            >
              <GripVertical className="size-3.5" />
            </button>

            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-(--color-text) hover:text-(--color-text-2) transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring) rounded-xs px-1"
              onClick={() => setMinimized(false)}
              title="Click to expand update details"
            >
              {statusIcon(status)}
              <span className="font-medium">{minimizedLabel(status)}</span>
            </button>

            {status.status === 'available' && (
              <Button type="button" variant="primary" size="xs" onClick={() => void downloadUpdate()}>
                Download
              </Button>
            )}
            {status.status === 'downloaded' && (
              <Button type="button" variant="primary" size="xs" onClick={() => void installUpdate()}>
                Install
              </Button>
            )}
            {status.status === 'error' && (
              <Button type="button" variant="default" size="xs" onClick={() => void checkForUpdates(false)}>
                Retry
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setMinimized(false)}
              title="Expand"
              aria-label="Expand"
            >
              <Maximize2 className="size-3.5" />
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleLater}
              title="Remind me later"
            >
              Later
            </Button>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label="Drag update notification (double-click to reset position)"
                  title="Drag to move · Double-click to reset"
                  onPointerDown={(e) => dragControls.start(e)}
                  onDoubleClick={resetPosition}
                  className="cursor-grab active:cursor-grabbing p-0.5 rounded-xs text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--bg-key)/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring) mt-0.5"
                >
                  <GripVertical className="size-3.5" />
                </button>
                <div>
                  <div className="font-medium">{titleForStatus(status)}</div>
                  <div className="mt-1 text-xs text-(--color-text-muted)">{descriptionForStatus(status)}</div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setMinimized(true)}
                  title="Minimize"
                  aria-label="Minimize"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleLater}
                  title="Remind me later"
                >
                  Later
                </Button>
              </div>
            </div>

            {status.version && (status.status === 'available' || status.status === 'downloaded') ? (
              <div className="pl-6">
                <ReleaseNotesButton fallbackNotes={status.notes} version={status.version} />
              </div>
            ) : null}

            {status.status === 'downloading' ? (
              <div className="mt-3 pl-6">
                <div className="h-2 overflow-hidden rounded-full bg-(--bg-page)">
                  <div className="h-full rounded-full bg-(--color-accent) transition-all" style={{ width: `${progress ?? 10}%` }} />
                </div>
                <div className="mt-1 text-xs text-(--color-text-muted)">
                  {formatBytes(status.downloaded_bytes)}
                  {status.total_bytes ? ` / ${formatBytes(status.total_bytes)}` : ''}
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              {status.status === 'error' ? (
                <Button type="button" variant="default" size="sm" onClick={() => void checkForUpdates(false)}>
                  Try again
                </Button>
              ) : null}
              {status.status === 'available' ? (
                <Button type="button" variant="primary" size="sm" onClick={() => void downloadUpdate()}>
                  Download
                </Button>
              ) : null}
              {status.status === 'downloaded' ? (
                <Button type="button" variant="primary" size="sm" onClick={() => void installUpdate()}>
                  Install and restart
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </motion.div>
    </aside>
  )
}

function ReleaseNotesButton({ fallbackNotes, version }: { fallbackNotes?: string | null; version: string }) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<ReleaseNotes | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openNotes() {
    setOpen(true)
    setError(null)
    try {
      setNotes(await fetchReleaseNotes(version))
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <>
      <button
        type="button"
        className="mt-2 text-xs font-medium text-(--color-accent) underline-offset-4 hover:underline hover:text-(--color-accent)/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) transition-colors cursor-pointer"
        onClick={() => void openNotes()}
      >
        See release notes
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Release notes"
          className="z-60 w-full max-w-lg overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-0 text-(--color-text) shadow-md"
        >
          <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
            <DialogTitle className="text-sm font-semibold">Release notes</DialogTitle>
            <div className="flex items-center gap-2">
              {notes?.url ? (
                <a
                  className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                  href={notes.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault()
                    void openExternalUrl(notes.url)
                  }}
                >
                  View in GitHub
                </a>
              ) : null}
              <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </DialogHeader>
          <div className="max-h-[24rem] overflow-y-auto overscroll-contain touch-pan-y px-4 py-3 text-(--color-text)">
            <LazyMarkdownBlock
              content={`${notes?.body ?? fallbackNotes ?? 'Loading release notes...'}${error ? `\n\nCould not load GitHub release notes: ${error}` : ''}`}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function statusIcon(status: UpdateStatus) {
  if (status.status === 'downloading' || status.status === 'installing' || status.status === 'checking') {
    return <Loader2 className="size-3.5 animate-spin text-(--color-text-muted)" />
  }
  if (status.status === 'error') {
    return <AlertCircle className="size-3.5 text-(--color-error)" />
  }
  return <Download className="size-3.5 text-(--color-accent)" />
}

function minimizedLabel(status: UpdateStatus): string {
  if (status.status === 'checking') return 'Checking updates…'
  if (status.status === 'available') return `Update ${status.version ?? ''}`
  if (status.status === 'downloading') return 'Downloading update…'
  if (status.status === 'downloaded') return `Ready to install (${status.version ?? ''})`
  if (status.status === 'installing') return 'Installing…'
  if (status.status === 'up_to_date') return 'Up to date'
  if (status.status === 'error') return 'Update failed'
  return 'Update'
}

function titleForStatus(status: UpdateStatus): string {
  if (status.status === 'checking') return 'Checking for updates...'
  if (status.status === 'available') return `OpenAgentd ${status.version} is available`
  if (status.status === 'downloading') return `Downloading OpenAgentd ${status.version}`
  if (status.status === 'downloaded') return `OpenAgentd ${status.version} is ready to install`
  if (status.status === 'installing') return 'Installing update...'
  if (status.status === 'up_to_date') return 'OpenAgentd is up to date'
  if (status.status === 'error') return 'Update failed'
  return ''
}

function descriptionForStatus(status: UpdateStatus): string {
  if (status.message) return status.message
  if (status.status === 'available') return `Current version: ${status.current_version}`
  if (status.status === 'downloaded') return 'Install now to restart into the new version.'
  if (status.status === 'installing') return 'OpenAgentd will restart when installation completes.'
  if (status.status === 'downloading') return 'You can keep using OpenAgentd while the update downloads.'
  return ''
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 MB'
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}
