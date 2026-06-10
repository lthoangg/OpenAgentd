import { useEffect } from 'react'
import { installDesktopAuth } from '@/api/auth'
import { onApiBaseUrlChange, setApiBaseUrl } from '@/api/base-url'
import { getAppBackendStatus } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'

export function useAppBackendBootstrap(): void {
  useEffect(() => {
    let cancelled = false
    void getAppBackendStatus().then((status) => {
      if (cancelled || !status?.base_url) return
      if (status.token) {
        Object.defineProperty(window, '__OAD_TOKEN__', {
          value: status.token,
          writable: true,
          configurable: true,
        })
        installDesktopAuth()
      }
      setApiBaseUrl(status.base_url)
    })
    const unsubscribe = onApiBaseUrlChange(() => {
      queryClient.clear()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
