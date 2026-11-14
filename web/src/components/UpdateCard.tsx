/**
 * The update notice: one line in the notices column, one decision.
 *
 * The desktop downloads a new version on its own and shows nothing until it
 * is ready; the line then asks once, to restart. Android asks before the
 * download too (an APK, on what may be mobile data) and hands the install to
 * the system. A check the user asked for (the app menu) answers in a toast.
 * Settings → About keeps Check for updates and the release notes.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { hashKey } from '@tanstack/react-query'
import { checkForUpdates as invokeCheckForUpdates, downloadUpdate as invokeDownloadUpdate, hasInAppUpdates, installUpdate as invokeInstallUpdate, type UpdateStatus } from '@/lib/updater'
import { NoticeLine } from '@/components/NoticeLine'
import { Button } from '@/components/ui/button'
import { isMobileApp } from '@/lib/mobile-app'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { sessionsSpending } from '@/lib/active-sessions'
import { failureToast } from '@/lib/failure-toast'
import { noticePresence } from '@/lib/motion'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const RESTART_TIMEOUT_MS = 60_000
const IDLE: UpdateStatus = { status: 'idle' }

/**
 * Whether any agent is mid-turn. Restarting stops the built-in backend, which
 * ends its turns, and drops the stream of any other. Read from the
 * active-sessions list the sidebar keeps live.
 */
function agentsWorking(): boolean {
  return sessionsSpending(queryClient.getQueryData(queryKeys.session.sessions.active()))
}

const ACTIVE_SESSIONS_HASH = hashKey(queryKeys.session.sessions.active())

function subscribeToSessions(onChange: () => void): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === ACTIVE_SESSIONS_HASH) onChange()
  })
}

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

const pushToast = (toast: Parameters<ReturnType<typeof useToastStore.getState>['push']>[0]) => useToastStore.getState().push(toast)

