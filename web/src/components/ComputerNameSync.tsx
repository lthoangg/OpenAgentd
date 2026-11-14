/**
 * Keeps the app's memory of what the computer in use calls itself.
 *
 * The name is read from the server (`/api/server/name`) over the connection
 * the app already has, and handed to the shell, which keeps it per computer
 * (`computer-names.json`) so the lists can show it while the app is on some
 * other server. Nothing is drawn.
 *
 * A name is filed only under the server it was read from: the answer is
 * tagged with the server that gave it, and dropped when the app has moved.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { computerNameKey, rememberComputerName } from '@/lib/app-backend'
import { normalizeServerBaseUrl } from '@/lib/backend-switch'
import { queryKeys } from '@/queries/keys'
import { useBackendStatusQuery } from '@/queries/useHealthQuery'
import { useServerNameQuery } from '@/queries/useServerNameQuery'

export function ComputerNameSync() {
  const queryClient = useQueryClient()
  const status = useBackendStatusQuery().data ?? null
  const named = useServerNameQuery().data
  // The last pair handed over: an older shell answers nothing, and is not asked again.
  const sent = useRef<string | null>(null)

  useEffect(() => {
    const key = computerNameKey(status)
    const name = named?.name?.trim()
    if (!status || !key || !named || !name) return
    if (normalizeServerBaseUrl(named.origin) !== normalizeServerBaseUrl(status.base_url)) return
    if (status.computer_names?.[key] === name) return
    const pair = `${key}\n${name}`
    if (sent.current === pair) return
    sent.current = pair
    void rememberComputerName(key, name).then((next) => {
      if (next) queryClient.setQueryData(queryKeys.backendStatus(), next)
    })
  }, [status, named, queryClient])

  return null
}
