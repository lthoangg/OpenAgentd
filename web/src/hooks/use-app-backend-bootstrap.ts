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
import { useLspInstallStore } from '@/stores/useLspInstallStore'

const DESKTOP_BOOTSTRAP_POLL_MS = 300
const DESKTOP_BOOTSTRAP_TIMEOUT_MS = 60_000
const ACTIVE_BACKEND_URL_STORAGE = 'openagentd.activeBackendUrl'

export interface AppBackendBootstrap {
  ready: boolean
  unavailable: boolean
  failed: boolean
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

export function useAppBackendBootstrap(): AppBackendBootstrap {
  const [ready, setReady] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [failed, setFailed] = useState(false)
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
        setUnavailable(false)
        setRetryKey((key) => key + 1)
      })
  }, [retrying])

  useEffect(() => {
    let cancelled = false
    let unlistenBackendReady: (() => void) | undefined
    let unlistenBackendError: (() => void) | undefined
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
      setFailed(false)
      setUnavailable(false)
      setReady(true)
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
        if (cancelled) return
        if (status?.backend_failed) {
          setFailed(true)
          setUnavailable(true)
          return
        }
        if (isBootstrapReady(status, isTauri)) {
          if (status?.base_url) {
            if (status.external) {
              window.localStorage.setItem(ACTIVE_BACKEND_URL_STORAGE, status.base_url)
            }
            await applyDesktopBackend(status)
          }
          finishReady()
          return
        }
        schedulePoll()
      } catch {
        if (cancelled) return
        if (!isTauri) {
          finishReady()
          return
        }
        schedulePoll()
      }
    }

    // Listen scoped to *this* webview window only. The generic `listen()`
    // from `@tauri-apps/api/event` registers with `target: { kind: 'Any' }`,
    // which matches every emit regardless of what target the Rust side used
    // — so a plain `listen('backend-ready', ...)` here would still pick up
    // another window's backend switch even after the Rust command scopes its
    // `emit_to`/`emit_filter` call to a specific window. Using
    // `getCurrentWebviewWindow().listen(...)` registers with this window's
    // label as the target, which Tauri's event filter actually respects.
    void import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      if (cancelled) return
      const currentWindow = getCurrentWebviewWindow()
      void currentWindow
        .listen<{ base_url: string; token?: string | null }>('backend-ready', (event) => {
          if (cancelled || !event.payload.base_url) return
          void applyDesktopBackend(event.payload).then(finishReady).catch(() => {
            if (!cancelled) setUnavailable(true)
          })
        }).then((unlisten) => {
          if (cancelled) unlisten()
          else unlistenBackendReady = unlisten
        }).catch(() => {})
      void currentWindow
        .listen<{ message: string }>('backend-error', () => {
          // Do not wait out the generic startup timeout when native startup has
          // already failed. The shell's detailed error remains in its log;
          // the recovery UI intentionally exposes only safe generic copy.
          if (!cancelled) {
            setFailed(true)
            setUnavailable(true)
          }
        }).then((unlisten) => {
          if (cancelled) unlisten()
          else unlistenBackendError = unlisten
        }).catch(() => {})
    }).catch(() => {})

    void bootstrap()

    const unsubscribe = onApiBaseUrlChange(() => {
      queryClient.clear()
      useLspInstallStore.getState().dismiss()
    })
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      unlistenBackendReady?.()
      unlistenBackendError?.()
      unsubscribe()
    }
  }, [retryKey])

  return { ready, unavailable, failed, retrying, retry }
}
