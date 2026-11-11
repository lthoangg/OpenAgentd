/**
 * Settings → Server — which OpenAgentd server this app talks to and, in
 * the desktop app, whether phones and other computers may connect to the
 * built-in one. The Server dialog shows the same panel.
 *
 * In the desktop app, "Your computers" comes first: the other computers of
 * the account this computer is signed in to, each opened in this window
 * with Use (the phone's list, `AccountComputersSection`).
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { AccountComputersSection, useAccountComputers } from '@/components/phone/AccountComputers'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { startBundledAppBackend } from '@/lib/app-backend'
import { isDesktopShell } from '@/lib/desktop-shell'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** The desktop's "Your computers", above its servers. */
function useDesktopComputers() {
  const { computers, devices, connected, canOpen, builtinStopped, hiddenServerUrls, app, currentAlive, reloadApp } = useAccountComputers(true)
  const start = async () => {
    await startBundledAppBackend()
    await reloadApp()
    await queryClient.invalidateQueries({ queryKey: queryKeys.cloud.status() })
  }
  const shown = builtinStopped || connected
  return {
    hiddenServerUrls,
    section: shown ? (
      <AccountComputersSection
        computers={computers}
        loaded={devices !== undefined}
        app={app}
        currentAlive={currentAlive}
        onOpenSessions={() => useSettingsStore.getState().closeSettings()}
        builtinStopped={builtinStopped}
        onStartBuiltin={start}
        cannotOpen={!canOpen}
      />
    ) : null,
  }
}

function DesktopConnectionSettings() {
  const { section, hiddenServerUrls } = useDesktopComputers()
  return (
    <>
      {section}
      <AppBackendPanel active hiddenServerUrls={hiddenServerUrls} />
      <NetworkAccessCard title="Access from other devices" />
    </>
  )
}

export function ConnectionSettingsPage() {
  return (
    <SettingsPage
      title="Server"
      description="Use the built-in server that runs inside this app, or a server you run elsewhere."
    >
      {isDesktopShell() ? <DesktopConnectionSettings /> : <AppBackendPanel active />}
    </SettingsPage>
  )
}
