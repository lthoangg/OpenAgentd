/**
 * The desktop's account computers as rows of the Server panel's one list.
 * Settings → Switch computer and the Server dialog (the status bar's server
 * button) both draw them, so both lists hold the same computers.
 */
import { AccountComputerRows, useAccountComputers } from '@/components/phone/AccountComputers'
import { startBundledAppBackend } from '@/lib/app-backend'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * The rows, or `null` for a guest. `active`: the list is on screen; the
 * account is asked nothing while it is not. `onOpened`: a computer was
 * opened in this window (close what showed the list).
 */
export function useDesktopAccountRows(active: boolean, onOpened: () => void) {
  const { computers, devices, connected, canOpen, builtinStopped, app, route, reloadApp } = useAccountComputers(active)
  const start = async () => {
    await startBundledAppBackend()
    await reloadApp()
    await queryClient.invalidateQueries({ queryKey: queryKeys.cloud.status() })
  }
  if (!active || (!builtinStopped && !connected)) return null
  return (
    <AccountComputerRows
      computers={computers}
      loaded={devices !== undefined}
      app={app}
      route={route}
      onOpenSessions={onOpened}
      builtinStopped={builtinStopped}
      onStartBuiltin={start}
      cannotOpen={!canOpen}
      onRenamed={reloadApp}
    />
  )
}

/** Settings closes once a computer is opened from its page. */
export const closeSettings = () => useSettingsStore.getState().closeSettings()
