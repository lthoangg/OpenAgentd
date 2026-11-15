/**
 * Settings → Computers — which computer's OpenAgentd this app talks to and,
 * in the desktop app, which devices may connect to this one ("Let other
 * devices connect": the local network, and the account's own devices). The
 * Server dialog shows the same list.
 *
 * One list, Computers: in the desktop app the other computers of the
 * account this computer is signed in to are rows of it
 * (`AccountComputerRows`), each opened in this window with Use.
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { DirectSessionsRow } from '@/components/DirectSessionsCard'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { AccountComputerRows, useAccountComputers } from '@/components/phone/AccountComputers'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { startBundledAppBackend } from '@/lib/app-backend'
import { isDesktopShell } from '@/lib/desktop-shell'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** The account's computers, as rows of the desktop's list. */
function useDesktopComputerRows() {
  const { computers, devices, connected, canOpen, builtinStopped, app, route, reloadApp } = useAccountComputers(true)
  const start = async () => {
    await startBundledAppBackend()
    await reloadApp()
    await queryClient.invalidateQueries({ queryKey: queryKeys.cloud.status() })
  }
  if (!builtinStopped && !connected) return null
  return (
    <AccountComputerRows
      computers={computers}
      loaded={devices !== undefined}
      app={app}
      route={route}
      onOpenSessions={() => useSettingsStore.getState().closeSettings()}
      builtinStopped={builtinStopped}
      onStartBuiltin={start}
      cannotOpen={!canOpen}
      onRenamed={reloadApp}
    />
  )
}

function DesktopConnectionSettings() {
  const accountRows = useDesktopComputerRows()
  return (
    <>
      <AppBackendPanel active accountRows={accountRows} />
      <NetworkAccessCard extraRows={<DirectSessionsRow />} />
    </>
  )
}

export function ComputersSettingsPage() {
  return (
    <SettingsPage
      title="Computers"
      description="Which computer this app uses, and which devices can connect to it."
    >
      {isDesktopShell() ? <DesktopConnectionSettings /> : <AppBackendPanel active />}
    </SettingsPage>
  )
}
