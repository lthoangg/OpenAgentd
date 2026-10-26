/**
 * Wires ``buildServerCommands`` to the backend status, a health check of the
 * saved servers (run when the page opens), and the shared connect code.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useBackendStatusQuery } from '@/queries/useHealthQuery'
import { queryKeys } from '@/queries/keys'
import {
  connectBundledBackend,
  connectExternalBackend,
  currentBackendOrigin,
  normalizeServerBaseUrl,
  reloadForBackendSwitch,
} from '@/lib/backend-switch'
import { pingServer } from '@/lib/server-probe'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useToastStore } from '@/stores/useToastStore'
import type { Command } from '../CommandPalette'
import { buildServerCommands, type ServerHealth } from './paletteServerCommands'

export function usePaletteServerCommands(): Command[] {
  const queryClient = useQueryClient()
  const { data: status = null, refetch } = useBackendStatusQuery()
  const [health, setHealth] = useState<Record<string, ServerHealth>>({})
  const statusRef = useRef(status)
  statusRef.current = status

  const checkHealth = useCallback(() => {
    void refetch()
    const servers = statusRef.current?.servers ?? []
    setHealth(Object.fromEntries(servers.map((s) => [normalizeServerBaseUrl(s.base_url), 'checking' as const])))
    for (const server of servers) {
      const base = normalizeServerBaseUrl(server.base_url)
      void pingServer(base).then((online) => {
        setHealth((prev) => ({ ...prev, [base]: online ? 'online' : 'offline' }))
      })
    }
  }, [refetch])

  return useMemo(() => {
    const fail = (title: string, description: string) =>
      useToastStore.getState().push({ tone: 'error', title, description })
    const finish = (next: Awaited<ReturnType<typeof connectBundledBackend>>) => {
      if (!next.ok) return false
      if (next.status) queryClient.setQueryData(queryKeys.backendStatus(), next.status)
      if (next.reload) reloadForBackendSwitch()
      return true
    }
    return buildServerCommands(
      { status, health },
      {
        useBundled: () => {
          void connectBundledBackend(currentBackendOrigin(status)).then((result) => {
            if (!finish(result)) fail('Could not switch to the builtin backend', result.ok ? '' : result.error)
          })
        },
        useExternal: (server) => {
          const label = server.name?.trim() || server.base_url
          void connectExternalBackend({
            baseUrl: server.base_url,
            name: server.name ?? '',
            persist: true,
            currentBaseUrl: currentBackendOrigin(status),
          }).then((result) => {
            if (!result.ok) {
              fail(`Could not connect to ${label}`, result.error)
              return
            }
            finish(result)
          })
        },
        manage: () => useSettingsStore.getState().openSettings('connection'),
        checkHealth,
      },
    )
  }, [status, health, checkHealth, queryClient])
}
