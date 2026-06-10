import { useEffect } from 'react'
import { onApiBaseUrlChange, setApiBaseUrl } from '@/api/base-url'
import { getAppBackendStatus } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'

export function useAppBackendBootstrap(): void {
  useEffect(() => {
    let cancelled = false
    void getAppBackendStatus().then((status) => {
      if (cancelled || !status?.base_url) return
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
