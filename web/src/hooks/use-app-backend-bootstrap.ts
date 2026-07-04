import { useEffect, useState } from 'react'
import { installDesktopAuth } from '@/api/auth'
import { onApiBaseUrlChange, setApiBaseUrl } from '@/api/base-url'
import { getPlatform } from '@/hooks/use-platform'
import { type AppBackendStatus, getAppBackendStatus } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'

const DESKTOP_BOOTSTRAP_POLL_MS = 300
const DESKTOP_BOOTSTRAP_TIMEOUT_MS = 15_000

function applyDesktopBackend(status: Pick<AppBackendStatus, 'base_url' | 'token'>): void {
  if (status.token) {
    Object.defineProperty(window, '__OAD_TOKEN__', {
      value: status.token,
      writable: true,
      configurable: true,
    })
    installDesktopAuth()
  }
  setApiBaseUrl(status.base_url)
}

function isBootstrapReady(status: AppBackendStatus | null, isTauri: boolean): boolean {
  if (!status?.base_url) return !isTauri
  if (!isTauri) return true
  if (status.external) return true
  return status.sidecar_running
}

export function useAppBackendBootstrap(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlistenBackendReady: (() => void) | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const isTauri = getPlatform().isTauri
    const deadline = Date.now() + DESKTOP_BOOTSTRAP_TIMEOUT_MS

    const finishReady = () => {
      if (cancelled) return
      setReady(true)
    }

    const schedulePoll = () => {
      if (cancelled || !isTauri || Date.now() >= deadline) {
        finishReady()
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
        if (isBootstrapReady(status, isTauri)) {
          if (status?.base_url) applyDesktopBackend(status)
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
      void getCurrentWebviewWindow()
        .listen<{ base_url: string; token?: string | null }>('backend-ready', (event) => {
          if (cancelled || !event.payload.base_url) return
          applyDesktopBackend(event.payload)
          finishReady()
        }).then((unlisten) => {
          if (cancelled) unlisten()
          else unlistenBackendReady = unlisten
        }).catch(() => {})
    }).catch(() => {})

    void bootstrap()

    const unsubscribe = onApiBaseUrlChange(() => {
      queryClient.clear()
    })
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      unlistenBackendReady?.()
      unsubscribe()
    }
  }, [])

  return ready
}
