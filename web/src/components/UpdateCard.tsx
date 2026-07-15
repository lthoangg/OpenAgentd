import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkForUpdates as invokeCheckForUpdates, downloadUpdate as invokeDownloadUpdate, fetchReleaseNotes, installUpdate as invokeInstallUpdate, type ReleaseNotes, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { getPlatform } from '@/hooks/use-platform'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DISMISSED_UNTIL_KEY = 'openagentd.updater.dismissedUntil'

export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus>({ status: 'idle' })
  const [tauriReady, setTauriReady] = useState(false)
  const dismissedUntilNextCheckRef = useRef(isDismissedUntilNextInterval())
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const checkForUpdates = useCallback(async (silent = false) => {
    setTauriReady(true)
    if (!silent) setStatus({ status: 'checking' })
    try {
      const next = await invokeCheckForUpdates(silent)
      clearDismissedUntilNextInterval()
      dismissedUntilNextCheckRef.current = false
      if (!silent || next.status !== 'up_to_date') setStatus(next)
    } catch (error) {
      if (!silent) setStatus({ status: 'error', message: String(error) })
    }
  }, [])

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

  useEffect(() => {
    const platform = getPlatform()
    // Mobile releases are delivered by the platform distribution channel;
    // only the desktop shell registers the custom updater commands below.
    if (!platform.isTauri || platform.os === 'ios' || platform.os === 'android') {
      setTauriReady(false)
      return
    }

    let cleanup: (() => void) | undefined
    let interval: number | undefined
    let cancelled = false

    async function start() {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        setTauriReady(true)
        const unlistenStatus = await listen<UpdateStatus>('updater-status', (event) => {
          if (dismissedUntilNextCheckRef.current && (event.payload.status === 'available' || event.payload.status === 'downloaded')) return
          setStatus(event.payload)
        })
        const unlistenCheck = await listen('updater-check-requested', () => {
          void checkForUpdates(false)
        })
        cleanup = () => {
          void unlistenStatus()
          void unlistenCheck()
        }
        if (!dismissedUntilNextCheckRef.current) void checkForUpdates(true)
        interval = window.setInterval(() => {
          void checkForUpdates(true)
        }, CHECK_INTERVAL_MS)
        const handleForeground = () => {
          if (document.visibilityState === 'visible') void checkForUpdates(true)
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
      if (interval) window.clearInterval(interval)
    }
  }, [checkForUpdates])

  const progress = useMemo(() => {
    if (status.status !== 'downloading' || !status.downloaded_bytes || !status.total_bytes) return null
    return Math.min(100, Math.round((status.downloaded_bytes / status.total_bytes) * 100))
  }, [status])

  if (!tauriReady || status.status === 'idle') return null
  if (status.status === 'up_to_date' && !status.message) return null

  return (
    <aside className="mobile-safe-floating fixed z-50 w-auto max-w-sm rounded-sm border border-(--color-border) bg-(--bg-card) p-4 text-sm text-(--color-text) shadow-md sm:left-auto sm:w-full" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{titleForStatus(status)}</div>
          <div className="mt-1 text-xs text-(--color-text-muted)">{descriptionForStatus(status)}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            dismissedUntilNextCheckRef.current = true
            persistDismissedUntilNextInterval()
            setStatus({ status: 'idle' })
          }}
        >
          Later
        </Button>
      </div>

        {status.version && (status.status === 'available' || status.status === 'downloaded') ? <ReleaseNotesButton fallbackNotes={status.notes} version={status.version} /> : null}


      {status.status === 'downloading' ? (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-(--bg-page)">
            <div className="h-full rounded-full bg-(--color-accent) transition-all" style={{ width: `${progress ?? 10}%` }} />
          </div>
          <div className="mt-1 text-xs text-(--color-text-muted)">{formatBytes(status.downloaded_bytes)}{status.total_bytes ? ` / ${formatBytes(status.total_bytes)}` : ''}</div>
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        {status.status === 'error' ? (
          <Button type="button" variant="default" size="sm" onClick={() => void checkForUpdates(false)}>Try again</Button>
        ) : null}
        {status.status === 'available' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => void downloadUpdate()}>Download</Button>
        ) : null}
        {status.status === 'downloaded' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => void installUpdate()}>Install and restart</Button>
        ) : null}
      </div>
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
        className="mt-3 text-xs font-medium text-(--color-accent) underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        onClick={() => void openNotes()}
      >
        See release notes
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Release notes"
          className="z-60 w-full max-w-lg overflow-hidden rounded-xl border border-(--color-border) bg-(--bg-card) p-0 text-(--color-text) shadow-xl"
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

function isDismissedUntilNextInterval(): boolean {
  const dismissedUntil = Number(window.localStorage.getItem(DISMISSED_UNTIL_KEY) ?? 0)
  if (!Number.isFinite(dismissedUntil) || dismissedUntil <= Date.now()) {
    clearDismissedUntilNextInterval()
    return false
  }
  return true
}

function persistDismissedUntilNextInterval() {
  window.localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + CHECK_INTERVAL_MS))
}

function clearDismissedUntilNextInterval() {
  window.localStorage.removeItem(DISMISSED_UNTIL_KEY)
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
