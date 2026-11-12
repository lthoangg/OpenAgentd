/**
 * Settings → Server — which OpenAgentd server this app talks to and, in
 * the desktop app, whether phones and other computers may connect to the
 * built-in one. The Server dialog shows the same panel.
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { DirectSessionsCard } from '@/components/DirectSessionsCard'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { isDesktopShell } from '@/lib/desktop-shell'

export function ConnectionSettingsPage() {
  return (
    <SettingsPage
      title="Server"
      description="Use the built-in server that runs inside this app, or a server you run elsewhere."
    >
      <AppBackendPanel active />
      {isDesktopShell() && <DirectSessionsCard />}
      {isDesktopShell() && <NetworkAccessCard title="Access from other devices" />}
    </SettingsPage>
  )
}
