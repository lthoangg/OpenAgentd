/**
 * Wires ``buildServerCommands`` to the backend status, a health check of the
 * saved servers (run when the page opens), the account's computers (read
 * when the page opens; desktop), and the shared connect code.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useBackendStatusQuery } from '@/queries/useHealthQuery'
import { queryKeys } from '@/queries/keys'
import { accountComputerLine, useAccountComputers } from '@/lib/account-computers'
import {
  connectAccountComputer,
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
import { buildServerCommands, type PaletteComputer, type ServerHealth } from './paletteServerCommands'

export function usePaletteServerCommands(): Command[] {
  const queryClient = useQueryClient()
  const { data: status = null, refetch } = useBackendStatusQuery()
  const [health, setHealth] = useState<Record<string, ServerHealth>>({})
  // The account's computers are read once the page was opened, not polled.
  const [opened, setOpened] = useState(false)
  const account = useAccountComputers(opened, { poll: false })
  const statusRef = useRef(status)
  statusRef.current = status
  const refreshComputers = account.refresh

  const checkHealth = useCallback(() => {
    void refetch()
    setOpened(true)
    void refreshComputers()
    const servers = statusRef.current?.servers ?? []
    setHealth(Object.fromEntries(servers.map((s) => [normalizeServerBaseUrl(s.base_url), 'checking' as const])))
    for (const server of servers) {
      const base = normalizeServerBaseUrl(server.base_url)
      void pingServer(base).then((online) => {
        setHealth((prev) => ({ ...prev, [base]: online ? 'online' : 'offline' }))
      })
    }
  }, [refetch, refreshComputers])

  const computers = useMemo<PaletteComputer[]>(() => account.computers.map((computer) => {
    const line = accountComputerLine(computer, account.app ?? status, account.route)
    return { device_id: computer.device.device_id, label: computer.label, line, current: line.startsWith('Current') }
  }), [account.computers, account.app, account.route, status])

  return useMemo(() => {
    const fail = (title: string, description: string) =>
      useToastStore.getState().push({ tone: 'error', title, description })
    const finish = (next: Awaited<ReturnType<typeof connectBundledBackend>>) => {
      if (!next.ok) return false
      if (next.status) queryClient.setQueryData(queryKeys.backendStatus(), next.status)
      if (next.reload) reloadForBackendSwitch()
      return true
    }
    const byId = new Map(account.computers.map((computer) => [computer.device.device_id, computer]))
    return buildServerCommands(
      { status, health, computers },
      {
        useBundled: () => {
          void connectBundledBackend(currentBackendOrigin(status)).then((result) => {
            if (!finish(result)) fail("Couldn't switch to the built-in server", result.ok ? '' : result.error)
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
        useComputer: (row) => {
          const computer = byId.get(row.device_id)
          if (!computer) return
          void connectAccountComputer({
            deviceId: computer.device.device_id,
            label: computer.label,
            currentBaseUrl: currentBackendOrigin(status),
          }).then((result) => {
            if (!result.ok) {
              fail(`Could not open ${computer.label}`, result.error)
              return
            }
            finish(result)
          })
        },
        manage: () => useSettingsStore.getState().openSettings('connection'),
        checkHealth,
      },
    )
  }, [status, health, computers, account.computers, checkHealth, queryClient])
}
