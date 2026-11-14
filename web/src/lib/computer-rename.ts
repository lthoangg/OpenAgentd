/**
 * Renaming the computer the app is on. Its name lives on the computer
 * (`PUT /api/server/name`), so it is changed through the connection the app
 * has to it, then remembered in the shell under that computer's key so the
 * lists show it at once.
 *
 * Both read and write the app's own `queryClient`: the Servers screen shows
 * before the router (and its `QueryClientProvider`) exists.
 */
import { apiBaseUrl } from '@/api/base-url'
import { setServerName } from '@/api/client/server-name'
import { renameCloudComputer } from '@/api/phone-cloud'
import { computerNameKey, rememberComputerName, type AppBackendStatus } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { SERVER_NAME_CAPABILITY, type ServerNameOf } from '@/queries/useServerNameQuery'

/** Shown in Details where Rename would be, on a server that predates names. */
export const NAME_NEEDS_UPDATE = 'Update OpenAgentd on this computer to name it.'

/** Whether the server in use keeps a name, from what the app already knows of it (nothing is asked). */
export function serverInUseKeepsName(): boolean {
  const known = queryClient.getQueryData<{ capabilities?: string[] }>(queryKeys.health())
  return known?.capabilities?.includes(SERVER_NAME_CAPABILITY) ?? false
}

/**
 * Name the computer in use; an empty name gives it its host name back.
 * Returns the app's status with the name remembered, or null from a shell
 * that keeps no names. Throws what the computer answered when it refused.
 */
export async function renameComputerInUse(status: AppBackendStatus | null, name: string): Promise<AppBackendStatus | null> {
  const origin = apiBaseUrl()
  const saved = await setServerName(name)
  queryClient.setQueryData<ServerNameOf>(queryKeys.serverName(), { ...saved, origin })
  const key = computerNameKey(status)
  if (!key) return null
  const next = await rememberComputerName(key, saved.name ?? '')
  if (next) queryClient.setQueryData(queryKeys.backendStatus(), next)
  return next
}

/**
 * Name any computer of the account. The one in use is renamed over the
 * app's own connection; any other through its link, in the background
 * (the window stays where it is). The name is then remembered under its
 * device id so every list shows it. Throws what the computer or the link
 * answered when it could not.
 */
export async function renameAccountComputer(status: AppBackendStatus | null, deviceId: string, name: string): Promise<AppBackendStatus | null> {
  const onIt = status?.account_device?.device_id === deviceId && (status.mode === 'external' || Boolean(status.external))
  if (onIt) return renameComputerInUse(status, name)
  const saved = await renameCloudComputer(deviceId, name)
  const next = await rememberComputerName(deviceId, saved.name ?? '')
  if (next) queryClient.setQueryData(queryKeys.backendStatus(), next)
  return next
}
