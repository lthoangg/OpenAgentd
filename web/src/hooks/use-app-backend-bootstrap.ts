import { useEffect, useState } from 'react'
import { installDesktopAuth } from '@/api/auth'
import { onApiBaseUrlChange, setApiBaseUrl } from '@/api/base-url'
import { getAppBackendStatus } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'

export function useAppBackendBootstrap(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlistenBackendReady: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) => {
      if (cancelled) return
      void listen<{ base_url: string; token?: string | null }>('backend-ready', (event) => {
        if (cancelled || !event.payload.base_url) return
        if (event.payload.token) {
          Object.defineProperty(window, '__OAD_TOKEN__', {
            value: event.payload.token,
            writable: true,
            configurable: true,
          })
          installDesktopAuth()
        }
        setApiBaseUrl(event.payload.base_url)
      }).then((unlisten) => {
        if (cancelled) unlisten()
        else unlistenBackendReady = unlisten
      }).catch(() => {})
    }).catch(() => {})
    void getAppBackendStatus().then((status) => {
      if (cancelled) return
      if (!status?.base_url) {
        setReady(true)
        return
      }
      if (status.token) {
        Object.defineProperty(window, '__OAD_TOKEN__', {
          value: status.token,
          writable: true,
          configurable: true,
        })
        installDesktopAuth()
      }
      setApiBaseUrl(status.base_url)
      setReady(true)
    }).catch(() => {
      if (!cancelled) setReady(true)
    })
    const unsubscribe = onApiBaseUrlChange(() => {
      queryClient.clear()
    })
    return () => {
      cancelled = true
      unlistenBackendReady?.()
      unsubscribe()
    }
  }, [])

  return ready
}