export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus>(IDLE)
  const [tauriReady, setTauriReady] = useState(false)
  // "Restart when agents finish" was chosen: the restart waits for them.
  const [waiting, setWaiting] = useState(false)
  const working = useSyncExternalStore(subscribeToSessions, agentsWorking)
  const reduced = useReducedMotion() ?? false
  const mobile = isMobileApp()
  const [initialAutomaticCheckAt] = useState(() => Date.now())
  const dismissedUntilNextCheckRef = useRef(false)
  const nextAutomaticCheckAtRef = useRef(initialAutomaticCheckAt)
  const [nextAutomaticCheckAt, setNextAutomaticCheckAt] = useState(initialAutomaticCheckAt)
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The version whose download this window started, so one is not started twice.
  const downloadingVersionRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const scheduleNextAutomaticCheck = useCallback((timestamp: number) => {
    nextAutomaticCheckAtRef.current = timestamp
    setNextAutomaticCheckAt(timestamp)
  }, [])

  /**
   * Take a status from a check, a download or the shell. ``asked`` is true
   * when the user started it, and then every outcome says something.
   */
  const receive = useCallback((next: UpdateStatus, asked: boolean) => {
    if (next.status === 'available' && !isMobileApp()) {
      // The desktop's one decision is the restart: fetch the update now.
      const version = next.version ?? ''
      if (downloadingVersionRef.current === version) return
      downloadingVersionRef.current = version
      if (asked) {
        pushToast({ tone: 'info', title: `Downloading OpenAgentd ${version}`, description: 'It asks to restart when it is ready.' })
      }
      void invokeDownloadUpdate()
        .then((downloaded) => { if (mountedRef.current) setStatus(downloaded) })
        .catch((error: unknown) => {
          // Unasked, a failed download says nothing: the next check tries again.
          downloadingVersionRef.current = null
          if (asked) pushToast(failureToast("Couldn't download the update", error))
        })
      return
    }
    if (next.status === 'up_to_date') {
      if (asked) {
        pushToast({
          tone: 'success',
          title: 'OpenAgentd is up to date',
          description: next.message ?? (next.current_version ? `${next.current_version} is the latest version.` : undefined),
        })
      }
      setStatus(IDLE)
      return
    }
    if (next.status === 'error') {
      if (asked) pushToast(failureToast("Couldn't check for updates", next.message))
      setStatus(IDLE)
      return
    }
    setStatus(next)
  }, [])

  const checkForUpdates = useCallback(async (silent = false, asked = !silent) => {
    setTauriReady(true)
    if (!silent) {
      dismissedUntilNextCheckRef.current = false
      scheduleNextAutomaticCheck(Date.now() + CHECK_INTERVAL_MS)
    }
    try {
      receive(await invokeCheckForUpdates(silent), asked)
    } catch (error) {
      if (asked) pushToast(failureToast("Couldn't check for updates", error))
    }
  }, [receive, scheduleNextAutomaticCheck])

  const runAutomaticUpdateCheck = useCallback(() => {
    const now = Date.now()
    if (now < nextAutomaticCheckAtRef.current) return
    dismissedUntilNextCheckRef.current = false
    scheduleNextAutomaticCheck(now + CHECK_INTERVAL_MS)
    void checkForUpdates(true)
  }, [checkForUpdates, scheduleNextAutomaticCheck])

  // Android only: the desktop downloads without being asked.
  const downloadUpdate = useCallback(async () => {
    try {
      setStatus(await invokeDownloadUpdate())
    } catch (error) {
      pushToast(failureToast("Couldn't download the update", error))
    }
  }, [])

  const installUpdate = useCallback(async () => {
    setWaiting(false)
    setStatus((current) => ({ ...current, status: 'installing' }))
    if (isMobileApp()) {
      // Android hands off to the system installer and returns; the system
      // replaces the app if the user confirms.
      try {
        await invokeInstallUpdate()
        setStatus((current) => current.channel === 'apk' ? { ...current, status: 'downloaded' } : IDLE)
      } catch (error) {
        setStatus((current) => ({ ...current, status: 'downloaded' }))
        pushToast(failureToast("Couldn't install the update", error))
      }
      return
    }
    try {
      // The Tauri command shuts down the sidecar and then calls
      // `app.restart()`, so this promise intentionally never resolves: the
      // process is replaced before a response can come back. It is raced
      // against a timeout so a restart that fails for any reason leaves
      // "Installing update…" instead of staying on it.
      const restartTimeout = new Promise<never>((_, reject) => {
        restartTimeoutRef.current = setTimeout(
          () => reject(new Error('The restart timed out. Quit and reopen OpenAgentd.')),
          RESTART_TIMEOUT_MS,
        )
      })
      await Promise.race([
        invokeInstallUpdate(),
        restartTimeout,
      ])
    } catch (error) {
      if (!mountedRef.current) return
      pushToast(failureToast("Couldn't update OpenAgentd", error))
      // The download may be stale or gone: ask the shell what is there now.
      // Quiet, since the toast has said what happened.
      downloadingVersionRef.current = null
      setStatus(IDLE)
      void checkForUpdates(false, false)
    } finally {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current)
      restartTimeoutRef.current = undefined
    }
  }, [checkForUpdates])

  // The agents finished: restart, as asked.
  useEffect(() => {
    if (waiting && !working && status.status === 'downloaded') void installUpdate()
  }, [installUpdate, status.status, waiting, working])

  const handleLater = useCallback(() => {
    const dismissedUntil = Date.now() + CHECK_INTERVAL_MS
    dismissedUntilNextCheckRef.current = true
    scheduleNextAutomaticCheck(dismissedUntil)
    setWaiting(false)
    setStatus(IDLE)
  }, [scheduleNextAutomaticCheck])

  useEffect(() => {
    // Desktop and Android update themselves; the browser build has no
    // updater, and iOS gets updates from TestFlight or the App Store.
    if (!hasInAppUpdates()) {
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
            receive(incomingStatus, false)
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
  }, [checkForUpdates, receive, runAutomaticUpdateCheck])

  useEffect(() => {
    if (!tauriReady) return
    const delay = Math.max(0, nextAutomaticCheckAt - Date.now())
    const timeout = window.setTimeout(runAutomaticUpdateCheck, delay)
    return () => window.clearTimeout(timeout)
  }, [nextAutomaticCheckAt, runAutomaticUpdateCheck, tauriReady])

  const line = tauriReady ? lineFor(status, mobile) : null

  return (
    <AnimatePresence>
      {line && (
        <motion.aside
          key="update-notice"
          className="pointer-events-none flex w-full justify-end"
          aria-live="polite"
          {...noticePresence(reduced)}
        >
          {line === 'installing' && <NoticeLine busy text={mobile ? 'Opening the installer…' : 'Installing update…'} />}
          {line === 'downloading' && <NoticeLine busy text={downloadingText(status)} />}
          {line === 'available' && (
            <NoticeLine text={`OpenAgentd ${status.version} is available`}>
              <Button type="button" variant="ghost" size="xs" onClick={handleLater}>Later</Button>
              <Button type="button" variant="primary" size="xs" onClick={() => void downloadUpdate()}>Download</Button>
            </NoticeLine>
          )}
          {line === 'ready' && (waiting ? (
            <NoticeLine text="Restarts to update when agents finish">
              <Button type="button" variant="ghost" size="xs" onClick={() => setWaiting(false)}>Cancel</Button>
              <Button type="button" variant="default" size="xs" onClick={() => void installUpdate()}>Restart now</Button>
            </NoticeLine>
          ) : (
            <NoticeLine text={`OpenAgentd ${status.version} is ready`}>
              <Button type="button" variant="ghost" size="xs" onClick={handleLater}>Later</Button>
              {mobile ? (
                // Mobile agents run on the server, so installing interrupts nothing.
                <Button type="button" variant="primary" size="xs" onClick={() => void installUpdate()}>Install</Button>
              ) : working ? (
                <Button type="button" variant="primary" size="xs" onClick={() => setWaiting(true)}>Restart when agents finish</Button>
              ) : (
                <Button type="button" variant="primary" size="xs" onClick={() => void installUpdate()}>Restart to update</Button>
              )}
            </NoticeLine>
          ))}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/** Which line the status puts on screen, if any. The desktop shows its download to nobody. */
function lineFor(status: UpdateStatus, mobile: boolean): 'available' | 'downloading' | 'ready' | 'installing' | null {
  if (status.status === 'downloaded') return 'ready'
  if (status.status === 'installing') return 'installing'
  if (!mobile) return null
  if (status.status === 'available' || status.status === 'downloading') return status.status
  return null
}

function downloadingText(status: UpdateStatus): string {
  const done = formatMegabytes(status.downloaded_bytes)
  return status.total_bytes ? `Downloading update… ${done} of ${formatMegabytes(status.total_bytes)}` : `Downloading update… ${done}`
}

/** Whole megabytes, so a download's progress does not flicker by tenths. */
function formatMegabytes(bytes?: number | null): string {
  if (!bytes) return '0 MB'
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}
