/**
 * Settings → Switch computer — which computer's OpenAgentd this app talks to and,
 * in the desktop app, which devices may connect to this one ("Let other
 * devices connect": the local network, and the account's own devices). The
 * Server dialog shows the same list.
 *
 * One list, Computers: in the desktop app the other computers of the
 * account this computer is signed in to are rows of it
 * (`useDesktopAccountRows`), each opened in this window with Use.
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { DirectSessionsRow } from '@/components/DirectSessionsCard'
import { closeSettings, useDesktopAccountRows } from '@/components/DesktopAccountRows'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { isDesktopShell } from '@/lib/desktop-shell'

function DesktopConnectionSettings() {
  const accountRows = useDesktopAccountRows(true, closeSettings)
  return (
    <>
      <AppBackendPanel active accountRows={accountRows} />
      <NetworkAccessCard extraRows={<DirectSessionsRow />} />
    </>
  )
}

export function SwitchComputerSettingsPage() {
  return (
    <SettingsPage
      title="Switch computer"
      description="Which computer this app uses, and which devices can connect to it."
    >
      {isDesktopShell() ? <DesktopConnectionSettings /> : <AppBackendPanel active />}
    </SettingsPage>
  )
}
