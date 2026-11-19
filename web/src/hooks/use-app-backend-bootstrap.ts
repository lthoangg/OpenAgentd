import { useCallback, useEffect, useState } from 'react'
import { installDesktopAuth, primeStoredAccessKey } from '@/api/auth'
import { onApiBaseUrlChange, setApiBaseUrl } from '@/api/base-url'
import { getPlatform } from '@/hooks/use-platform'
import {
  type AppBackendStatus,
  getAppBackendStatus,
  switchToBundledAppBackend,
} from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'
import { noteAppStarted, setAppStarter } from '@/lib/app-start'
import { clearProviderUsage } from '@/queries/providerUsageCache'
import { preloadConnectedApp } from '@/lib/connected-app-preload'
import { backendSwitchActive } from '@/stores/useBackendSwitchStore'
import { useLspInstallStore } from '@/stores/useLspInstallStore'

const DESKTOP_BOOTSTRAP_POLL_MS = 300
const DESKTOP_BOOTSTRAP_TIMEOUT_MS = 60_000
const ACTIVE_BACKEND_URL_STORAGE = 'openagentd.activeBackendUrl'

export interface AppBackendBootstrap {
  ready: boolean
  unavailable: boolean
  failed: boolean
  /**
   * What the shell said when its own start-up failed. Not for the screen
   * (the recovery screen says it in plain words); for Copy details.
   */
  failureMessage: string | null
  retrying: boolean
  retry: () => void
}

async function applyDesktopBackend(status: Pick<AppBackendStatus, 'base_url' | 'token'>): Promise<void> {
  if (status.token) {
    Object.defineProperty(window, '__OAD_TOKEN__', {
      value: status.token,
      writable: true,
      configurable: true,
    })
    installDesktopAuth()
  } else {
    delete window.__OAD_TOKEN__
  }
  setApiBaseUrl(status.base_url)
  // Bundled sidecars authenticate with their ephemeral desktop token; never
  // let unavailable persistent storage delay that startup path.
  if (!status.token) await primeStoredAccessKey()
}

function isBootstrapReady(status: AppBackendStatus | null, isTauri: boolean): boolean {
  if (!status?.base_url) return !isTauri
  if (!isTauri) return true
  if (status.external) return true
  return status.sidecar_running
}

async function listenWebviewBackendEvents(callbacks: {
  onReady: (payload: { base_url: string; token?: string | null }) => void
  onError: (message: string | null) => void
}): Promise<() => void> {
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const currentWindow = getCurrentWebviewWindow()
  const unlistenReady = await currentWindow.listen<{ base_url: string; token?: string | null }>(
    'backend-ready',
    (event) => {
      callbacks.onReady(event.payload)
    },
  )
  const unlistenError = await currentWindow.listen<{ message: string }>('backend-error', (event) => {
    callbacks.onError(typeof event.payload?.message === 'string' ? event.payload.message : null)
  })
  return () => {
    unlistenReady()
    unlistenError()
  }
}

