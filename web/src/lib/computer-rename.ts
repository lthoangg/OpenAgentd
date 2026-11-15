/**
 * Renaming devices. A device of the account has one name, kept by the
 * account (`renameAccountDevice`): every device and the account pages show
 * it. A computer also calls itself by a name (`PUT /api/server/name`), which
 * it keeps in step with the account's; renaming a computer here changes that
 * one too, through the connection the app has to it or its link, and the
 * shell remembers it under that computer's key so the lists show it at once.
 *
 * Both read and write the app's own `queryClient`: the Servers screen shows
 * before the router (and its `QueryClientProvider`) exists.
 */
import { apiBaseUrl } from '@/api/base-url'
import { setServerName } from '@/api/client/server-name'
import { phoneCloudRenameDevice, renameCloudComputer } from '@/api/phone-cloud'
import { computerNameKey, rememberComputerName, type AppBackendStatus } from '@/lib/app-backend'
import { isDesktopShell } from '@/lib/desktop-shell'
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

/** A device of the account, as far as renaming it goes. */
export interface RenamedDevice {
  device_id: string
  me: boolean
  server: boolean
  /** Absent: an older shell or server, which keeps no account names. */
  name?: string | null
}

/**
 * Name a device of the account; an empty name leaves it unnamed (a
 * computer then goes back to its own name). The account keeps the name, so
 * every device shows it. A computer's own name follows: this computer's
 * through its server (the desktop's account route does both), another's in
 * the background through the app's connection or its link (and the computer
 * takes the account's name by itself the next time it checks in). A device
 * from an older shell or server is renamed the old way, on the computer only.
 */
export async function renameAccountDevice(status: AppBackendStatus | null, device: RenamedDevice, name: string): Promise<void> {
  if (device.name === undefined) {
    await renameAccountComputer(status, device.device_id, name)
    return
  }
  const wanted = name.trim() || null
  // Loaded on use: `@/api/cloud` stays out of the startup bundle.
  const saved = isDesktopShell()
    ? await (await import('@/api/cloud')).cloudRenameDevice(device.device_id, wanted)
    : await phoneCloudRenameDevice(device.device_id, wanted)
  void queryClient.invalidateQueries({ queryKey: queryKeys.cloud.devices() })
  void queryClient.invalidateQueries({ queryKey: queryKeys.phoneCloud.devices() })
  if (device.me) {
    // This computer's server took the name too.
    if (isDesktopShell()) void queryClient.invalidateQueries({ queryKey: queryKeys.serverName() })
    return
  }
  if (device.server) {
    void renameAccountComputer(status, device.device_id, saved.name ?? '').catch(() => undefined)
  }
}