export function useAppBackendBootstrap(): AppBackendBootstrap {
  const [ready, setReady] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [failed, setFailed] = useState(false)
  const [failureMessage, setFailureMessage] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retry = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    void getAppBackendStatus()
      .then(async (status) => {
        // On desktop, a failed initial spawn needs a real native retry —
        // restarting the frontend-only polling loop cannot make a missing
        // sidecar appear. Mobile/external backends retain poll-only retry.
        if (status?.supports_bundled && !status.sidecar_running && !status.backend_starting && !status.external) {
          await switchToBundledAppBackend()
        }
      })
      .catch(() => {})
      .finally(() => {
        setRetrying(false)
        setFailed(false)
        setFailureMessage(null)
        setUnavailable(false)
        setRetryKey((key) => key + 1)
      })
  }, [retrying])

  useEffect(() => {
    let cancelled = false
    let unlistenBackendEvents: (() => void) | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const isTauri = getPlatform().isTauri
    const deadline = Date.now() + DESKTOP_BOOTSTRAP_TIMEOUT_MS
    const rememberedBackendUrl = isTauri
      ? window.localStorage.getItem(ACTIVE_BACKEND_URL_STORAGE)
      : null
    // Keychain reads can be the slowest part of a cold mobile launch. Start
    // the read from the previously verified backend while the shell resolves
    // its current status; applyDesktopBackend will reuse the same in-flight
    // read after the native status confirms the URL.
    if (rememberedBackendUrl) void primeStoredAccessKey(rememberedBackendUrl).catch(() => {})

    const finishReady = () => {
      if (cancelled) return
      // Start the shell's first reads before it renders (an effect would run
      // after the whole router tree's first commit), and again for a
      // restarted or switched backend, whose cache was just cleared.
      preloadConnectedApp(queryClient)
      noteAppStarted()
      setFailed(false)
      setUnavailable(false)
      setReady(true)
    }

    // One start from the shell's status: the poll's, or the one a switch
    // asks for (below). Whichever comes first is the only one.
    let starting = false
    const start = async (status: AppBackendStatus | null) => {
      starting = true
      if (pollTimer) clearTimeout(pollTimer)
      try {
        if (status?.base_url) {
          if (status.external) {
            window.localStorage.setItem(ACTIVE_BACKEND_URL_STORAGE, status.base_url)
          }
          await applyDesktopBackend(status)
        }
      } catch (error) {
        // Not started after all: the poll (or the switch's reload) goes on.
        starting = false
        throw error
      }
      finishReady()
    }

    const schedulePoll = () => {
      if (cancelled || !isTauri) {
        finishReady()
        return
      }
      if (Date.now() >= deadline) {
        setFailed(false)
        setUnavailable(true)
        return
      }
      pollTimer = setTimeout(() => {
        void bootstrap()
      }, DESKTOP_BOOTSTRAP_POLL_MS)
    }

    const bootstrap = async () => {
      try {
        const status = await getAppBackendStatus()
        if (cancelled || starting) return
        if (status?.backend_failed) {
          setFailed(true)
          setUnavailable(true)
          return
        }
        if (isBootstrapReady(status, isTauri)) {
          // A switch still under way ends in a reload onto its server (or is
          // called off, and the next poll starts the app). Starting on this
          // page meanwhile would mount the router only for the reload to
          // throw it away, with whatever it had taken: the session a tapped
          // notification left for the reloaded page, a link marked handled.
          if (isTauri && backendSwitchActive()) {
            schedulePoll()
            return
          }
          await start(status)
          return
        }
        schedulePoll()
      } catch {
        if (cancelled || starting) return
        if (!isTauri) {
          finishReady()
          return
        }
        schedulePoll()
      }
    }

    // A switch that moved the shell before the app started here lands by
    // starting it (`landOnSwitchedBackend`); the poll holds while its screen
    // is up. False leaves the switch to reload, as it does on a running app.
    const startForSwitch = async () => {
      if (cancelled || starting) return false
      const status = await getAppBackendStatus()
      if (cancelled || starting || !status?.base_url || !isBootstrapReady(status, isTauri)) return false
      await start(status)
      return !cancelled
    }
    setAppStarter(startForSwitch)

    // Listen scoped to *this* webview window only. The generic `listen()`
    // from `@tauri-apps/api/event` registers with `target: { kind: 'Any' }`,
    // which matches every emit regardless of what target the Rust side used
    // — so a plain `listen('backend-ready', ...)` here would still pick up
    // another window's backend switch even after the Rust command scopes its
    // `emit_to`/`emit_filter` call to a specific window. Using
    // `getCurrentWebviewWindow().listen(...)` registers with this window's
    // label as the target, which Tauri's event filter actually respects.
    void listenWebviewBackendEvents({
      onReady: (payload) => {
        if (cancelled || !payload.base_url) return
        void applyDesktopBackend(payload).then(finishReady).catch(() => {
          if (!cancelled) setUnavailable(true)
        })
      },
      onError: (message) => {
        // Do not wait out the generic startup timeout when native startup has
        // already failed, and leave a running UI when the bundled backend
        // died and could not be restarted. The shell's detailed error
        // remains in its log; the recovery UI shows only generic copy and
        // hands the message to Copy details.
        if (!cancelled) {
          setReady(false)
          setFailureMessage(message)
          setFailed(true)
          setUnavailable(true)
        }
      },
    }).then((unlisten) => {
      if (cancelled) unlisten()
      else unlistenBackendEvents = unlisten
    }).catch(() => {})

    void bootstrap()

    const unsubscribe = onApiBaseUrlChange(() => {
      queryClient.clear()
      clearProviderUsage(queryClient)
      useLspInstallStore.getState().dismiss()
    })
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      setAppStarter(null)
      unlistenBackendEvents?.()
      unsubscribe()
    }
  }, [retryKey])

  return { ready, unavailable, failed, failureMessage, retrying, retry }
}
